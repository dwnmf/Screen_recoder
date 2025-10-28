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
    }
  } catch (error) {
    console.error('Failed to check status:', error);
  }
}

loadTabs();
checkRecordingStatus();

async function startRecording() {
  try {
    statusDiv.textContent = 'Initializing...';
    statusDiv.className = 'status';
    
    const fps = parseInt(fpsSelect.value);
    const includeAudio = audioCheckbox.checked;
    const captureMode = document.querySelector('input[name="captureMode"]:checked').value;
    const tabId = captureMode === 'tab' ? parseInt(tabSelect.value) : null;
    
    const response = await chrome.runtime.sendMessage({
      action: 'startCapture',
      captureMode: captureMode,
      tabId: tabId,
      fps: fps,
      includeAudio: includeAudio
    });
    
    if (!response.success) {
      throw new Error(response.error || 'Failed to start recording');
    }
    
    isRecording = true;
    startTime = Date.now();
    
    await chrome.storage.local.set({
      isRecording: true,
      startTime: startTime,
      fps: fps,
      includeAudio: includeAudio
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
  timerDiv.textContent = '00:00';
  timerDiv.classList.remove('active');
  bufferSizeDiv.textContent = '';
  bufferSizeDiv.classList.remove('warning');
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
      statusDiv.textContent = 'Recording saved!';
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
});
