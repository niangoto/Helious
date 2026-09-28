// Calculator view: начален капитал, цени, обем, леверидж, колебание и марджин.
// Показва/скрива изгледа с калкулатор.
function toggleCalculator() {
    closeNews();
    const chartView = document.getElementById('chart-view');
    const ivView = document.getElementById('indicator-view');
    const calcView = document.getElementById('calculator-view');
    const calcBtn = document.getElementById('calculatorToggle');
    const showing = calcView.style.display !== 'none';
    calcView.style.display = showing ? 'none' : 'flex';
    if (calcBtn) calcBtn.classList.toggle('active', !showing);
    if (!showing) {
        chartView.style.display = 'none';
        ivView.style.display = 'none';
        document.getElementById('viewToggle')?.classList.remove('active');
        calcCompute();
    }
}

// Затваря изгледа с калкулатор и връща към графики/табло.
function closeCalculator() {
    const calcView = document.getElementById('calculator-view');
    if (calcView) calcView.style.display = 'none';
    document.getElementById('calculatorToggle')?.classList.remove('active');
}

function calcNum(id) {
    const el = document.getElementById(id);
    if (!el) return NaN;
    const v = el.value.trim();
    return v === '' ? NaN : parseFloat(v);
}

// Смята при кои по-високи (Buy) или по-ниски (Sell) цени може да се отвори
// още 1 обем, така че:
//   - да има свободен марджин за него;
//   - ако цената се движи срещу позицията с колебанието, марджин нивото
//     (Equity / Използван марджин × 100) да остане >= минималния процент
//     (вкл. новоотворената позиция).
// Връща { levels: [{ price, total, profit }], capped, error }.
function calcBuildLevels(p) {
    const V = p.volume, L = p.leverage, C = p.capital, M = p.margin;
    const fxRate = p.fxRate || 1.14; // Курс EUR/USD (1 EUR = fxRate USD)
    const C_usd = C * fxRate;       // Капитал в USD за изчисленията с котировките
    const pct = p.unit === 'pct';
    const buy = p.direction !== 'sell';
    const k = buy ? 1 : -1;          // +1 дълга, -1 къса позиция
    const levels = [];

    // --- ПРОВЕРКА НА ПЪРВАТА ПОЗИЦИЯ ---
    const reqInitialMarginEur = (V * p.entry) / (L * fxRate);
    if (C < reqInitialMarginEur) {
        return {
            levels: [],
            capped: false,
            error: `Началният капитал (${calcFmtMoney(C)}) не стига за отваряне на първата позиция. Необходим марджин: ${calcFmtMoney(reqInitialMarginEur)}.`
        };
    }

    levels.push({ price: p.entry, total: C, profit: 0 });  // първата позиция е на началната цена
    let A = p.entry;   // сума на входните цени на отворените позиции
    let m = 1;         // брой отворени позиции
    let last = p.entry;
    const MAX = 1000;
    let capped = false;

    for (let i = 0; i < MAX; i++) {
        let Pa, Pb;
        if (buy) {
            // Условие А: свободният марджин стига за още 1 обем при цена P.
            const denA = m - 1 / L;
            Pa = denA > 0 ? (A * (1 + 1 / L) - C_usd / V) / denA : Infinity;

            // Условие B: марджин нивото след спад с колебанието е >= M.
            if (pct) {
                const denB = 100 * L * m - M - L * (m + 1) * p.volatility;
                Pb = denB > 0 ? (A * (M + 100 * L) - 100 * L * C_usd / V) / denB : Infinity;
            } else {
                const denB = 100 * L * m - M;
                Pb = denB > 0 ? (A * (M + 100 * L) + 100 * L * (m + 1) * p.volatility - 100 * L * C_usd / V) / denB : Infinity;
            }
        } else {
            // Sell: новите позиции се отварят на по-ниски цени, а неблагоприятното
            // движение е нагоре с колебанието. Условията дават горна граница за P.
            const denA = m + 1 / L;
            Pa = (C_usd / V + A * (1 - 1 / L)) / denA;

            if (pct) {
                const denB = 100 * L * m + M + L * (m + 1) * p.volatility;
                Pb = (A * (100 * L - M) + 100 * L * C_usd / V) / denB;
            } else {
                const denB = 100 * L * m + M;
                Pb = (A * (100 * L - M) + 100 * L * C_usd / V - 100 * L * (m + 1) * p.volatility) / denB;
            }
        }

        // Buy: най-ниската сигурна цена над последната; Sell: най-високата под нея.
        let price = buy ? Math.max(Pa, Pb) : Math.min(Pa, Pb);
        if (!Number.isFinite(price)) break;
        price = buy ? Math.max(price, last) : Math.min(price, last);
        if (buy ? price >= p.exit : price <= p.exit) break;

        A += price;
        m += 1;
        last = price;

        // Превалутиране на плаващата печалба и общата стойност обратно в EUR
        const profitEur = (k * V * (m * price - A)) / fxRate;
        const totalEur = C + profitEur;

        const prev = levels[levels.length - 1];
        if (prev && Math.abs(price - prev.price) < 1e-9) {
            prev.total = totalEur;              // същата цена -> обединяваме
            prev.profit = profitEur;
        } else {
            levels.push({ price, total: totalEur, profit: profitEur });
        }
        if (i === MAX - 1) capped = true;
    }

    // Последният ред е общата сума на крайната цена.
    const lastPrice = levels[levels.length - 1].price;
    if (Math.abs(p.exit - lastPrice) > 1e-9) {
        const profitEur = (k * V * (m * p.exit - A)) / fxRate;
        levels.push({ price: p.exit, total: C + profitEur, profit: profitEur, final: true });
    }
    return { levels, capped };
}

