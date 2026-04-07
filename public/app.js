// app.js - ClassChitChat client
'use strict';

// ── DOM refs ──────────────────────────────────────────────────
const loginScreen   = document.getElementById('login-screen');
const chatScreen    = document.getElementById('chat-screen');
const usernameInput = document.getElementById('username-input');
const roomInput     = document.getElementById('room-input');
const joinBtn       = document.getElementById('join-btn');
const loginError    = document.getElementById('login-error');
const leaveBtn      = document.getElementById('leave-btn');
const headerRoom    = document.getElementById('header-room');
const signalDot     = document.getElementById('signal-dot');
const statusLabel   = document.getElementById('status-label');
const usersList     = document.getElementById('users-list');
const busyBanner    = document.getElementById('busy-banner');
const busyUsername  = document.getElementById('busy-username');
const messageLog    = document.getElementById('message-log');
const pttBtn        = document.getElementById('ptt-btn');
const pttStatus     = document.getElementById('ptt-status');

// ── State ─────────────────────────────────────────────────────
let ws              = null;
let mediaRecorder   = null;
let audioChunks     = [];
let myUsername      = '';
let myRoom          = '';
let isTransmitting  = false;
let channelBusy     = false;
let micStream       = null;
let currentSpeaker  = '';  // name of whoever is currently transmitting to us

// ── Login ─────────────────────────────────────────────────────
joinBtn.addEventListener('click', joinChannel);
usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinChannel(); });
roomInput.addEventListener('keydown',     (e) => { if (e.key === 'Enter') joinChannel(); });

function joinChannel() {
  const username = usernameInput.value.trim();
  const room     = roomInput.value.trim() || 'general';
  if (!username) {
    showLoginError('Please enter your name.');
    return;
  }
  myUsername = username;
  myRoom     = room;
  connectWS(username, room);
}

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.hidden = false;
}

// ── WebSocket ─────────────────────────────────────────────────
function connectWS(username, room) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    sendJSON({ type: 'join', username, room });
  };

  ws.onmessage = (evt) => {
    if (evt.data instanceof Blob) {
      handleIncomingAudio(evt.data);
    } else {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      handleServerMessage(msg);
    }
  };

  ws.onclose = () => {
    setStatus('Disconnected', '');
    addSystemMessage('Disconnected from server.');
    pttBtn.disabled = true;
  };

  ws.onerror = () => {
    showLoginError('Could not connect to server. Is it running?');
  };
}

function sendJSON(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── Server message handling ───────────────────────────────────
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'room_info':
      showChatScreen();
      updateUsers(msg.users);
      setStatus('Ready', 'ready');
      break;

    case 'user_joined':
      updateUsers(msg.users);
      addSystemMessage(`${msg.username} joined the channel.`);
      break;

    case 'user_left':
      updateUsers(msg.users);
      addSystemMessage(`${msg.username} left the channel.`);
      if (channelBusy) {
        channelBusy = false;
        busyBanner.hidden = true;
        pttBtn.disabled = false;
        setStatus('Ready', 'ready');
      }
      break;

    case 'transmit_start':
      currentSpeaker = msg.username;
      if (msg.username !== myUsername) {
        channelBusy = true;
        busyUsername.textContent = msg.username;
        busyBanner.hidden = false;
        pttBtn.disabled = true;
        setStatus(`${msg.username} transmitting`, 'live');
      }
      break;

    case 'transmit_end':
      if (msg.username !== myUsername) {
        channelBusy = false;
        busyBanner.hidden = true;
        pttBtn.disabled = false;
        setStatus('Ready', 'ready');
      }
      break;

    case 'channel_busy':
      pttStatus.textContent = `Channel busy — ${msg.username} is transmitting.`;
      setTimeout(() => { if (!isTransmitting) pttStatus.textContent = 'Ready'; }, 2500);
      break;

    default:
      break;
  }
}

// ── Incoming audio ────────────────────────────────────────────
async function handleIncomingAudio(blob) {
  const url   = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  try { await audio.play(); } catch { /* autoplay blocked — audio control shown in log */ }
  addAudioMessage(blob, false, currentSpeaker);
}

