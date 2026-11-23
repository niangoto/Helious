'use strict';
// DiDemos — интерфейс (без зависимости). Целият потребителски текст се вмъква чрез textContent (защита от XSS).
const app = document.getElementById('app');
const state = { notice: null, user: null, communities: [], tab: 'feed', openId: null, filter: '' };

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const k in (props || {})) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) { if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
  return e;
}
async function api(method, url, body) {
  const r = await fetch(url.replace(/^\//, ''), { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Грешка ' + r.status);
  return d;
}
const fmtDate = (t) => new Date(t).toLocaleString('bg-BG', { dateStyle: 'short', timeStyle: 'short' });
function msg(kind, text) { return el('div', { class: 'msg ' + kind }, text); }
function flash(box, kind, text) { box.replaceChildren(msg(kind, text)); }

// ── Вход / регистрация ──────────────────────────────────────────
function renderAuth() {
  let mode = 'login';
  const box = el('div', { class: 'card auth' });
  const draw = () => {
    const u = el('input', { type: 'text', autocomplete: 'username' });
    const p = el('input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password' });
    const out = el('div');
    const go = async () => {
      try {
        await api('POST', mode === 'login' ? '/api/login' : '/api/register', { username: u.value, password: p.value });
        await boot();
      } catch (e) { flash(out, 'err', e.message); }
    };
    p.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    box.replaceChildren(
      el('h2', null, mode === 'login' ? 'Вход в DiDemos' : 'Нов профил'),
      el('label', null, 'Потребителско име'), u,
      el('label', null, 'Парола' + (mode === 'login' ? '' : ' (поне 6 знака)')), p,
      out,
      el('div', { class: 'row' },
        el('button', { onclick: go }, mode === 'login' ? 'Вход' : 'Създай профил'),
        el('button', { class: 'ghost', onclick: () => { mode = mode === 'login' ? 'register' : 'login'; draw(); } },
          mode === 'login' ? 'Нямам профил' : 'Вече имам профил'))
    );
  };
  draw();
  app.replaceChildren(header(false), el('main', null, box));
}

function header(loggedIn) {
  return el('header', null,
    el('h1', null, 'DiDemos'),
    el('span', { class: 'meta' }, 'гласувай и споделяй мнение'),
    el('span', { class: 'sp' }),
    loggedIn ? [el('span', null, '👤 ' + state.user),
      el('button', { class: 'ghost', onclick: async () => { await api('POST', '/api/logout'); state.user = null; state.openId = null; renderAuth(); } }, 'Изход')] : null);
}

// ── Общности ────────────────────────────────────────────────────
function communityBar() {
  const out = el('div');
  const name = el('input', { type: 'text', placeholder: 'Име на нова общност', maxlength: 80 });
  const code = el('input', { type: 'text', placeholder: 'Код за присъединяване', maxlength: 20 });
  const create = async () => {
    try {
      const c = await api('POST', '/api/communities', { name: name.value });
      await loadCommunities(); state.notice = ['ok', 'Общността „' + c.name + '“ е създадена. Код за присъединяване: ' + c.code];
      render();
    } catch (e) { flash(out, 'err', e.message); }
  };
  const join = async () => {
    try {
      const c = await api('POST', '/api/communities/join', { code: code.value });
      await loadCommunities(); state.notice = ['ok', 'Присъедини се към „' + c.name + '“.']; render();
    } catch (e) { flash(out, 'err', e.message); }
  };
  return el('div', { class: 'card' },
    el('div', { class: 'row' }, el('b', null, 'Общности:'),
      state.communities.length ? state.communities.map((c) => el('span', { class: 'badge', title: c.owner ? 'Ти си създателят' : '' }, c.name + (c.code ? ' · ' + c.code : ''))) : el('span', { class: 'meta' }, 'още не си в нито една')),
    el('div', { class: 'row' }, name, el('button', { onclick: create }, 'Създай общност')),
    el('div', { class: 'row' }, code, el('button', { class: 'ghost', onclick: join }, 'Присъедини се')),
    el('div', null, out, (() => { const n = state.notice; state.notice = null; return n ? msg(n[0], n[1]) : null; })()));
}
async function loadCommunities() { state.communities = await api('GET', '/api/communities'); }
const communitySelect = (value) => el('select', null, state.communities.map((c) => el('option', { value: c.id, selected: c.id === value }, c.name)));

// ── Пано 1: новини (запитвания) ─────────────────────────────────
async function paneFeed(box) {
  if (state.openId) return paneSurvey(box, state.openId);
  const list = await api('GET', '/api/surveys' + (state.filter ? '?communityId=' + encodeURIComponent(state.filter) : ''));
  const sel = el('select', { onchange: (e) => { state.filter = e.target.value; render(); } },
    el('option', { value: '' }, 'Всички общности'),
    state.communities.map((c) => el('option', { value: c.id, selected: c.id === state.filter }, c.name)));
  box.replaceChildren(el('div', { class: 'card' }, sel));
  if (!list.length) box.append(el('div', { class: 'card meta' }, 'Още няма запитвания. Създай първото от панела „Създай запитване“.'));
  for (const s of list) {
    box.append(el('div', { class: 'card news', onclick: () => { state.openId = s.id; render(); } },
      el('h3', null, s.title),
      el('div', { class: 'meta' }, s.community + ' · от ' + s.author + ' · ' + fmtDate(s.createdAt)),
      el('p', null, s.preview + (s.preview.length >= 160 ? '…' : '')),
      el('div', null,
        el('span', { class: 'badge' }, s.options.length ? (s.multiple ? 'Анкета · няколко отговора' : 'Анкета') : 'Свободен текст'),
        s.answered ? el('span', { class: 'badge done' }, '✓ отговорил си') : null,
        s.closed ? el('span', { class: 'badge closed' }, 'затворено') : null)));
  }
}

async function paneSurvey(box, id) {
  const s = await api('GET', '/api/surveys/' + id);
  const out = el('div');
  const checks = s.options.map((o, i) => {
    const on = !!(s.mine && s.mine.choices.includes(i));
    return { i, input: el('input', { type: s.multiple ? 'checkbox' : 'radio', name: 'opt', checked: on }), o };
  });
  const text = el('textarea', { placeholder: 'Напиши мнението си…', maxlength: 3000, value: s.mine ? s.mine.text : '' });
  const send = async () => {
    try {
      await api('POST', '/api/surveys/' + id + '/respond', { choices: checks.filter((c) => c.input.checked).map((c) => c.i), text: text.value });
      flash(out, 'ok', 'Отговорът е записан. Можеш да го промениш по всяко време.');
    } catch (e) { flash(out, 'err', e.message); }
  };
  box.replaceChildren(
    el('button', { class: 'ghost back', onclick: () => { state.openId = null; render(); } }, '← Назад към новините'),
    el('div', { class: 'card' },
      el('h2', null, s.title),
      el('div', { class: 'meta' }, s.community + ' · от ' + s.author + ' · ' + fmtDate(s.createdAt)),
      el('p', { class: 'body-text' }, s.body),
      s.closed ? el('div', { class: 'msg err' }, 'Запитването е затворено.') : [
        s.options.length ? el('div', null, el('b', null, s.multiple ? 'Избери един или повече отговора:' : 'Избери отговор:'),
          checks.map((c) => el('label', { class: 'opt' }, c.input, c.o))) : null,
        s.allowText ? [el('label', null, s.options.length ? 'Допълнителен коментар (по желание)' : 'Твоето мнение'), text] : null,
        out, el('button', { onclick: send }, s.answered ? 'Обнови отговора' : 'Изпрати')]),
    s.isAuthor ? authorBox(s) : null);
}

// ── Следене и обобщение (само за автора) ────────────────────────
function authorBox(s) {
  const holder = el('div');
  const draw = (r) => {
    if (!r) { holder.replaceChildren(el('div', { class: 'meta' }, 'Още няма обобщение.')); return; }
    const list = (title, arr) => arr && arr.length ? [el('h4', null, title), el('ul', null, arr.map((x) => el('li', null, x)))] : null;
    holder.replaceChildren(el('div', { class: 'sum' },
      el('div', null, 'Настроение на мнозинството: ', el('span', { class: 'sent ' + (r.score > 0.2 ? 'pos' : r.score < -0.2 ? 'neg' : '') }, r.sentiment)),
      el('p', null, r.summary),
      list('Критики към предложението', r.criticisms), list('Други предложения', r.suggestions), list('Коментари', r.comments),
      el('div', { class: 'meta' }, 'Базирано на ' + r.responses + ' отговора · ' + fmtDate(r.createdAt) + ' · ' + (r.source === 'ai' ? 'ИИ' : 'автоматично, без ИИ'))));
  };
  const btn = el('button', null, '✨ Обобщение с ИИ');
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Обобщавам…';
    try { draw(await api('POST', '/api/surveys/' + s.id + '/summary')); }
    catch (e) { flash(holder, 'err', e.message); }
    btn.disabled = false; btn.textContent = '✨ Обобщение с ИИ';
  });
  const closeBtn = el('button', { class: 'ghost', onclick: async () => { await api('POST', '/api/surveys/' + s.id + '/close', { closed: !s.closed }); render(); } }, s.closed ? 'Отвори отново' : 'Затвори запитването');
  api('GET', '/api/surveys/' + s.id + '/summary').then(draw).catch(() => {});
  return el('div', { class: 'card' }, el('h3', null, 'За автора: ' + s.responses + ' отговора'),
    el('div', { class: 'row' }, btn, closeBtn), holder);
}

