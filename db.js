// Слой за база данни (PostgreSQL).
// Локално, ако `pg` не е инсталиран или няма DATABASE_URL, базата е изключена —
// приложението продължава да работи (полезно за dev без Docker).

let pg = null;
try { pg = require('pg'); } catch (e) { pg = null; }

let pool = null;
let enabled = false;
let lastError = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function init() {
  if (!pg) {
    console.warn('[db] пакетът "pg" липсва — базата е изключена (dev режим).');
    return false;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('[db] DATABASE_URL не е зададен — базата е изключена.');
    return false;
  }

  const attempts = Math.max(1, parseInt(process.env.DB_CONNECT_RETRIES || '30', 10));
  const delay = Math.max(500, parseInt(process.env.DB_CONNECT_DELAY_MS || '2000', 10));

  for (let i = 1; i <= attempts; i++) {
    try {
      pool = new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30000 });
      pool.on('error', (e) => { lastError = e.message; console.error('[db] pool error:', e.message); });
      await pool.query('SELECT 1');
      enabled = true;
      console.log('[db] свързана с PostgreSQL.');
      return true;
    } catch (e) {
      lastError = e.message;
      if (pool) { await pool.end().catch(() => {}); pool = null; }
      if (i < attempts) {
        console.warn(`[db] опит ${i}/${attempts} неуспешен (${e.message}) — повтарям след ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  console.error('[db] не успях да се свържа:', lastError);
  return false;
}

async function health() {
  if (!pg || !pool) return { enabled: false, ok: false, error: lastError };
  try {
    await pool.query('SELECT 1');
    return { enabled: true, ok: true };
  } catch (e) {
    return { enabled: true, ok: false, error: e.message };
  }
}

function query(text, params) {
  if (!pool) return Promise.reject(new Error('DB disabled'));
  return pool.query(text, params);
}

function connect() {
  if (!pool) return Promise.reject(new Error('DB disabled'));
  return pool.connect();
}

async function close() {
  if (pool) { await pool.end().catch(() => {}); pool = null; enabled = false; }
}

module.exports = { init, health, query, connect, close, isEnabled: () => enabled };
