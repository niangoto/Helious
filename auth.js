// Профили и сесии за вход. Пази потребители и токени в ./data/auth.json
// (в Docker това е volume, така че оцелява рестарт). Паролите са scrypt хешове.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'auth.json');
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 дни

let store = null;

function load() {
  if (store) return;
  try {
    store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    store = { users: [], tokens: {} };
  }
  if (!Array.isArray(store.users)) store.users = [];
  if (!store.tokens || typeof store.tokens !== 'object') store.tokens = {};
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
  } catch (e) { /* ignore */ }
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return 'scrypt:' + salt + ':' + hash;
}

function verifyPassword(pw, stored) {
  try {
    const [alg, salt, hash] = String(stored).split(':');
    if (alg !== 'scrypt' || !salt || !hash) return false;
    const calc = crypto.scryptSync(pw, salt, 64);
    const orig = Buffer.from(hash, 'hex');
    return calc.length === orig.length && crypto.timingSafeEqual(calc, orig);
  } catch (e) { return false; }
}

const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const publicUser = (u) => ({ id: u.id, email: u.email, createdAt: u.createdAt });
const normEmail = (e) => String(e || '').toLowerCase().trim();

function findUser(email) { load(); return store.users.find(u => u.email === normEmail(email)); }

function createUser(email, password) {
  load();
  const em = normEmail(email);
  if (!em || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw new Error('Невалиден имейл');
  if (!password || String(password).length < 6) throw new Error('Паролата трябва да е поне 6 знака');
  if (findUser(em)) throw new Error('Вече има профил с този имейл');
  const user = { id: crypto.randomBytes(8).toString('hex'), email: em, pass: hashPassword(password), createdAt: Date.now() };
  store.users.push(user);
  save();
  return publicUser(user);
}

function verifyUser(email, password) {
  const u = findUser(email);
  if (!u) return null;
  return verifyPassword(password, u.pass) ? publicUser(u) : null;
}

function createToken(userId) {
  load();
  const token = crypto.randomBytes(32).toString('hex');
  store.tokens[tokenHash(token)] = { userId, exp: Date.now() + TOKEN_TTL_MS };
  save();
  return token;
}

function verifyToken(token) {
  load();
  if (!token) return null;
  const key = tokenHash(token);
  const rec = store.tokens[key];
  if (!rec) return null;
  if (rec.exp < Date.now()) { delete store.tokens[key]; save(); return null; }
  const u = store.users.find(x => x.id === rec.userId);
  return u ? publicUser(u) : null;
}

function deleteToken(token) {
  load();
  if (!token) return;
  delete store.tokens[tokenHash(token)];
  save();
}

module.exports = { createUser, verifyUser, createToken, verifyToken, deleteToken };
