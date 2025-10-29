let timerInterval = null;
let startTime = 0;
let isRecording = false;
let isPaused = false;
let pauseStartTime = 0;
let pausedDuration = 0;
let countdownActive = false;

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const pauseBtn = document.getElementById('pauseBtn');
const tabSelect = document.getElementById('tabSelect');
const tabSelectGroup = document.getElementById('tabSelectGroup');
const fpsSelect = document.getElementById('fps');
const qualitySelect = document.getElementById('quality');
const audioCheckbox = document.getElementById('audio');
const statusDiv = document.getElementById('status');
const timerDiv = document.getElementById('timer');
const bufferSizeDiv = document.getElementById('bufferSize');
const captureModeRadios = document.querySelectorAll('input[name="captureMode"]');
const audioNoteDiv = document.getElementById('audioNote');
const vizCanvas = document.getElementById('audioViz');
const vizCtx = vizCanvas.getContext('2d');
const chunkCheckbox = document.getElementById('chunkEnabled');
const chunkOptions = document.getElementById('chunkOptions');
const chunkSizeInput = document.getElementById('chunkSize');
const chunkFolderInput = document.getElementById('chunkFolder');
const countdownOverlay = document.getElementById('countdownOverlay');
const countdownText = document.getElementById('countdownText');
const pauseIcon = pauseBtn.querySelector('.icon-pause');
const resumeIcon = pauseBtn.querySelector('.icon-resume');
const pauseBtnLabel = pauseBtn.querySelector('.btn-label');

startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
pauseBtn.addEventListener('click', togglePause);
qualitySelect.addEventListener('change', persistQualitySetting);

captureModeRadios.forEach(radio => {
  radio.addEventListener('change', (e) => {
    if (e.target.value === 'tab') {
      tabSelectGroup.style.display = 'block';
    } else {
      tabSelectGroup.style.display = 'none';
    }
  });
});

chunkCheckbox.addEventListener('change', () => {
  toggleChunkOptions(chunkCheckbox.checked);
  persistChunkSettings();
});

chunkSizeInput.addEventListener('change', () => {
  normalizeChunkSizeInput();
  persistChunkSettings();
});

chunkFolderInput.addEventListener('blur', () => {
  chunkFolderInput.value = sanitizeFolderValue(chunkFolderInput.value);
  persistChunkSettings();
});

async function loadTabs() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    tabSelect.innerHTML = '';
    
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    tabs.forEach(tab => {
      const option = document.createElement('option');
      option.value = tab.id;
      
      let title = tab.title || 'Untitled';
      if (title.length > 40) {
        title = title.substring(0, 37) + '...';
      }
      
      option.textContent = tab.id === currentTab.id ? `${title} (Current)` : title;
      
      if (tab.id === currentTab.id) {
        option.selected = true;
      }
      
      tabSelect.appendChild(option);
    });
  } catch (error) {
    console.error('Failed to load tabs:', error);
    tabSelect.innerHTML = '<option value="current">Current Tab</option>';
  }
}

async function checkRecordingStatus() {
  try {
    const stored = await chrome.storage.local.get(['isRecording', 'startTime', 'isPaused', 'pauseStart', 'pausedDuration']);

    if (stored.isRecording) {
      isRecording = true;
      startTime = typeof stored.startTime === 'number' && stored.startTime > 0 ? stored.startTime : Date.now();
      pausedDuration = typeof stored.pausedDuration === 'number' && stored.pausedDuration > 0 ? stored.pausedDuration : 0;
      const storedPauseStart = typeof stored.pauseStart === 'number' && stored.pauseStart > 0 ? stored.pauseStart : 0;
      isPaused = !!stored.isPaused;
      pauseStartTime = isPaused ? storedPauseStart || Date.now() : 0;

      setRecordingUI();
      updateTimer();
      if (timerInterval) {
        clearInterval(timerInterval);
      }
      if (!isPaused) {
        timerInterval = setInterval(updateTimer, 1000);
      }
    } else {
      isRecording = false;
      isPaused = false;
      pauseStartTime = 0;
      pausedDuration = 0;
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      setChunkControlsDisabled(false);
      updatePauseUI();
    }
  } catch (error) {
    console.error('Failed to check status:', error);
  }
}

