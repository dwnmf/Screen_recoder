let mediaRecorder = null;
let recordedChunks = [];
let stream = null;
let startTime = 0;
let bufferSizeInterval = null;
let currentBufferSize = 0;
const MAX_BUFFER_SIZE = 500 * 1024 * 1024;
const WARNING_BUFFER_SIZE = 400 * 1024 * 1024;

function calculateBufferSize() {
  return recordedChunks.reduce((total, chunk) => total + chunk.size, 0);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function startBufferMonitoring() {
  if (bufferSizeInterval) {
    clearInterval(bufferSizeInterval);
  }
  
  bufferSizeInterval = setInterval(() => {
    currentBufferSize = calculateBufferSize();
    
    chrome.runtime.sendMessage({
      action: 'bufferSizeUpdate',
      size: currentBufferSize,
      formatted: formatBytes(currentBufferSize),
      warning: currentBufferSize >= WARNING_BUFFER_SIZE
    }).catch(() => {});
    
    if (currentBufferSize >= MAX_BUFFER_SIZE) {
      console.warn('Buffer size limit reached, stopping recording automatically');
      stopRecording().catch(console.error);
    }
  }, 1000);
}

function stopBufferMonitoring() {
  if (bufferSizeInterval) {
    clearInterval(bufferSizeInterval);
    bufferSizeInterval = null;
  }
  currentBufferSize = 0;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startRecording') {
    startRecording(message.streamId, message.captureMode, message.options)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'stopRecording') {
    stopRecording()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'getStatus') {
    sendResponse({
      isRecording: mediaRecorder && mediaRecorder.state === 'recording',
      startTime: startTime,
      bufferSize: currentBufferSize
    });
    return true;
  }
});

async function startRecording(streamId, captureMode, options) {
  try {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      throw new Error('Recording already in progress');
    }

    const mediaSource = captureMode === 'browser' ? 'desktop' : 'tab';
    
    const constraints = {
      video: {
        mandatory: {
          chromeMediaSource: mediaSource,
          chromeMediaSourceId: streamId
        }
      }
    };
    
    if (options.includeAudio) {
      if (captureMode === 'browser') {
        constraints.audio = {
          mandatory: {
            chromeMediaSource: mediaSource,
            chromeMediaSourceId: streamId
          }
        };
      } else {
        constraints.audio = {
          mandatory: {
            chromeMediaSource: mediaSource,
            chromeMediaSourceId: streamId,
            suppressLocalAudioPlayback: false
          }
        };
      }
    } else {
      constraints.audio = false;
    }

    stream = await navigator.mediaDevices.getUserMedia(constraints);

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack && options.fps) {
      try {
        await videoTrack.applyConstraints({
          frameRate: { ideal: options.fps, max: options.fps }
        });
      } catch (error) {
        console.warn('Failed to apply FPS constraints:', error);
      }
    }

    const recorderOptions = {
      mimeType: 'video/webm;codecs=vp9',
      videoBitsPerSecond: 2500000
    };
    
    if (!MediaRecorder.isTypeSupported(recorderOptions.mimeType)) {
      recorderOptions.mimeType = 'video/webm;codecs=vp8';
      if (!MediaRecorder.isTypeSupported(recorderOptions.mimeType)) {
        recorderOptions.mimeType = 'video/webm';
      }
    }
    
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream, recorderOptions);
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };
    
    mediaRecorder.onstop = async () => {
      stopBufferMonitoring();
      
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const filename = `recording_${timestamp}.webm`;
      
      try {
        await chrome.runtime.sendMessage({
          action: 'saveRecording',
          url: url,
          filename: filename
        });
        
        chrome.runtime.sendMessage({
          action: 'recordingComplete',
          success: true
        });
      } catch (error) {
        chrome.runtime.sendMessage({
          action: 'recordingComplete',
          success: false,
          error: error.message
        });
      }
      
      URL.revokeObjectURL(url);
      recordedChunks = [];
      
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
      }
    };
    
    mediaRecorder.onerror = (error) => {
      console.error('MediaRecorder error:', error);
      chrome.runtime.sendMessage({
        action: 'recordingError',
        error: error.message || 'Recording error'
      });
    };
    
    startTime = Date.now();
    mediaRecorder.start(1000);
    
    startBufferMonitoring();
    
    chrome.runtime.sendMessage({
      action: 'recordingStarted',
      startTime: startTime
    });
    
  } catch (error) {
    console.error('Failed to start recording:', error);
    stopBufferMonitoring();
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }
    throw error;
  }
}

async function stopRecording() {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      stopBufferMonitoring();
      resolve();
      return;
    }
    
    stopBufferMonitoring();
    
    mediaRecorder.onstop = async (...args) => {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const filename = `recording_${timestamp}.webm`;
      
      try {
        await chrome.runtime.sendMessage({
          action: 'saveRecording',
          url: url,
          filename: filename
        });
        
        chrome.runtime.sendMessage({
          action: 'recordingComplete',
          success: true
        });
        resolve();
      } catch (error) {
        chrome.runtime.sendMessage({
          action: 'recordingComplete',
          success: false,
          error: error.message
        });
        reject(error);
      }
      
      URL.revokeObjectURL(url);
      recordedChunks = [];
      
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
      }
    };
    
    mediaRecorder.stop();
  });
}
