// Изпълнява SQL миграциите от ./migrations при стартиране.
// Идемпотентно: приложените версии се пазят в schema_migrations.

const fs = require('fs');
const path = require('path');
const db = require('./db');

const DIR = path.join(__dirname, 'migrations');

async function run() {
  if (!db.isEnabled()) {
    console.warn('[migrate] базата е изключена — пропускам миграциите.');
    return { applied: 0, skipped: true };
  }

  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const applied = new Set((await db.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
  let files = [];
  try {
    files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
  } catch (e) {
    console.warn('[migrate] няма папка migrations — пропускам.');
    return { applied: 0, skipped: true };
  }

  let count = 0;
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
    console.log(`[migrate] прилагам ${version}...`);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      count++;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`миграция ${version} се провали: ${e.message}`);
    } finally {
      client.release();
    }
  }
  console.log(`[migrate] готово — приложени ${count} нови, общо ${files.length}.`);
  return { applied: count, total: files.length };
}

module.exports = { run };