initializeSettings();
loadTabs();
checkRecordingStatus();

async function startRecording() {
  if (isRecording || countdownActive) {
    return;
  }

  try {
    statusDiv.textContent = '';
    statusDiv.className = 'status';
    audioNoteDiv.textContent = '';
    hideVisualizer();

    await runCountdown(3);
    statusDiv.textContent = 'Initializing...';
    
    const fps = parseInt(fpsSelect.value, 10) || 30;
    const includeAudio = audioCheckbox.checked;
    const videoBitsPerSecond = parseVideoBitrate();
    const captureMode = document.querySelector('input[name="captureMode"]:checked').value;
    const chunkEnabled = chunkCheckbox.checked;
    const chunkSizeMB = normalizeChunkSizeInput();
    const chunkFolder = sanitizeFolderValue(chunkFolderInput.value);
    const chunkOptionsPayload = {
      enabled: chunkEnabled,
      sizeMB: chunkSizeMB,
      folder: chunkFolder
    };

    if (chunkFolderInput.value !== chunkFolder) {
      chunkFolderInput.value = chunkFolder;
    }
    const bitrateValue = String(videoBitsPerSecond);
    if (qualitySelect.value !== bitrateValue) {
      qualitySelect.value = bitrateValue;
    }

    let tabId = null;
    if (captureMode === 'tab') {
      const raw = tabSelect.value;
      const parsed = parseInt(raw, 10);
      if (Number.isNaN(parsed)) {
        // Fallback to active tab if dropdown value is not a number (e.g., 'current')
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id ?? null;
      } else {
        tabId = parsed;
      }
    }

    // Determine a targetTabId to anchor desktop picker in MV3
    let targetTabId = null;
    try {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      targetTabId = active?.id ?? null;
    } catch (_) {}

    let response;
    if (captureMode === 'browser') {
      // Ask background to run the desktop picker (service worker) with a target tab
      response = await chrome.runtime.sendMessage({
        action: 'startCapture',
        captureMode: captureMode,
        tabId: null,
        targetTabId: targetTabId,
        fps: fps,
        includeAudio: includeAudio,
        videoBitsPerSecond: videoBitsPerSecond,
        chunk: chunkOptionsPayload
      });
    } else {
      response = await chrome.runtime.sendMessage({
        action: 'startCapture',
        captureMode: captureMode,
        tabId: tabId,
        targetTabId: targetTabId,
        fps: fps,
        includeAudio: includeAudio,
        videoBitsPerSecond: videoBitsPerSecond,
        chunk: chunkOptionsPayload
      });
    }
    
    if (!response.success) {
      throw new Error(response.error || 'Failed to start recording');
    }
    
    isRecording = true;
    isPaused = false;
    startTime = Date.now();
    pauseStartTime = 0;
    pausedDuration = 0;

    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    
    await chrome.storage.local.set({
      isRecording: true,
      startTime: startTime,
      fps: fps,
      includeAudio: includeAudio,
      isPaused: false,
      pauseStart: null,
      pausedDuration: 0,
      videoBitsPerSecond: videoBitsPerSecond,
      chunkEnabled: chunkEnabled,
      chunkSizeMB: chunkSizeMB,
      chunkFolder: chunkFolder
    });
    
    setRecordingUI();
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
    
  } catch (error) {
    console.error('Recording error:', error);
    statusDiv.textContent = 'Error: ' + error.message;
    statusDiv.className = 'status error';
    resetUI();
  } finally {
    countdownActive = false;
    hideCountdownOverlay();
  }
}

function parseVideoBitrate() {
  const parsed = parseInt(qualitySelect.value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 2500000;
  }
  return parsed;
}

function persistQualitySetting() {
  chrome.storage.local.set({
    videoBitsPerSecond: parseVideoBitrate()
  }).catch(() => {});
}

