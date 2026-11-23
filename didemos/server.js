'use strict';
// DiDemos — сървър без външни зависимости (Node >= 18).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { summarize } = require('./ai');

const PORT = parseInt(process.env.PORT, 10) || 3100;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSION_DAYS = 30;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // без лесно обърквани 0/O/1/I

// ── Хранилище (JSON файл, атомичен запис) ───────────────────────
let db = { users: [], sessions: {}, communities: [], surveys: [], responses: [], opinions: [] };
function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
}
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 50);
}
function saveNow() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
let COOKIE_PATH = '/';
const uid = () => crypto.randomBytes(9).toString('base64url');

// ── Помощни ─────────────────────────────────────────────────────
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (msg) => new HttpError(400, msg);

function send(res, code, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 100 * 1024) { reject(new HttpError(413, 'Твърде голяма заявка')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(bad('Невалиден JSON')); }
    });
    req.on('error', reject);
  });
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Пароли: scrypt със случайна сол.
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(hashHex, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

// Ограничение на опитите за вход/регистрация (по IP).
const attempts = new Map();
function rateLimit(req) {
  const ip = req.socket.remoteAddress || '?', now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 60000);
  if (a.length >= 20) throw new HttpError(429, 'Твърде много опити. Опитай след минута.');
  a.push(now); attempts.set(ip, a);
}

function currentUser(req) {
  const tok = parseCookies(req).didemos_session;
  const s = tok && db.sessions[tok];
  if (!s || s.expires < Date.now()) return null;
  return db.users.find((u) => u.id === s.userId) || null;
}
function startSession(res, user) {
  const tok = crypto.randomBytes(32).toString('base64url');
  db.sessions[tok] = { userId: user.id, expires: Date.now() + SESSION_DAYS * 86400000 };
  saveDb();
  return { 'Set-Cookie': `didemos_session=${tok}; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${SESSION_DAYS * 86400}` };
}
function requireUser(req) {
  const u = currentUser(req);
  if (!u) throw new HttpError(401, 'Трябва да влезеш в профила си');
  return u;
}

// ── Общности ────────────────────────────────────────────────────
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 8; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!db.communities.some((x) => x.code === c)) return c;
  }
}
const myCommunities = (u) => db.communities.filter((c) => c.members.includes(u.id));
function memberCommunity(u, id) {
  const c = db.communities.find((x) => x.id === id);
  if (!c || !c.members.includes(u.id)) throw new HttpError(403, 'Не си член на тази общност');
  return c;
}
const nameOf = (id) => (db.users.find((u) => u.id === id) || {}).username || '—';
function pubCommunity(c, u) {
  return { id: c.id, name: c.name, members: c.members.length, owner: c.ownerId === u.id,
    code: c.ownerId === u.id || c.members.includes(u.id) ? c.code : undefined };
}

// ── Запитвания ──────────────────────────────────────────────────
function surveyView(s, u, full) {
  const c = db.communities.find((x) => x.id === s.communityId);
  const mine = db.responses.find((r) => r.surveyId === s.id && r.userId === u.id);
  const isAuthor = s.authorId === u.id;
  const v = {
    id: s.id, title: s.title, communityId: s.communityId, community: c ? c.name : '—',
    author: nameOf(s.authorId), isAuthor, createdAt: s.createdAt, closed: !!s.closed,
    answered: !!mine, multiple: s.multiple, allowText: s.allowText, options: s.options
  };
  if (full) { v.body = s.body; v.mine = mine ? { choices: mine.choices, text: mine.text } : null; }
  else v.preview = s.body.slice(0, 160);
  if (isAuthor) v.responses = db.responses.filter((r) => r.surveyId === s.id).length;
  return v;
}
function visibleSurvey(u, id) {
  const s = db.surveys.find((x) => x.id === id);
  if (!s) throw new HttpError(404, 'Запитването не е намерено');
  memberCommunity(u, s.communityId);
  return s;
}

