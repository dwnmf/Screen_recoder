let mediaRecorder = null;
let recordedChunks = [];
let stream = null;
let startTime = 0;
let bufferSizeInterval = null;
let currentBufferSize = 0;
let audioPlaybackElement = null;
let audioContext = null;
let analyserNode = null;
let visualizerInterval = null;
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

function startAudioVisualizer(sourceStream) {
  stopAudioVisualizer();
  try {
    const hasAudio = sourceStream && sourceStream.getAudioTracks && sourceStream.getAudioTracks().length > 0;
    if (!hasAudio) return;

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(sourceStream);
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 1024; // frequencyBinCount = 512
    analyserNode.smoothingTimeConstant = 0.85;
    source.connect(analyserNode);

    const rawBins = new Uint8Array(analyserNode.frequencyBinCount);
    const targetBars = 32;

    visualizerInterval = setInterval(() => {
      if (!analyserNode) return;
      analyserNode.getByteFrequencyData(rawBins);

      // Downsample to fixed number of bars
      const bucketSize = Math.floor(rawBins.length / targetBars) || 1;
      const bars = new Array(targetBars).fill(0);
      for (let i = 0; i < targetBars; i++) {
        let sum = 0;
        let count = 0;
        const start = i * bucketSize;
        const end = Math.min(rawBins.length, start + bucketSize);
        for (let j = start; j < end; j++) { sum += rawBins[j]; count++; }
        bars[i] = count ? Math.round(sum / count) : 0;
      }

      chrome.runtime.sendMessage({ action: 'audioData', bars }).catch(() => {});
    }, 100);

    // Attempt to resume context in case it's suspended
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
  } catch (e) {
    console.warn('Audio visualizer setup failed:', e);
  }
}