function delay(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function runCountdown(seconds = 3) {
  const duration = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  if (duration <= 0) {
    hideCountdownOverlay();
    return;
  }

  countdownActive = true;
  startBtn.disabled = true;
  stopBtn.disabled = true;
  pauseBtn.disabled = true;
  countdownOverlay.hidden = false;

  // Allow CSS transition to apply after display change
  requestAnimationFrame(() => {
    countdownOverlay.classList.add('active');
  });

  for (let remaining = duration; remaining > 0; remaining -= 1) {
    countdownText.textContent = String(remaining);
    statusDiv.textContent = `Starting in ${remaining}...`;
    statusDiv.className = 'status';
    await delay(1000);
  }

  countdownOverlay.classList.remove('active');
  await delay(200);
  countdownOverlay.hidden = true;
  countdownActive = false;
}

function hideCountdownOverlay() {
  countdownOverlay.classList.remove('active');
  countdownOverlay.hidden = true;
}

async function togglePause() {
  if (!isRecording || countdownActive) {
    return;
  }

  pauseBtn.disabled = true;

  try {
    if (!isPaused) {
      const response = await chrome.runtime.sendMessage({ action: 'pauseCapture' });
      if (!response?.success) {
        throw new Error(response?.error || 'Failed to pause recording');
      }
      applyPauseState(Date.now());
    } else {
      const response = await chrome.runtime.sendMessage({ action: 'resumeCapture' });
      if (!response?.success) {
        throw new Error(response?.error || 'Failed to resume recording');
      }
      applyResumeState(Date.now());
    }
  } catch (error) {
    console.error('Pause toggle error:', error);
    statusDiv.textContent = 'Error: ' + error.message;
    statusDiv.className = 'status error';
  } finally {
    if (isRecording) {
      pauseBtn.disabled = false;
    }
  }
}

function applyPauseState(pauseTimestamp) {
  if (!isRecording || isPaused) {
    return;
  }

  isPaused = true;
  pauseStartTime = typeof pauseTimestamp === 'number' && pauseTimestamp > 0 ? pauseTimestamp : Date.now();

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  updateTimer();
  setRecordingUI();

  chrome.storage.local.set({
    isPaused: true,
    pauseStart: pauseStartTime,
    pausedDuration: pausedDuration
  }).catch(() => {});
}

function applyResumeState(resumeTimestamp) {
  if (!isRecording || !isPaused) {
    return;
  }

  const resumeTime = typeof resumeTimestamp === 'number' && resumeTimestamp > 0 ? resumeTimestamp : Date.now();
  if (pauseStartTime) {
    pausedDuration += Math.max(0, resumeTime - pauseStartTime);
  }

  isPaused = false;
  pauseStartTime = 0;

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  updateTimer();
  setRecordingUI();
  timerInterval = setInterval(updateTimer, 1000);

  chrome.storage.local.set({
    isPaused: false,
    pauseStart: null,
    pausedDuration: pausedDuration
  }).catch(() => {});
}

function updatePauseUI() {
  pauseBtn.disabled = !isRecording;
  pauseBtn.classList.toggle('resume', isPaused);
  if (pauseBtnLabel) {
    pauseBtnLabel.textContent = isPaused ? 'Resume' : 'Pause';
  }
  if (pauseIcon) {
    pauseIcon.hidden = isPaused;
  }
  if (resumeIcon) {
    resumeIcon.hidden = !isPaused;
  }
}

function setRecordingUI() {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  pauseBtn.disabled = false;
  tabSelect.disabled = true;
  fpsSelect.disabled = true;
  qualitySelect.disabled = true;
  audioCheckbox.disabled = true;
  captureModeRadios.forEach(radio => radio.disabled = true);
  setChunkControlsDisabled(true);
  
  if (isPaused) {
    statusDiv.textContent = '⏸ Paused';
    statusDiv.className = 'status paused';
    timerDiv.classList.remove('active');
  } else {
    statusDiv.textContent = '● Recording...';
    statusDiv.className = 'status recording';
    timerDiv.classList.add('active');
  }

  updatePauseUI();
}

async function stopRecording() {
  try {
    statusDiv.textContent = 'Processing...';
    statusDiv.className = 'status';
    stopBtn.disabled = true;
    pauseBtn.disabled = true;
    
    const response = await chrome.runtime.sendMessage({
      action: 'stopCapture'
    });
    
    if (!response.success) {
      throw new Error(response.error || 'Failed to stop recording');
    }
    
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    
    isRecording = false;
    isPaused = false;
    pauseStartTime = 0;
    pausedDuration = 0;
    await chrome.storage.local.set({
      isRecording: false,
      isPaused: false,
      pauseStart: null,
      pausedDuration: 0
    });
    
  } catch (error) {
    console.error('Stop recording error:', error);
    statusDiv.textContent = 'Error: ' + error.message;
    statusDiv.className = 'status error';
    resetUI();
  } finally {
    if (!isRecording) {
      stopBtn.disabled = true;
    }
  }
}

function updateTimer() {
  if (!startTime || startTime <= 0) {
    timerDiv.textContent = '00:00';
    return;
  }

  const reference = (isPaused && pauseStartTime) ? pauseStartTime : Date.now();
  const elapsedMs = Math.max(0, reference - startTime - pausedDuration);
  const elapsed = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const seconds = (elapsed % 60).toString().padStart(2, '0');
  timerDiv.textContent = `${minutes}:${seconds}`;
}

function resetUI() {
  isRecording = false;
  isPaused = false;
  startTime = 0;
  pauseStartTime = 0;
  pausedDuration = 0;
  countdownActive = false;

  startBtn.disabled = false;
  stopBtn.disabled = true;
  pauseBtn.disabled = true;
  tabSelect.disabled = false;
  fpsSelect.disabled = false;
  qualitySelect.disabled = false;
  audioCheckbox.disabled = false;
  captureModeRadios.forEach(radio => radio.disabled = false);
  setChunkControlsDisabled(false);
  timerDiv.textContent = '00:00';
  timerDiv.classList.remove('active');
  bufferSizeDiv.textContent = '';
  bufferSizeDiv.classList.remove('warning');
  audioNoteDiv.textContent = '';
  hideVisualizer();
  hideCountdownOverlay();
  updatePauseUI();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'bufferSizeUpdate') {
    bufferSizeDiv.textContent = `Buffer: ${message.formatted}`;
    
    if (message.warning) {
      bufferSizeDiv.classList.add('warning');
    } else {
      bufferSizeDiv.classList.remove('warning');
    }
  }
  
  if (message.action === 'recordingComplete') {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    
    isRecording = false;
    isPaused = false;
    pauseStartTime = 0;
    pausedDuration = 0;
    chrome.storage.local.set({
      isRecording: false,
      isPaused: false,
      pauseStart: null,
      pausedDuration: 0
    });
    
    resetUI();
    
    if (message.success) {
      if (message.chunked) {
        const chunkCount = Number(message.chunks) || 0;
        const chunkLabel = chunkCount === 1 ? 'chunk' : 'chunks';
        statusDiv.textContent = chunkCount > 0 ? `Saved ${chunkCount} ${chunkLabel}` : 'Recording saved!';
      } else {
        statusDiv.textContent = 'Recording saved!';
      }
      statusDiv.className = 'status success';
      setTimeout(() => {
        statusDiv.textContent = '';
        statusDiv.className = 'status';
      }, 3000);
    } else {
      statusDiv.textContent = 'Error: ' + (message.error || 'Failed to save recording');
      statusDiv.className = 'status error';
    }
  }
  
  if (message.action === 'recordingError') {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    
    isRecording = false;
    isPaused = false;
    pauseStartTime = 0;
    pausedDuration = 0;
    chrome.storage.local.set({
      isRecording: false,
      isPaused: false,
      pauseStart: null,
      pausedDuration: 0
    });
    
    resetUI();
    statusDiv.textContent = 'Error: ' + (message.error || 'Recording error');
    statusDiv.className = 'status error';
  }
  
  if (message.action === 'recordingStarted') {
    startTime = message.startTime || Date.now();
    pausedDuration = 0;
    pauseStartTime = 0;
    isPaused = false;
    chrome.storage.local.set({
      startTime: startTime,
      isPaused: false,
      pauseStart: null,
      pausedDuration: 0
    });
    if (!timerInterval) {
      timerInterval = setInterval(updateTimer, 1000);
    }
    setRecordingUI();
  }

  if (message.action === 'recordingPaused') {
    applyPauseState(typeof message.pauseTime === 'number' ? message.pauseTime : Date.now());
  }

  if (message.action === 'recordingResumed') {
    applyResumeState(typeof message.resumeTime === 'number' ? message.resumeTime : Date.now());
  }

  if (message.action === 'recordingWarning') {
    audioNoteDiv.textContent = message.message || 'Recording without audio';
  }

  if (message.action === 'audioData' && Array.isArray(message.bars)) {
    showVisualizer();
    drawBars(message.bars);
  }
});

