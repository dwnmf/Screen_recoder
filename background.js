let offscreenDocumentCreated = false;

chrome.runtime.onInstalled.addListener(() => {
  console.log('Tab Screen Recorder extension installed');
});

function normalizeDownloadFilename(filename) {
  if (!filename || typeof filename !== 'string') {
    return `recording_${Date.now()}.webm`;
  }

  const cleanedSegments = filename
    .replace(/\\/g, '/')
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment && segment !== '..')
    .map(segment => segment
      .replace(/\s+/g, ' ')
      .replace(/[^a-zA-Z0-9 _.\-]/g, '_')
    );

  const joined = cleanedSegments.join('/');
  return joined || `recording_${Date.now()}.webm`;
}

async function setupOffscreenDocument() {
  if (offscreenDocumentCreated) return;

  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (existingContexts.length > 0) {
      offscreenDocumentCreated = true;
      return;
    }

    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DISPLAY_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Screen/tab recording with MediaRecorder API from an offscreen document and local audio playback preview'
    });
    
    offscreenDocumentCreated = true;
    console.log('Offscreen document created');
  } catch (error) {
    console.error('Failed to create offscreen document:', error);
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startCapture') {
    handleStartCapture(message, sender)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'stopCapture') {
    chrome.runtime.sendMessage({ action: 'stopRecording' })
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'startCaptureWithStreamId') {
    handleStartWithProvidedStreamId(message)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'saveRecording') {
    const downloadOptions = {
      url: message.url,
      filename: normalizeDownloadFilename(message.filename),
      saveAs: typeof message.saveAs === 'boolean' ? message.saveAs : true,
      conflictAction: message.conflictAction || 'uniquify'
    };

    chrome.downloads.download(downloadOptions, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId });
      }
    });
    return true;
  }
  
  if (message.action === 'getStatus') {
    chrome.runtime.sendMessage({ action: 'getStatus' })
      .then(status => sendResponse(status))
      .catch(() => sendResponse({ isRecording: false }));
    return true;
  }
  
  if (message.action === 'bufferSizeUpdate' || 
      message.action === 'recordingComplete' || 
      message.action === 'recordingError' ||
      message.action === 'recordingStarted' ||
      message.action === 'recordingWarning' ||
      message.action === 'audioData') {
    chrome.runtime.sendMessage(message).catch(() => {});
  }
});

async function handleStartCapture(options, sender) {
  try {
    console.log('handleStartCapture called with options:', options);
    await setupOffscreenDocument();
    
    let streamId;
    let captureMode = options.captureMode || 'tab';
    let allowAudio = !!options.includeAudio;
    
    if (captureMode === 'browser') {
      // Run the desktop picker from the service worker with a target tab.
      // This avoids MV3 errors that require a target tab when not called
      // from a visible tab context.
      const sources = allowAudio ? ['window', 'screen', 'audio'] : ['window', 'screen'];

      // Resolve target tab: prefer explicit targetTabId, fallback to sender tab, then active tab
      let targetTab = null;
      try {
        const targetTabId = options.targetTabId || sender?.tab?.id;
        if (targetTabId) {
          targetTab = await chrome.tabs.get(targetTabId);
        } else {
          const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          targetTab = active || null;
        }
      } catch (e) {
        // ignore, we'll pass null and let API error if required
      }

      streamId = await new Promise((resolve, reject) => {
        try {
          chrome.desktopCapture.chooseDesktopMedia(
            sources,
            targetTab || undefined,
            (chosenStreamId, pickerOptions) => {
              const lastErr = chrome.runtime.lastError?.message || '';
              if (!chosenStreamId) {
                if (lastErr) console.warn('chooseDesktopMedia error:', lastErr);
                reject(new Error('User cancelled desktop capture'));
                return;
              }
              // If audio requested but picker/OS cannot provide it, disable audio and warn UI
              const canRequestAudio = !!(pickerOptions && pickerOptions.canRequestAudioTrack);
              if (allowAudio && !canRequestAudio) {
                allowAudio = false;
                chrome.runtime.sendMessage({ action: 'recordingWarning', message: 'Recording without audio' }).catch(() => {});
              }
              resolve(chosenStreamId);
            }
          );
        } catch (e) {
          reject(e);
        }
      });
    } else {
      console.log('Requesting tab capture for tabId:', options.tabId);
      streamId = await new Promise((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({
          targetTabId: options.tabId
        }, (streamId) => {
          if (chrome.runtime.lastError) {
            console.error('Tab capture error:', chrome.runtime.lastError.message);
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!streamId) {
            console.error('Tab capture returned empty streamId');
            reject(new Error('Failed to get stream ID from tab capture'));
            return;
          }
          console.log('Tab capture streamId obtained:', streamId);
          resolve(streamId);
        });
      });
    }
    
    console.log('Sending startRecording message to offscreen with streamId:', streamId);

    const response = await chrome.runtime.sendMessage({
      action: 'startRecording',
      streamId: streamId,
      captureMode: captureMode,
      options: {
        fps: options.fps,
        includeAudio: allowAudio,
        chunk: options.chunk
      }
    });

    return response;
  } catch (error) {
    console.error('Failed to start capture:', error);
    throw error;
  }
}

async function handleStartWithProvidedStreamId(payload) {
  try {
    await setupOffscreenDocument();
    if (!payload.streamId) {
      throw new Error('Missing streamId');
    }
    const captureMode = payload.captureMode || 'browser';
    const response = await chrome.runtime.sendMessage({
      action: 'startRecording',
      streamId: payload.streamId,
      captureMode: captureMode,
      options: {
        fps: payload.fps,
        includeAudio: !!payload.includeAudio,
        chunk: payload.chunk
      }
    });
    return response;
  } catch (e) {
    console.error('Failed to start with provided streamId:', e);
    throw e;
  }
}
