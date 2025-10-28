let offscreenDocumentCreated = false;

chrome.runtime.onInstalled.addListener(() => {
  console.log('Tab Screen Recorder extension installed');
});

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
    handleStartCapture(message)
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
  
  if (message.action === 'saveRecording') {
    chrome.downloads.download({
      url: message.url,
      filename: message.filename,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true });
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

async function handleStartCapture(options) {
  try {
    console.log('handleStartCapture called with options:', options);
    await setupOffscreenDocument();
    
    let streamId;
    let captureMode = options.captureMode || 'tab';
    let allowAudio = !!options.includeAudio;
    
    if (captureMode === 'browser') {
      const wantAudio = !!options.includeAudio;
      const sources = ['window', 'screen'];
      if (wantAudio) sources.push('audio');

      const result = await new Promise((resolve, reject) => {
        console.log('Requesting desktop capture with sources:', sources);
        chrome.desktopCapture.chooseDesktopMedia(sources, (chosenStreamId, pickerOptions) => {
          if (!chosenStreamId) {
            console.error('User cancelled desktop capture or no streamId returned');
            reject(new Error('User cancelled desktop capture'));
            return;
          }
          const canRequestAudio = !!(pickerOptions && pickerOptions.canRequestAudioTrack);
          resolve({ chosenStreamId, canRequestAudio });
        });
      });

      streamId = result.chosenStreamId;
      // Разрешаем аудио только если пользователь отметил «Share system audio»
      allowAudio = wantAudio && result.canRequestAudio;
      if (wantAudio && !allowAudio) {
        console.warn('System audio was not granted in the picker; continuing without audio.');
        // Notify UI that we will record without audio
        chrome.runtime.sendMessage({
          action: 'recordingWarning',
          message: 'Recording without audio'
        }).catch(() => {});
      }
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
        includeAudio: allowAudio
      }
    });

    return response;
  } catch (error) {
    console.error('Failed to start capture:', error);
    throw error;
  }
}
