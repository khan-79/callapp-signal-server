'use strict';
/*
 * Storage for users and direct messages.
 *
 *  - If DATABASE_URL is set  -> PostgreSQL (use this in production: Render's
 *    free disk is wiped on every restart/redeploy, a database is not).
 *  - Otherwise              -> a JSON file (fine for local testing only).
 *
 * Both backends expose the same async interface.
 */
const fs = require('fs');
const path = require('path');

const MAX_FILE_MESSAGES = 3000;

// A friendship/request row seen from one user's side.
const relView = (rel, uid) => ({
  userId: rel.requesterId === uid ? rel.addresseeId : rel.requesterId,
  status: rel.status, // 'pending' | 'accepted'
  outgoing: rel.requesterId === uid,
  createdAt: rel.createdAt
});

const pubMsg = (m) => ({
  id: m.id,
  fromId: m.fromId,
  toId: m.toId,
  text: m.text,
  image: m.image || null,
  createdAt: m.createdAt,
  read: !!m.read,
  editedAt: m.editedAt || null
});

/* ------------------------------------------------------------------ */
/* JSON file backend                                                   */
/* ------------------------------------------------------------------ */
async function createFileStore(file) {
  let data = { users: [], messages: [], relations: [], pushSubs: [], settings: {}, nextUserId: 1, nextMsgId: 1 };
  try {
    Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('Could not read', file, e.message);
  }
  if (!Array.isArray(data.relations)) data.relations = [];
  if (!Array.isArray(data.pushSubs)) data.pushSubs = [];
  if (!data.settings) data.settings = {};
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, file);
      } catch (e) {
        console.error('Could not save data file:', e.message);
      }
    }, 250);
  };

  const clone = (o) => (o ? { ...o } : null);
  const isPair = (m, a, b) =>
    (m.fromId === a && m.toId === b) || (m.fromId === b && m.toId === a);

  return {
    kind: 'file',

    async getUserByUsername(username) {
      const u = String(username || '').toLowerCase();
      return clone(data.users.find((x) => x.username === u));
    },
    async getUserById(id) {
      return clone(data.users.find((x) => x.id === Number(id)));
    },
    async listUsers() {
      return data.users.map(clone);
    },
    async createUser({ username, displayName, passwordHash, isAdmin }) {
      username = String(username).toLowerCase();
      if (data.users.some((x) => x.username === username)) throw new Error('USERNAME_TAKEN');
      const u = {
        id: data.nextUserId++,
        username,
        displayName,
        passwordHash,
        isAdmin: !!isAdmin,
        createdAt: Date.now()
      };
      data.users.push(u);
      save();
      return clone(u);
    },
    async updateUser(id, f) {
      const u = data.users.find((x) => x.id === Number(id));
      if (!u) return null;
      if (f.username !== undefined && f.username !== u.username) {
        if (data.users.some((x) => x.username === f.username && x.id !== u.id)) throw new Error('USERNAME_TAKEN');
        u.username = f.username;
      }
      if (f.displayName !== undefined) u.displayName = f.displayName;
      if (f.passwordHash !== undefined) u.passwordHash = f.passwordHash;
      if (f.isAdmin !== undefined) u.isAdmin = !!f.isAdmin;
      save();
      return clone(u);
    },
    async deleteUser(id) {
      id = Number(id);
      data.users = data.users.filter((x) => x.id !== id);
      data.messages = data.messages.filter((m) => m.fromId !== id && m.toId !== id);
      data.relations = data.relations.filter((r) => r.requesterId !== id && r.addresseeId !== id);
      data.pushSubs = data.pushSubs.filter((p) => p.userId !== id);
      save();
    },
    async countAdmins() {
      return data.users.filter((u) => u.isAdmin).length;
    },

    async getSetting(k) {
      return data.settings[k] || null;
    },
    async setSetting(k, v) {
      data.settings[k] = v;
      save();
    },
    async addPushSub({ endpoint, userId, p256dh, auth }) {
      data.pushSubs = data.pushSubs.filter((x) => x.endpoint !== endpoint);
      data.pushSubs.push({ endpoint, userId, p256dh, auth });
      save();
    },
    async removePushSub(endpoint, userId) {
      data.pushSubs = data.pushSubs.filter((x) => !(x.endpoint === endpoint && x.userId === userId));
      save();
    },
    async listPushSubs(uid) {
      return data.pushSubs.filter((x) => x.userId === uid).map((x) => ({ endpoint: x.endpoint, p256dh: x.p256dh, auth: x.auth }));
    },

    async getRelation(a, b) {
      const r = data.relations.find(
        (x) => (x.requesterId === a && x.addresseeId === b) || (x.requesterId === b && x.addresseeId === a)
      );
      return clone(r);
    },
    async setRelation(requesterId, addresseeId, status) {
      const same = (x) =>
        (x.requesterId === requesterId && x.addresseeId === addresseeId) ||
        (x.requesterId === addresseeId && x.addresseeId === requesterId);
      data.relations = data.relations.filter((x) => !same(x));
      data.relations.push({ requesterId, addresseeId, status, createdAt: Date.now() });
      save();
    },
    async deleteRelation(a, b) {
      data.relations = data.relations.filter(
        (x) => !((x.requesterId === a && x.addresseeId === b) || (x.requesterId === b && x.addresseeId === a))
      );
      save();
    },
    async listRelations(uid) {
      return data.relations
        .filter((x) => x.requesterId === uid || x.addresseeId === uid)
        .map((x) => relView(x, uid));
    },

    async addMessage({ fromId, toId, text, image }) {
      const m = {
        id: data.nextMsgId++,
        fromId,
        toId,
        text: text || '',
        image: image || null,
        createdAt: Date.now(),
        read: false
      };
      data.messages.push(m);
      if (data.messages.length > MAX_FILE_MESSAGES) {
        data.messages.splice(0, data.messages.length - MAX_FILE_MESSAGES);
      }
      save();
      return pubMsg(m);
    },
    async getMessage(id) {
      const m = data.messages.find((x) => x.id === Number(id));
      return m ? pubMsg(m) : null;
    },
    async deleteMessage(id) {
      data.messages = data.messages.filter((x) => x.id !== Number(id));
      save();
    },
    async editMessage(id, text) {
      const m = data.messages.find((x) => x.id === Number(id));
      if (!m) return null;
      m.text = text;
      m.editedAt = Date.now();
      save();
      return pubMsg(m);
    },
    async getMessages(a, b, { before, limit = 100 } = {}) {
      let list = data.messages.filter((m) => isPair(m, a, b));
      if (before) list = list.filter((m) => m.id < before);
      return list.slice(-limit).map(pubMsg);
    },
    async getConversations(uid) {
      const out = {};
      for (const m of data.messages) {
        if (m.fromId !== uid && m.toId !== uid) continue;
        const other = m.fromId === uid ? m.toId : m.fromId;
        const c = out[other] || (out[other] = { userId: other, unread: 0, _id: 0 });
        if (m.id > c._id) {
          c._id = m.id;
          c.lastText = m.text;
          c.lastHasImage = !!m.image;
          c.lastAt = m.createdAt;
          c.lastFromId = m.fromId;
        }
        if (m.toId === uid && !m.read) c.unread++;
      }
      Object.values(out).forEach((c) => delete c._id);
      return out;
    },
    async markRead(uid, otherId) {
      let changed = false;
      for (const m of data.messages) {
        if (m.toId === uid && m.fromId === otherId && !m.read) {
          m.read = true;
          changed = true;
        }
      }
      if (changed) save();
    }
  };
}