// ── Пано 2: сподели мнение ──────────────────────────────────────
async function paneOpinion(box) {
  if (!state.communities.length) { box.replaceChildren(el('div', { class: 'card meta' }, 'Първо създай общност или се присъедини към такава.')); return; }
  const cSel = communitySelect(), sSel = el('select'), text = el('textarea', { placeholder: 'Какво мислиш? Идея, коментар, критика…', maxlength: 3000 });
  const out = el('div'), recent = el('div');
  const fillSurveys = async () => {
    const list = await api('GET', '/api/surveys?communityId=' + encodeURIComponent(cSel.value));
    sSel.replaceChildren(el('option', { value: '' }, 'Общо мнение за общността'), list.map((s) => el('option', { value: s.id }, 'По запитване: ' + s.title)));
  };
  const loadRecent = async () => {
    const list = await api('GET', '/api/opinions');
    recent.replaceChildren(el('h3', null, 'Последни мнения (анонимни)'), list.length ? list.map((o) => el('div', { class: 'card' },
      el('div', { class: 'meta' }, o.community + (o.survey ? ' · ' + o.survey : '') + ' · ' + fmtDate(o.createdAt) + (o.mine ? ' · твое' : '')),
      el('div', { class: 'body-text' }, o.text))) : el('div', { class: 'meta' }, 'Още няма мнения.'));
  };
  cSel.addEventListener('change', fillSurveys);
  await fillSurveys();
  box.replaceChildren(el('div', { class: 'card' }, el('h2', null, 'Сподели мнение'),
    el('label', null, 'Общност'), cSel, el('label', null, 'Към'), sSel, el('label', null, 'Мнение'), text, out,
    el('button', { onclick: async () => {
      try { await api('POST', '/api/opinions', { communityId: cSel.value, surveyId: sSel.value || null, text: text.value }); text.value = ''; flash(out, 'ok', 'Мнението е изпратено.'); loadRecent(); }
      catch (e) { flash(out, 'err', e.message); }
    } }, 'Изпрати')), recent);
  loadRecent();
}

