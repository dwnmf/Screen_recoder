let mediaRecorder = null;
let recordedChunks = [];
let stream = null;
let startTime = 0;
let bufferSizeInterval = null;
let currentBufferSize = 0;
let audioPlaybackElement = null;
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

function startLocalAudioPlayback(sourceStream) {
  stopLocalAudioPlayback();

  audioPlaybackElement = document.createElement('audio');
  audioPlaybackElement.style.display = 'none';
  audioPlaybackElement.srcObject = sourceStream;
  audioPlaybackElement.autoplay = true;
  audioPlaybackElement.muted = false;
  audioPlaybackElement.playsInline = true;

  document.body.appendChild(audioPlaybackElement);

  const playPromise = audioPlaybackElement.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(error => {
      console.warn('Failed to start local audio playback preview:', error);
    });
  }
}

function stopLocalAudioPlayback() {
  if (!audioPlaybackElement) {
    return;
  }

  audioPlaybackElement.pause();
  audioPlaybackElement.srcObject = null;
  audioPlaybackElement.remove();
  audioPlaybackElement = null;
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
          // Use modern constraint syntax to prevent browser audio muting
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          suppressLocalAudioPlayback: false,
          mandatory: {
            chromeMediaSource: mediaSource,
            chromeMediaSourceId: streamId
          }
        };
      }
    } else {
      constraints.audio = false;
    }

    stream = await navigator.mediaDevices.getUserMedia(constraints);

    const videoTrack = stream.getVideoTracks()[0];
    const audioTracks = stream.getAudioTracks();
    
    // Validate video track
    if (!videoTrack) {
      throw new Error('No video track available');
    }
    
    // Validate and monitor audio tracks if audio is enabled
    if (options.includeAudio) {
      if (audioTracks.length === 0) {
        console.warn('No audio tracks found, recording will be video-only');
      } else {
        console.log(`Audio capture enabled: ${audioTracks.length} audio track(s) found`);
        
        // Monitor audio track state
        audioTracks.forEach((track, index) => {
          track.addEventListener('ended', () => {
            console.warn(`Audio track ${index} ended unexpectedly`);
          });
          
          track.addEventListener('mute', () => {
            console.warn(`Audio track ${index} was muted`);
          });
          
          track.addEventListener('unmute', () => {
            console.log(`Audio track ${index} was unmuted`);
          });
        });

        startLocalAudioPlayback(stream);
      }
    }
    
    // Apply video constraints
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

      stopLocalAudioPlayback();
    };
    
    mediaRecorder.onerror = (error) => {
      console.error('MediaRecorder error:', error);
      
      // Enhanced error handling for audio-specific issues
      let errorMessage = 'Recording error';
      if (error.message) {
        if (error.message.includes('audio') || error.message.includes('Audio')) {
          errorMessage = 'Audio capture error: ' + error.message;
        } else if (error.message.includes('permission') || error.message.includes('Permission')) {
          errorMessage = 'Permission denied: ' + error.message;
        } else {
          errorMessage = error.message;
        }
      }
      
      chrome.runtime.sendMessage({
        action: 'recordingError',
        error: errorMessage
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
    stopLocalAudioPlayback();
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
      stopLocalAudioPlayback();
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

      stopLocalAudioPlayback();
    };
    
    mediaRecorder.stop();
  });
}
