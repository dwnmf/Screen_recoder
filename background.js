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
      reasons: ['USER_MEDIA'],
      justification: 'Recording tab screen with MediaRecorder API'
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
      message.action === 'recordingStarted') {
    chrome.runtime.sendMessage(message).catch(() => {});
  }
});

async function handleStartCapture(options) {
  try {
    await setupOffscreenDocument();
    
    let streamId;
    let captureMode = options.captureMode || 'tab';
    
    if (captureMode === 'browser') {
      streamId = await new Promise((resolve, reject) => {
        chrome.desktopCapture.chooseDesktopMedia(
          ['window', 'screen'],
          (chosenStreamId) => {
            if (!chosenStreamId) {
              reject(new Error('User cancelled desktop capture'));
              return;
            }
            resolve(chosenStreamId);
          }
        );
      });
    } else {
      streamId = await new Promise((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({
          targetTabId: options.tabId
        }, (streamId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!streamId) {
            reject(new Error('Failed to get stream ID'));
            return;
          }
          resolve(streamId);
        });
      });
    }

    const response = await chrome.runtime.sendMessage({
      action: 'startRecording',
      streamId: streamId,
      captureMode: captureMode,
      options: {
        fps: options.fps,
        includeAudio: options.includeAudio
      }
    });

    return response;
  } catch (error) {
    console.error('Failed to start capture:', error);
    throw error;
  }
}
