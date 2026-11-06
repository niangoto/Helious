// HEROS ↔ MetaTrader 5 — връзка с агента на Windows компютъра.
//
// Агентът (mt5-agent.py) се свързва ИЗХОДЯЩО към този сървър с токен:
//   POST /api/mt5/agent/hello   — представяне (акаунт, сървър, версия)
//   GET  /api/mt5/agent/poll    — long-poll: взима команди за изпълнение
//   POST /api/mt5/agent/result  — резултат от команда
// Сървърът вика `call(agentId, type, payload)` (RPC през опашката) за:
//   snapshot, order_open, order_close, order_modify, symbols
// Токените се пазят хеширани в data/mt5-agents.json.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'mt5-agents.json');
const POLL_HOLD_MS = 25000;
const ONLINE_MS = 45000;
const CALL_TIMEOUT_MS = 20000;

let store = { agents: [] };
try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (j && Array.isArray(j.agents)) store = j; } catch (e) { /* няма файл */ }
function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store, null, 1), { mode: 0o600 });
  } catch (e) { console.error('[mt5] save:', e.message); }
}

const hashToken = (secret) => crypto.createHash('sha256').update(String(secret)).digest('hex');

// ── Регистър на агентите (профил → токени) ─────────────────────
function createAgent(ownerId, name) {
  const id = crypto.randomBytes(5).toString('hex');
  const secret = crypto.randomBytes(24).toString('hex');
  store.agents.push({
    id, ownerId, name: String(name || 'MT5 ' + (store.agents.filter(a => a.ownerId === ownerId).length + 1)).slice(0, 40),
    hash: hashToken(secret), createdAt: Date.now()
  });
  save();
  return { id, token: 'hmt_' + id + '_' + secret };      // токенът се показва само веднъж
}
function removeAgent(ownerId, id) {
  const n = store.agents.length;
  store.agents = store.agents.filter(a => !(a.id === id && a.ownerId === ownerId));
  runtime.delete(id);
  if (store.agents.length !== n) save();
  return store.agents.length !== n;
}
function regenerate(ownerId, id) {
  const a = store.agents.find(x => x.id === id && x.ownerId === ownerId);
  if (!a) return null;
  const secret = crypto.randomBytes(24).toString('hex');
  a.hash = hashToken(secret);
  save();
  return { id, token: 'hmt_' + id + '_' + secret };
}
function agentOf(token) {
  const m = /^hmt_([0-9a-f]{10})_([0-9a-f]{48})$/.exec(String(token || ''));
  if (!m) return null;
  const a = store.agents.find(x => x.id === m[1]);
  if (!a) return null;
  const h = Buffer.from(hashToken(m[2]));
  const e = Buffer.from(a.hash);
  return (h.length === e.length && crypto.timingSafeEqual(h, e)) ? a : null;
}
function owns(ownerId, id) { return store.agents.some(a => a.id === id && a.ownerId === ownerId); }

// ── Runtime състояние (в паметта) ─────────────────────────────
const runtime = new Map();   // agentId → { lastSeen, info, queue, waiter, calls }
function rt(id) {
  let r = runtime.get(id);
  if (!r) { r = { lastSeen: 0, info: null, queue: [], waiter: null, calls: new Map() }; runtime.set(id, r); }
  return r;
}
const isOnline = (id) => { const r = runtime.get(id); return !!r && Date.now() - r.lastSeen < ONLINE_MS; };

function listFor(ownerId) {
  return store.agents.filter(a => a.ownerId === ownerId).map(a => {
    const r = runtime.get(a.id);
    return { id: a.id, name: a.name, createdAt: a.createdAt, online: isOnline(a.id), lastSeen: r ? r.lastSeen : 0, info: r ? r.info : null };
  });
}

function flush(r) {
  if (r.waiter && r.queue.length) {
    const w = r.waiter; r.waiter = null; clearTimeout(w.timer);
    const cmds = r.queue.splice(0);
    w.res.writeHead(200, { 'Content-Type': 'application/json' });
    w.res.end(JSON.stringify({ ok: true, commands: cmds }));
  }
}

// RPC към агента. Отхвърля при офлайн/таймаут/грешка от агента.
function call(agentId, type, payload, timeoutMs) {
  if (!isOnline(agentId)) return Promise.reject(new Error('MT5 агентът е офлайн'));
  const r = rt(agentId);
  const id = crypto.randomBytes(6).toString('hex');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { r.calls.delete(id); reject(new Error('MT5 агентът не отговори (' + type + ')')); }, timeoutMs || CALL_TIMEOUT_MS);
    r.calls.set(id, { resolve, reject, timer });
    r.queue.push({ id, type, payload: payload || {} });
    flush(r);
  });
}

