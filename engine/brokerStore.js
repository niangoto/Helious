// Съхранение на борсовите (Binance Testnet) API ключове — криптирано.
// Секретът се пази AES-256-GCM в ./data/broker.json и НИКОГА не се връща
// към клиента. Ключът за криптиране идва от ENCRYPTION_KEY (hex, 32 байта)
// или се генерира веднъж в ./data/.broker_key.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'broker.json');
const KEYFILE = path.join(DATA_DIR, '.broker_key');

let store = null;

function encKey() {
  const env = String(process.env.ENCRYPTION_KEY || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(env)) return Buffer.from(env, 'hex');
  try {
    const hex = fs.readFileSync(KEYFILE, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  } catch (e) { /* няма файл */ }
  const buf = crypto.randomBytes(32);
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(KEYFILE, buf.toString('hex'), { mode: 0o600 }); } catch (e) {}
  return buf;
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decrypt(blob) {
  try {
    const b = Buffer.from(blob, 'base64');
    const iv = b.slice(0, 12), tag = b.slice(12, 28), ct = b.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) { return null; }
}

function load() {
  if (store) return;
  try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { store = {}; }
  if (typeof store !== 'object' || store === null) store = {};
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
  } catch (e) { /* ignore */ }
}

function mask(k) {
  const s = String(k || '');
  if (s.length <= 8) return '••••';
  return s.slice(0, 4) + '…' + s.slice(-4);
}

// Пази ключовете за даден профил (ownerId). Връща маскиран изглед.
function setCredentials(ownerId, { market, apiKey, apiSecret }) {
  load();
  market = (market === 'futures') ? 'futures' : 'spot';
  store[ownerId] = {
    market,
    apiKey: String(apiKey || ''),
    secret: encrypt(apiSecret),
    updatedAt: Date.now()
  };
  save();
  return statusFor(ownerId);
}

function getCredentials(ownerId) {
  load();
  const e = store[ownerId];
  if (!e) return null;
  const secret = e.secret ? decrypt(e.secret) : null;
  if (!secret) return null;
  return { market: e.market, apiKey: e.apiKey, apiSecret: secret };
}

function statusFor(ownerId) {
  load();
  const e = store[ownerId];
  if (!e) return { ok: true, saved: false };
  return { ok: true, saved: true, market: e.market, apiKey: mask(e.apiKey), updatedAt: e.updatedAt };
}

function removeCredentials(ownerId) {
  load();
  delete store[ownerId];
  save();
  return { ok: true, saved: false };
}

module.exports = { setCredentials, getCredentials, statusFor, removeCredentials };