function stopAudioVisualizer() {
  if (visualizerInterval) {
    clearInterval(visualizerInterval);
    visualizerInterval = null;
  }
  if (analyserNode) {
    try { analyserNode.disconnect(); } catch (_) {}
    analyserNode = null;
  }
  if (audioContext) {
    try { audioContext.close(); } catch (_) {}
    audioContext = null;
  }
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

    // Validate streamId: required for tab capture; for desktop capture the
    // offscreen document may request it via chooseDesktopMedia below.
    if (!streamId && captureMode !== 'browser') {
      throw new Error('Invalid stream ID: stream ID is required');
    }

    console.log('Starting recording with:', { streamId, captureMode, options });

    // For desktop capture, allow the offscreen document to invoke the picker
    // so that the resulting streamId is consumed in the same document.
    if (captureMode === 'browser' && !streamId) {
      const wantAudio = !!options.includeAudio;
      const sources = ['window', 'screen'];
      if (wantAudio) sources.push('audio');

      const result = await new Promise((resolve, reject) => {
        try {
          if (!chrome.desktopCapture || typeof chrome.desktopCapture.chooseDesktopMedia !== 'function') {
            reject(new Error('Desktop capture API unavailable in offscreen context'));
            return;
          }
          chrome.desktopCapture.chooseDesktopMedia(sources, (chosenStreamId, pickerOptions) => {
            const lastErr = chrome.runtime.lastError?.message || '';
            if (!chosenStreamId) {
              if (lastErr) console.warn('chooseDesktopMedia (offscreen) error:', lastErr);
              reject(new Error('User cancelled desktop capture'));
              return;
            }
            resolve({
              chosenStreamId,
              canRequestAudio: !!(pickerOptions && pickerOptions.canRequestAudioTrack)
            });
          });
        } catch (e) { reject(e); }
      });

      streamId = result.chosenStreamId;
      if (wantAudio && !result.canRequestAudio) {
        options.includeAudio = false;
        chrome.runtime.sendMessage({ action: 'recordingWarning', message: 'Recording without audio' }).catch(() => {});
      }
    }

    const mediaSource = captureMode === 'browser' ? 'desktop' : 'tab';

    function buildConstraints({ legacy, includeAudio }) {
      const c = {};
      // Video
      if (legacy) {
        c.video = { mandatory: { chromeMediaSource: mediaSource, chromeMediaSourceId: streamId } };
      } else {
        c.video = { chromeMediaSource: mediaSource, chromeMediaSourceId: streamId };
      }
      // Audio (omit property entirely if not requested)
      if (includeAudio) {
        if (legacy) {
          c.audio = {
            mandatory: {
              chromeMediaSource: mediaSource,
              chromeMediaSourceId: streamId
            }
          };
        } else {
          c.audio = {
            chromeMediaSource: mediaSource,
            chromeMediaSourceId: streamId
          };
          // Experimental: keep tab audio audible during capture in tab mode
          if (captureMode === 'tab') {
            c.audio.suppressLocalAudioPlayback = false;
          }
        }
      }
      return c;
    }

    // Try order: desktop prefers legacy first; tab prefers modern first
    const constraintsToTry = [];
    if (captureMode === 'browser') {
      constraintsToTry.push(buildConstraints({ legacy: true, includeAudio: !!options.includeAudio }));
      constraintsToTry.push(buildConstraints({ legacy: false, includeAudio: !!options.includeAudio }));
    } else {
      constraintsToTry.push(buildConstraints({ legacy: false, includeAudio: !!options.includeAudio }));
      constraintsToTry.push(buildConstraints({ legacy: true, includeAudio: !!options.includeAudio }));
    }

    let lastError = null;
    let tryWithoutAudio = false;
    
    for (const constraints of constraintsToTry) {
      try {
        console.log('Trying getUserMedia with constraints:', constraints);
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        console.log('Successfully got media stream');
        lastError = null;
        break;
      } catch (err) {
        console.error('getUserMedia failed:', err);
        lastError = err;
        const isNotFound = err.name === 'NotFoundError' || /Requested device not found/i.test(err.message || '');
        const isPermissionDenied = err.name === 'NotAllowedError' || /permission/i.test(err.message || '');
        const isAbortInvalidState = (err.name === 'AbortError' && /Invalid state/i.test(err.message || '')) || /Invalid state/i.test(err.message || '');

        if (isPermissionDenied) {
          throw new Error('Permission denied. Please allow screen capture access.');
        }

        // Some Chrome versions transiently throw AbortError: Invalid state — wait and retry once
        if (isAbortInvalidState) {
          try {
            await new Promise(r => setTimeout(r, 150));
            console.warn('Retrying getUserMedia after AbortError Invalid state...');
            stream = await navigator.mediaDevices.getUserMedia(constraints);
            console.log('Successfully got media stream after retry');
            lastError = null;
            break;
          } catch (retryErr) {
            console.error('Retry after AbortError also failed:', retryErr);
            lastError = retryErr;
          }
        }

        // If audio seems to be the culprit, try without audio
        if (options.includeAudio && (isNotFound || isAbortInvalidState) && !tryWithoutAudio) {
          console.warn('Audio device not found, retrying without audio');
          tryWithoutAudio = true;
          try {
            const retryConstraints = JSON.parse(JSON.stringify(constraints));
            // Remove audio entirely
            delete retryConstraints.audio;
            console.log('Retry constraints without audio:', retryConstraints);
            stream = await navigator.mediaDevices.getUserMedia(retryConstraints);
            console.log('Successfully got media stream without audio');
            options.includeAudio = false;
            chrome.runtime.sendMessage({ action: 'recordingWarning', message: 'Recording without audio' }).catch(() => {});
            lastError = null;
            break;
          } catch (retryErr) {
            console.error('Retry without audio also failed:', retryErr);
            lastError = retryErr;
          }
        }
        // Continue to next variant
      }
    }
    
    if (!stream) {
      const tried = constraintsToTry.map(c => Object.keys(c).join('+')).join(' | ');
      const errorMsg = lastError ? `${lastError.name}: ${lastError.message} (mode=${captureMode}, tried=${tried})` : 'Failed to acquire capture stream';
      console.error('All getUserMedia attempts failed:', errorMsg);
      throw new Error(errorMsg);
    }

    const videoTrack = stream.getVideoTracks()[0];
    const audioTracks = stream.getAudioTracks();
    
    // Validate video track
    if (!videoTrack) {
      throw new Error('No video track available');
    }
    
    // Validate and monitor audio tracks
    const audioEnabled = options.includeAudio && audioTracks.length > 0;
    if (!audioEnabled && options.includeAudio) {
      console.warn('No audio tracks found on the captured source (system audio likely not granted by picker/OS). Recording will be video-only.');
      chrome.runtime.sendMessage({
        action: 'recordingWarning',
        message: 'Recording without audio'
      }).catch(() => {});
    }

    if (audioEnabled) {
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

      // Only preview local audio for tab mode to avoid feedback loops with system audio
      if (captureMode === 'tab') {
        startLocalAudioPlayback(stream);
      }

      if (captureMode !== 'browser') {
        try {
          await Promise.all(audioTracks.map(track => track.applyConstraints({
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          })));
        } catch (error) {
          console.warn('Failed to adjust audio track constraints:', error);
        }
      }

      // Start sending visualizer data to the popup
      startAudioVisualizer(stream);
    } else {
      // Ensure visualizer is stopped when audio isn't active
      stopAudioVisualizer();
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
      // Ignore spurious errors after stopping
      if (!mediaRecorder || mediaRecorder.state !== 'recording') {
        console.warn('MediaRecorder error ignored (not recording):', error);
        return;
      }
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
    stopAudioVisualizer();
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
      stopAudioVisualizer();
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
      stopAudioVisualizer();
    };
    
    mediaRecorder.stop();
  });
}
