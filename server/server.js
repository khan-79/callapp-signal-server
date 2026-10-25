'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const createStore = require('./db');

const PORT = process.env.PORT || 3000;
const MAX_CALL_SIZE = 8; // mesh calls get heavy beyond this
const RING_MS = 45 * 1000;
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const IMG_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+=*$/;

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('JWT_SECRET is not set: everyone will be signed out whenever the server restarts. Set it in your host settings.');
}

const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  isAdmin: !!u.isAdmin
});
const pwFingerprint = (u) =>
  crypto.createHash('sha256').update(u.passwordHash).digest('hex').slice(0, 12);
const signToken = (u) =>
  jwt.sign({ uid: u.id, pv: pwFingerprint(u) }, JWT_SECRET, { expiresIn: '30d' });
const validImage = (s) => typeof s === 'string' && s.length <= 3000000 && IMG_RE.test(s);
const cleanText = (s, max) => (typeof s === 'string' ? s.trim().slice(0, max) : '');
const cleanName = (s, fallback) => {
  const v = typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').slice(0, 40) : '';
  return v || fallback;
};
const fn = (f) => (typeof f === 'function' ? f : () => {});

function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || ''
    });
  }
  return list;
}

async function bootstrapAdmin(store) {
  const username = String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const envPassword = process.env.ADMIN_PASSWORD;
  const existing = await store.getUserByUsername(username);

  if (existing && existing.isAdmin) {
    // The ADMIN_PASSWORD setting stays the source of truth for this one account,
    // so a forgotten admin password can always be reset from the host settings.
    if (envPassword && !(await bcrypt.compare(envPassword, existing.passwordHash))) {
      await store.updateUser(existing.id, { passwordHash: await bcrypt.hash(envPassword, 10) });
      console.log('Admin password updated from ADMIN_PASSWORD.');
    }
    return;
  }
  if ((await store.countAdmins()) > 0) return;

  const generated = !envPassword;
  const password = envPassword || crypto.randomBytes(7).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 10);
  if (existing) {
    await store.updateUser(existing.id, { isAdmin: true, passwordHash });
  } else {
    await store.createUser({ username, displayName: 'Admin', passwordHash, isAdmin: true });
  }
  console.log('Created admin account "' + username + '".');
  if (generated) {
    console.log('ADMIN_PASSWORD was not set. Temporary admin password: ' + password);
    console.log('Set ADMIN_PASSWORD in your host settings to choose your own.');
  }
}

