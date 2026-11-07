// Page 11: Кубична регресия (3-та степен), без вероятности.
// Напасва y = a·x³ + b·x² + c·x + d върху избрания период (x е нормализиран
// 0..1), показва приблизителната крива и нейното продължение след данните.

(function () {
    let cubicCandles = [];
    let cubicBound = false;

    function cubicFitWindow() {
        const el = document.getElementById('cubicFitWindow');
        const v = el ? parseInt(el.value, 10) : 0;
        return Math.max(0, v || 0);   // 0 = всички
    }

    function cubicExtBars() {
        const el = document.getElementById('cubicExtBars');
        const v = el ? parseInt(el.value, 10) : 20;
        return Math.max(1, Math.min(500, v || 20));
    }

    function cubicMode() {
        const el = document.getElementById('cubicMode');
        const v = el ? el.value : 'interp4';
        return v === 'regression' ? 'regression' : (v === 'spline' ? 'spline' : 'interp4');
    }

    // linear = стабилно линейно продължение (по подразбиране), cubic = последният сегмент.
    function cubicExtMode() {
        const el = document.getElementById('cubicExtMode');
        return el && el.value === 'cubic' ? 'cubic' : 'linear';
    }

    // Среден наклон на центровете за последните до 20 бара (за линейно продължение).
    function linearSlopeCenters(candles, fromIdx, toIdx) {
        const k = Math.max(1, Math.min(20, toIdx - fromIdx));
        return (candleCenter(candles[toIdx]) - candleCenter(candles[toIdx - k])) / k;
    }

    // Център на свещта (средата на high-low диапазона) — точка за напасването.
    function candleCenter(c) {
        if (!c) return 0;
        if (isFinite(c.high) && isFinite(c.low)) return (c.high + c.low) / 2;
        if (isFinite(c.open) && isFinite(c.close)) return (c.open + c.close) / 2;
        return isFinite(c.close) ? c.close : 0;
    }

    // Решава 4×4 линейна система с частично водещ елемент. Връща [d,c,b,a].
    function solve4(A, v) {
        const M = A.map((row, i) => row.concat([v[i]]));
        for (let col = 0; col < 4; col++) {
            let piv = col;
            for (let r = col + 1; r < 4; r++) {
                if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
            }
            if (Math.abs(M[piv][col]) < 1e-12) return null;
            if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
            const div = M[col][col];
            for (let c = col; c < 5; c++) M[col][c] /= div;
            for (let r = 0; r < 4; r++) {
                if (r === col) continue;
                const f = M[r][col];
                if (!f) continue;
                for (let c = col; c < 5; c++) M[r][c] -= f * M[col][c];
            }
        }
        return [M[0][4], M[1][4], M[2][4], M[3][4]];
    }

    function cubicEval(c, x) {
        return ((c.a * x + c.b) * x + c.c) * x + c.d;
    }

    function fitCubic(candles, fromIdx, toIdx) {
        const m = toIdx - fromIdx + 1;
        if (m < 4) return null;
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, s5 = 0, s6 = 0;
        let t0 = 0, t1 = 0, t2 = 0, t3 = 0;
        for (let i = fromIdx; i <= toIdx; i++) {
            const x = (i - fromIdx) / (m - 1);
            const x2 = x * x, x3 = x2 * x;
            const y = candleCenter(candles[i]);
            s0 += 1; s1 += x; s2 += x2; s3 += x3;
            s4 += x2 * x2; s5 += x2 * x3; s6 += x3 * x3;
            t0 += y; t1 += x * y; t2 += x2 * y; t3 += x3 * y;
        }
        const sol = solve4([
            [s0, s1, s2, s3],
            [s1, s2, s3, s4],
            [s2, s3, s4, s5],
            [s3, s4, s5, s6]
        ], [t0, t1, t2, t3]);
        if (!sol) return null;
        const c = { d: sol[0], c: sol[1], b: sol[2], a: sol[3] };
        let mean = 0;
        for (let i = fromIdx; i <= toIdx; i++) mean += candleCenter(candles[i]);
        mean /= m;
        let sse = 0, sst = 0;
        for (let i = fromIdx; i <= toIdx; i++) {
            const x = (i - fromIdx) / (m - 1);
            const e = candleCenter(candles[i]) - cubicEval(c, x);
            sse += e * e;
            const dm = candleCenter(candles[i]) - mean;
            sst += dm * dm;
        }
        c.r2 = sst > 0 ? 1 - sse / sst : 0;
        c.fromIdx = fromIdx;
        c.toIdx = toIdx;
        c.m = m;
        return c;
    }


    // Една кубична, която минава ТОЧНО през 4 точки: първата, последната и
    // най-добрата двойка вътрешни центрове (минимизира общата грешка).
    function fitCubic4(candles, fromIdx, toIdx) {
        const m = toIdx - fromIdx + 1;
        if (m < 4) return null;
        const cand = [];
        for (const p of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
            const idx = fromIdx + Math.round(p * (m - 1));
            if (idx > fromIdx && idx < toIdx && cand.indexOf(idx) < 0) cand.push(idx);
        }
        if (cand.length < 2) return null;
        const xOf = i => (i - fromIdx) / (m - 1);
        const yOf = i => candleCenter(candles[i]);
        let mean = 0;
        for (let i = fromIdx; i <= toIdx; i++) mean += yOf(i);
        mean /= m;
        let best = null;
        for (let ai = 0; ai < cand.length - 1; ai++) {
            for (let bi = ai + 1; bi < cand.length; bi++) {
                const idxs = [fromIdx, cand[ai], cand[bi], toIdx];
                const A = [], rhs = [];
                for (const i of idxs) {
                    const x = xOf(i);
                    A.push([x * x * x, x * x, x, 1]);
                    rhs.push(yOf(i));
                }
                const sol = solve4(A, rhs);
                if (!sol) continue;
                const c = { a: sol[0], b: sol[1], c: sol[2], d: sol[3] };
                let sse = 0, sst = 0;
                for (let i = fromIdx; i <= toIdx; i++) {
                    const x = xOf(i);
                    const e = yOf(i) - cubicEval(c, x);
                    sse += e * e;
                    const dm = yOf(i) - mean;
                    sst += dm * dm;
                }
                c.r2 = sst > 0 ? 1 - sse / sst : 0;
                c.anchors = idxs;
                c.fromIdx = fromIdx;
                c.toIdx = toIdx;
                c.m = m;
                c.sse = sse;
                if (!best || sse < best.sse - 1e-12) best = c;
            }
        }
        return best;
    }

    // Монотонен кубичен сплайн (PCHIP) през центровете (h=1 в бар-индекси).
    // Минава ТОЧНО през всяка свещ, но без силни превишавания/трептения между тях
    // и с по-стабилно продължение от естествен кубичен сплайн.
    function buildCubicSpline(candles, fromIdx, toIdx) {
        const m = toIdx - fromIdx + 1;
        if (m < 4) return null;
        const ys = [];
        for (let i = fromIdx; i <= toIdx; i++) ys.push(candleCenter(candles[i]));
        const delta = new Array(m - 1);
        for (let i = 0; i < m - 1; i++) delta[i] = ys[i + 1] - ys[i];
        const slopes = new Array(m).fill(0);
        if (m === 2) {
            slopes[0] = slopes[1] = delta[0];
        } else {
            slopes[0] = delta[0];
            slopes[m - 1] = delta[m - 2];
            for (let i = 1; i < m - 1; i++) {
                const d0 = delta[i - 1], d1 = delta[i];
                if (d0 * d1 <= 0) {
                    slopes[i] = 0;
                } else {
                    slopes[i] = (2 * d0 * d1) / (d0 + d1);
                }
            }
        }
        const y0 = ys[m - 2], y1 = ys[m - 1];
        const m0 = slopes[m - 2], m1 = slopes[m - 1];
        // Последен сегмент в t: y = a·t³ + b·t² + c·t + d (t = бар − (N−2)).
        const last = {
            a: 2 * y0 + m0 - 2 * y1 + m1,
            b: -3 * y0 - 2 * m0 + 3 * y1 - m1,
            c: m0,
            d: y0
        };
        return { ys, slopes, m, fromIdx, last };
    }

    function splineSeg(ys, slopes, i, t) {
        const y0 = ys[i], y1 = ys[i + 1];
        const m0 = slopes[i] || 0, m1 = slopes[i + 1] || 0;
        const t2 = t * t, t3 = t2 * t;
        return (2 * t3 - 3 * t2 + 1) * y0 +
            (t3 - 2 * t2 + t) * m0 +
            (-2 * t3 + 3 * t2) * y1 +
            (t3 - t2) * m1;
    }

    function splineEval(sp, x) {
        const m = sp.m;
        if (x <= 0) return splineSeg(sp.ys, sp.slopes, 0, x);
        if (x >= m - 1) return splineSeg(sp.ys, sp.slopes, m - 2, x - (m - 2));
        const i = Math.floor(x);
        return splineSeg(sp.ys, sp.slopes, i, x - i);
    }

    function medianStep(candles) {
        const diffs = [];
        for (let i = Math.max(1, candles.length - 20); i < candles.length; i++) {
            const d = candles[i].time - candles[i - 1].time;
            if (d > 0) diffs.push(d);
        }
        if (!diffs.length) return 3600;
        diffs.sort((a, b) => a - b);
        return diffs[Math.floor(diffs.length / 2)] || 3600;
    }

    function fmtPrice(v) {
        if (v == null || !isFinite(v)) return '---';
        const abs = Math.abs(v);
        const frac = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
        return v.toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac });
    }

    function fmtCoef(v) {
        if (v == null || !isFinite(v)) return '0';
        const abs = Math.abs(v);
        if (abs === 0) return '0';
        if (abs >= 0.001 && abs < 1e6) return v.toFixed(4);
        return v.toExponential(3);
    }

    function cubicEquation(c, v) {
        v = v || 'x';
        const sgn = x => x < 0 ? '−' : '+';
        return 'y = ' + fmtCoef(c.a) + '·' + v + '³ ' + sgn(c.b) + ' ' + fmtCoef(Math.abs(c.b)) +
            '·' + v + '² ' + sgn(c.c) + ' ' + fmtCoef(Math.abs(c.c)) +
            '·' + v + ' ' + sgn(c.d) + ' ' + fmtCoef(Math.abs(c.d));
    }

    function fmtTime(t) {
        try {
            return new Date(t * 1000).toLocaleString('bg-BG', {
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
            });
        } catch (e) { return ''; }
    }

    function syncCubicCutoff() {
        const cut = document.getElementById('cubicCutoff');
        const label = document.getElementById('cubicCutoffLabel');
        if (!cut || typeof latestCandles === 'undefined' || !latestCandles || !latestCandles.length) return;
        cut.max = String(latestCandles.length - 1);
        let idx = latestCandles.length - 1;
        if (typeof presentLineLocked !== 'undefined' && presentLineLocked &&
            typeof presentCutoffTime === 'number' && presentCutoffTime) {
            for (let i = latestCandles.length - 1; i >= 0; i--) {
                if (latestCandles[i].time <= presentCutoffTime) { idx = i; break; }
            }
        }
        if (document.activeElement !== cut) cut.value = String(idx);
        if (label) {
            if (typeof presentLineLocked === 'boolean' && presentLineLocked &&
                typeof presentCutoffTime === 'number' && presentCutoffTime) {
                label.textContent = new Date(presentCutoffTime * 1000).toLocaleString('bg-BG', {
                    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
                });
            } else {
                label.textContent = 'СЕГА';
            }
        }
    }

    function bindCubicUI() {
        if (cubicBound) return;
        cubicBound = true;
        ['cubicFitWindow', 'cubicExtBars', 'cubicMode', 'cubicExtMode'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', () => {
                drawCubicPage();
                if (typeof updateCubicOverlay === 'function' && cubicCandles.length) {
                    updateCubicOverlay(cubicCandles);
                }
            });
        });
        const cut = document.getElementById('cubicCutoff');
        if (cut) {
            cut.addEventListener('input', () => {
                if (typeof latestCandles === 'undefined' || !latestCandles || !latestCandles.length) return;
                const idx = Math.max(0, Math.min(latestCandles.length - 1, parseInt(cut.value, 10) || 0));
                presentLineLocked = true;
                presentCutoffTime = latestCandles[idx].time;
                if (typeof window.updatePresentLinePosition === 'function') window.updatePresentLinePosition();
                if (typeof recomputePredictions === 'function') recomputePredictions();
                syncCubicCutoff();
            });
        }
        syncCubicCutoff();
        window.addEventListener('resize', () => {
            if (cubicCandles.length) drawCubicPage();
        });
    }

    function drawCubicPage() {
        const cvs = document.getElementById('cubicCanvas');
        const info = document.getElementById('cubicInfo');
        const legend = document.getElementById('cubicLegend');
        if (!cvs) return;
        const wrap = cvs.parentElement;
        const w = wrap ? wrap.clientWidth : cvs.clientWidth;
        const h = wrap ? wrap.clientHeight : cvs.clientHeight;
        if (w <= 0 || h <= 0) return;

        const dpr = window.devicePixelRatio || 1;
        cvs.width = Math.round(w * dpr);
        cvs.height = Math.round(h * dpr);
        cvs.style.width = w + 'px';
        cvs.style.height = h + 'px';
        const ctx = cvs.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const candles = cubicCandles || [];
        if (candles.length < 4) {
            if (info) info.textContent = 'Няма достатъчно данни.';
            if (legend) legend.textContent = 'y = a·x³ + b·x² + c·x + d';
            return;
        }

        const win = cubicFitWindow();
        const fromIdx = win > 0 ? Math.max(0, candles.length - win) : 0;
        const toIdx = candles.length - 1;
        const mode = cubicMode();
        let fit = null, spline = null;
        if (mode === 'spline') {
            spline = buildCubicSpline(candles, fromIdx, toIdx);
            if (!spline) {
                if (info) info.textContent = 'Кубичният сплайн не може да се изчисли.';
                return;
            }
            if (legend) {
                legend.textContent = 'Кубичен сплайн (през всички центрове) · последен сегмент: ' +
                    cubicEquation(spline.last, 't') + ' · t = бар − (N−2) · N=' + spline.m +
                    ' · продължение: ' + (cubicExtMode() === 'cubic' ? 'кубично' : 'линейно');
            }
        } else {
            fit = mode === 'interp4'
                ? fitCubic4(candles, fromIdx, toIdx)
                : fitCubic(candles, fromIdx, toIdx);
            if (!fit) {
                if (info) info.textContent = 'Кубичната функция не може да се изчисли.';
                return;
            }
            if (legend) {
                const name = mode === 'interp4' ? 'Интерполация (1 кубична, 4 точки)' : 'Регресия (1 кубична)';
                const anchors = (mode === 'interp4' && fit.anchors)
                    ? ' · точки: бар ' + fit.anchors.join(', ')
                    : '';
                legend.textContent = name + ' · ' + cubicEquation(fit) +
                    ' · x = (бар − ' + fromIdx + ') / ' + (fit.m - 1) +
                    ' · R² = ' + fit.r2.toFixed(4) + anchors +
                    ' · продължение: ' + (cubicExtMode() === 'cubic' ? 'кубично' : 'линейно');
            }
        }

        const extBars = cubicExtBars();
        const padL = 54, padR = 12, padT = 12, padB = 18;
        const plotW = Math.max(10, w - padL - padR);
        const plotH = Math.max(60, h - padT - padB);

        const maxBars = Math.max(40, Math.min(340, Math.floor(plotW / 3.2)));
        const visFrom = Math.max(fromIdx, candles.length - maxBars);
        const vis = candles.slice(visFrom);
        const totalBars = vis.length + extBars;
        const barW = plotW / totalBars;
        const X = pos => padL + (pos + 0.5) * barW;

        const step = medianStep(candles);
        const lastTime = candles[candles.length - 1].time;

        // Стойности на кубичната крива за видимите барове и за продължението.
        const fitVals = [];
        for (let i = visFrom; i <= toIdx; i++) {
            fitVals.push(spline ? splineEval(spline, i - fromIdx) : cubicEval(fit, (i - fromIdx) / (fit.m - 1)));
        }
        const extMode = cubicExtMode();
        const futureVals = [];
        if (spline) {
            const y0 = spline.ys[spline.m - 1];
            const slope = linearSlopeCenters(candles, fromIdx, toIdx);
            for (let k = 0; k < extBars; k++) {
                futureVals.push(extMode === 'cubic'
                    ? splineEval(spline, (toIdx - fromIdx) + (k + 1))
                    : y0 + slope * (k + 1));
            }
        } else {
            const y0 = cubicEval(fit, 1);
            const slopePerBar = (3 * fit.a + 2 * fit.b + fit.c) / (fit.m - 1);
            for (let k = 0; k < extBars; k++) {
                futureVals.push(extMode === 'cubic'
                    ? cubicEval(fit, 1 + (k + 1) / (fit.m - 1))
                    : y0 + slopePerBar * (k + 1));
            }
        }

        let pMin = Infinity, pMax = -Infinity;
        for (const c of vis) {
            pMin = Math.min(pMin, c.low);
            pMax = Math.max(pMax, c.high);
        }
        for (const v of fitVals) {
            if (isFinite(v)) { pMin = Math.min(pMin, v); pMax = Math.max(pMax, v); }
        }
        if (!(pMax > pMin)) { pMin -= 1; pMax += 1; }
        const pPad = (pMax - pMin) * 0.06;
        pMin -= pPad; pMax += pPad;
        const Y = v => padT + ((pMax - v) / (pMax - pMin)) * plotH;

        // Фон на продължението.
        const futureX = X(vis.length - 1);
        ctx.fillStyle = 'rgba(180,80,255,0.06)';
        ctx.fillRect(futureX, padT, w - padR - futureX, plotH);

        ctx.font = '9px JetBrains Mono';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let k = 0; k <= 4; k++) {
            const v = pMax - (pMax - pMin) * k / 4;
            const y = Y(v);
            ctx.strokeStyle = 'rgba(255,255,255,0.06)';
            ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.45)';
            ctx.fillText(fmtPrice(v), padL - 6, y);
        }

        // Клип за свещите/кривите, за да не излизат върху надписите.
        ctx.save();
        ctx.beginPath(); ctx.rect(padL, padT, plotW, plotH); ctx.clip();

        // Свещи.
        const bodyW = Math.max(1, Math.min(7, barW * 0.62));
        for (let i = 0; i < vis.length; i++) {
            const c = vis[i];
            const x = X(i);
            const up = c.close >= c.open;
            ctx.strokeStyle = up ? 'rgba(0,255,102,0.9)' : 'rgba(255,59,92,0.9)';
            ctx.fillStyle = ctx.strokeStyle;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x, Y(c.high)); ctx.lineTo(x, Y(c.low)); ctx.stroke();
            const yO = Y(c.open), yC = Y(c.close);
            ctx.fillRect(x - bodyW / 2, Math.min(yO, yC), bodyW, Math.max(1, Math.abs(yC - yO)));
        }

        // Кубичната крива върху данните.
        ctx.beginPath();
        let started = false;
        if (spline) {
            // Плавната сплайн крива между центровете (минава точно през тях).
            const startX = visFrom - fromIdx;
            const endX = toIdx - fromIdx;
            for (let x = startX; x <= endX + 1e-9; x += 0.25) {
                const y = splineEval(spline, x);
                if (!isFinite(y)) continue;
                const px = X(x - startX);
                if (!started) { ctx.moveTo(px, Y(y)); started = true; }
                else ctx.lineTo(px, Y(y));
            }
            if (started) ctx.lineTo(X(vis.length - 1), Y(splineEval(spline, endX)));
        } else {
            fitVals.forEach((v, i) => {
                if (!isFinite(v)) return;
                const x = X(i), y = Y(v);
                if (!started) { ctx.moveTo(x, y); started = true; }
                else ctx.lineTo(x, y);
            });
        }
        ctx.strokeStyle = '#b450ff';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Маркери на 4-те точки, през които минава точно (интерполация).
        if (fit && fit.anchors) {
            ctx.fillStyle = '#ffd27a';
            for (const ai of fit.anchors) {
                if (ai < visFrom || ai > toIdx) continue;
                const y = cubicEval(fit, (ai - fromIdx) / (fit.m - 1));
                if (!isFinite(y)) continue;
                ctx.beginPath();
                ctx.arc(X(ai - visFrom), Y(y), 3, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Продължение след данните — пунктир (започва от последната крива).
        ctx.beginPath();
        const lastDataY = spline ? splineEval(spline, toIdx - fromIdx) : fitVals[fitVals.length - 1];
        ctx.moveTo(X(vis.length - 1), Y(lastDataY));
        if (spline && extMode === 'cubic') {
            const startX = toIdx - fromIdx;
            const endX = startX + extBars;
            for (let x = startX + 0.25; x <= endX + 1e-9; x += 0.25) {
                const y = splineEval(spline, x);
                if (!isFinite(y)) continue;
                const pos = vis.length - 1 + (x - startX);
                ctx.lineTo(X(pos), Y(y));
            }
            ctx.lineTo(X(vis.length - 1 + extBars), Y(splineEval(spline, endX)));
        } else {
            futureVals.forEach((v, k) => {
                if (!isFinite(v)) return;
                ctx.lineTo(X(vis.length + k), Y(v));
            });
        }
        ctx.strokeStyle = 'rgba(180,80,255,0.85)';
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // Вертикална линия при последната реална свещ.
        const xData = X(vis.length - 1);
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(xData, padT); ctx.lineTo(xData, h - padB); ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('Кубична (3-та степен) · продължение', padL + 4, padT + 3);

        // Времева ос.
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillText(fmtTime(vis[0].time), padL, h - 14);
        ctx.textAlign = 'right';
        ctx.fillText(fmtTime(lastTime + extBars * step), w - padR, h - 14);

        const lastFit = spline ? splineEval(spline, (candles.length - 1) - fromIdx) : cubicEval(fit, 1);
        const futureLast = futureVals[futureVals.length - 1];
        const fitName = spline ? 'сплайн' : 'кубична';
        if (info) {
            info.textContent = 'Център ' + fmtPrice(candleCenter(candles[candles.length - 1])) +
                ' · ' + fitName + ' ' + fmtPrice(lastFit) +
                ' · след ' + extBars + ' бара: ' + fmtPrice(futureLast) +
                (futureLast < pMin || futureLast > pMax ? ' (извън графика)' : '') +
                ' · N=' + (spline ? spline.m : fit.m);
        }
    }

    // Лента под главната графика: остатък (цена − кубична).
    function drawCubicStrip(ctx, w, h, label) {
        const candles = (typeof candlesUpToCutoff === 'function')
            ? candlesUpToCutoff(typeof latestCandles !== 'undefined' ? latestCandles : null)
            : ((typeof ivPanelCandles !== 'undefined' && ivPanelCandles) ? ivPanelCandles : []);
        if (!candles || candles.length < 4) {
            label.textContent = 'Кубична';
            return;
        }
        const win = cubicFitWindow();
        const fromIdx = win > 0 ? Math.max(0, candles.length - win) : 0;
        const mode = cubicMode();
        const spline = mode === 'spline' ? buildCubicSpline(candles, fromIdx, candles.length - 1) : null;
        const fit = mode === 'spline' ? null
            : (mode === 'interp4'
                ? fitCubic4(candles, fromIdx, candles.length - 1)
                : fitCubic(candles, fromIdx, candles.length - 1));
        if (mode === 'spline' ? !spline : !fit) {
            label.textContent = 'Кубична';
            return;
        }
        let range = null;
        try { range = chart.timeScale().getVisibleRange(); } catch (e) { range = null; }

        const pts = [];
        for (let i = fromIdx; i < candles.length; i++) {
            const t = candles[i].time;
            if (range && (t < range.from || t > range.to)) continue;
            const xNorm = (i - fromIdx);
            const v = spline
                ? splineEval(spline, xNorm + 0.5) - splineEval(spline, xNorm - 0.5)
                : candleCenter(candles[i]) - cubicEval(fit, xNorm / (fit.m - 1));
            let x = null;
            try { x = chart.timeScale().timeToCoordinate(t); } catch (e) { x = null; }
            if (x == null) continue;
            pts.push({ x, v });
        }
        label.textContent = spline ? 'Наклон на сплайна' : 'Остатък (център − кубична)';
        if (pts.length < 2) return;

        let abs = 0;
        for (const p of pts) abs = Math.max(abs, Math.abs(p.v));
        if (!(abs > 0)) abs = 0.01;
        const toY = v => h - ((v + abs * 1.15) / (abs * 2.3)) * (h - 8) - 4;
        const zeroY = toY(0);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(w, zeroY); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, toY(p.v)); else ctx.lineTo(p.x, toY(p.v)); });
        ctx.strokeStyle = '#b450ff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    // Данни за кубичната крива върху главната графика (page 11).
    // Връща { fit:[{time,value}], ext:[{time,value}] } до линията „СЕГА“.
    window.cubicOverlayData = function (candles) {
        if (!candles || candles.length < 4) return null;
        const win = cubicFitWindow();
        const fromIdx = win > 0 ? Math.max(0, candles.length - win) : 0;
        const toIdx = candles.length - 1;
        const mode = cubicMode();
        const extBars = cubicExtBars();
        const extMode = cubicExtMode();
        const step = medianStep(candles);
        // Пазим продължението в разумен ценови диапазон, за да не смачка
        // главната графика при кубична екстраполация, която „избяга“.
        let pMin = Infinity, pMax = -Infinity;
        for (const c of candles) {
            pMin = Math.min(pMin, c.low);
            pMax = Math.max(pMax, c.high);
        }
        const span = Math.max(1e-9, pMax - pMin);
        const lo = pMin - span * 0.75, hi = pMax + span * 0.75;
        const fit = [], ext = [];
        if (mode === 'spline') {
            const sp = buildCubicSpline(candles, fromIdx, toIdx);
            if (!sp) return null;
            for (let i = fromIdx; i <= toIdx; i++) {
                fit.push({ time: candles[i].time, value: splineEval(sp, i - fromIdx) });
            }
            const lastTime = candles[toIdx].time;
            const y0 = sp.ys[sp.m - 1];
            const slope = linearSlopeCenters(candles, fromIdx, toIdx);
            for (let k = 1; k <= extBars; k++) {
                const v = extMode === 'cubic' ? splineEval(sp, (toIdx - fromIdx) + k) : y0 + slope * k;
                if (v < lo || v > hi) break;
                ext.push({ time: lastTime + k * step, value: v });
            }
        } else {
            const f = mode === 'interp4'
                ? fitCubic4(candles, fromIdx, toIdx)
                : fitCubic(candles, fromIdx, toIdx);
            if (!f) return null;
            for (let i = fromIdx; i <= toIdx; i++) {
                fit.push({ time: candles[i].time, value: cubicEval(f, (i - fromIdx) / (f.m - 1)) });
            }
            const lastTime = candles[toIdx].time;
            const y0 = cubicEval(f, 1);
            const slopePerBar = (3 * f.a + 2 * f.b + f.c) / (f.m - 1);
            for (let k = 0; k < extBars; k++) {
                const v = extMode === 'cubic' ? cubicEval(f, 1 + (k + 1) / (f.m - 1)) : y0 + slopePerBar * (k + 1);
                if (v < lo || v > hi) break;
                ext.push({ time: lastTime + (k + 1) * step, value: v });
            }
        }
        return { fit, ext };
    };

    registerTab({
        index: 11,
        renderPanel: function (candles) {
            cubicCandles = candles || [];
            bindCubicUI();
            syncCubicCutoff();
            drawCubicPage();
        },
        drawChart: drawCubicStrip
    });
})();
