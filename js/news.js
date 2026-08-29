// News view: движещи новини със сентимент → зелена ▲ (ще расте) / червена ▼ (ще пада).
const NEWS_QUERIES = {
    'BTCUSDT': 'bitcoin BTC',
    'ETHUSDT': 'ethereum ETH',
    'XAUUSD': 'gold price',
    'PAXGUSDT': 'gold price',
    'BZUSDT': 'Brent oil price',
    'CLUSDT': 'WTI oil price',
    'WTI': 'WTI oil price',
    'BRENT': 'Brent oil price',
    'GOLD': 'gold price',
    'DAX': 'DAX index',
    'NDX': 'NASDAQ index',
    'SPX': 'S&P 500 index',
    'DJI': 'Dow Jones index',
    'CAC': 'CAC 40 index',
    'UK100': 'FTSE 100 index',
    'NI225': 'Nikkei 225 index'
};

function newsQueryFor(symbol) {
    if (NEWS_QUERIES[symbol]) return NEWS_QUERIES[symbol];
    const base = symbol.replace('USDT', '');
    return base + (symbol.endsWith('USDT') ? ' crypto price' : ' stock price');
}

// Показва/скрива изгледа с новини.
function toggleNews() {
    const chartView = document.getElementById('chart-view');
    const ivView = document.getElementById('indicator-view');
    const newsView = document.getElementById('news-view');
    const newsBtn = document.getElementById('newsToggle');
    const showing = newsView.style.display !== 'none';
    newsView.style.display = showing ? 'none' : 'flex';
    if (newsBtn) newsBtn.classList.toggle('active', !showing);
    if (!showing) {
        chartView.style.display = 'none';
        ivView.style.display = 'none';
        document.getElementById('viewToggle')?.classList.remove('active');
        loadNews();
    }
}

// Затваря новинарския изглед и връща към графики/табло.
function closeNews() {
    const newsView = document.getElementById('news-view');
    if (newsView) newsView.style.display = 'none';
    document.getElementById('newsToggle')?.classList.remove('active');
}

// Зарежда новините от сървъра и ги рисува като блокчета със сентимент.
async function loadNews() {
    const list = document.getElementById('newsList');
    const header = document.getElementById('newsHeaderLabel');
    if (!list) return;
    const sym = ivCurrentSymbol || currentSymbol || 'BTCUSDT';
    const query = newsQueryFor(sym);
    if (header) header.textContent = '📰 Движещи новини: ' + query;
    list.innerHTML = '<div class="news-empty">Зареждане на новините...</div>';
    try {
        const url = API_BASE
            ? `${API_BASE}/news?query=${encodeURIComponent(query)}`
            : `/news?query=${encodeURIComponent(query)}`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (!data.ok || !data.items || !data.items.length) {
            list.innerHTML = '<div class="news-empty">Няма намерени новини.</div>';
            return;
        }
        list.innerHTML = data.items.map(renderNewsCard).join('');
    } catch (e) {
        console.error('News load error:', e);
        list.innerHTML = '<div class="news-empty">Грешка при зареждане на новините.</div>';
    }
}

// Блокче новина: зелена ▲ (bullish → ще расте), червена ▼ (bearish → ще пада) + съдържание.
function renderNewsCard(it) {
    const arrow = it.sentiment === 'bullish' ? '▲' : it.sentiment === 'bearish' ? '▼' : '●';
    const cls = it.sentiment === 'bullish' ? 'bullish' : it.sentiment === 'bearish' ? 'bearish' : 'neutral';
    const meta = [it.source, it.date && new Date(it.date).toLocaleTimeString ? new Date(it.date).toLocaleString('bg-BG', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''].filter(Boolean).join(' · ');
    const summary = it.summary && it.summary.length > 10 ? `<div class="news-summary">${escapeHtml(it.summary)}</div>` : '';
    return `<div class="news-card ${cls}" onclick="window.open('${(it.link || '').replace(/'/g, '')}','_blank')">
        <div class="news-card-top">
            <span class="news-arrow ${cls}">${arrow}</span>
            <span class="news-title">${escapeHtml(it.title || '')}</span>
        </div>
        ${summary}
        <div class="news-meta"><span>${it.sentiment === 'bullish' ? 'Ще расте' : it.sentiment === 'bearish' ? 'Ще пада' : 'Неутрално'}</span><span>${escapeHtml(meta)}</span></div>
    </div>`;
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