async function main() {
  const store = await createStore();
  await bootstrapAdmin(store);

  const app = express();
  app.set('trust proxy', 1);
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: '*' },
    maxHttpBufferSize: 4e6
  });

  const online = new Map(); // userId -> Set(socketId)
  const calls = new Map(); // callId -> call

  /* ---------------- HTTP: middleware ---------------- */
  app.use((req, res, next) => {
    // Bearer tokens (no cookies) so a wildcard origin is safe, and it lets the
    // desktop app (file://) talk to the API.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  const wrap = (f) => (req, res, next) => Promise.resolve(f(req, res, next)).catch(next);

  async function userFromToken(token) {
    try {
      const p = jwt.verify(token, JWT_SECRET);
      const user = await store.getUserById(p.uid);
      if (!user || p.pv !== pwFingerprint(user)) return null;
      return user;
    } catch (e) {
      return null;
    }
  }

  const auth = wrap(async (req, res, next) => {
    const h = req.headers.authorization || '';
    const user = h.startsWith('Bearer ') ? await userFromToken(h.slice(7)) : null;
    if (!user) return res.status(401).json({ error: 'Please sign in again.' });
    req.user = user;
    next();
  });
  const adminOnly = (req, res, next) =>
    req.user.isAdmin ? next() : res.status(403).json({ error: 'Admins only.' });

  /* ---------------- HTTP: login (rate limited) ---------------- */
  const attempts = new Map();
  const blocked = (key) => {
    const a = attempts.get(key);
    return !!a && a.count >= 8 && Date.now() < a.until;
  };
  const noteFail = (key) => {
    const now = Date.now();
    let a = attempts.get(key);
    if (!a || now > a.until) {
      a = { count: 0, until: now + 15 * 60 * 1000 };
      attempts.set(key, a);
    }
    a.count++;
  };
  setInterval(() => {
    const now = Date.now();
    for (const [k, a] of attempts) if (now > a.until) attempts.delete(k);
  }, 10 * 60 * 1000).unref();

  const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

  app.post('/api/login', wrap(async (req, res) => {
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const key = req.ip + '|' + username;
    if (blocked(key)) {
      return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    }
    const user = username ? await store.getUserByUsername(username) : null;
    const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !ok) {
      noteFail(key);
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    attempts.delete(key);
    res.json({ token: signToken(user), user: publicUser(user) });
  }));

  /* ---------------- HTTP: signed-in API ---------------- */
  app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

  app.get('/api/config', auth, (req, res) =>
    res.json({ iceServers: iceServers(), maxCallSize: MAX_CALL_SIZE })
  );

  app.get('/api/users', auth, wrap(async (req, res) => {
    const users = await store.listUsers();
    res.json(users.map((u) => ({ ...publicUser(u), online: online.has(u.id) })));
  }));

  app.get('/api/conversations', auth, wrap(async (req, res) => {
    res.json(await store.getConversations(req.user.id));
  }));

  app.get('/api/messages/:userId', auth, wrap(async (req, res) => {
    const other = Number(req.params.userId);
    if (!Number.isInteger(other)) return res.status(400).json({ error: 'Bad user.' });
    const before = Number(req.query.before) || null;
    res.json(await store.getMessages(req.user.id, other, { before, limit: 100 }));
  }));

  app.post('/api/messages/:userId/read', auth, wrap(async (req, res) => {
    const other = Number(req.params.userId);
    if (!Number.isInteger(other)) return res.status(400).json({ error: 'Bad user.' });
    await store.markRead(req.user.id, other);
    res.json({ ok: true });
  }));

  app.post('/api/me/password', auth, wrap(async (req, res) => {
    const current = String((req.body && req.body.current) || '');
    const next = String((req.body && req.body.next) || '');
    if (!(await bcrypt.compare(current, req.user.passwordHash))) {
      return res.status(400).json({ error: 'Your current password is wrong.' });
    }
    if (next.length < 6 || next.length > 100) {
      return res.status(400).json({ error: 'New password must be 6 to 100 characters.' });
    }
    const updated = await store.updateUser(req.user.id, { passwordHash: await bcrypt.hash(next, 10) });
    res.json({ ok: true, token: signToken(updated) });
  }));

  /* ---------------- HTTP: admin ---------------- */
  app.get('/api/admin/users', auth, adminOnly, wrap(async (req, res) => {
    const users = await store.listUsers();
    res.json(users.map((u) => ({ ...publicUser(u), online: online.has(u.id), createdAt: u.createdAt })));
  }));

  app.post('/api/admin/users', auth, adminOnly, wrap(async (req, res) => {
    const b = req.body || {};
    const username = String(b.username || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-32 characters: letters, numbers, dot, dash or underscore.' });
    }
    if (password.length < 6 || password.length > 100) {
      return res.status(400).json({ error: 'Password must be 6 to 100 characters.' });
    }
    try {
      const user = await store.createUser({
        username,
        displayName: cleanName(b.displayName, username),
        passwordHash: await bcrypt.hash(password, 10),
        isAdmin: !!b.isAdmin
      });
      io.emit('users-changed');
      res.json({ user: publicUser(user) });
    } catch (e) {
      if (e.message === 'USERNAME_TAKEN') return res.status(409).json({ error: 'That username is already taken.' });
      throw e;
    }
  }));

  app.patch('/api/admin/users/:id', auth, adminOnly, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const target = await store.getUserById(id);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    const b = req.body || {};
    const fields = {};
    if (b.displayName !== undefined) fields.displayName = cleanName(b.displayName, target.username);
    if (b.password !== undefined && b.password !== '') {
      const pw = String(b.password);
      if (pw.length < 6 || pw.length > 100) {
        return res.status(400).json({ error: 'Password must be 6 to 100 characters.' });
      }
      fields.passwordHash = await bcrypt.hash(pw, 10);
    }
    if (b.isAdmin !== undefined) {
      if (!b.isAdmin && target.isAdmin && (await store.countAdmins()) <= 1) {
        return res.status(400).json({ error: 'There must be at least one admin.' });
      }
      fields.isAdmin = !!b.isAdmin;
    }
    const updated = await store.updateUser(id, fields);
    if (fields.passwordHash && id !== req.user.id) kickUser(id); // old sessions are no longer valid
    io.emit('users-changed');
    res.json({ user: publicUser(updated) });
  }));

  app.delete('/api/admin/users/:id', auth, adminOnly, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: "You can't delete your own account." });
    const target = await store.getUserById(id);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (target.isAdmin && (await store.countAdmins()) <= 1) {
      return res.status(400).json({ error: 'There must be at least one admin.' });
    }
    kickUser(id);
    await store.deleteUser(id);
    io.emit('users-changed');
    res.json({ ok: true });
  }));

  /* ---------------- HTTP: web client + health ---------------- */
  app.get('/health', (req, res) => res.send('CallApp server is running.'));
  app.use(express.static(path.join(__dirname, '..', 'renderer')));

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  });

  /* ================= Sockets ================= */
  const userSockets = (uid) => [...(online.get(uid) || [])];
  const sockOf = (sid) => io.sockets.sockets.get(sid);
  const isInCall = (uid) =>
    userSockets(uid).some((sid) => {
      const s = sockOf(sid);
      return s && s.callId;
    });
  const toUser = (uid, event, payload) =>
    userSockets(uid).forEach((sid) => io.to(sid).emit(event, payload));
  const toCall = (call, event, payload, exceptSid) => {
    for (const sid of call.participants.keys()) if (sid !== exceptSid) io.to(sid).emit(event, payload);
  };

  function kickUser(uid) {
    for (const sid of userSockets(uid)) {
      const s = sockOf(sid);
      if (s) {
        s.emit('kicked');
        s.disconnect(true);
      }
    }
  }

  io.use(async (socket, next) => {
    const user = await userFromToken(socket.handshake.auth && socket.handshake.auth.token);
    if (!user) return next(new Error('unauthorized'));
    socket.user = publicUser(user);
    next();
  });

  function newCall(video) {
    const call = {
      id: crypto.randomBytes(8).toString('hex'),
      video: !!video,
      participants: new Map(), // socketId -> {userId, displayName, audio, video}
      pending: new Map(), // userId -> {timer, fromUserId}
      everConnected: false
    };
    calls.set(call.id, call);
    return call;
  }

  function addParticipant(call, socket, hasVideo) {
    call.participants.set(socket.id, {
      userId: socket.user.id,
      displayName: socket.user.displayName,
      audio: true,
      video: !!hasVideo
    });
    socket.callId = call.id;
    if (call.participants.size >= 2) call.everConnected = true;
  }

  function inviteUsers(call, from, ids) {
    const result = { ringing: [], offline: [], busy: [], full: [] };
    const inCallUsers = new Set([...call.participants.values()].map((p) => p.userId));
    for (const uid of ids) {
      if (inCallUsers.has(uid) || call.pending.has(uid)) continue;
      if (call.participants.size + call.pending.size >= MAX_CALL_SIZE) {
        result.full.push(uid);
        continue;
      }
      if (!userSockets(uid).length) {
        result.offline.push(uid);
        continue;
      }
      if (isInCall(uid)) {
        result.busy.push(uid);
        continue;
      }

      const timer = setTimeout(() => {
        if (!call.pending.has(uid)) return;
        call.pending.delete(uid);
        toCall(call, 'call-no-answer', { userId: uid });
        toUser(uid, 'call-cancelled', { callId: call.id, reason: 'missed' });
        checkCallEnd(call);
      }, RING_MS);

      call.pending.set(uid, { timer, fromUserId: from.user.id });
      toUser(uid, 'incoming-call', {
        callId: call.id,
        video: call.video,
        from: { id: from.user.id, displayName: from.user.displayName },
        with: [...call.participants.values()].map((p) => p.displayName)
      });
      result.ringing.push(uid);
    }
    return result;
  }

  function checkCallEnd(call) {
    if (!calls.has(call.id)) return;
    if (call.participants.size === 0) {
      for (const [uid, p] of call.pending) {
        clearTimeout(p.timer);
        toUser(uid, 'call-cancelled', { callId: call.id, reason: 'cancelled' });
      }
      call.pending.clear();
      calls.delete(call.id);
      return;
    }
    if (call.participants.size === 1 && call.pending.size === 0) {
      const [sid] = call.participants.keys();
      const s = sockOf(sid);
      if (s) s.callId = null;
      io.to(sid).emit('call-ended', { callId: call.id, reason: call.everConnected ? 'left' : 'unanswered' });
      call.participants.clear();
      calls.delete(call.id);
    }
  }

  function leaveCall(socket) {
    const call = calls.get(socket.callId);
    socket.callId = null;
    if (!call || !call.participants.delete(socket.id)) return;
    toCall(call, 'peer-left', { socketId: socket.id, userId: socket.user.id });
    checkCallEnd(call);
  }

  io.on('connection', (socket) => {
    const me = socket.user;
    socket.callId = null;

    if (!online.has(me.id)) online.set(me.id, new Set());
    const wasOffline = online.get(me.id).size === 0;
    online.get(me.id).add(socket.id);
    if (wasOffline) io.emit('presence', { userId: me.id, online: true });

    /* ---------- direct messages ---------- */
    socket.on('dm-send', async (p, ack) => {
      ack = fn(ack);
      p = p || {};
      try {
        const toId = Number(p.toUserId);
        const text = cleanText(p.text, 2000);
        const image = p.image ? (validImage(p.image) ? p.image : null) : null;
        if (p.image && !image) return ack({ error: 'That image is unsupported or too large.' });
        if (!text && !image) return ack({ error: 'Empty message.' });
        const to = Number.isInteger(toId) ? await store.getUserById(toId) : null;
        if (!to || to.id === me.id) return ack({ error: 'Unknown user.' });
        const msg = await store.addMessage({ fromId: me.id, toId, text, image });
        toUser(me.id, 'dm-message', msg);
        toUser(toId, 'dm-message', msg);
        ack({ ok: true });
      } catch (e) {
        console.error(e);
        ack({ error: 'Could not send the message.' });
      }
    });

    /* ---------- calls ---------- */
    socket.on('call-start', (p, ack) => {
      ack = fn(ack);
      p = p || {};
      if (socket.callId) return ack({ error: 'You are already in a call.' });
      const ids = [...new Set((Array.isArray(p.toUserIds) ? p.toUserIds : []).map(Number))]
        .filter((id) => Number.isInteger(id) && id !== me.id)
        .slice(0, MAX_CALL_SIZE - 1);
      if (!ids.length) return ack({ error: 'Pick at least one person to call.' });

      const call = newCall(p.video);
      addParticipant(call, socket, !!p.video);
      const result = inviteUsers(call, socket, ids);
      if (!call.pending.size) {
        leaveCall(socket);
        return ack({ error: 'unavailable', ...result });
      }
      ack({ ok: true, callId: call.id, ...result });
    });

    socket.on('call-invite', (p, ack) => {
      ack = fn(ack);
      const call = calls.get(socket.callId);
      if (!call || !call.participants.has(socket.id)) return ack({ error: 'You are not in a call.' });
      const ids = [...new Set(((p && p.toUserIds) || []).map(Number))].filter(
        (id) => Number.isInteger(id) && id !== me.id
      );
      ack({ ok: true, ...inviteUsers(call, socket, ids) });
    });

    socket.on('call-accept', (p, ack) => {
      ack = fn(ack);
      p = p || {};
      const call = calls.get(p.callId);
      if (!call || !call.pending.has(me.id)) return ack({ error: 'This call is no longer available.' });
      if (socket.callId) return ack({ error: 'You are already in a call.' });

      clearTimeout(call.pending.get(me.id).timer);
      call.pending.delete(me.id);
      // Stop ringing on this person's other devices.
      userSockets(me.id).forEach((sid) => {
        if (sid !== socket.id) io.to(sid).emit('call-cancelled', { callId: call.id, reason: 'answered-elsewhere' });
      });

      const peers = [...call.participants.entries()].map(([sid, q]) => ({
        socketId: sid,
        userId: q.userId,
        displayName: q.displayName,
        audio: q.audio,
        video: q.video
      }));
      addParticipant(call, socket, !!p.video);
      toCall(
        call,
        'peer-joined',
        { socketId: socket.id, userId: me.id, displayName: me.displayName, audio: true, video: !!p.video },
        socket.id
      );
      ack({ ok: true, callId: call.id, peers, video: call.video });
    });

    socket.on('call-decline', (p) => {
      const call = calls.get(p && p.callId);
      if (!call || !call.pending.has(me.id)) return;
      clearTimeout(call.pending.get(me.id).timer);
      call.pending.delete(me.id);
      userSockets(me.id).forEach((sid) => {
        if (sid !== socket.id) io.to(sid).emit('call-cancelled', { callId: call.id, reason: 'answered-elsewhere' });
      });
      toCall(call, 'call-declined', { userId: me.id });
      checkCallEnd(call);
    });

    socket.on('call-leave', () => leaveCall(socket));

    socket.on('signal', (p) => {
      const call = calls.get(socket.callId);
      if (!call || !p || !call.participants.has(p.to) || !p.data || typeof p.data !== 'object') return;
      io.to(p.to).emit('signal', { from: socket.id, data: p.data });
    });

    socket.on('media-state', (p) => {
      const call = calls.get(socket.callId);
      const mine = call && call.participants.get(socket.id);
      if (!mine || !p) return;
      mine.audio = !!p.audio;
      mine.video = !!p.video;
      toCall(call, 'media-state', { socketId: socket.id, audio: mine.audio, video: mine.video }, socket.id);
    });

    socket.on('call-chat', (p) => {
      const call = calls.get(socket.callId);
      if (!call || !p) return;
      const text = cleanText(p.text, 2000);
      const image = p.image ? (validImage(p.image) ? p.image : null) : null;
      if (!text && !image) return;
      toCall(call, 'call-chat', {
        socketId: socket.id,
        userId: me.id,
        name: me.displayName,
        text,
        image,
        ts: Date.now()
      });
    });

    socket.on('disconnect', () => {
      leaveCall(socket);
      const set = online.get(me.id);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          online.delete(me.id);
          io.emit('presence', { userId: me.id, online: false });
        }
      }
    });
  });

  server.listen(PORT, () => console.log('CallApp server listening on port ' + PORT));
}

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