function calcFmtPrice(v) {
    const abs = Math.abs(v);
    const d = abs < 1 ? 6 : abs < 100 ? 4 : 2;
    return v.toLocaleString('bg-BG', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function calcFmtMoney(v) {
    return v.toLocaleString('bg-BG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function renderCalcLevels(levels, capped, error) {
    const list = document.getElementById('calcLevels');
    if (!list) return;

    if (error) {
        list.innerHTML = `<div class="calc-empty">${error}</div>`;
        return;
    }

    if (!levels || !levels.length) {
        list.innerHTML = '<div class="calc-empty">Няма достижимо ниво за нова позиция до крайната цена.</div>';
        return;
    }
    let html = levels.map((lv, i) => {
        return `<div class="calc-level${lv.final ? ' final' : ''}">
            <span class="calc-level-idx">${i + 1}</span>
            <span class="calc-level-price">${calcFmtPrice(lv.price)}</span>
            <span class="calc-level-total">${calcFmtMoney(lv.total)} <span class="calc-level-profit">(+${calcFmtMoney(lv.profit)})</span></span>
        </div>`;
    }).join('');
    if (capped) {
        html += '<div class="calc-empty">Показани първи 1000 нива (твърде много за изчисляване).</div>';
    }
    list.innerHTML = html;
}

let calcTimer = null;
function calcSchedule() {
    clearTimeout(calcTimer);
    calcTimer = setTimeout(calcCompute, 120);
}

// Сменя посоката Buy/Sell: обновява подсказката за крайната цена и преизчислява.
function calcDirectionChange() {
    const dir = document.getElementById('calcDirection')?.value;
    const ex = document.getElementById('calcExit');
    if (ex) ex.placeholder = dir === 'sell' ? 'напр. 55000' : 'напр. 65000';
    calcSchedule();
}

// Чете входните данни и пресмята нивата.
function calcCompute() {
    const list = document.getElementById('calcLevels');
    if (!list) return;

    const p = {
        capital: calcNum('calcCapital'),
        entry: calcNum('calcEntry'),
        volume: calcNum('calcVolume'),
        exit: calcNum('calcExit'),
        leverage: calcNum('calcLeverage'),
        volatility: calcNum('calcVolatility'),
        margin: calcNum('calcMargin'),
        fxRate: calcNum('calcFxRate') || calcNum('calcEurUsd') || 1.14,
        direction: document.getElementById('calcDirection')?.value || 'buy',
        unit: document.getElementById('calcVolatilityUnit')?.value || 'pct'
    };

    const dirOk = p.direction === 'sell' ? p.exit < p.entry : p.exit > p.entry;
    const valid = [p.capital, p.entry, p.volume, p.exit, p.leverage, p.margin, p.fxRate].every(Number.isFinite)
        && p.leverage > 0 && p.volume > 0 && p.entry > 0
        && dirOk && p.margin >= 0 && p.fxRate > 0
        && Number.isFinite(p.volatility) && p.volatility >= 0;

    if (!valid) {
        list.innerHTML = '<div class="calc-empty">Въведи валидни стойности, за да започне изчислението.</div>';
        return;
    }

    const { levels, capped, error } = calcBuildLevels(p);
    renderCalcLevels(levels, capped, error);
}