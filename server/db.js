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

const pubMsg = (m) => ({
  id: m.id,
  fromId: m.fromId,
  toId: m.toId,
  text: m.text,
  image: m.image || null,
  createdAt: m.createdAt
});

/* ------------------------------------------------------------------ */
/* JSON file backend                                                   */
/* ------------------------------------------------------------------ */
async function createFileStore(file) {
  let data = { users: [], messages: [], nextUserId: 1, nextMsgId: 1 };
  try {
    Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('Could not read', file, e.message);
  }
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
      save();
    },
    async countAdmins() {
      return data.users.filter((u) => u.isAdmin).length;
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

  const rowUser = (r) =>
    r && {
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      passwordHash: r.password_hash,
      isAdmin: r.is_admin,
      createdAt: new Date(r.created_at).getTime()
    };
  const rowMsg = (r) => ({
    id: Number(r.id),
    fromId: r.from_id,
    toId: r.to_id,
    text: r.body,
    image: r.image || null,
    createdAt: new Date(r.created_at).getTime()
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
      if (f.displayName !== undefined) { vals.push(f.displayName); sets.push(`display_name = $${vals.length}`); }
      if (f.passwordHash !== undefined) { vals.push(f.passwordHash); sets.push(`password_hash = $${vals.length}`); }
      if (f.isAdmin !== undefined) { vals.push(!!f.isAdmin); sets.push(`is_admin = $${vals.length}`); }
      if (!sets.length) return this.getUserById(id);
      vals.push(Number(id));
      const r = await pool.query(
        `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
        vals
      );
      return rowUser(r.rows[0]);
    },
    async deleteUser(id) {
      await pool.query('DELETE FROM users WHERE id = $1', [Number(id)]);
    },
    async countAdmins() {
      const r = await pool.query('SELECT COUNT(*) AS n FROM users WHERE is_admin = TRUE');
      return Number(r.rows[0].n);
    },

    async addMessage({ fromId, toId, text, image }) {
      const r = await pool.query(
        'INSERT INTO messages (from_id, to_id, body, image) VALUES ($1,$2,$3,$4) RETURNING *',
        [fromId, toId, text || '', image || null]
      );
      return rowMsg(r.rows[0]);
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
