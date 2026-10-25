/* App shell: sign-in, contacts + presence, direct messages, incoming calls, admin. */
/* global io */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const U = window.U;
  U.hydrateIcons();

  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  // Opened as a normal website => this page and the API share one address.
  // Inside the desktop app (file://) the person types the server address once.
  const isWeb = typeof window.appInfo === 'undefined' && /^https?:$/.test(location.protocol);

  const S = {
    server: isWeb ? location.origin : LS.get('ca.server') || '',
    token: LS.get('ca.token'),
    me: null,
    users: [],
    convs: {},
    msgs: new Map(), // userId -> [messages]
    hasMore: new Map(), // userId -> bool
    active: null,
    socket: null,
    ice: [],
    incoming: [],
    current: null,
    requests: { incoming: [], outgoing: [] },
    presence: new Map() // userId -> {online, t}: live updates that may be newer than a fetch in flight
  };

  const byId = (id) => S.users.find((u) => u.id === id);

  /* ================= API ================= */
  async function api(path, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    if (S.token) headers.Authorization = 'Bearer ' + S.token;
    let res;
    try {
      res = await fetch(S.server + path, {
        method: opts.method || 'GET',
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
    } catch (e) {
      throw new Error('Cannot reach the server. Check the address and your connection.');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (res.status === 401 && S.token && !opts.noRedirect) {
      logout('Please sign in again.');
      throw new Error((data && data.error) || 'Signed out.');
    }
    if (!res.ok) throw new Error((data && data.error) || 'Request failed (' + res.status + ').');
    return data;
  }

  /* ================= screens ================= */
  function show(id) {
    ['login-screen', 'app-screen'].forEach((s) => $(s).classList.toggle('hidden', s !== id));
  }

  function showLogin(message) {
    show('login-screen');
    $('server-field').hidden = isWeb;
    if (!isWeb) $('server-input').value = S.server || '';
    $('login-pass').value = '';
    $('login-error').textContent = message || '';
    document.title = 'CallApp';
  }

  function logout(message) {
    if (window.Call && Call.isActive()) Call.leave();
    if (S.socket) { S.socket.off(); S.socket.disconnect(); S.socket = null; }
    LS.del('ca.token');
    S.token = null;
    S.me = null;
    S.users = [];
    S.convs = {};
    S.msgs.clear();
    S.hasMore.clear();
    S.presence.clear();
    S.active = null;
    S.incoming = [];
    if (S.current) closeIncoming();
    ['picker', 'admin-modal', 'account-modal'].forEach((id) => $(id).classList.add('hidden'));
    $('app-screen').classList.remove('show-chat');
    showLogin(typeof message === 'string' ? message : '');
  }

  /* ================= login ================= */
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('login-error');
    err.textContent = '';
    if (!isWeb) {
      let url = $('server-input').value.trim().replace(/\/+$/, '');
      if (!url) { err.textContent = 'Enter the server address.'; return; }
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      S.server = url;
    }
    const btn = $('login-btn');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    U.Ring.unlock();
    try {
      const r = await api('/api/login', {
        method: 'POST',
        body: { username: $('login-user').value.trim(), password: $('login-pass').value },
        noRedirect: true
      });
      S.token = r.token;
      S.me = r.user;
      LS.set('ca.token', r.token);
      if (!isWeb) LS.set('ca.server', S.server);
      await startSession();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  $('logout-btn').addEventListener('click', () => logout(''));

  async function boot() {
    if (S.token && S.server) {
      try {
        const r = await api('/api/me', { noRedirect: true });
        S.me = r.user;
        await startSession();
        return;
      } catch (e) {
        LS.del('ca.token');
        S.token = null;
        showLogin(/reach/i.test(e.message) ? e.message : '');
        return;
      }
    }
    showLogin('');
  }

  async function startSession() {
    show('app-screen');
    $('me-name').textContent = S.me.displayName;
    $('me-avatar').replaceChildren(U.avatar(S.me.displayName, 40));
    $('admin-btn').hidden = !S.me.isAdmin;
    setStatus('Connecting…');
    const cfg = await api('/api/config');
    S.ice = cfg.iceServers;
    await refreshAll();
    connectSocket();
    renderChatPane();
    syncPush();
    updateNotifyBanner();
    openFromLink();
  }

  function setStatus(t) { $('conn-status').textContent = t; }

  /* ================= data ================= */
  // A fetch can finish after a live event that is newer than its data, so merge
  // presence instead of overwriting it.
  function applyUsers(users, t0) {
    users.forEach((u) => {
      const o = S.presence.get(u.id);
      if (o && o.t >= t0) u.online = o.online;
    });
    S.users = users;
  }
  function applyConvs(convs) {
    const merged = Object.assign({}, convs);
    for (const [id, c] of Object.entries(S.convs)) {
      const fromServer = merged[id];
      if (!fromServer || (c.lastAt || 0) > (fromServer.lastAt || 0)) merged[id] = c;
    }
    S.convs = merged;
  }

  // Friends, incoming and outgoing requests. Everything else in the app builds on this.
  async function refreshFriends() {
    const t0 = Date.now();
    const data = await api('/api/friends');
    applyUsers(data.friends, t0);
    S.requests = { incoming: data.incoming, outgoing: data.outgoing };
    // If the person you were chatting with is no longer a friend, close that chat.
    if (S.active !== null && !byId(S.active)) {
      S.active = null;
      $('app-screen').classList.remove('show-chat');
      renderChatPane();
    }
    renderContacts();
    updateChatHeader();
    renderRequestBadge();
    if (!$('friends-modal').classList.contains('hidden')) renderFriendsModal();
  }

  async function refreshAll() {
    const [convs] = await Promise.all([api('/api/conversations'), refreshFriends()]);
    applyConvs(convs);
    renderContacts();
    if (S.active !== null) loadHistory(S.active, true);
  }

  /* ================= socket ================= */
  function connectSocket() {
    if (S.socket) { S.socket.off(); S.socket.disconnect(); }
    const s = io(S.server || undefined, {
      auth: { token: S.token },
      transports: ['websocket', 'polling'],
      reconnectionDelayMax: 5000
    });
    S.socket = s;

    Call.bind(s, {
      me: S.me,
      ice: S.ice,
      getUser: byId,
      onAddPeople: openAddPeople
    });

    s.on('connect', () => {
      setStatus('Online');
      if (S.me) refreshAll().catch(() => {});
    });
    s.on('disconnect', () => setStatus('Reconnecting…'));
    s.on('connect_error', (err) => {
      if (err && err.message === 'unauthorized') logout('Your session expired. Please sign in again.');
      else setStatus('Reconnecting…');
    });
    s.on('kicked', () => logout('You were signed out.'));
    s.on('presence', (p) => {
      S.presence.set(p.userId, { online: p.online, t: Date.now() });
      const u = byId(p.userId);
      if (u) {
        u.online = p.online;
        renderContacts();
        updateChatHeader();
      }
    });
    s.on('users-changed', () => refreshFriends().catch(() => {}));
    s.on('friends-changed', () => refreshFriends().catch(() => {}));
    s.on('friend-request', (p) => {
      U.toast(p.from.displayName + ' sent you a friend request.', 5000);
      U.Ring.ding();
      refreshFriends().catch(() => {});
    });
    s.on('dm-message', onDm);
    s.on('incoming-call', onIncoming);
    s.on('call-cancelled', onCallCancelled);
  }

  /* ================= contacts ================= */
  function contactsFor(filter) {
    const q = (filter || '').trim().toLowerCase();
    let list = S.users.filter((u) => u.id !== S.me.id);
    if (q) {
      list = list.filter((u) => u.displayName.toLowerCase().indexOf(q) >= 0 || u.username.indexOf(q) >= 0);
    }
    list.sort((a, b) => {
      const ta = (S.convs[a.id] && S.convs[a.id].lastAt) || 0;
      const tb = (S.convs[b.id] && S.convs[b.id].lastAt) || 0;
      if (ta !== tb) return tb - ta;
      if (!!a.online !== !!b.online) return a.online ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
    return list;
  }

  function avatarWithDot(user, size) {
    const wrap = document.createElement('span');
    wrap.className = 'av-wrap';
    wrap.appendChild(U.avatar(user.displayName, size));
    const dot = document.createElement('i');
    dot.className = 'presence' + (user.online ? ' on' : '');
    wrap.appendChild(dot);
    return wrap;
  }

  function renderContacts() {
    if (!S.me) return;
    const ul = $('contact-list');
    const list = contactsFor($('search').value);
    ul.replaceChildren();
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'empty muted';
      li.textContent = S.users.length === 0
        ? 'No friends yet. Tap the add-friend icon to send a request.'
        : 'No matches.';
      ul.appendChild(li);
    }
    for (const u of list) {
      const conv = S.convs[u.id];
      const li = document.createElement('li');
      li.className = 'contact' + (S.active === u.id ? ' active' : '');

      const main = document.createElement('div');
      main.className = 'c-main';
      const name = document.createElement('div');
      name.className = 'c-name';
      name.textContent = u.displayName;
      const prev = document.createElement('div');
      prev.className = 'c-prev muted';
      if (conv && (conv.lastText || conv.lastHasImage)) {
        const who = conv.lastFromId === S.me.id ? 'You: ' : '';
        prev.textContent = who + (conv.lastHasImage && !conv.lastText ? 'Photo' : conv.lastText);
      } else {
        prev.textContent = u.online ? 'Online' : 'Offline';
      }
      main.appendChild(name);
      main.appendChild(prev);

      const meta = document.createElement('div');
      meta.className = 'c-meta';
      if (conv && conv.lastAt) {
        const t = document.createElement('small');
        t.className = 'muted';
        t.textContent = U.fmtShort(conv.lastAt);
        meta.appendChild(t);
      }
      if (conv && conv.unread > 0) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = conv.unread > 99 ? '99+' : String(conv.unread);
        meta.appendChild(b);
      }

      const btns = document.createElement('div');
      btns.className = 'c-btns';
      const aBtn = document.createElement('button');
      aBtn.type = 'button';
      aBtn.className = 'icon-btn sm';
      aBtn.title = 'Voice call';
      aBtn.setAttribute('aria-label', 'Voice call ' + u.displayName);
      U.setIcon(aBtn, 'phone', 18);
      aBtn.addEventListener('click', (e) => { e.stopPropagation(); Call.startOutgoing([u.id], false); });
      const vBtn = document.createElement('button');
      vBtn.type = 'button';
      vBtn.className = 'icon-btn sm';
      vBtn.title = 'Video call';
      vBtn.setAttribute('aria-label', 'Video call ' + u.displayName);
      U.setIcon(vBtn, 'video', 18);
      vBtn.addEventListener('click', (e) => { e.stopPropagation(); Call.startOutgoing([u.id], true); });
      btns.appendChild(aBtn);
      btns.appendChild(vBtn);

      li.appendChild(avatarWithDot(u, 44));
      li.appendChild(main);
      li.appendChild(meta);
      li.appendChild(btns);
      li.addEventListener('click', () => openChat(u.id));
      ul.appendChild(li);
    }
    updateTitleBadge();
  }
  $('search').addEventListener('input', renderContacts);

  function updateTitleBadge() {
    const n = Object.values(S.convs).reduce((a, c) => a + (c.unread || 0), 0);
    document.title = (n ? '(' + n + ') ' : '') + 'CallApp';
  }

  /* ================= chat ================= */
  function mergeMsgs(a, b) {
    const map = new Map();
    a.concat(b).forEach((m) => map.set(m.id, m));
    return [...map.values()].sort((x, y) => x.id - y.id);
  }

  function renderChatPane() {
    const has = S.active !== null && !!byId(S.active);
    $('chat-empty').hidden = has;
    $('chat-view').hidden = !has;
  }

  function updateChatHeader() {
    const u = S.active !== null ? byId(S.active) : null;
    if (!u) return;
    $('chat-avatar').replaceChildren(avatarWithDot(u, 40));
    $('chat-name').textContent = u.displayName;
    $('chat-presence').textContent = u.online ? 'Online' : 'Offline';
  }

  async function openChat(id) {
    if (!byId(id)) return;
    S.active = id;
    $('app-screen').classList.add('show-chat');
    renderChatPane();
    updateChatHeader();
    renderContacts();
    renderMessages();
    await loadHistory(id, false);
    markRead(id);
    if (matchMedia('(min-width: 761px)').matches) $('chat-input').focus();
  }

  async function loadHistory(id, silent) {
    try {
      const list = await api('/api/messages/' + id);
      const merged = mergeMsgs(S.msgs.get(id) || [], list);
      S.msgs.set(id, merged);
      if (!S.hasMore.has(id)) S.hasMore.set(id, list.length >= 100);
      if (S.active === id) renderMessages(!silent);
    } catch (e) {
      if (!silent) U.toast(e.message);
    }
  }

  async function loadEarlier() {
    const id = S.active;
    const cur = S.msgs.get(id) || [];
    if (!cur.length) return;
    try {
      const list = await api('/api/messages/' + id + '?before=' + cur[0].id);
      S.hasMore.set(id, list.length >= 100);
      S.msgs.set(id, mergeMsgs(cur, list));
      const box = $('chat-messages');
      const prevH = box.scrollHeight;
      renderMessages(false);
      box.scrollTop = box.scrollHeight - prevH;
    } catch (e) {
      U.toast(e.message);
    }
  }

  function dayDivider(ts) {
    const d = document.createElement('div');
    d.className = 'day';
    d.textContent = U.fmtDay(ts);
    return d;
  }

  function bubbleFor(m) {
    return U.bubble({ mine: m.fromId === S.me.id, text: m.text, image: m.image, ts: m.createdAt });
  }

  function renderMessages(toBottom) {
    const box = $('chat-messages');
    const list = S.msgs.get(S.active) || [];
    box.replaceChildren();
    if (S.hasMore.get(S.active)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small more';
      b.textContent = 'Load earlier messages';
      b.addEventListener('click', loadEarlier);
      box.appendChild(b);
    }
    let lastDay = '';
    for (const m of list) {
      const day = new Date(m.createdAt).toDateString();
      if (day !== lastDay) { box.appendChild(dayDivider(m.createdAt)); lastDay = day; }
      box.appendChild(bubbleFor(m));
    }
    box.dataset.lastDay = lastDay;
    if (toBottom !== false) box.scrollTop = box.scrollHeight;
  }

  function appendMessage(m) {
    const box = $('chat-messages');
    const day = new Date(m.createdAt).toDateString();
    if (box.dataset.lastDay !== day) { box.appendChild(dayDivider(m.createdAt)); box.dataset.lastDay = day; }
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    box.appendChild(bubbleFor(m));
    if (nearBottom || m.fromId === S.me.id) box.scrollTop = box.scrollHeight;
  }

  function markRead(id) {
    const c = S.convs[id];
    if (c && c.unread) {
      c.unread = 0;
      renderContacts();
    }
    api('/api/messages/' + id + '/read', { method: 'POST', body: {} }).catch(() => {});
  }

  function onDm(m) {
    const other = m.fromId === S.me.id ? m.toId : m.fromId;
    const conv = S.convs[other] || (S.convs[other] = { userId: other, unread: 0 });
    conv.lastText = m.text;
    conv.lastHasImage = !!m.image;
    conv.lastAt = m.createdAt;
    conv.lastFromId = m.fromId;

    const list = S.msgs.get(other);
    const isNew = !!list && !list.some((x) => x.id === m.id);
    if (isNew) list.push(m);
    if (S.active === other && isNew) appendMessage(m);

    if (m.fromId !== S.me.id) {
      if (S.active === other && document.visibilityState === 'visible') markRead(other);
      else { conv.unread = (conv.unread || 0) + 1; U.Ring.ding(); }
      if (isNew) {
        const who = byId(m.fromId);
        pageNotify(who ? who.displayName : 'New message', m.text || 'Sent a photo', 'dm-' + other, { chat: other });
      }
    }
    renderContacts();
  }

  function sendDm(image) {
    const id = S.active;
    if (id === null) return;
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text && !image) return;
    if (!S.socket || !S.socket.connected) { U.toast('Not connected. Try again in a moment.'); return; }
    S.socket.emit('dm-send', { toUserId: id, text, image: image || null }, (res) => {
      if (res && res.error) U.toast(res.error);
    });
    input.value = '';
  }

  $('chat-send').addEventListener('click', () => sendDm(null));
  $('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendDm(null); });
  $('chat-attach').addEventListener('click', () => $('chat-file').click());
  $('chat-file').addEventListener('change', async () => {
    const f = $('chat-file').files[0];
    $('chat-file').value = '';
    if (!f) return;
    try { sendDm(await U.imageToDataUrl(f)); } catch (e) { U.toast(e.message); }
  });
  $('chat-back').addEventListener('click', () => {
    S.active = null;
    $('app-screen').classList.remove('show-chat');
    renderChatPane();
    renderContacts();
  });
  $('chat-audio').addEventListener('click', () => { if (S.active !== null) Call.startOutgoing([S.active], false); });
  $('chat-video').addEventListener('click', () => { if (S.active !== null) Call.startOutgoing([S.active], true); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.me && S.active !== null) markRead(S.active);
  });

  /* ================= incoming calls ================= */
  function onIncoming(c) {
    if (Call.isActive() || (S.socket && !S.socket.connected)) {
      S.socket.emit('call-decline', { callId: c.callId });
      return;
    }
    S.incoming.push(c);
    pageNotify('Incoming call', c.from.displayName + ' is calling you', 'call-' + c.callId, null);
    showNextIncoming();
  }

  function showNextIncoming() {
    if (S.current || !S.incoming.length) return;
    const c = S.current = S.incoming.shift();
    $('inc-avatar').replaceChildren(U.avatar(c.from.displayName, 96));
    $('inc-name').textContent = c.from.displayName;
    const others = (c.with || []).filter((n) => n !== c.from.displayName);
    $('inc-kind').textContent =
      (c.video ? 'Video call' : 'Voice call') + (others.length ? ' with ' + others.join(', ') : '');
    $('incoming').classList.remove('hidden');
    document.title = 'Incoming call - CallApp';
    U.Ring.start();
  }

  function closeIncoming() {
    U.Ring.stop();
    $('incoming').classList.add('hidden');
    S.current = null;
    updateTitleBadge();
    showNextIncoming();
  }

  $('inc-accept').addEventListener('click', () => {
    const c = S.current;
    if (!c) return;
    S.incoming.forEach((x) => S.socket.emit('call-decline', { callId: x.callId }));
    S.incoming = [];
    closeIncoming();
    Call.acceptIncoming(c.callId, c.video);
  });
  $('inc-decline').addEventListener('click', () => {
    const c = S.current;
    if (!c) return;
    S.socket.emit('call-decline', { callId: c.callId });
    closeIncoming();
  });

  function onCallCancelled(p) {
    const queued = S.incoming.findIndex((x) => x.callId === p.callId);
    if (queued >= 0) S.incoming.splice(queued, 1);
    if (S.current && S.current.callId === p.callId) {
      const name = S.current.from.displayName;
      closeIncoming();
      if (p.reason === 'cancelled' || p.reason === 'missed') U.toast('Missed call from ' + name + '.', 5000);
    }
  }

  /* ================= people picker (group calls / add to call) ================= */
  let pickerOk = null;
  function openPicker(title, okLabel, exclude, onOk) {
    $('picker-title').textContent = title;
    $('picker-ok').textContent = okLabel;
    pickerOk = onOk;
    const ul = $('picker-list');
    ul.replaceChildren();
    const list = S.users
      .filter((u) => u.id !== S.me.id && !exclude.has(u.id))
      .sort((a, b) => (!!b.online - !!a.online) || a.displayName.localeCompare(b.displayName));
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'empty muted';
      li.textContent = 'No one else to add.';
      ul.appendChild(li);
    }
    for (const u of list) {
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'pick' + (u.online ? '' : ' offline');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = String(u.id);
      cb.disabled = !u.online;
      const nm = document.createElement('span');
      nm.className = 'pick-name';
      nm.textContent = u.displayName;
      const st = document.createElement('small');
      st.className = 'muted';
      st.textContent = u.online ? 'Online' : 'Offline';
      label.appendChild(cb);
      label.appendChild(avatarWithDot(u, 32));
      label.appendChild(nm);
      label.appendChild(st);
      li.appendChild(label);
      ul.appendChild(li);
    }
    $('picker').classList.remove('hidden');
  }
  function closePicker() { $('picker').classList.add('hidden'); pickerOk = null; }
  $('picker-cancel').addEventListener('click', closePicker);
  $('picker-ok').addEventListener('click', () => {
    const ids = [...$('picker-list').querySelectorAll('input:checked')].map((i) => Number(i.value));
    const cb = pickerOk;
    closePicker();
    if (!ids.length) return;
    if (cb) cb(ids);
  });

  function openAddPeople() {
    openPicker('Add people to this call', 'Add', new Set(Call.participantUserIds()), (ids) => Call.invite(ids));
  }
  $('group-btn').addEventListener('click', () => {
    if (Call.isActive()) { U.toast('You are already in a call.'); return; }
    openPicker('New group call', 'Start video call', new Set(), (ids) => Call.startOutgoing(ids, true));
  });

  /* ================= friends ================= */
  function renderRequestBadge() {
    $('friends-badge').hidden = !S.requests.incoming.length;
  }

  function fillList(ul, items, emptyText, makeRow) {
    ul.replaceChildren();
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty muted';
      li.textContent = emptyText;
      ul.appendChild(li);
      return;
    }
    items.forEach((u) => ul.appendChild(makeRow(u)));
  }

  function personRow(u, sub, buttons) {
    const li = document.createElement('li');
    li.className = 'admin-row';
    const top = document.createElement('div');
    top.className = 'admin-top';
    const info = document.createElement('div');
    info.className = 'admin-info';
    const nm = document.createElement('strong');
    nm.textContent = u.displayName;
    const un = document.createElement('small');
    un.className = 'muted';
    un.textContent = '@' + u.username + (sub ? ' · ' + sub : '');
    info.appendChild(nm);
    info.appendChild(un);
    const acts = document.createElement('div');
    acts.className = 'admin-actions';
    buttons.forEach((b) => acts.appendChild(b));
    top.appendChild(avatarWithDot(u, 36));
    top.appendChild(info);
    top.appendChild(acts);
    li.appendChild(top);
    return li;
  }

  function actionBtn(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small ' + (cls || '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // Two taps for destructive actions so nothing is removed by accident.
  function confirmBtn(label, onConfirm) {
    let armed = null;
    const b = actionBtn(label, 'danger-text', () => {
      if (!armed) {
        b.textContent = 'Tap again to confirm';
        armed = setTimeout(() => { armed = null; b.textContent = label; }, 4000);
        return;
      }
      clearTimeout(armed);
      armed = null;
      b.textContent = label;
      onConfirm();
    });
    return b;
  }

  async function respond(id, action) {
    const msg = $('friend-msg');
    msg.className = 'error';
    msg.textContent = '';
    try {
      if (action === 'accept') await api('/api/friends/' + id + '/accept', { method: 'POST', body: {} });
      else await api('/api/friends/' + id, { method: 'DELETE' });
      await refreshFriends();
    } catch (e) {
      msg.textContent = e.message;
    }
  }

  function renderFriendsModal() {
    fillList($('req-in'), S.requests.incoming, 'No requests waiting.', (u) =>
      personRow(u, 'wants to be friends', [
        actionBtn('Accept', 'primary', () => respond(u.id, 'accept')),
        actionBtn('Decline', '', () => respond(u.id, 'decline'))
      ])
    );
    fillList($('req-out'), S.requests.outgoing, 'No requests sent.', (u) =>
      personRow(u, 'request sent', [actionBtn('Cancel', '', () => respond(u.id, 'cancel'))])
    );
    fillList($('friend-list'), S.users, 'No friends yet.', (u) =>
      personRow(u, u.online ? 'Online' : 'Offline', [
        actionBtn('Call', '', () => {
          closeFriends();
          Call.startOutgoing([u.id], true);
        }),
        actionBtn('Message', '', () => {
          closeFriends();
          openChat(u.id);
        }),
        confirmBtn('Remove', () => respond(u.id, 'remove'))
      ])
    );
  }

  function openFriends() {
    $('friend-msg').textContent = '';
    $('friend-msg').className = 'error';
    $('friends-modal').classList.remove('hidden');
    renderFriendsModal();
    refreshFriends().catch(() => {});
  }
  function closeFriends() { $('friends-modal').classList.add('hidden'); }

  $('friends-btn').addEventListener('click', openFriends);
  $('friends-close').addEventListener('click', closeFriends);
  $('friend-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('friend-msg');
    const un = $('friend-username').value.trim();
    msg.className = 'error';
    msg.textContent = '';
    if (!un) return;
    try {
      const r = await api('/api/friends/request', { method: 'POST', body: { username: un } });
      msg.className = 'ok';
      msg.textContent = r.status === 'accepted' ? 'You are now friends.' : 'Request sent to @' + un.toLowerCase() + '.';
      $('friend-username').value = '';
      await refreshFriends();
    } catch (ex) {
      msg.textContent = ex.message;
    }
  });

  /* ================= admin ================= */
  function openAdmin() {
    $('admin-error').textContent = '';
    $('admin-modal').classList.remove('hidden');
    loadAdminList();
  }
  async function loadAdminList() {
    const ul = $('admin-list');
    try {
      const users = await api('/api/admin/users');
      ul.replaceChildren();
      users.forEach((u) => ul.appendChild(adminRow(u)));
    } catch (e) {
      $('admin-error').textContent = e.message;
    }
  }

  function adminRow(u) {
    const li = document.createElement('li');
    li.className = 'admin-row';

    const top = document.createElement('div');
    top.className = 'admin-top';
    const info = document.createElement('div');
    info.className = 'admin-info';
    const nm = document.createElement('strong');
    nm.textContent = u.displayName;
    const un = document.createElement('small');
    un.className = 'muted';
    un.textContent = '@' + u.username + (u.isAdmin ? ' · Admin' : '') + (u.online ? ' · Online' : '');
    info.appendChild(nm);
    info.appendChild(un);

    const acts = document.createElement('div');
    acts.className = 'admin-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn small';
    edit.textContent = 'Edit';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn small danger-text';
    del.textContent = 'Delete';
    del.disabled = u.id === S.me.id;
    acts.appendChild(edit);
    acts.appendChild(del);

    top.appendChild(U.avatar(u.displayName, 36));
    top.appendChild(info);
    top.appendChild(acts);
    li.appendChild(top);

    // inline editor (the desktop app has no window.prompt)
    const form = document.createElement('form');
    form.className = 'admin-edit hidden';
    form.autocomplete = 'off';
    const unIn = document.createElement('input');
    unIn.value = u.username;
    unIn.placeholder = 'Username (login)';
    unIn.setAttribute('autocapitalize', 'none');
    unIn.setAttribute('autocorrect', 'off');
    const dn = document.createElement('input');
    dn.value = u.displayName;
    dn.placeholder = 'Display name';
    const pw = document.createElement('input');
    pw.type = 'text';
    pw.placeholder = 'New password (leave empty to keep)';
    pw.autocomplete = 'off';
    pw.setAttribute('autocapitalize', 'none');
    const adminLbl = document.createElement('label');
    adminLbl.className = 'check';
    const ac = document.createElement('input');
    ac.type = 'checkbox';
    ac.checked = u.isAdmin;
    adminLbl.appendChild(ac);
    adminLbl.appendChild(document.createTextNode(' Admin'));
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'btn primary small';
    save.textContent = 'Save';
    const msg = document.createElement('p');
    msg.className = 'error';
    form.appendChild(unIn);
    form.appendChild(dn);
    form.appendChild(pw);
    form.appendChild(adminLbl);
    form.appendChild(save);
    form.appendChild(msg);
    li.appendChild(form);

    edit.addEventListener('click', () => form.classList.toggle('hidden'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = '';
      const body = { displayName: dn.value, isAdmin: ac.checked };
      const newUn = unIn.value.trim().toLowerCase();
      if (newUn !== u.username) body.username = newUn;
      if (pw.value) body.password = pw.value;
      try {
        await api('/api/admin/users/' + u.id, { method: 'PATCH', body });
        await loadAdminList();
      } catch (ex) {
        msg.textContent = ex.message;
      }
    });

    let armed = null;
    del.addEventListener('click', async () => {
      if (!armed) {
        del.textContent = 'Tap again to confirm';
        armed = setTimeout(() => { armed = null; del.textContent = 'Delete'; }, 4000);
        return;
      }
      clearTimeout(armed);
      try {
        await api('/api/admin/users/' + u.id, { method: 'DELETE' });
        await loadAdminList();
      } catch (ex) {
        $('admin-error').textContent = ex.message;
        armed = null;
        del.textContent = 'Delete';
      }
    });
    return li;
  }

  $('admin-btn').addEventListener('click', openAdmin);
  $('admin-close').addEventListener('click', () => $('admin-modal').classList.add('hidden'));
  $('admin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('admin-error');
    err.textContent = '';
    try {
      await api('/api/admin/users', {
        method: 'POST',
        body: {
          username: $('adm-user').value,
          displayName: $('adm-name').value,
          password: $('adm-pass').value,
          isAdmin: $('adm-isadmin').checked
        }
      });
      U.toast('User "' + $('adm-user').value.trim().toLowerCase() + '" created.');
      $('admin-form').reset();
      await loadAdminList();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });

  /* ================= account ================= */
  $('account-btn').addEventListener('click', () => {
    $('acc-name').textContent = S.me.displayName;
    $('acc-user').textContent = '@' + S.me.username + (S.me.isAdmin ? ' · Admin' : '');
    $('acc-msg').textContent = '';
    $('acc-form').reset();
    $('account-modal').classList.remove('hidden');
  });
  $('acc-close').addEventListener('click', () => $('account-modal').classList.add('hidden'));
  $('acc-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('acc-msg');
    msg.className = 'error';
    msg.textContent = '';
    try {
      const r = await api('/api/me/password', {
        method: 'POST',
        body: { current: $('acc-cur').value, next: $('acc-new').value }
      });
      S.token = r.token;
      LS.set('ca.token', r.token);
      if (S.socket) S.socket.auth = { token: r.token };
      $('acc-form').reset();
      msg.className = 'ok';
      msg.textContent = 'Password updated.';
    } catch (ex) {
      msg.textContent = ex.message;
    }
  });

  /* ================= notifications ================= */
  // Three layers: (1) this page shows notifications while it is open in the background,
  // (2) the service worker (sw.js) shows them when the app is closed, using Web Push,
  // (3) the desktop app shows them through the operating system.
  let notifyDismissed = false;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = () => isWeb && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  function b64ToBytes(b64) {
    const base = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function subscribeForPush() {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const key = await api('/api/push/key');
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToBytes(key.publicKey)
      });
    }
    await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  }

  // Refresh this device's subscription every time the app opens, if already allowed.
  function syncPush() {
    if (pushSupported() && Notification.permission === 'granted') subscribeForPush().catch(() => {});
  }

  async function turnOnNotifications() {
    if (!('Notification' in window)) {
      U.toast('This browser cannot show notifications.');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      U.toast('Notifications are blocked. Allow them in your browser settings to get calls and messages.', 6000);
      updateNotifyBanner();
      return;
    }
    if (pushSupported()) {
      try {
        await subscribeForPush();
        U.toast('Notifications are on. You will get calls and messages even when CallApp is closed.', 5000);
      } catch (e) {
        U.toast('Notifications are on while CallApp is open. Background notifications failed: ' + e.message, 6000);
      }
    } else {
      U.toast('Notifications are on while CallApp is open.');
    }
    updateNotifyBanner();
  }

  function updateNotifyBanner() {
    let msg = null;
    let canEnable = false;
    if (S.me && !notifyDismissed) {
      if (isWeb && isIOS() && !isStandalone()) {
        msg = 'To get calls and messages when CallApp is closed, tap Share in Safari, choose "Add to Home Screen", then open CallApp from your Home Screen.';
      } else if ('Notification' in window && Notification.permission === 'default') {
        msg = "Turn on notifications so you don't miss calls and messages.";
        canEnable = true;
      }
    }
    $('notify-banner').hidden = !msg;
    $('notify-text').textContent = msg || '';
    $('notify-btn').hidden = !canEnable;
  }
  $('notify-btn').addEventListener('click', turnOnNotifications);
  $('notify-later').addEventListener('click', () => {
    notifyDismissed = true;
    updateNotifyBanner();
  });

  // Shows a notification while CallApp is in the background. Does nothing when the
  // page is visible, because the in-app screens already show it.
  async function pageNotify(title, body, tag, opts) {
    if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
    const chat = opts && opts.chat;
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title, {
          body,
          tag,
          renotify: true,
          data: chat ? { chat, url: '/?chat=' + chat } : { url: '/' }
        });
        return;
      }
      const n = new Notification(title, { body, tag });
      n.onclick = () => {
        window.focus();
        n.close();
        if (chat) openChat(chat);
      };
    } catch (e) { /* notifications not available here */ }
  }

  // Tapping a notification opens the app; if it was a message, open that chat.
  function openFromLink() {
    const q = new URLSearchParams(location.search);
    const id = Number(q.get('chat'));
    if (!id) return;
    history.replaceState(null, '', location.pathname);
    if (byId(id)) openChat(id);
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open' && e.data.chat && byId(e.data.chat)) openChat(e.data.chat);
    });
  }

  /* ================= viewer + misc ================= */
  $('viewer').addEventListener('click', () => $('viewer').classList.add('hidden'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('viewer').classList.add('hidden');
      closeFriends();
      closePicker();
    }
  });

  boot();
})();