// ── Пано 3: създай запитване ────────────────────────────────────
async function paneCreate(box) {
  if (!state.communities.length) { box.replaceChildren(el('div', { class: 'card meta' }, 'Първо създай общност или се присъедини към такава.')); return; }
  const cSel = communitySelect(), title = el('input', { type: 'text', maxlength: 160 }), body = el('textarea', { placeholder: 'Пълният въпрос / предложение', maxlength: 5000 });
  const opts = el('textarea', { placeholder: 'Незадължително — по един отговор на ред (напр. Да / Не / Въздържам се). Празно = само свободен текст.' });
  const multi = el('input', { type: 'checkbox' }), allowText = el('input', { type: 'checkbox', checked: true });
  const out = el('div');
  box.replaceChildren(el('div', { class: 'card' }, el('h2', null, 'Създай запитване'),
    el('label', null, 'Общност'), cSel, el('label', null, 'Заглавие'), title, el('label', null, 'Въпрос'), body,
    el('label', null, 'Отговори за анкета'), opts,
    el('label', { class: 'opt' }, multi, 'Може да се избира повече от един отговор'),
    el('label', { class: 'opt' }, allowText, 'Позволи и свободен коментар'), out,
    el('button', { onclick: async () => {
      try {
        const s = await api('POST', '/api/surveys', { communityId: cSel.value, title: title.value, body: body.value,
          options: opts.value.split('\n'), multiple: multi.checked, allowText: allowText.checked });
        state.tab = 'feed'; state.openId = s.id; render();
      } catch (e) { flash(out, 'err', e.message); }
    } }, 'Публикувай')));
  const mine = await api('GET', '/api/surveys');
  const own = mine.filter((s) => s.isAuthor);
  box.append(el('h3', null, 'Моите запитвания'), own.length ? own.map((s) => el('div', { class: 'card news', onclick: () => { state.tab = 'feed'; state.openId = s.id; render(); } },
    el('b', null, s.title), el('div', { class: 'meta' }, s.community + ' · ' + s.responses + ' отговора · ' + fmtDate(s.createdAt)))) : el('div', { class: 'meta' }, 'Още нямаш създадени запитвания.'));
}

// ── Основен изглед ──────────────────────────────────────────────
async function render() {
  const pane = el('div');
  const tab = (id, label) => el('button', { class: state.tab === id ? 'on' : '', onclick: () => { state.tab = id; state.openId = null; render(); } }, label);
  app.replaceChildren(header(true), el('main', null, communityBar(),
    el('div', { class: 'tabs' }, tab('feed', '📰 Новини'), tab('opinion', '💬 Сподели мнение'), tab('create', '➕ Създай запитване')), pane));
  try {
    if (state.tab === 'feed') await paneFeed(pane);
    else if (state.tab === 'opinion') await paneOpinion(pane);
    else await paneCreate(pane);
  } catch (e) { pane.replaceChildren(msg('err', e.message)); }
}

async function boot() {
  const me = await api('GET', '/api/me');
  if (!me.username) return renderAuth();
  state.user = me.username;
  await loadCommunities();
  render();
}
boot().catch((e) => { app.replaceChildren(msg('err', e.message)); });