function showVisualizer() {
  vizCanvas.hidden = false;
  // Clear once when shown
  vizCtx.clearRect(0, 0, vizCanvas.width, vizCanvas.height);
}

function hideVisualizer() {
  vizCanvas.hidden = true;
  vizCtx.clearRect(0, 0, vizCanvas.width, vizCanvas.height);
}

function drawBars(bars) {
  const w = vizCanvas.width;
  const h = vizCanvas.height;
  vizCtx.clearRect(0, 0, w, h);

  const count = bars.length;
  const gap = 2; // px between bars
  const barWidth = Math.max(1, Math.floor((w - (count - 1) * gap) / count));

  for (let i = 0; i < count; i++) {
    const mag = Math.max(0, Math.min(255, bars[i] | 0));
    const barHeight = Math.round((mag / 255) * (h - 2));
    const x = i * (barWidth + gap);
    const y = h - barHeight;

    // Color from quiet (light gray) to loud (dark)
    const shade = 110 + Math.round((mag / 255) * 100);
    vizCtx.fillStyle = `rgb(${shade}, ${shade}, ${shade})`;
    vizCtx.fillRect(x, y, barWidth, barHeight);
  }
}

async function initializeSettings() {
  try {
    const stored = await chrome.storage.local.get({
      chunkEnabled: false,
      chunkSizeMB: 100,
      chunkFolder: '',
      videoBitsPerSecond: 2500000
    });

    chunkCheckbox.checked = !!stored.chunkEnabled;
    chunkSizeInput.value = normalizeChunkSizeInput(stored.chunkSizeMB);
    chunkFolderInput.value = sanitizeFolderValue(stored.chunkFolder);
    toggleChunkOptions(chunkCheckbox.checked);

    const storedBitrate = Number(stored.videoBitsPerSecond) || 2500000;
    const bitrateOption = Array.from(qualitySelect.options).find(option => Number(option.value) === storedBitrate);
    qualitySelect.value = bitrateOption ? bitrateOption.value : '2500000';
  } catch (error) {
    console.error('Failed to load settings:', error);
    chunkCheckbox.checked = false;
    chunkSizeInput.value = 100;
    chunkFolderInput.value = '';
    toggleChunkOptions(false);
    qualitySelect.value = '2500000';
  }
}