/* ------------------------------------------------------------------ */
/* PostgreSQL backend                                                  */
/* ------------------------------------------------------------------ */
async function createPgStore(url) {
  const { Pool } = require('pg');
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  u.searchParams.delete('channel_binding');
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
  const pool = new Pool({
    connectionString: u.toString(),
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 5
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id         BIGSERIAL PRIMARY KEY,
      from_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body       TEXT NOT NULL DEFAULT '',
      image      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at    TIMESTAMPTZ
    )`);
  await pool.query('CREATE INDEX IF NOT EXISTS messages_from_idx ON messages (from_id, to_id, id)');
  await pool.query('CREATE INDEX IF NOT EXISTS messages_to_idx ON messages (to_id, from_id, id)');
  await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS relations (
      requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status       TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (requester_id, addressee_id),
      CHECK (requester_id <> addressee_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint   TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  const rowUser = (r) =>
    r && {
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      passwordHash: r.password_hash,
      isAdmin: r.is_admin,
      createdAt: new Date(r.created_at).getTime()
    };
  const rowRel = (r) =>
    r && {
      requesterId: r.requester_id,
      addresseeId: r.addressee_id,
      status: r.status,
      createdAt: new Date(r.created_at).getTime()
    };
  const rowMsg = (r) => ({
    id: Number(r.id),
    fromId: r.from_id,
    toId: r.to_id,
    text: r.body,
    image: r.image || null,
    createdAt: new Date(r.created_at).getTime(),
    read: !!r.read_at,
    editedAt: r.edited_at ? new Date(r.edited_at).getTime() : null
  });

  return {
    kind: 'postgres',

    async getUserByUsername(username) {
      const r = await pool.query('SELECT * FROM users WHERE username = $1', [
        String(username || '').toLowerCase()
      ]);
      return rowUser(r.rows[0]);
    },
    async getUserById(id) {
      const n = Number(id);
      if (!Number.isInteger(n)) return null;
      const r = await pool.query('SELECT * FROM users WHERE id = $1', [n]);
      return rowUser(r.rows[0]);
    },
    async listUsers() {
      const r = await pool.query('SELECT * FROM users ORDER BY lower(display_name), id');
      return r.rows.map(rowUser);
    },
    async createUser({ username, displayName, passwordHash, isAdmin }) {
      try {
        const r = await pool.query(
          'INSERT INTO users (username, display_name, password_hash, is_admin) VALUES ($1,$2,$3,$4) RETURNING *',
          [String(username).toLowerCase(), displayName, passwordHash, !!isAdmin]
        );
        return rowUser(r.rows[0]);
      } catch (e) {
        if (e.code === '23505') throw new Error('USERNAME_TAKEN');
        throw e;
      }
    },
    async updateUser(id, f) {
      const sets = [];
      const vals = [];
      if (f.username !== undefined) { vals.push(f.username); sets.push(`username = $${vals.length}`); }
      if (f.displayName !== undefined) { vals.push(f.displayName); sets.push(`display_name = $${vals.length}`); }
      if (f.passwordHash !== undefined) { vals.push(f.passwordHash); sets.push(`password_hash = $${vals.length}`); }
      if (f.isAdmin !== undefined) { vals.push(!!f.isAdmin); sets.push(`is_admin = $${vals.length}`); }
      if (!sets.length) return this.getUserById(id);
      vals.push(Number(id));
      try {
        const r = await pool.query(
          `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
          vals
        );
        return rowUser(r.rows[0]);
      } catch (e) {
        if (e.code === '23505') throw new Error('USERNAME_TAKEN');
        throw e;
      }
    },
    async deleteUser(id) {
      await pool.query('DELETE FROM users WHERE id = $1', [Number(id)]);
    },
    async countAdmins() {
      const r = await pool.query('SELECT COUNT(*) AS n FROM users WHERE is_admin = TRUE');
      return Number(r.rows[0].n);
    },

    async getSetting(k) {
      const r = await pool.query('SELECT value FROM settings WHERE key = $1', [k]);
      return r.rows[0] ? r.rows[0].value : null;
    },
    async setSetting(k, v) {
      await pool.query('DELETE FROM settings WHERE key = $1', [k]);
      await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2)', [k, v]);
    },
    async addPushSub({ endpoint, userId, p256dh, auth }) {
      await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
      await pool.query(
        'INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES ($1, $2, $3, $4)',
        [endpoint, userId, p256dh, auth]
      );
    },
    async removePushSub(endpoint, userId) {
      await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, userId]);
    },
    async listPushSubs(uid) {
      const r = await pool.query('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [uid]);
      return r.rows.map((x) => ({ endpoint: x.endpoint, p256dh: x.p256dh, auth: x.auth }));
    },

    async getRelation(a, b) {
      const r = await pool.query(
        'SELECT * FROM relations WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1) LIMIT 1',
        [a, b]
      );
      return rowRel(r.rows[0]) || null;
    },
    async setRelation(requesterId, addresseeId, status) {
      await pool.query(
        'DELETE FROM relations WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)',
        [requesterId, addresseeId]
      );
      await pool.query(
        'INSERT INTO relations (requester_id, addressee_id, status) VALUES ($1, $2, $3)',
        [requesterId, addresseeId, status]
      );
    },
    async deleteRelation(a, b) {
      await pool.query(
        'DELETE FROM relations WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)',
        [a, b]
      );
    },
    async listRelations(uid) {
      const r = await pool.query(
        'SELECT * FROM relations WHERE requester_id = $1 OR addressee_id = $1',
        [uid]
      );
      return r.rows.map((x) => relView(rowRel(x), uid));
    },

    async addMessage({ fromId, toId, text, image }) {
      const r = await pool.query(
        'INSERT INTO messages (from_id, to_id, body, image) VALUES ($1,$2,$3,$4) RETURNING *',
        [fromId, toId, text || '', image || null]
      );
      return rowMsg(r.rows[0]);
    },
    async getMessage(id) {
      const r = await pool.query('SELECT * FROM messages WHERE id = $1', [Number(id)]);
      return r.rows[0] ? rowMsg(r.rows[0]) : null;
    },
    async deleteMessage(id) {
      await pool.query('DELETE FROM messages WHERE id = $1', [Number(id)]);
    },
    async editMessage(id, text) {
      const r = await pool.query(
        'UPDATE messages SET body = $2, edited_at = NOW() WHERE id = $1 RETURNING *',
        [Number(id), text]
      );
      return r.rows[0] ? rowMsg(r.rows[0]) : null;
    },
    async getMessages(a, b, { before, limit = 100 } = {}) {
      const r = await pool.query(
        `SELECT * FROM messages
         WHERE ((from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1))
           AND ($3::bigint IS NULL OR id < $3::bigint)
         ORDER BY id DESC LIMIT $4`,
        [a, b, before || null, limit]
      );
      return r.rows.map(rowMsg).reverse();
    },
    async getConversations(uid) {
      const r = await pool.query(
        `SELECT t.other_id, t.unread, m.from_id, m.body, m.created_at,
                (m.image IS NOT NULL) AS has_image
           FROM (SELECT other_id, MAX(id) AS last_id,
                        SUM(CASE WHEN to_id = $1 AND read_at IS NULL THEN 1 ELSE 0 END) AS unread
                   FROM (SELECT id, to_id, read_at,
                                CASE WHEN from_id = $1 THEN to_id ELSE from_id END AS other_id
                           FROM messages WHERE from_id = $1 OR to_id = $1) x
                  GROUP BY other_id) t
           JOIN messages m ON m.id = t.last_id`,
        [uid]
      );
      const out = {};
      for (const row of r.rows) {
        out[row.other_id] = {
          userId: row.other_id,
          lastText: row.body,
          lastHasImage: !!row.has_image,
          lastAt: new Date(row.created_at).getTime(),
          lastFromId: row.from_id,
          unread: Number(row.unread)
        };
      }
      return out;
    },
    async markRead(uid, otherId) {
      await pool.query(
        'UPDATE messages SET read_at = NOW() WHERE to_id = $1 AND from_id = $2 AND read_at IS NULL',
        [uid, otherId]
      );
    }
  };
}

module.exports = async function createStore() {
  if (process.env.DATABASE_URL) {
    const s = await createPgStore(process.env.DATABASE_URL);
    console.log('Storage: PostgreSQL');
    return s;
  }
  const file = process.env.DATA_FILE || path.join(__dirname, 'data', 'store.json');
  const s = await createFileStore(file);
  console.warn(
    'Storage: local JSON file (' + file + '). On hosts with a temporary disk (e.g. Render free tier) ' +
      'this is WIPED on every restart. Set DATABASE_URL for permanent storage.'
  );
  return s;
};
