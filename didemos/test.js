'use strict';
// Интеграционен тест: node test.js (стартира сървъра на случаен порт с временна база).
const os = require('os'), fs = require('fs'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'didemos-'));
delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY;
const test = require('node:test'), assert = require('node:assert/strict');
const { createServer, loadDb } = require('./server');

let base; const server = createServer();
test.before(async () => { loadDb(); await new Promise((r) => server.listen(0, r)); base = 'http://localhost:' + server.address().port; });
test.after(() => server.close());

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: await r.json() };
  };
}

test('целият поток: профили, общност, запитване, отговори, обобщение', async () => {
  const a = client(), b = client(), anon = client();
  assert.equal((await anon('GET', '/api/communities')).status, 401);
  assert.equal((await a('POST', '/api/register', { username: 'ана', password: '123' })).status, 400);
  assert.equal((await a('POST', '/api/register', { username: 'ана', password: 'тайна123' })).status, 201);
  assert.equal((await anon('POST', '/api/register', { username: 'АНА', password: 'тайна123' })).status, 409);
  assert.equal((await b('POST', '/api/register', { username: 'борис', password: 'тайна123' })).status, 201);
  assert.equal((await anon('POST', '/api/login', { username: 'ана', password: 'грешна' })).status, 401);

  const com = (await a('POST', '/api/communities', { name: 'Съвет на входа' })).data;
  assert.match(com.code, /^[A-Z2-9]{8}$/);
  // борис още не е член
  assert.equal((await b('POST', '/api/surveys', { communityId: com.id, title: 'x', body: 'y' })).status, 403);
  assert.equal((await b('POST', '/api/communities/join', { code: 'NOPE0000' })).status, 404);
  assert.equal((await b('POST', '/api/communities/join', { code: com.code.toLowerCase() })).status, 200);

  const s = (await a('POST', '/api/surveys', { communityId: com.id, title: 'Нов асансьор', body: 'Да сменим ли асансьора?', options: ['Да', 'Не'], multiple: false, allowText: true })).data;
  assert.equal((await a('POST', '/api/surveys', { communityId: com.id, title: 'едно', body: 'само един отговор', options: ['А'] })).status, 400);
  const feed = (await b('GET', '/api/surveys')).data;
  assert.equal(feed.length, 1); assert.equal(feed[0].responses, undefined);   // само авторът вижда броя

  assert.equal((await b('POST', `/api/surveys/${s.id}/respond`, { choices: [] })).status, 400);
  assert.equal((await b('POST', `/api/surveys/${s.id}/respond`, { choices: [0, 1], text: 'Добра идея, но е скъпо. Предлагам да се събират пари на вноски.' })).status, 200);
  assert.equal((await b('POST', `/api/surveys/${s.id}/respond`, { choices: [0], text: 'Подкрепям, добре е за хората.' })).status, 200);   // презаписва
  assert.equal((await a('POST', `/api/surveys/${s.id}/respond`, { choices: [1], text: 'Против, лош момент и скъпо.' })).status, 200);
  assert.equal((await b('POST', '/api/opinions', { communityId: com.id, surveyId: s.id, text: 'Предлагам по-евтин ремонт вместо смяна.' })).status, 201);

  assert.equal((await b('POST', `/api/surveys/${s.id}/summary`)).status, 403);   // не е автор
  const sum = (await a('POST', `/api/surveys/${s.id}/summary`)).data;
  assert.equal(sum.responses, 2); assert.equal(sum.source, 'local');
  assert.ok(sum.suggestions.length >= 1 && sum.summary.includes('гласове'));
  assert.equal((await a('GET', `/api/surveys/${s.id}`)).data.responses, 2);
  assert.equal((await b('GET', `/api/surveys/${s.id}`)).data.mine.choices[0], 0);
});

test('чужд човек не вижда запитвания и не пробива статичните файлове', async () => {
  const c = client(); await c('POST', '/api/register', { username: 'чужд', password: 'тайна123' });
  assert.equal((await c('GET', '/api/surveys')).data.length, 0);
  assert.equal((await fetch(base + '/..%2fserver.js')).status, 404);
  assert.equal((await fetch(base + '/')).status, 200);
});
