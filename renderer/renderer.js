/* global io */

// STUN helps peers discover their public address. For calls between people on
// different/strict networks (e.g. corporate NAT, mobile carriers) you will
// also want a TURN server here — see README "TURN server" section.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
  // { urls: 'turn:your-turn-server.example.com:3478', username: 'user', credential: 'pass' }
];

const joinScreen = document.getElementById('join-screen');
const callScreen = document.getElementById('call-screen');
const nameInput = document.getElementById('name-input');
const roomInput = document.getElementById('room-input');
const serverInput = document.getElementById('server-input');
const joinBtn = document.getElementById('join-btn');
const joinError = document.getElementById('join-error');
const roomLabel = document.getElementById('room-label');
const copyRoomBtn = document.getElementById('copy-room-btn');
const videoGrid = document.getElementById('video-grid');
const toggleMicBtn = document.getElementById('toggle-mic-btn');
const toggleCamBtn = document.getElementById('toggle-cam-btn');
const toggleChatBtn = document.getElementById('toggle-chat-btn');
const leaveBtn = document.getElementById('leave-btn');
const chatPanel = document.getElementById('chat-panel');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');

let socket = null;
let localStream = null;
let myName = '';
let roomName = '';
let micOn = true;
let camOn = true;

// peerId -> { pc: RTCPeerConnection, name, videoEl }
const peers = new Map();

function showError(msg) {
  joinError.textContent = msg;
}

joinBtn.addEventListener('click', joinRoom);

async function joinRoom() {
  const name = nameInput.value.trim() || 'Guest';
  const room = roomInput.value.trim();
  const serverUrl = serverInput.value.trim();

  if (!room) return showError('Enter a room code.');
  if (!serverUrl) return showError('Enter your signaling server URL.');

  showError('');
  myName = name;
  roomName = room;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch (err) {
    return showError('Could not access camera/microphone: ' + err.message);
  }

  socket = io(serverUrl, { transports: ['websocket', 'polling'] });

  socket.on('connect_error', (err) => {
    showError('Could not reach signaling server: ' + err.message);
  });

  socket.on('connect', () => {
    socket.emit('join-room', { room: roomName, name: myName });
    enterCallScreen();
  });

  socket.on('existing-peers', (existingPeers) => {
    existingPeers.forEach((p) => createPeerConnection(p.id, p.name, true));
  });

  socket.on('peer-joined', (p) => {
    createPeerConnection(p.id, p.name, false);
  });

  socket.on('signal', async ({ from, data }) => {
    const peer = peers.get(from);
    if (!peer) return;
    const pc = peer.pc;

    if (data.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: pc.localDescription });
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data));
      } catch (e) { /* ignore benign candidate errors */ }
    }
  });

  socket.on('peer-left', ({ id }) => {
    removePeer(id);
  });

  socket.on('media-state', ({ id, audio, video }) => {
    const peer = peers.get(id);
    if (!peer) return;
    const tile = document.getElementById('tile-' + id);
    if (!tile) return;
    const mutedIcon = tile.querySelector('.muted-icon');
    mutedIcon.textContent = !audio ? '🔇' : '';
  });

  socket.on('chat-message', ({ name, text, from }) => {
    appendChatMessage(from === socket.id ? 'You' : name, text);
  });
}

function enterCallScreen() {
  joinScreen.classList.add('hidden');
  callScreen.classList.remove('hidden');
  roomLabel.textContent = 'Room: ' + roomName;
  addLocalVideoTile();
}

function addLocalVideoTile() {
  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = 'tile-local';

  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true; // never hear yourself
  video.playsInline = true;
  video.srcObject = localStream;

  const nameTag = document.createElement('div');
  nameTag.className = 'name-tag';
  nameTag.textContent = myName + ' (You)';

  const mutedIcon = document.createElement('div');
  mutedIcon.className = 'muted-icon';

  tile.appendChild(video);
  tile.appendChild(nameTag);
  tile.appendChild(mutedIcon);
  videoGrid.appendChild(tile);
}

function createPeerConnection(peerId, peerName, isInitiator) {
  if (peers.has(peerId)) return;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { to: peerId, data: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    addRemoteVideoTile(peerId, peerName, event.streams[0]);
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      // Let peer-left (from server) drive cleanup; this is just a safety net.
    }
  };

  peers.set(peerId, { pc, name: peerName });

  if (isInitiator) {
    (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: peerId, data: pc.localDescription });
    })();
  }
}

function addRemoteVideoTile(peerId, peerName, stream) {
  if (document.getElementById('tile-' + peerId)) return;

  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = 'tile-' + peerId;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = stream;

  const nameTag = document.createElement('div');
  nameTag.className = 'name-tag';
  nameTag.textContent = peerName;

  const mutedIcon = document.createElement('div');
  mutedIcon.className = 'muted-icon';

  tile.appendChild(video);
  tile.appendChild(nameTag);
  tile.appendChild(mutedIcon);
  videoGrid.appendChild(tile);
}

function removePeer(peerId) {
  const peer = peers.get(peerId);
  if (peer) {
    peer.pc.close();
    peers.delete(peerId);
  }
  const tile = document.getElementById('tile-' + peerId);
  if (tile) tile.remove();
}

// --- Controls ---

toggleMicBtn.addEventListener('click', () => {
  micOn = !micOn;
  localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  toggleMicBtn.textContent = micOn ? 'Mute' : 'Unmute';
  toggleMicBtn.classList.toggle('active', !micOn);
  if (socket) socket.emit('media-state', { audio: micOn, video: camOn });
});

toggleCamBtn.addEventListener('click', () => {
  camOn = !camOn;
  localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
  toggleCamBtn.textContent = camOn ? 'Camera Off' : 'Camera On';
  toggleCamBtn.classList.toggle('active', !camOn);
  if (socket) socket.emit('media-state', { audio: micOn, video: camOn });
});

toggleChatBtn.addEventListener('click', () => {
  chatPanel.classList.toggle('hidden');
});

copyRoomBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(roomName);
  copyRoomBtn.textContent = 'Copied!';
  setTimeout(() => (copyRoomBtn.textContent = 'Copy Room Code'), 1500);
});

leaveBtn.addEventListener('click', () => {
  peers.forEach((peer, id) => removePeer(id));
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  if (socket) socket.disconnect();
  window.location.reload();
});

function appendChatMessage(who, text) {
  const el = document.createElement('div');
  el.className = 'msg';
  el.innerHTML = '<span class="who"></span><span class="text"></span>';
  el.querySelector('.who').textContent = who + ':';
  el.querySelector('.text').textContent = text;
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

chatSendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !socket) return;
  socket.emit('chat-message', { text });
  chatInput.value = '';
}
