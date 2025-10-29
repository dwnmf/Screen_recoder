let timerInterval = null;
let startTime = 0;
let isRecording = false;

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const tabSelect = document.getElementById('tabSelect');
const tabSelectGroup = document.getElementById('tabSelectGroup');
const fpsSelect = document.getElementById('fps');
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

startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);

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
    const { isRecording: recording, startTime: savedStartTime } = await chrome.storage.local.get(['isRecording', 'startTime']);
    
    if (recording) {
      isRecording = true;
      startTime = savedStartTime || Date.now();
      setRecordingUI();
      updateTimer();
      timerInterval = setInterval(updateTimer, 1000);
    } else {
      setChunkControlsDisabled(false);
    }
  } catch (error) {
    console.error('Failed to check status:', error);
  }
}

initializeSettings();
loadTabs();
checkRecordingStatus();

async function startRecording() {
  try {
    statusDiv.textContent = 'Initializing...';
    statusDiv.className = 'status';
    audioNoteDiv.textContent = '';
    hideVisualizer();
    
    const fps = parseInt(fpsSelect.value);
    const includeAudio = audioCheckbox.checked;
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
        chunk: chunkOptionsPayload
      });
    }
    
    if (!response.success) {
      throw new Error(response.error || 'Failed to start recording');
    }
    
    isRecording = true;
    startTime = Date.now();
    
    await chrome.storage.local.set({
      isRecording: true,
      startTime: startTime,
      fps: fps,
      includeAudio: includeAudio,
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
  }
}

function setRecordingUI() {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  tabSelect.disabled = true;
  fpsSelect.disabled = true;
  audioCheckbox.disabled = true;
  captureModeRadios.forEach(radio => radio.disabled = true);
  setChunkControlsDisabled(true);
  
  statusDiv.textContent = '● Recording...';
  statusDiv.className = 'status recording';
  timerDiv.classList.add('active');
}

async function stopRecording() {
  try {
    statusDiv.textContent = 'Processing...';
    statusDiv.className = 'status';
    
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
    await chrome.storage.local.set({ isRecording: false });
    
  } catch (error) {
    console.error('Stop recording error:', error);
    statusDiv.textContent = 'Error: ' + error.message;
    statusDiv.className = 'status error';
    resetUI();
  }
}

function updateTimer() {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const seconds = (elapsed % 60).toString().padStart(2, '0');
  timerDiv.textContent = `${minutes}:${seconds}`;
}

function resetUI() {
  startBtn.disabled = false;
  stopBtn.disabled = true;
  tabSelect.disabled = false;
  fpsSelect.disabled = false;
  audioCheckbox.disabled = false;
  captureModeRadios.forEach(radio => radio.disabled = false);
  setChunkControlsDisabled(false);
  timerDiv.textContent = '00:00';
  timerDiv.classList.remove('active');
  bufferSizeDiv.textContent = '';
  bufferSizeDiv.classList.remove('warning');
  audioNoteDiv.textContent = '';
  hideVisualizer();
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
    chrome.storage.local.set({ isRecording: false });
    
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
    chrome.storage.local.set({ isRecording: false });
    
    resetUI();
    statusDiv.textContent = 'Error: ' + (message.error || 'Recording error');
    statusDiv.className = 'status error';
  }
  
  if (message.action === 'recordingStarted') {
    startTime = message.startTime || Date.now();
    chrome.storage.local.set({ startTime: startTime });
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
      chunkFolder: ''
    });

    chunkCheckbox.checked = !!stored.chunkEnabled;
    chunkSizeInput.value = normalizeChunkSizeInput(stored.chunkSizeMB);
    chunkFolderInput.value = sanitizeFolderValue(stored.chunkFolder);
    toggleChunkOptions(chunkCheckbox.checked);
  } catch (error) {
    console.error('Failed to load settings:', error);
    chunkCheckbox.checked = false;
    chunkSizeInput.value = 100;
    chunkFolderInput.value = '';
    toggleChunkOptions(false);
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