// ── API ─────────────────────────────────────────────────────────
async function api(req, res, url) {
  const m = req.method, p = url.pathname;
  const body = (m === 'POST' || m === 'PUT') ? await readBody(req) : {};

  if (m === 'POST' && p === '/api/register') {
    rateLimit(req);
    const username = str(body.username, 32), password = typeof body.password === 'string' ? body.password : '';
    if (!/^[\p{L}0-9_.-]{3,32}$/u.test(username)) throw bad('Потребителското име е 3–32 знака: букви, цифри, _ . -');
    if (password.length < 6 || password.length > 200) throw bad('Паролата трябва да е поне 6 знака');
    if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) throw new HttpError(409, 'Потребителското име е заето');
    const user = { id: uid(), username, passHash: hashPassword(password), createdAt: Date.now() };
    db.users.push(user);
    return send(res, 201, { username }, startSession(res, user));
  }
  if (m === 'POST' && p === '/api/login') {
    rateLimit(req);
    const username = str(body.username, 32), password = typeof body.password === 'string' ? body.password : '';
    const user = db.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user || !checkPassword(password, user.passHash)) throw new HttpError(401, 'Грешно потребителско име или парола');
    return send(res, 200, { username: user.username }, startSession(res, user));
  }
  if (m === 'POST' && p === '/api/logout') {
    const tok = parseCookies(req).didemos_session;
    if (tok) { delete db.sessions[tok]; saveDb(); }
    return send(res, 200, { ok: true }, { 'Set-Cookie': `didemos_session=; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=0` });
  }
  if (m === 'GET' && p === '/api/me') {
    const u = currentUser(req);
    return send(res, 200, u ? { username: u.username } : { username: null });
  }

  const u = requireUser(req);

  if (m === 'GET' && p === '/api/communities') return send(res, 200, myCommunities(u).map((c) => pubCommunity(c, u)));
  if (m === 'POST' && p === '/api/communities') {
    const name = str(body.name, 80);
    if (name.length < 2) throw bad('Въведи име на общността (поне 2 знака)');
    const c = { id: uid(), name, code: newCode(), ownerId: u.id, members: [u.id], createdAt: Date.now() };
    db.communities.push(c); saveDb();
    return send(res, 201, pubCommunity(c, u));
  }
  if (m === 'POST' && p === '/api/communities/join') {
    const code = str(body.code, 20).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const c = db.communities.find((x) => x.code === code);
    if (!c) throw new HttpError(404, 'Няма общност с този код');
    if (!c.members.includes(u.id)) { c.members.push(u.id); saveDb(); }
    return send(res, 200, pubCommunity(c, u));
  }

  if (m === 'GET' && p === '/api/surveys') {
    const ids = myCommunities(u).map((c) => c.id);
    const only = url.searchParams.get('communityId');
    const list = db.surveys.filter((s) => ids.includes(s.communityId) && (!only || s.communityId === only))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
    return send(res, 200, list.map((s) => surveyView(s, u, false)));
  }
  if (m === 'POST' && p === '/api/surveys') {
    const c = memberCommunity(u, str(body.communityId, 40));
    const title = str(body.title, 160), text = str(body.body, 5000);
    if (title.length < 3) throw bad('Въведи заглавие (поне 3 знака)');
    if (text.length < 3) throw bad('Въведи пълния въпрос');
    const options = Array.isArray(body.options) ? body.options.map((o) => str(o, 160)).filter(Boolean).slice(0, 20) : [];
    if (new Set(options).size !== options.length) throw bad('Отговорите трябва да са различни');
    if (options.length === 1) throw bad('Задай поне два отговора или никакъв (свободен текст)');
    const s = { id: uid(), communityId: c.id, authorId: u.id, title, body: text, options,
      multiple: options.length > 1 && !!body.multiple, allowText: options.length === 0 ? true : !!body.allowText,
      closed: false, createdAt: Date.now(), summary: null };
    db.surveys.push(s); saveDb();
    return send(res, 201, surveyView(s, u, true));
  }

  let mt;
  if ((mt = p.match(/^\/api\/surveys\/([\w-]+)$/)) && m === 'GET') return send(res, 200, surveyView(visibleSurvey(u, mt[1]), u, true));

  if ((mt = p.match(/^\/api\/surveys\/([\w-]+)\/respond$/)) && m === 'POST') {
    const s = visibleSurvey(u, mt[1]);
    if (s.closed) throw bad('Запитването е затворено');
    let choices = Array.isArray(body.choices) ? [...new Set(body.choices.map(Number))] : [];
    choices = choices.filter((i) => Number.isInteger(i) && i >= 0 && i < s.options.length);
    if (!s.multiple) choices = choices.slice(0, 1);
    const text = s.allowText ? str(body.text, 3000) : '';
    if (s.options.length && !choices.length && !text) throw bad('Избери отговор' + (s.allowText ? ' или напиши мнение' : ''));
    if (!s.options.length && !text) throw bad('Напиши мнение');
    let r = db.responses.find((x) => x.surveyId === s.id && x.userId === u.id);
    if (r) { r.choices = choices; r.text = text; r.updatedAt = Date.now(); }
    else { r = { id: uid(), surveyId: s.id, userId: u.id, choices, text, createdAt: Date.now() }; db.responses.push(r); }
    saveDb();
    return send(res, 200, { ok: true });
  }

  if ((mt = p.match(/^\/api\/surveys\/([\w-]+)\/close$/)) && m === 'POST') {
    const s = visibleSurvey(u, mt[1]);
    if (s.authorId !== u.id) throw new HttpError(403, 'Само авторът може да затваря запитването');
    s.closed = !!body.closed; saveDb();
    return send(res, 200, { closed: s.closed });
  }

  // Обобщение с ИИ — само за автора.
  if ((mt = p.match(/^\/api\/surveys\/([\w-]+)\/summary$/))) {
    const s = visibleSurvey(u, mt[1]);
    if (s.authorId !== u.id) throw new HttpError(403, 'Обобщение може да иска само авторът');
    if (m === 'GET') return send(res, 200, s.summary || null);
    if (m === 'POST') {
      const resp = db.responses.filter((r) => r.surveyId === s.id);
      const counts = s.options.map((o, i) => ({ option: o, votes: resp.filter((r) => r.choices.includes(i)).length }));
      const texts = resp.filter((r) => r.text).map((r) => r.text);
      const opinions = db.opinions.filter((o) => o.surveyId === s.id).map((o) => o.text);
      const result = await summarize({ title: s.title, body: s.body, counts, responses: resp.length, texts: texts.concat(opinions) });
      s.summary = Object.assign(result, { createdAt: Date.now(), responses: resp.length });
      saveDb();
      return send(res, 200, s.summary);
    }
  }

  // „Сподели мнение“: свободно мнение към общност (по избор — към конкретно запитване).
  if (m === 'POST' && p === '/api/opinions') {
    const c = memberCommunity(u, str(body.communityId, 40));
    const text = str(body.text, 3000);
    if (text.length < 3) throw bad('Напиши мнението си');
    let surveyId = null;
    if (body.surveyId) {
      const s = visibleSurvey(u, str(body.surveyId, 40));
      if (s.communityId !== c.id) throw bad('Запитването не е от тази общност');
      surveyId = s.id;
    }
    db.opinions.push({ id: uid(), communityId: c.id, surveyId, userId: u.id, text, createdAt: Date.now() });
    saveDb();
    return send(res, 201, { ok: true });
  }
  if (m === 'GET' && p === '/api/opinions') {   // анонимно, само от моите общности
    const ids = myCommunities(u).map((c) => c.id);
    const list = db.opinions.filter((o) => ids.includes(o.communityId)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
      .map((o) => ({ id: o.id, text: o.text, createdAt: o.createdAt, mine: o.userId === u.id,
        community: (db.communities.find((c) => c.id === o.communityId) || {}).name,
        survey: o.surveyId ? (db.surveys.find((s) => s.id === o.surveyId) || {}).title : null }));
    return send(res, 200, list);
  }

  throw new HttpError(404, 'Няма такъв адрес');
}

// ── Статични файлове ────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не е намерено');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'",
    'X-Content-Type-Options': 'nosniff'
  });
  fs.createReadStream(file).pipe(res);
}

// Обработчик на заявка. base = префикс, под който е монтиран (напр. '/didemos'); '' = на корена.
function createHandler(base) {
  base = (base || '').replace(/\/+$/, '');
  COOKIE_PATH = base || '/';
  return async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (base) {
        if (url.pathname === base) { res.writeHead(301, { Location: base + '/' + url.search }); return res.end(); }
        url.pathname = url.pathname.slice(base.length) || '/';
      }
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) send(res, e.code, { error: e.message });
      else { console.error(e); send(res, 500, { error: 'Вътрешна грешка' }); }
    }
  };
}
function createServer(base) { return http.createServer(createHandler(base)); }

if (require.main === module) {
  loadDb();
  createServer().listen(PORT, () => console.log('DiDemos работи на http://localhost:' + PORT));
  process.on('SIGINT', () => { saveNow(); process.exit(0); });
  process.on('SIGTERM', () => { saveNow(); process.exit(0); });
}
module.exports = { createServer, createHandler, loadDb, saveNow };