function toggleChunkOptions(enabled) {
  chunkOptions.hidden = !enabled;
  setChunkControlsDisabled(chunkCheckbox.disabled);
}

function setChunkControlsDisabled(disabled) {
  chunkCheckbox.disabled = disabled;
  chunkSizeInput.disabled = disabled || !chunkCheckbox.checked;
  chunkFolderInput.disabled = disabled || !chunkCheckbox.checked;
}

function normalizeChunkSizeInput(value) {
  const raw = value !== undefined ? value : parseInt(chunkSizeInput.value, 10);
  const fallback = 100;
  let parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    parsed = fallback;
  }
  parsed = Math.min(Math.max(Math.round(parsed), 10), 2048);
  if (value === undefined) {
    chunkSizeInput.value = parsed;
  }
  return parsed;
}

function sanitizeFolderValue(raw) {
  if (!raw) {
    return '';
  }
  let value = String(raw).trim();
  value = value.replace(/\\/g, '/');
  value = value.replace(/\.+/g, '.');
  value = value.replace(/^\/+/, '').replace(/\/+$/, '');
  value = value.replace(/\.\//g, '').replace(/\/\./g, '/');
  value = value.split('/').map(segment => {
    const cleaned = segment.trim().replace(/[^a-zA-Z0-9 _.-]/g, '');
    return cleaned;
  }).filter(Boolean).join('/');
  return value;
}

function persistChunkSettings() {
  chrome.storage.local.set({
    chunkEnabled: chunkCheckbox.checked,
    chunkSizeMB: normalizeChunkSizeInput(),
    chunkFolder: sanitizeFolderValue(chunkFolderInput.value)
  });
}
