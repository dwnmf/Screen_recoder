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
const MIN_CHUNK_SIZE_MB = 10;
const MAX_CHUNK_SIZE_MB = 2048;
const DEFAULT_CHUNK_SIZE_MB = 100;

let chunkConfig = createDefaultChunkConfig('');
let chunkBufferSize = 0;
let chunkFlushPromise = Promise.resolve();
let lastChunkError = null;
let recordingIdentifier = '';

function calculateBufferSize() {
  if (chunkConfig.enabled) {
    return chunkBufferSize;
  }
  return recordedChunks.reduce((total, chunk) => total + chunk.size, 0);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function createDefaultChunkConfig(recordingId = '') {
  const base = recordingId ? `recording_${recordingId}` : 'recording';
  return {
    enabled: false,
    sizeBytes: 0,
    folder: '',
    baseName: base,
    nextIndex: 1,
    requireSaveAs: true,
    savedChunks: 0
  };
}

function sanitizeFolderPath(raw) {
  if (!raw) {
    return '';
  }

  return String(raw)
    .replace(/\\/g, '/')
    .split('/')
    .map(part => part.trim())
    .filter(part => part && part !== '..')
    .map(part => part.replace(/\s+/g, ' ').replace(/[^a-zA-Z0-9 _.\-]/g, '_'))
    .join('/');
}

function createChunkConfig(rawOptions, recordingId) {
  const config = createDefaultChunkConfig(recordingId);
  if (!rawOptions || !rawOptions.enabled) {
    return config;
  }

  let sizeMB = parseInt(rawOptions.sizeMB, 10);
  if (!Number.isFinite(sizeMB)) {
    sizeMB = DEFAULT_CHUNK_SIZE_MB;
  }
  sizeMB = Math.min(Math.max(sizeMB, MIN_CHUNK_SIZE_MB), MAX_CHUNK_SIZE_MB);

  config.enabled = true;
  config.sizeBytes = sizeMB * 1024 * 1024;
  config.folder = sanitizeFolderPath(rawOptions.folder);
  config.requireSaveAs = false;
  return config;
}

function resetRecorderBuffers() {
  recordedChunks = [];
  chunkBufferSize = 0;
  chunkFlushPromise = Promise.resolve();
  lastChunkError = null;
}

function chunkArraySize(chunks) {
  return chunks.reduce((total, chunk) => total + (chunk?.size || 0), 0);
}

async function flushChunk(force = false) {
  if (!chunkConfig.enabled) {
    return;
  }

  if (!force && chunkBufferSize < chunkConfig.sizeBytes) {
    return;
  }

  if (!recordedChunks.length) {
    return;
  }

  const chunksToWrite = recordedChunks;
  recordedChunks = [];
  chunkBufferSize = 0;

  const blob = new Blob(chunksToWrite, { type: 'video/webm' });
  if (!blob.size) {
    recordedChunks = chunksToWrite.concat(recordedChunks);
    chunkBufferSize = chunkArraySize(recordedChunks);
    return;
  }

  const url = URL.createObjectURL(blob);
  const index = chunkConfig.nextIndex++;
  const suffix = String(index).padStart(3, '0');
  const folderPrefix = chunkConfig.folder ? `${chunkConfig.folder}/` : '';
  const filename = `${folderPrefix}${chunkConfig.baseName}_part${suffix}.webm`;

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'saveRecording',
      url,
      filename,
      saveAs: chunkConfig.requireSaveAs,
      conflictAction: 'uniquify'
    });

    if (!response || !response.success) {
      throw new Error(response?.error || 'Failed to save chunk');
    }

    chunkConfig.requireSaveAs = false;
    chunkConfig.savedChunks = index;
  } catch (error) {
    recordedChunks = chunksToWrite.concat(recordedChunks);
    chunkBufferSize = chunkArraySize(recordedChunks);
    throw error;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function queueChunkFlush(force = false) {
  chunkFlushPromise = chunkFlushPromise
    .then(() => flushChunk(force))
    .catch(error => {
      lastChunkError = error;
      console.error('Failed to save recording chunk:', error);
      chrome.runtime.sendMessage({
        action: 'recordingError',
        error: error?.message ? `Chunk save failed: ${error.message}` : 'Chunk save failed'
      }).catch(() => {});
    });
  return chunkFlushPromise;
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

    options = options || {};
    recordingIdentifier = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    chunkConfig = createChunkConfig(options.chunk, recordingIdentifier);
    resetRecorderBuffers();

    // Validate streamId: required for tab capture; for desktop capture the
    // offscreen document may request it via chooseDesktopMedia below.
    if (!streamId && captureMode !== 'browser') {
      throw new Error('Invalid stream ID: stream ID is required');
    }

    console.log('Starting recording with:', { streamId, captureMode, options });

    // For desktop capture, allow the offscreen document to invoke the picker
    // so that the resulting streamId is consumed in the same document.
    const mediaSource = captureMode === 'browser' ? 'desktop' : 'tab';

    async function ensureStreamId(currentStreamId, allowAudio) {
      if (captureMode !== 'browser' || currentStreamId) {
        return { streamId: currentStreamId, audioAllowed: allowAudio };
      }

      const wantAudio = !!allowAudio;
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

      if (wantAudio && !result.canRequestAudio) {
        chrome.runtime.sendMessage({ action: 'recordingWarning', message: 'Recording without audio' }).catch(() => {});
        options.includeAudio = false;
        return { streamId: result.chosenStreamId, audioAllowed: false };
      }

      return { streamId: result.chosenStreamId, audioAllowed: allowAudio };
    }

    function buildConstraints({ legacy, includeAudio, streamIdentifier }) {
      const c = {};
      // Video
      if (legacy) {
        c.video = { mandatory: { chromeMediaSource: mediaSource, chromeMediaSourceId: streamIdentifier } };
      } else {
        c.video = { chromeMediaSource: mediaSource, chromeMediaSourceId: streamIdentifier };
      }
      // Audio (omit property entirely if not requested)
      if (includeAudio) {
        if (legacy) {
          c.audio = {
            mandatory: {
              chromeMediaSource: mediaSource,
              chromeMediaSourceId: streamIdentifier
            }
          };
        } else {
          c.audio = {
            chromeMediaSource: mediaSource,
            chromeMediaSourceId: streamIdentifier
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
    const constraintsToTryBase = captureMode === 'browser'
      ? [
          (streamIdentifier, includeAudio) => buildConstraints({ legacy: true, includeAudio, streamIdentifier }),
          (streamIdentifier, includeAudio) => buildConstraints({ legacy: false, includeAudio, streamIdentifier })
        ]
      : [
          (streamIdentifier, includeAudio) => buildConstraints({ legacy: false, includeAudio, streamIdentifier }),
          (streamIdentifier, includeAudio) => buildConstraints({ legacy: true, includeAudio, streamIdentifier })
        ];

    let lastError = null;
    let tryWithoutAudio = false;
    let streamIdToUse = streamId;
    let audioAllowed = !!options.includeAudio;
    let retriedWithFreshStreamId = false;

    while (!stream) {
      const ensured = await ensureStreamId(streamIdToUse, audioAllowed);
      streamIdToUse = ensured.streamId;
      audioAllowed = ensured.audioAllowed;

      const constraintsToTry = constraintsToTryBase.map(fn => fn(streamIdToUse, audioAllowed));

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
          if (audioAllowed && (isNotFound || isAbortInvalidState) && !tryWithoutAudio) {
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
              audioAllowed = false;
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

      if (stream) {
        break;
      }

      const triedKeys = constraintsToTry.map(c => Object.keys(c).join('+')).join(' | ');
      const isStreamInvalid = lastError && (lastError.name === 'NotFoundError' || /Requested device not found/i.test(lastError.message || ''));

      if (captureMode === 'browser' && isStreamInvalid && !retriedWithFreshStreamId) {
        console.warn('Stream ID appears invalid, requesting a new selection and retrying capture.');
        retriedWithFreshStreamId = true;
        streamIdToUse = null;
        tryWithoutAudio = false;
        continue;
      }

      const errorMsg = lastError ? `${lastError.name}: ${lastError.message} (mode=${captureMode}, tried=${triedKeys})` : 'Failed to acquire capture stream';
      console.error('All getUserMedia attempts failed:', errorMsg);
      throw new Error(errorMsg);
    }

    streamId = streamIdToUse;

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
    chunkBufferSize = 0;
    mediaRecorder = new MediaRecorder(stream, recorderOptions);
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
        if (chunkConfig.enabled) {
          chunkBufferSize += event.data.size;
          if (chunkBufferSize >= chunkConfig.sizeBytes) {
            queueChunkFlush(false);
          }
        }
      }
    };
    
    mediaRecorder.onstop = async () => {
      try {
        await finalizeRecording();
      } catch (error) {
        console.error('Finalize recording error:', error);
      }
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
    recordedChunks = [];
    chunkBufferSize = 0;
    chunkFlushPromise = Promise.resolve();
    lastChunkError = null;
    chunkConfig = createDefaultChunkConfig('');
    recordingIdentifier = '';
    mediaRecorder = null;
    throw error;
  }
}

async function finalizeRecording() {
  stopBufferMonitoring();
  stopLocalAudioPlayback();
  stopAudioVisualizer();

  try {
    if (chunkConfig.enabled) {
      if (recordedChunks.length > 0) {
        await queueChunkFlush(true);
      }
      await chunkFlushPromise;
      if (lastChunkError) {
        throw lastChunkError;
      }
      chrome.runtime.sendMessage({
        action: 'recordingComplete',
        success: true,
        chunked: true,
        chunks: chunkConfig.savedChunks,
        baseName: chunkConfig.baseName
      }).catch(() => {});
    } else {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      if (!blob.size) {
        chrome.runtime.sendMessage({
          action: 'recordingComplete',
          success: true,
          chunked: false,
          empty: true
        }).catch(() => {});
      } else {
        const url = URL.createObjectURL(blob);
        const filenameBase = recordingIdentifier || new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const filename = `recording_${filenameBase}.webm`;
        try {
          const response = await chrome.runtime.sendMessage({
            action: 'saveRecording',
            url,
            filename,
            saveAs: true,
            conflictAction: 'uniquify'
          });
          if (!response || !response.success) {
            throw new Error(response?.error || 'Failed to save recording');
          }
          chrome.runtime.sendMessage({
            action: 'recordingComplete',
            success: true
          }).catch(() => {});
        } finally {
          URL.revokeObjectURL(url);
        }
      }
    }
  } catch (error) {
    chrome.runtime.sendMessage({
      action: 'recordingComplete',
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }).catch(() => {});
    throw error;
  } finally {
    recordedChunks = [];
    chunkBufferSize = 0;
    chunkFlushPromise = Promise.resolve();
    lastChunkError = null;
    chunkConfig = createDefaultChunkConfig('');
    recordingIdentifier = '';
    currentBufferSize = 0;
    startTime = 0;
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }
    mediaRecorder = null;
    stopLocalAudioPlayback();
    stopAudioVisualizer();
  }
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    stopBufferMonitoring();
    stopLocalAudioPlayback();
    stopAudioVisualizer();
    return;
  }

  stopBufferMonitoring();

  return new Promise((resolve, reject) => {
    mediaRecorder.onstop = async () => {
      try {
        await finalizeRecording();
        resolve();
      } catch (error) {
        reject(error);
      }
    };

    try {
      mediaRecorder.stop();
    } catch (error) {
      reject(error);
    }
  });
}