// ── Push-to-talk ──────────────────────────────────────────────
// Support both mouse and touch events
pttBtn.addEventListener('mousedown',   startTransmit);
pttBtn.addEventListener('touchstart',  startTransmit, { passive: false });
pttBtn.addEventListener('mouseup',     stopTransmit);
pttBtn.addEventListener('mouseleave',  stopTransmit);
pttBtn.addEventListener('touchend',    stopTransmit);
pttBtn.addEventListener('touchcancel', stopTransmit);

async function startTransmit(e) {
  e.preventDefault();
  if (isTransmitting || channelBusy) return;

  // Request microphone on first use; reuse existing stream afterwards
  if (!micStream) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      pttStatus.textContent = 'Microphone access denied.';
      return;
    }
  }

  sendJSON({ type: 'transmit_start' });

  audioChunks = [];
  const mimeType = getSupportedMime();
  mediaRecorder = new MediaRecorder(micStream, mimeType ? { mimeType } : undefined);

  mediaRecorder.ondataavailable = (evt) => {
    if (evt.data.size > 0) {
      audioChunks.push(evt.data);
      // Stream chunks in real-time for lower latency
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(evt.data);
      }
    }
  };

  mediaRecorder.start(200); // emit a chunk every 200 ms
  isTransmitting = true;
  pttBtn.classList.add('transmitting');
  pttStatus.textContent = '🔴 Transmitting…';
  setStatus('Transmitting', 'live');
}

function stopTransmit(e) {
  if (!isTransmitting) return;
  e.preventDefault();

  const recorder = mediaRecorder;
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
  }

  isTransmitting = false;
  pttBtn.classList.remove('transmitting');
  pttStatus.textContent = 'Ready';
  setStatus('Ready', 'ready');
  sendJSON({ type: 'transmit_end' });

  // Add playback entry for own transmission once recording stops
  recorder.onstop = () => {
    const mimeType = recorder.mimeType || 'audio/webm';
    const blob = new Blob(audioChunks, { type: mimeType });
    if (blob.size > 0) addAudioMessage(blob, true, myUsername);
    audioChunks = [];
  };
}

function getSupportedMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
  for (const t of types) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

// ── UI helpers ────────────────────────────────────────────────
function showChatScreen() {
  loginScreen.hidden = true;
  chatScreen.hidden  = false;
  headerRoom.textContent = `📻 ${myRoom}`;
  pttBtn.disabled = false;
  document.title = `ClassChitChat — ${myRoom}`;
}

function setStatus(label, dotClass) {
  statusLabel.textContent = label;
  signalDot.className = 'signal-dot' + (dotClass ? ` ${dotClass}` : '');
}

function updateUsers(users) {
  usersList.textContent = users.length ? users.join(', ') : '—';
}

function addSystemMessage(text) {
  const li = document.createElement('li');
  li.className = 'system';
  li.textContent = text;
  appendMessage(li);
}

function addAudioMessage(blob, isSelf, speaker) {
  const url = URL.createObjectURL(blob);
  const li  = document.createElement('li');
  li.className = isSelf ? 'self' : 'other';

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = `${isSelf ? 'You' : speaker}  •  ${timestamp()}`;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  const icon = document.createElement('span');
  icon.textContent = '🎙️';

  const audio = document.createElement('audio');
  audio.src = url;
  audio.controls = true;
  audio.onended = () => URL.revokeObjectURL(url);

  bubble.appendChild(icon);
  bubble.appendChild(audio);
  li.appendChild(meta);
  li.appendChild(bubble);
  appendMessage(li);
}

function appendMessage(li) {
  messageLog.appendChild(li);
  messageLog.scrollTop = messageLog.scrollHeight;
}

function timestamp() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Leave ─────────────────────────────────────────────────────
leaveBtn.addEventListener('click', () => {
  if (isTransmitting) stopTransmit({ preventDefault: () => {} });
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (ws) { ws.close(); ws = null; }
  chatScreen.hidden  = true;
  loginScreen.hidden = false;
  loginError.hidden  = true;
  messageLog.innerHTML = '';
  pttBtn.disabled = true;
  setStatus('Standby', '');
});