// ── HTTP: агентски маршрути (токен) и потребителски (cookie) ───
function bearer(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

// ctx = { sendJson, readJson, user } ; връща true ако е обработил заявката.
async function route(req, res, url, ctx) {
  const p = url.pathname;
  if (!p.startsWith('/api/mt5/')) return false;
  const { sendJson, readJson } = ctx;

  // ─ Агент
  if (p.startsWith('/api/mt5/agent/')) {
    const agent = agentOf(bearer(req));
    if (!agent) { sendJson(res, 401, { ok: false, error: 'Невалиден токен' }); return true; }
    const r = rt(agent.id);
    r.lastSeen = Date.now();
    const action = p.slice('/api/mt5/agent/'.length);
    if (action === 'hello' && req.method === 'POST') {
      const b = await readJson(req);
      r.info = { account: b.account || null, version: b.version || null, host: b.host || null, helloAt: Date.now() };
      sendJson(res, 200, { ok: true, agentId: agent.id, name: agent.name });
      return true;
    }
    if (action === 'poll' && req.method === 'GET') {
      if (r.waiter) { try { r.waiter.res.writeHead(200, { 'Content-Type': 'application/json' }); r.waiter.res.end('{"ok":true,"commands":[]}'); } catch (e) {} clearTimeout(r.waiter.timer); r.waiter = null; }
      if (r.queue.length) {
        const cmds = r.queue.splice(0);
        sendJson(res, 200, { ok: true, commands: cmds });
        return true;
      }
      const timer = setTimeout(() => {
        if (r.waiter && r.waiter.res === res) r.waiter = null;
        try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"commands":[]}'); } catch (e) {}
      }, POLL_HOLD_MS);
      r.waiter = { res, timer };
      req.on('close', () => { if (r.waiter && r.waiter.res === res) { clearTimeout(timer); r.waiter = null; } });
      return true;
    }
    if (action === 'result' && req.method === 'POST') {
      const b = await readJson(req);
      const c = r.calls.get(b.id);
      if (c) {
        r.calls.delete(b.id); clearTimeout(c.timer);
        if (b.ok) c.resolve(b.data); else c.reject(new Error(b.error || 'грешка от MT5'));
      }
      sendJson(res, 200, { ok: true });
      return true;
    }
    sendJson(res, 404, { ok: false, error: 'Неизвестен агентски път' });
    return true;
  }

  // ─ Потребител
  const user = ctx.user;
  if (!user) { sendJson(res, 401, { ok: false, error: 'Изисква вход' }); return true; }
  const parts = p.split('/').filter(Boolean);        // api mt5 agents [:id] [:action]
  if (parts[2] !== 'agents') { sendJson(res, 404, { ok: false, error: 'Неизвестен API път' }); return true; }
  try {
    if (parts.length === 3 && req.method === 'GET') { sendJson(res, 200, { ok: true, agents: listFor(user.id) }); return true; }
    if (parts.length === 3 && req.method === 'POST') {
      const b = await readJson(req);
      const a = createAgent(user.id, b && b.name);
      sendJson(res, 201, { ok: true, id: a.id, token: a.token });
      return true;
    }
    const id = parts[3];
    if (!owns(user.id, id)) { sendJson(res, 404, { ok: false, error: 'Няма такъв агент' }); return true; }
    const action = parts[4];
    if (!action && req.method === 'DELETE') { sendJson(res, 200, { ok: removeAgent(user.id, id) }); return true; }
    if (action === 'token' && req.method === 'POST') { const a = regenerate(user.id, id); sendJson(res, 200, { ok: true, id, token: a.token }); return true; }
    if (action === 'account' && req.method === 'GET') {
      const snap = await call(id, 'snapshot', { symbols: [] });
      sendJson(res, 200, { ok: true, account: snap.account, positions: snap.positions });
      return true;
    }
    if (action === 'candles' && req.method === 'GET') {
      const iv = url.searchParams.get('interval') || '1h';
      if (!['1m', '5m', '15m', '30m', '1h', '4h', '1d'].includes(iv)) { sendJson(res, 200, { ok: false, error: 'Неподдържан интервал' }); return true; }
      const sym = url.searchParams.get('symbol') || '';
      const count = Math.max(50, Math.min(5000, parseInt(url.searchParams.get('count'), 10) || 1500));
      const snap = await call(id, 'snapshot', { symbols: [{ name: sym, interval: iv, count, from: 0 }] });
      const d = snap.symbols && snap.symbols[sym];
      if (!d || d.error) { sendJson(res, 200, { ok: false, error: (d && d.error) || 'Няма данни' }); return true; }
      sendJson(res, 200, { ok: true, interval: iv, candles: (d.candles || []).map(c => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4] })) });
      return true;
    }
    if (action === 'symbols' && req.method === 'GET') {
      const list = await call(id, 'symbols', { query: url.searchParams.get('query') || '' });
      sendJson(res, 200, { ok: true, symbols: list });
      return true;
    }
    sendJson(res, 404, { ok: false, error: 'Неизвестен API път' });
  } catch (e) {
    sendJson(res, 200, { ok: false, error: e.message });
  }
  return true;
}

module.exports = { route, call, isOnline, owns, listFor, createAgent, removeAgent };
