/* Call engine: media, WebRTC peer connections, video stage, in-call chat. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const U = window.U;

  const el = {
    screen: $('call-screen'),
    stage: $('stage'),
    title: $('call-title'),
    timer: $('call-timer'),
    mirror: $('c-mirror'),
    add: $('c-add'),
    mic: $('c-mic'),
    cam: $('c-cam'),
    flip: $('c-flip'),
    chat: $('c-chat'),
    leave: $('c-leave'),
    dot: $('chat-dot'),
    panel: $('call-chat'),
    msgs: $('call-chat-msgs'),
    input: $('call-chat-input'),
    attach: $('call-chat-attach'),
    file: $('call-chat-file'),
    send: $('call-chat-send'),
    close: $('call-chat-close')
  };

  const C = {
    socket: null,
    me: null,
    ice: [],
    getUser: null,
    onAddPeople: null,
    onEnded: null,
    active: false,
    callId: null,
    localAudio: null,
    localVideo: null,
    localStream: null,
    facing: 'user',
    micOn: true,
    camOn: false,
    peers: new Map(), // socketId -> peer
    tiles: new Map(), // 'local' | socketId -> tile
    pinned: null,
    connectedAt: 0,
    ticker: null,
    unread: 0,
    mirror: false,
    observer: null,
    wakeLock: null,
    needGesture: false,
    lastCount: 0
  };
  try { C.mirror = localStorage.getItem('ca.mirror') === '1'; } catch (e) { /* ignore */ }

  /* ================= media ================= */
  function gum(constraints) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const e = new Error('insecure');
      e.name = 'InsecureContext';
      return Promise.reject(e);
    }
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  function mediaErrorText(e) {
    switch (e && e.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Camera or microphone access is blocked. Allow it in your browser settings and try again.';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'No camera or microphone was found.';
      case 'NotReadableError':
        return 'Your camera or microphone is being used by another app.';
      case 'InsecureContext':
        return 'Calls need a secure (https) connection.';
      default:
        return 'Could not access your camera or microphone.';
    }
  }

  function videoConstraints(facing, exact) {
    return {
      facingMode: exact ? { exact: facing } : { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 }
    };
  }

  function watchVideoTrack(track) {
    // If the OS/browser ends the camera on its own, reflect that in the UI.
    track.onended = () => {
      if (C.localVideo !== track) return;
      C.localVideo = null;
      C.camOn = false;
      syncVideoSenders();
      rebuildLocalStream();
      updateControls();
      sendMediaState();
    };
  }

  async function acquireMedia(wantVideo) {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    let stream;
    try {
      stream = await gum({ audio, video: wantVideo ? videoConstraints(C.facing, false) : false });
    } catch (e) {
      if (!wantVideo) throw e;
      stream = await gum({ audio }); // throws if the microphone is the problem
      C.toast('Camera unavailable. Continuing with audio only.');
    }
    C.localAudio = stream.getAudioTracks()[0] || null;
    C.localVideo = stream.getVideoTracks()[0] || null;
    if (C.localVideo) watchVideoTrack(C.localVideo);
    C.micOn = true;
    C.camOn = !!C.localVideo;
    rebuildLocalStream();
  }

  function rebuildLocalStream() {
    C.localStream = new MediaStream([C.localAudio, C.localVideo].filter(Boolean));
    const t = C.tiles.get('local');
    if (t) {
      t.video.srcObject = C.localStream;
      playVideo(t.video);
    }
    updateTileState('local');
  }

  async function refreshFlipButton() {
    let show = false;
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      show = devs.filter((d) => d.kind === 'videoinput').length > 1;
    } catch (e) { /* ignore */ }
    el.flip.hidden = !show;
  }

  async function setCamera(on) {
    if (on) {
      try {
        const s = await gum({ video: videoConstraints(C.facing, false) });
        C.localVideo = s.getVideoTracks()[0];
        watchVideoTrack(C.localVideo);
        C.camOn = true;
      } catch (e) {
        C.toast(mediaErrorText(e));
        return;
      }
    } else {
      if (C.localVideo) C.localVideo.stop(); // turns the camera light off too
      C.localVideo = null;
      C.camOn = false;
    }
    await syncVideoSenders();
    rebuildLocalStream();
    updateControls();
    sendMediaState();
    refreshFlipButton();
  }

  async function flipCamera() {
    if (!C.localVideo) { C.toast('Turn your camera on first.'); return; }
    const prev = C.facing;
    const next = prev === 'user' ? 'environment' : 'user';
    C.localVideo.onended = null;
    C.localVideo.stop(); // phones usually need the old camera released first
    let track = null;
    try {
      track = (await gum({ video: videoConstraints(next, true) })).getVideoTracks()[0];
      C.facing = next;
    } catch (e1) {
      try {
        track = (await gum({ video: videoConstraints(next, false) })).getVideoTracks()[0];
        C.facing = next;
      } catch (e2) {
        C.toast('Could not switch cameras.');
        try { track = (await gum({ video: videoConstraints(prev, false) })).getVideoTracks()[0]; } catch (e3) { track = null; }
      }
    }
    C.localVideo = track;
    C.camOn = !!track;
    if (track) watchVideoTrack(track);
    await syncVideoSenders();
    rebuildLocalStream();
    updateControls();
    sendMediaState();
  }

  function toggleMic() {
    if (!C.localAudio) return;
    C.micOn = !C.micOn;
    C.localAudio.enabled = C.micOn;
    updateControls();
    updateTileState('local');
    sendMediaState();
  }

  async function syncVideoSenders() {
    for (const p of C.peers.values()) {
      try { await p.vSender.replaceTrack(C.localVideo); } catch (e) { console.warn('replaceTrack failed', e); }
    }
    tuneBitrate();
  }

  // Mesh calls send a copy of your video to every person, so shrink each copy as the group grows.
  function tuneBitrate() {
    const n = C.peers.size;
    const max = n >= 5 ? 250000 : n >= 3 ? 450000 : n === 2 ? 800000 : 1500000;
    for (const p of C.peers.values()) {
      const s = p.vSender;
      if (!s || !s.getParameters || !s.track) continue;
      try {
        const params = s.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = max;
        s.setParameters(params).catch(() => {});
      } catch (e) { /* not supported */ }
    }
  }

  function sendMediaState() {
    if (C.socket && C.active) C.socket.emit('media-state', { audio: C.micOn, video: !!C.localVideo && C.camOn });
  }

  /* ================= tiles & layout ================= */
  function playVideo(v) {
    const p = v.play();
    if (p && p.catch) p.catch(() => requestGesture());
  }
  function requestGesture() {
    if (C.needGesture) return;
    C.needGesture = true;
    C.toast('Tap the screen to turn on sound.');
    const h = () => {
      C.tiles.forEach((t) => t.video.play().catch(() => {}));
      document.removeEventListener('pointerdown', h);
      C.needGesture = false;
    };
    document.addEventListener('pointerdown', h);
  }

  function makeTile(id, name, local) {
    const root = document.createElement('div');
    root.className = 'tile nofx' + (local ? ' local' : '');
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    if (local) video.muted = true; // never hear yourself

    const ph = document.createElement('div');
    ph.className = 'ph';
    ph.appendChild(U.avatar(name.replace(/ \(You\)$/, '')));

    const tag = document.createElement('div');
    tag.className = 'tag';
    const nm = document.createElement('span');
    nm.className = 'tag-name';
    nm.textContent = name;
    const mic = document.createElement('span');
    mic.className = 'tag-mic';
    U.setIcon(mic, 'mic-off', 14);
    mic.hidden = true;
    tag.appendChild(nm);
    tag.appendChild(mic);

    root.appendChild(video);
    root.appendChild(ph);
    root.appendChild(tag);
    root.addEventListener('click', () => onTileClick(id));
    el.stage.appendChild(root);

    const tile = { id, root, video, mic };
    C.tiles.set(id, tile);
    // Skip the slide animation on first placement.
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('nofx')));
    return tile;
  }

  function updateTileState(id) {
    const t = C.tiles.get(id);
    if (!t) return;
    let videoOn;
    let micOn;
    if (id === 'local') {
      videoOn = !!C.localVideo && C.camOn;
      micOn = C.micOn;
      t.root.classList.toggle('mirror', C.mirror && C.facing === 'user');
    } else {
      const p = C.peers.get(id);
      videoOn = !!p && p.video;
      micOn = !p || p.audio;
    }
    t.root.classList.toggle('no-video', !videoOn);
    t.mic.hidden = micOn;
  }

  function stageIds() {
    return [...C.peers.keys(), 'local']; // you last, so others come first in the grid
  }

  function applyLayout() {
    if (!C.active) return;
    const W = el.stage.clientWidth;
    const H = el.stage.clientHeight;
    const ids = stageIds().filter((id) => C.tiles.has(id));
    // A swap made in a 1:1 call must not leak into a group layout (and vice versa).
    if ((ids.length >= 3) !== (C.lastCount >= 3)) C.pinned = null;
    C.lastCount = ids.length;
    if (C.pinned && ids.indexOf(C.pinned) < 0) C.pinned = null;
    const L = window.Layout.computeLayout({ W, H, ids, pinned: C.pinned, selfId: 'local', gap: 8 });
    ids.forEach((id) => {
      const r = L[id];
      const t = C.tiles.get(id);
      if (!r || !t) return;
      const s = t.root.style;
      s.left = r.x + 'px';
      s.top = r.y + 'px';
      s.width = r.w + 'px';
      s.height = r.h + 'px';
      s.zIndex = r.z;
      t.root.dataset.kind = r.kind;
    });
  }

  function onTileClick(id) {
    const ids = stageIds().filter((i) => C.tiles.has(i));
    if (ids.length < 2) return;
    if (ids.length === 2) {
      // Picture-in-picture: tapping the small tile swaps it with the big one.
      const main = ids.indexOf(C.pinned) >= 0 ? C.pinned : ids.find((i) => i !== 'local');
      if (id !== main) C.pinned = id;
    } else {
      C.pinned = C.pinned === id ? null : id; // tap again to go back to the grid
    }
    applyLayout();
  }

  /* ================= peers ================= */
  function sendSignal(to, data) {
    C.socket.emit('signal', { to, data });
  }

  function addPeer(socketId, info, initiator) {
    if (C.peers.has(socketId)) return C.peers.get(socketId);
    const pc = new RTCPeerConnection({ iceServers: C.ice });
    const peer = {
      socketId,
      userId: info.userId,
      name: info.displayName || 'Guest',
      pc,
      initiator,
      stream: new MediaStream(),
      pending: [],
      audio: info.audio !== false,
      video: !!info.video,
      vSender: null,
      restarting: false
    };
    C.peers.set(socketId, peer);
    const tile = makeTile(socketId, peer.name, false);
    tile.video.srcObject = peer.stream;
    updateTileState(socketId);

    if (C.localAudio) pc.addTrack(C.localAudio, C.localStream);
    else pc.addTransceiver('audio', { direction: 'recvonly' });
    if (C.localVideo) peer.vSender = pc.addTrack(C.localVideo, C.localStream);
    else peer.vSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;

    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal(socketId, e.candidate.toJSON());
    };
    pc.ontrack = (e) => {
      const tracks = peer.stream.getTracks();
      if (tracks.indexOf(e.track) < 0) tracks.push(e.track);
      peer.stream = new MediaStream(tracks); // fresh object so every browser re-attaches it
      tile.video.srcObject = peer.stream;
      playVideo(tile.video);
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') markConnected();
      if (s === 'failed' && peer.initiator && !peer.restarting) restartIce(peer);
    };

    if (initiator) sendOffer(peer, undefined);
    tuneBitrate();
    refreshTitle();
    applyLayout();
    return peer;
  }

  async function sendOffer(peer, opts) {
    try {
      const offer = await peer.pc.createOffer(opts);
      await peer.pc.setLocalDescription(offer);
      sendSignal(peer.socketId, { type: offer.type, sdp: offer.sdp });
    } catch (e) {
      console.warn('offer failed', e);
    }
  }

  async function restartIce(peer) {
    peer.restarting = true;
    await sendOffer(peer, { iceRestart: true });
    setTimeout(() => { peer.restarting = false; }, 10000);
  }

  async function flushPending(peer) {
    const list = peer.pending.splice(0);
    for (const c of list) {
      try { await peer.pc.addIceCandidate(c); } catch (e) { /* stale candidate */ }
    }
  }

  async function onSignal(msg) {
    if (!C.active || !msg || !msg.data) return;
    let peer = C.peers.get(msg.from);
    const data = msg.data;
    if (!peer) {
      if (data.type !== 'offer') return;
      peer = addPeer(msg.from, { userId: null, displayName: 'Guest', audio: true, video: true }, false);
    }
    const pc = peer.pc;
    try {
      if (data.type === 'offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        await flushPending(peer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(msg.from, { type: answer.type, sdp: answer.sdp });
      } else if (data.type === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        await flushPending(peer);
      } else if (data.candidate) {
        if (pc.remoteDescription && pc.remoteDescription.type) await pc.addIceCandidate(data).catch(() => {});
        else peer.pending.push(data);
      }
    } catch (e) {
      console.warn('signal error', e);
    }
  }

  function removePeer(socketId) {
    const peer = C.peers.get(socketId);
    if (!peer) return;
    try { peer.pc.close(); } catch (e) { /* ignore */ }
    C.peers.delete(socketId);
    const t = C.tiles.get(socketId);
    if (t) {
      t.video.srcObject = null;
      t.root.remove();
      C.tiles.delete(socketId);
    }
    if (C.pinned === socketId) C.pinned = null;
    tuneBitrate();
    refreshTitle();
    applyLayout();
  }

  /* ================= call UI ================= */
  function refreshTitle() {
    const names = [...C.peers.values()].map((p) => p.name);
    el.title.textContent = names.length ? names.join(', ') : 'Calling\u2026';
    el.add.hidden = false;
  }

  function markConnected() {
    if (C.connectedAt) return;
    C.connectedAt = Date.now();
    const tick = () => { el.timer.textContent = U.fmtDuration(Math.floor((Date.now() - C.connectedAt) / 1000)); };
    tick();
    C.ticker = setInterval(tick, 1000);
  }

  function updateControls() {
    U.setIcon(el.mic, C.micOn ? 'mic' : 'mic-off');
    el.mic.classList.toggle('off', !C.micOn);
    el.mic.setAttribute('aria-label', C.micOn ? 'Mute microphone' : 'Unmute microphone');
    const camOn = !!C.localVideo && C.camOn;
    U.setIcon(el.cam, camOn ? 'video' : 'video-off');
    el.cam.classList.toggle('off', !camOn);
    el.cam.setAttribute('aria-label', camOn ? 'Turn camera off' : 'Turn camera on');
    el.mirror.classList.toggle('on', C.mirror);
    el.mirror.setAttribute('aria-pressed', C.mirror ? 'true' : 'false');
  }

  async function keepAwake() {
    try {
      if (navigator.wakeLock && !C.wakeLock) {
        C.wakeLock = await navigator.wakeLock.request('screen');
        C.wakeLock.addEventListener('release', () => { C.wakeLock = null; });
      }
    } catch (e) { /* not available */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (C.active && document.visibilityState === 'visible') keepAwake();
  });

  function showUI() {
    C.active = true;
    C.pinned = null;
    C.lastCount = 0;
    C.unread = 0;
    C.connectedAt = 0;
    el.timer.textContent = '';
    el.dot.hidden = true;
    el.screen.classList.remove('hidden');
    document.body.classList.add('in-call');
    makeTile('local', C.me.displayName + ' (You)', true).video.srcObject = C.localStream;
    playVideo(C.tiles.get('local').video);
    updateTileState('local');
    updateControls();
    refreshFlipButton();
    refreshTitle();
    if (!C.observer) {
      C.observer = new ResizeObserver(() => applyLayout());
      C.observer.observe(el.stage);
    }
    applyLayout();
    keepAwake();
  }

  function teardown() {
    const wasActive = C.active;
    C.active = false;
    C.callId = null;
    C.peers.forEach((p) => { try { p.pc.close(); } catch (e) { /* ignore */ } });
    C.peers.clear();
    C.tiles.forEach((t) => { t.video.srcObject = null; t.root.remove(); });
    C.tiles.clear();
    [C.localAudio, C.localVideo].forEach((t) => { if (t) { t.onended = null; t.stop(); } });
    C.localAudio = C.localVideo = C.localStream = null;
    clearInterval(C.ticker);
    C.ticker = null;
    C.connectedAt = 0;
    if (C.observer) { C.observer.disconnect(); C.observer = null; }
    if (C.wakeLock) { C.wakeLock.release().catch(() => {}); C.wakeLock = null; }
    C.pinned = null;
    C.facing = 'user';
    C.unread = 0;
    el.dot.hidden = true;
    el.panel.classList.add('hidden');
    el.msgs.innerHTML = '';
    el.screen.classList.add('hidden');
    document.body.classList.remove('in-call');
    if (wasActive && C.onEnded) C.onEnded();
  }

  /* ================= in-call chat ================= */
  function onCallChat(m) {
    if (!C.active) return;
    const mine = m.socketId === C.socket.id;
    el.msgs.appendChild(U.bubble({ mine, name: m.name, text: m.text, image: m.image, ts: m.ts }));
    el.msgs.scrollTop = el.msgs.scrollHeight;
    if (!mine && el.panel.classList.contains('hidden')) {
      C.unread++;
      el.dot.hidden = false;
      U.Ring.ding();
    }
  }
  function sendCallChat(image) {
    const text = el.input.value.trim();
    if (!text && !image) return;
    C.socket.emit('call-chat', { text, image: image || null });
    el.input.value = '';
  }

  /* ================= public actions ================= */
  function nameOf(id) {
    const u = C.getUser && C.getUser(id);
    return u ? u.displayName : 'Someone';
  }
  function reportInvite(res) {
    if (!res) return;
    const list = (ids) => ids.map(nameOf).join(', ');
    const are = (ids) => (ids.length > 1 ? ' are ' : ' is ');
    if (res.offline && res.offline.length) C.toast(list(res.offline) + are(res.offline) + 'offline.');
    if (res.busy && res.busy.length) C.toast(list(res.busy) + are(res.busy) + 'on another call.');
    if (res.full && res.full.length) C.toast('The call is full.');
  }

  async function startOutgoing(userIds, video) {
    if (C.active) return C.toast('You are already in a call.');
    if (!C.socket || !C.socket.connected) return C.toast('Not connected yet. Try again in a moment.');
    try { await acquireMedia(video); } catch (e) { return C.toast(mediaErrorText(e)); }
    showUI();
    C.socket.emit('call-start', { toUserIds: userIds, video: !!C.localVideo }, (res) => {
      if (!res || res.error) {
        if (res && res.error === 'unavailable') reportInvite(res);
        else C.toast((res && res.error) || 'Could not start the call.');
        teardown();
        return;
      }
      C.callId = res.callId;
      reportInvite(res);
    });
  }

  async function acceptIncoming(callId, wantVideo) {
    if (C.active) {
      C.socket.emit('call-decline', { callId });
      return C.toast('You are already in a call.');
    }
    try { await acquireMedia(wantVideo); } catch (e) {
      C.toast(mediaErrorText(e));
      C.socket.emit('call-decline', { callId });
      return;
    }
    showUI();
    C.socket.emit('call-accept', { callId, video: !!C.localVideo }, (res) => {
      if (!res || res.error) {
        C.toast((res && res.error) || 'Could not join the call.');
        teardown();
        return;
      }
      C.callId = res.callId;
      res.peers.forEach((p) => addPeer(p.socketId, p, true));
      refreshTitle();
    });
  }

  function leave() {
    if (C.socket && C.active) C.socket.emit('call-leave');
    teardown();
  }

  function invite(userIds) {
    if (!C.active || !userIds.length) return;
    C.socket.emit('call-invite', { toUserIds: userIds }, (res) => {
      if (res && res.error) C.toast(res.error);
      else reportInvite(res);
    });
  }

  function participantUserIds() {
    const ids = [C.me.id];
    C.peers.forEach((p) => { if (p.userId) ids.push(p.userId); });
    return ids;
  }

  function bind(socket, opts) {
    C.socket = socket;
    C.me = opts.me;
    C.ice = opts.ice;
    C.getUser = opts.getUser;
    C.onAddPeople = opts.onAddPeople;
    C.onEnded = opts.onEnded || null;

    socket.on('peer-joined', (p) => {
      if (!C.active || C.peers.has(p.socketId)) return;
      addPeer(p.socketId, p, false);
    });
    socket.on('peer-left', (p) => removePeer(p.socketId));
    socket.on('signal', onSignal);
    socket.on('media-state', (p) => {
      const peer = C.peers.get(p.socketId);
      if (!peer) return;
      peer.audio = !!p.audio;
      peer.video = !!p.video;
      updateTileState(p.socketId);
    });
    socket.on('call-declined', (p) => C.toast(nameOf(p.userId) + ' declined the call.'));
    socket.on('call-no-answer', (p) => C.toast(nameOf(p.userId) + " didn't answer."));
    socket.on('call-ended', (p) => {
      if (!C.active) return;
      teardown();
      if (p && p.reason === 'left') C.toast('Call ended.');
    });
    socket.on('call-chat', onCallChat);
    socket.on('disconnect', () => {
      if (!C.active) return;
      teardown();
      C.toast('Connection lost. The call ended.');
    });
  }

  /* ================= button wiring ================= */
  el.mic.addEventListener('click', toggleMic);
  el.cam.addEventListener('click', () => setCamera(!(C.localVideo && C.camOn)));
  el.flip.addEventListener('click', flipCamera);
  el.leave.addEventListener('click', leave);
  el.add.addEventListener('click', () => { if (C.onAddPeople) C.onAddPeople(); });
  el.mirror.addEventListener('click', () => {
    C.mirror = !C.mirror;
    try { localStorage.setItem('ca.mirror', C.mirror ? '1' : '0'); } catch (e) { /* ignore */ }
    updateControls();
    updateTileState('local');
  });
  el.chat.addEventListener('click', () => {
    el.panel.classList.toggle('hidden');
    if (!el.panel.classList.contains('hidden')) {
      C.unread = 0;
      el.dot.hidden = true;
      el.msgs.scrollTop = el.msgs.scrollHeight;
      el.input.focus();
    }
  });
  el.close.addEventListener('click', () => el.panel.classList.add('hidden'));
  el.send.addEventListener('click', () => sendCallChat(null));
  el.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCallChat(null); });
  el.attach.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', async () => {
    const f = el.file.files[0];
    el.file.value = '';
    if (!f) return;
    try { sendCallChat(await U.imageToDataUrl(f)); } catch (e) { C.toast(e.message); }
  });

  window.Call = {
    bind,
    isActive: () => C.active,
    startOutgoing,
    acceptIncoming,
    leave,
    invite,
    participantUserIds
  };
  C.toast = U.toast;
})();
