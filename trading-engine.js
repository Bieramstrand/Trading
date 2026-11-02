/* Trading Engine
 * Die Regeln der trader Skills (Scanner, Einstieg, Ausstieg, Zeitmaschine,
 * Budget, Risiko, Alarme) als reine Funktionen ohne Netzwerk.
 * Laeuft im Browser (window.TraderEngine) und in Node (require), damit
 * sich alles mit Beispieldaten testen laesst.
 * Nur Long Trades. Bildung und Werkzeug, keine Anlageberatung.
 */
(function (root) {
  'use strict';

  // ---------- Zahlen ----------
  const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  const floorCent = (x) => Math.floor(x * 100 + 1e-7) / 100;
  const halfUpCent = (x) => Math.floor(x * 100 + 0.5 + 1e-7) / 100;
  const pct = (a, b) => (a / b - 1) * 100;
  const num = (x, d = 2) => Number(x).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
  const usd = (x) => num(x, 2) + ' $';
  const usd0 = (x) => (Number.isInteger(+x) ? num(x, 0) : num(x, 2)) + ' $';

  // ---------- New Yorker Uhr und NYSE Kalender ----------
  const NY_FMT = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  function ny(ms) {
    const p = {};
    for (const part of NY_FMT.formatToParts(new Date(ms))) p[part.type] = part.value;
    const h = +p.hour % 24, mi = +p.minute;
    return {
      date: `${p.year}-${p.month}-${p.day}`, y: +p.year, m: +p.month, d: +p.day,
      h, mi, s: +p.second, dow: DOW[p.weekday], min: h * 60 + mi,
    };
  }

  // nyse.com, gelesen 2026-10-13
  const HOLIDAYS = new Set([
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
    '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
    '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  ]);
  const EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);
  const OPEN_MIN = 570; // 9:30

  function dowOf(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }
  function isTradingDay(dateStr) {
    const dow = dowOf(dateStr);
    return dow !== 0 && dow !== 6 && !HOLIDAYS.has(dateStr);
  }
  const closeMinOf = (dateStr) => (EARLY_CLOSE.has(dateStr) ? 780 : 960);
  const knownYear = (y) => y === 2026 || y === 2027;

  function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return t.toISOString().slice(0, 10);
  }
  function nextTradingDay(dateStr) {
    let d = addDays(dateStr, 1);
    for (let i = 0; i < 14 && !isTradingDay(d); i++) d = addDays(d, 1);
    return d;
  }

  const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
  function fmtMin(min) {
    return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
  }
  const fmtHM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

  /** Zustand der NYSE zu einem Zeitpunkt. */
  function marketClock(nowMs) {
    const n = ny(nowMs);
    const out = { ny: n, date: n.date, knownYear: knownYear(n.y), earlyClose: EARLY_CLOSE.has(n.date) };
    out.closeMin = closeMinOf(n.date);
    if (!isTradingDay(n.date)) {
      out.state = 'closed';
      out.reason = HOLIDAYS.has(n.date) ? 'Feiertag an der NYSE' : 'Wochenende';
      out.nextOpenDate = nextTradingDay(n.date);
    } else if (n.min < OPEN_MIN) {
      out.state = 'pre'; out.reason = 'vor der Eröffnung'; out.nextOpenDate = n.date;
    } else if (n.min < out.closeMin) {
      out.state = 'open'; out.reason = 'Handel läuft';
    } else {
      out.state = 'post'; out.reason = 'nach Börsenschluss'; out.nextOpenDate = nextTradingDay(n.date);
    }
    out.open = out.state === 'open';
    return out;
  }

  // ---------- Kerzen ----------
  /** Yahoo Kerzen ({t,o,h,l,c,v}, t = Start in Sekunden) mit NY Datum und Minute. */
  function normalizeBars(bars, ivMin) {
    const out = [];
    for (const b of bars || []) {
      if (b == null || b.c == null || b.o == null || b.h == null || b.l == null) continue;
      const n = ny(b.t * 1000);
      if (ivMin && n.min % ivMin !== 0) continue; // Live Tick neben dem Raster
      if (n.s !== 0) continue;
      out.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, date: n.date, min: n.min });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }
  const regularOnly = (bars) => bars.filter((b) => b.min >= OPEN_MIN && b.min < closeMinOf(b.date));
  function groupByDate(bars) {
    const m = new Map();
    for (const b of bars) { if (!m.has(b.date)) m.set(b.date, []); m.get(b.date).push(b); }
    return m;
  }

  // ---------- Indikatoren ----------
  function rsiWilder(closes, period = 14) {
    if (closes.length < period + 1) return [];
    const out = new Array(closes.length).fill(null);
    let g = 0, l = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) g += d; else l -= d;
    }
    g /= period; l /= period;
    out[period] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      g = (g * (period - 1) + Math.max(d, 0)) / period;
      l = (l * (period - 1) + Math.max(-d, 0)) / period;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }
  const sma = (arr, n, end) => {
    if (end + 1 < n) return null;
    let s = 0; for (let i = end - n + 1; i <= end; i++) s += arr[i];
    return s / n;
  };
  function atr(bars, n = 14) {
    if (!bars.length) return { atr: null, used: 0 };
    const trs = bars.map((b, i) => {
      const pc = i > 0 ? bars[i - 1].c : null;
      return pc == null ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    });
    const use = trs.slice(-n);
    return { atr: use.reduce((a, b) => a + b, 0) / use.length, used: use.length };
  }

  // ---------- Scanner: Tagesschlusskurse ----------
  const SETUP_LABELS = {
    breakout_20d: '20 Tage Hoch',
    bull_flag: 'Bullenflagge',
    reclaim_ma20: 'Zurück über 20 Tage Schnitt',
    oversold: 'Überverkauft (RSI unter 30)',
    oversold_bounce: 'Erholung nach überverkauft',
    orb: 'Ausbruch aus der Eröffnungsspanne',
  };

  /** closes: abgeschlossene Tagesschlusskurse, aelteste zuerst. */
  function dailySetups(closes) {
    const hits = [];
    const n = closes.length;
    if (n < 22) return { hits, rsi: null };
    const last = closes[n - 1], prev = closes[n - 2];
    if (last > Math.max(...closes.slice(n - 21, n - 1))) hits.push('breakout_20d');
    if (n >= 16) {
      const run = closes[n - 6] / closes[n - 16] - 1;
      const last5 = closes.slice(n - 5);
      const lo = Math.min(...last5), hi = Math.max(...last5);
      if (run > 0.10 && (hi - lo) / lo <= 0.05) hits.push('bull_flag');
    }
    const maNow = sma(closes, 20, n - 1), maPrev = sma(closes, 20, n - 2);
    if (maPrev != null && prev < maPrev && last > maNow) hits.push('reclaim_ma20');
    const r = rsiWilder(closes, 14);
    const rNow = r[n - 1], rPrev = r[n - 2];
    if (rNow != null && rNow < 30) hits.push('oversold');
    if (rPrev != null && rPrev < 30 && last > prev) hits.push('oversold_bounce');
    return { hits, rsi: rNow, ma20: maNow };
  }

  /** Tageskerzen eines Werts pruefen. Laufender Handelstag wird weggelassen. */
  function scanDailySymbol(dailyBars, nowMs, opts = {}) {
    const minPrice = opts.minPrice ?? 5, minVolume = opts.minVolume ?? 1e6;
    const clock = marketClock(nowMs);
    let bars = (dailyBars || []).filter((b) => b && b.c != null);
    bars = bars.map((b) => ({ ...b, date: ny(b.t * 1000).date }));
    if (bars.length && bars[bars.length - 1].date === clock.date && clock.state !== 'post' && clock.state !== 'closed') {
      bars = bars.slice(0, -1); // heutiger Tag ist noch nicht fertig
    }
    if (bars.length < 22) return { usable: false, reason: 'zu wenig Daten' };
    const last = bars[bars.length - 1];
    const closes = bars.map((b) => b.c);
    const res = dailySetups(closes);
    const liquid = last.c >= minPrice && (last.v || 0) >= minVolume;
    return {
      usable: true, liquid, price: last.c, volume: last.v || 0, asOf: last.date,
      dollarVolume: last.c * (last.v || 0), setups: liquid ? res.hits : [], rsi: res.rsi,
      changePct: pct(last.c, bars[bars.length - 2].c),
    };
  }

  // ---------- Einstieg: Ausbruch aus der Eroeffnungsspanne oder Marke ----------
  /**
   * bars: Yahoo Kerzen von heute (1m oder 5m). Gibt status zurueck:
   * closed, notopen, forming, nodata, waiting, triggered, expired.
   */
  function entryCheck(rawBars, opts) {
    const iv = opts.interval || 5;
    const orMin = opts.orMinutes || 15;
    const nowMs = opts.nowMs ?? Date.now();
    const clock = marketClock(nowMs);
    const cfg = opts.config || {};
    const noBefore = hm(cfg.no_entries_before || '09:45');
    let cutoff = hm(cfg.no_entries_after || '15:30');
    if (clock.earlyClose) cutoff = Math.min(cutoff, clock.closeMin - 30);
    const res = { clock, interval: iv, orMinutes: orMin, cutoff, setup: opts.level ? 'level' : 'orb' };

    if (clock.state === 'closed') return { ...res, status: 'closed', text: `Die Börse ist zu (${clock.reason}).` };
    if (clock.state === 'pre') return { ...res, status: 'notopen', text: 'Noch nicht eröffnet. Handel ab 9:30 New York.' };

    const today = clock.date;
    const nowMin = clock.ny.min + clock.ny.s / 60;
    const all = regularOnly(normalizeBars(rawBars, iv)).filter((b) => b.date === today);
    // Eine Kerze zaehlt erst, wenn sie fertig ist (Start plus Intervall)
    const done = all.filter((b) => b.min + iv <= nowMin);
    const forming = all.find((b) => b.min + iv > nowMin) || null;
    res.bars = all;
    res.forming = forming;

    const orEnd = OPEN_MIN + orMin;
    if (nowMin < orEnd) return { ...res, status: 'forming', text: `Die Eröffnungsspanne bildet sich noch (bis ${fmtMin(orEnd)}).` };
    const rangeBars = done.filter((b) => b.min < orEnd);
    const need = Math.round(orMin / iv);
    if (rangeBars.length < need) return { ...res, status: 'nodata', text: `Für die Spanne fehlen Kerzen (${rangeBars.length} von ${need}). Halt oder dünner Wert.` };

    const orHigh = Math.max(...rangeBars.map((b) => b.h));
    const orLow = Math.min(...rangeBars.map((b) => b.l));
    const avgVol = rangeBars.reduce((a, b) => a + b.v, 0) / rangeBars.length;
    const level = opts.level ? +opts.level : orHigh;
    Object.assign(res, { orHigh, orLow, level, rangeCount: rangeBars.length, need, avgRangeVol: avgVol });

    const after = done.filter((b) => b.min >= orEnd);
    for (const b of after) {
      const closeT = b.min + iv;
      if (closeT < noBefore) continue;
      if (closeT > cutoff) break;
      if (!(b.c > level)) continue;
      const volX = avgVol > 0 ? b.v / avgVol : null;
      if (opts.minVolumeX && !(volX != null && volX >= opts.minVolumeX)) continue;
      const barNo = all.indexOf(b); // ab 0 gezaehlt wie in den Skills
      return {
        ...res, status: 'triggered', price: round2(b.c), time: closeT, timeText: fmtMin(closeT),
        barStart: b.min, barNo, volX, overPct: pct(b.c, level),
        lateBars: Math.floor((nowMin - closeT) / iv),
        text: `AUSGELÖST ${fmtMin(closeT)} bei ${usd(round2(b.c))}: die ${fmtMin(b.min)} Kerze schloss über ${usd(level)} (+${num(pct(b.c, level), 2)} %).`,
      };
    }
    const last = done[done.length - 1];
    if (nowMin >= cutoff || clock.state === 'post') {
      return { ...res, status: 'expired', last, text: `Abgelaufen: bis ${fmtMin(cutoff)} schloss keine Kerze über ${usd(level)}.` };
    }
    const gap = last ? level - last.c : null;
    return {
      ...res, status: 'waiting', last, gap,
      text: last
        ? `WARTEN: letzter Schluss ${usd(last.c)}, ${usd(gap)} unter ${usd(level)} (${num(pct(last.c, level), 2)} %).`
        : 'WARTEN: noch keine fertige Kerze nach der Spanne.',
    };
  }

  // ---------- Ausstieg: Stopp und Ziel ----------
  /**
   * p: {symbol, date, entry, entryTime (Minute des Schlusses), orHigh, orLow, setup,
   *     stopRule: 'or-mid'|'or-low'|'price'|'pct'|'atr', stopValue, targetRule: 'R'|'price',
   *     targetValue, bars (fuer ATR), flatBy, interval}
   */
  function planExit(p) {
    const entry = +p.entry;
    if (!(entry > 0)) return { ok: false, reason: 'Kein Einstiegskurs.' };
    let stop, stopText;
    const rule = p.stopRule || (p.setup === 'level' ? null : 'or-mid');
    if (!rule) return { ok: false, reason: 'Ein Marken Setup hat keine Eröffnungsspanne: bitte einen Stopp nennen (Kurs, Prozent oder ATR).' };
    if (rule === 'or-mid' || rule === 'or-low') {
      if (p.orHigh == null || p.orLow == null) return { ok: false, reason: 'Für diesen Stopp fehlt die Eröffnungsspanne.' };
      if (rule === 'or-mid') {
        const mid = (+p.orHigh + +p.orLow) / 2;
        stop = floorCent(mid);
        stopText = `Mitte der Spanne: (${usd((+p.orHigh))} + ${usd((+p.orLow))}) / 2 = ${num(mid, 3)} $, abgerundet`;
      } else { stop = floorCent(+p.orLow); stopText = 'Tief der Eröffnungsspanne'; }
    } else if (rule === 'price') {
      stop = floorCent(+p.stopValue); stopText = 'dein Kurs';
    } else if (rule === 'pct') {
      stop = floorCent(entry * (1 - +p.stopValue / 100)); stopText = `${p.stopValue} % unter dem Einstieg`;
    } else if (rule === 'atr') {
      const upTo = (p.bars || []).filter((b) => p.entryBarStart == null || b.min <= p.entryBarStart);
      const a = atr(upTo, 14);
      if (a.atr == null) return { ok: false, reason: 'Für den ATR Stopp fehlen die Kerzen des Tages.' };
      stop = floorCent(entry - +p.stopValue * a.atr);
      stopText = `${p.stopValue} × ATR ${num(a.atr, 2)}${a.used < 14 ? ` (nur ${a.used} Kerzen gemittelt)` : ' (14 Kerzen)'}`;
    } else return { ok: false, reason: 'Unbekannte Stopp Regel.' };

    if (!(stop > 0) || isNaN(stop)) return { ok: false, reason: 'Ungültiger Stopp.' };
    if (stop >= entry) return { ok: false, reason: `Der Stopp ${usd(stop)} liegt nicht unter dem Einstieg ${usd(entry)}. Nur Long Trades.` };
    const risk = round2(entry - stop);
    if (risk < entry * 0.0005) return { ok: false, reason: `Stopp zu eng: ${usd(risk)} sind unter 0,05 % vom Kurs. Normales Zappeln würde dich ausstoppen.` };

    let target, targetR, targetText;
    if ((p.targetRule || 'R') === 'R') {
      targetR = +(p.targetValue || 2);
      target = halfUpCent(entry + targetR * risk);
      targetText = `${targetR}R (${targetR} × Risiko)`;
    } else {
      target = round2(+p.targetValue);
      targetText = 'dein Kurs';
      if (!(target > entry)) return { ok: false, reason: `Das Ziel ${usd(target)} liegt nicht über dem Einstieg.` };
      targetR = (target - entry) / risk;
    }
    if (!(target > entry)) return { ok: false, reason: 'Das Ziel liegt nicht über dem Einstieg.' };

    const closeMin = p.date ? closeMinOf(p.date) : 960;
    let flatMin = hm(p.flatBy || '15:55');
    if (closeMin === 780) flatMin = Math.min(flatMin, 775);
    if (p.entryTime != null && p.entryTime >= flatMin) return { ok: false, reason: `Einstieg um ${fmtMin(p.entryTime)} liegt nach der Glattstell Zeit ${fmtHM(flatMin)}.` };

    return {
      ok: true, symbol: p.symbol, date: p.date, side: 'buy', setup: p.setup || 'orb',
      entry: round2(entry), entryTime: p.entryTime ?? null, entryBarStart: p.entryBarStart ?? null,
      stop, stopRule: rule, stopValue: p.stopValue ?? null, stopText,
      target, targetR: Math.round(targetR * 100) / 100, targetText,
      risk, riskPct: (risk / entry) * 100, rewardRisk: Math.round(((target - entry) / risk) * 100) / 100,
      orHigh: p.orHigh ?? null, orLow: p.orLow ?? null, flatBy: fmtHM(flatMin), flatMin,
      interval: p.interval || 5,
    };
  }

  // ---------- Zeitmaschine ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const quantile = (sorted, q) => {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  };

  function verdictOf(tf, sf, nf, R, avgR) {
    const lines = [];
    const hit = tf + sf;
    if (hit <= 0) return { text: 'Keine Wiederholung erreichte Stopp oder Ziel: der Kurs zum Schluss entscheidet alles.', lines, lean: 0 };
    const share = tf / hit, be = 1 / (1 + R);
    const diff = (share - be) * 100;
    const pair = `Ziel zuerst ${num((tf * 100), 1)} % gegen Stopp zuerst ${num((sf * 100), 1)} %`;
    let text, lean = 0;
    if (Math.abs(diff) < 5) text = (Math.abs(R - 1) < 1e-9 ? 'Nahe am Münzwurf: ' : 'Nahe am Break even: ') + pair + '.';
    else if (Math.abs(diff) < 15) { lean = Math.sign(diff); text = (diff > 0 ? 'Neigt zum Ziel: ' : 'Neigt zum Stopp: ') + pair + '.'; }
    else { lean = Math.sign(diff); text = (diff > 0 ? 'Deutlich Richtung Ziel: ' : 'Deutlich Richtung Stopp: ') + pair + '.'; }
    if (nf > 0.40) lines.push(`${num((nf * 100), 1)} % der Wiederholungen erreichten keine Seite; dort entscheidet der Kurs am Ende.`);
    if (lean !== 0 && Math.sign(avgR) !== 0 && Math.sign(avgR) !== lean) lines.push(`Der Durchschnitt von ${avgR >= 0 ? '+' : ''}${num(avgR, 3)} R zeigt in die andere Richtung, wegen der Wiederholungen ohne Treffer.`);
    return { text, lines, lean, share, breakEven: be };
  }

  /**
   * bars: 60 Tage 5 Minuten Kerzen von Yahoo. plan: aus planExit.
   * opts: {replays, seed, window, untilMin}
   */
  function timeMachine(rawBars, plan, opts = {}) {
    const replays = opts.replays || 10000, seed = opts.seed ?? 19, win = opts.window ?? 2;
    const bars = regularOnly(normalizeBars(rawBars, 5));
    const byDate = groupByDate(bars);
    const date = plan.date;
    // Pool: nur volle Tage (78 Kerzen) vor dem Plan Datum
    const sessions = [];
    let prevClose = null;
    for (const [d, list] of [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (d >= date) break;
      const full = list.length === 78 && closeMinOf(d) === 960 && list.every((b, i) => b.min === OPEN_MIN + 5 * i);
      if (full) {
        const ratios = list.map((b, i) => {
          const pc = i === 0 ? (prevClose ?? b.o) : list[i - 1].c;
          return [b.o / pc, b.h / pc, b.l / pc, b.c / pc];
        });
        sessions.push({ date: d, bars: list, ratios });
      }
      prevClose = list[list.length - 1].c;
    }
    if (sessions.length < 20) return { ok: false, reason: `Nur ${sessions.length} volle Handelstage in den Daten, mindestens 20 nötig.` };

    if (plan.entryBarStart == null) return { ok: false, reason: 'Im Plan fehlt die Einstiegskerze.' };
    if ((plan.entryBarStart - OPEN_MIN) % 5 !== 0) return { ok: false, reason: 'Der Einstieg liegt nicht auf dem 5 Minuten Raster.' };
    const eSlot = (plan.entryBarStart - OPEN_MIN) / 5;
    const closeMin = closeMinOf(date);
    const untilMin = Math.min(opts.untilMin || closeMin, closeMin);
    const lastSlot = Math.floor((untilMin - 5 - OPEN_MIN) / 5); // letzte Kerze, die bis untilMin schliesst
    if (lastSlot <= eSlot) return { ok: false, reason: 'Nach dem Einstieg bleibt keine Kerze bis zum Ende.' };
    if (!(plan.stop < plan.entry && plan.target > plan.entry)) return { ok: false, reason: 'Der Plan ergibt keinen Sinn (Stopp muss unter, Ziel über dem Einstieg liegen).' };

    const steps = lastSlot - eSlot;
    const rnd = mulberry32(seed);
    const risk = plan.entry - plan.stop;
    const R = (plan.target - plan.entry) / risk;
    let tf = 0, sf = 0, nf = 0, green = 0, sumR = 0;
    const finals = new Float64Array(replays);
    const pathCols = Array.from({ length: steps + 1 }, () => new Float64Array(replays));
    const samples = [];
    for (let r = 0; r < replays; r++) {
      let p = plan.entry, outcome = 0;
      pathCols[0][r] = p;
      for (let k = 1; k <= steps; k++) {
        const slot = eSlot + k;
        const s = sessions[Math.floor(rnd() * sessions.length)];
        const lo = Math.max(0, slot - win), hi = Math.min(77, slot + win);
        const pick = lo + Math.floor(rnd() * (hi - lo + 1));
        const [, rh, rl, rc] = s.ratios[pick];
        if (outcome === 0) {
          if (p * rl <= plan.stop) outcome = -1; // beide beruehrt zaehlt als Stopp
          else if (p * rh >= plan.target) outcome = 1;
        }
        p = p * rc;
        pathCols[k][r] = p;
      }
      finals[r] = p;
      let rr;
      if (outcome === 1) { tf++; rr = R; green++; }
      else if (outcome === -1) { sf++; rr = -1; }
      else { nf++; rr = (p - plan.entry) / risk; if (p > plan.entry) green++; }
      sumR += rr;
      if (samples.length < 60) samples.push(Array.from({ length: steps + 1 }, (_, k) => pathCols[k][r]));
    }
    const sortedFinals = Array.from(finals).sort((a, b) => a - b);
    const bands = pathCols.map((col) => {
      const s = Array.from(col).sort((a, b) => a - b);
      return { p5: quantile(s, 0.05), p25: quantile(s, 0.25), p50: quantile(s, 0.5), p75: quantile(s, 0.75), p95: quantile(s, 0.95) };
    });
    const mc = {
      replays, seed, steps, untilMin, untilText: fmtMin(untilMin), fromText: plan.entryTime != null ? fmtMin(plan.entryTime) : fmtMin(plan.entryBarStart + 5),
      targetFirst: tf / replays, stopFirst: sf / replays, neither: nf / replays, green: green / replays,
      median: quantile(sortedFinals, 0.5), p5: quantile(sortedFinals, 0.05), p95: quantile(sortedFinals, 0.95),
      avgR: sumR / replays, bands, samples,
    };

    const history = historyRun(sessions, plan, R, untilMin, opts);
    const v = verdictOf(mc.targetFirst, mc.stopFirst, mc.neither, R, mc.avgR);
    return { ok: true, plan, sessions: sessions.length, mc, history, verdict: v };
  }

  /** Dieselbe Regel auf jedem vergangenen vollen Tag. */
  function historyRun(sessions, plan, R, untilMin, opts) {
    const orMin = opts.orMinutes || 15;
    const cutoff = hm((opts.config && opts.config.no_entries_after) || '15:30');
    const stopPct = (plan.entry - plan.stop) / plan.entry;
    let fired = 0, t = 0, s = 0, n = 0, sumR = 0;
    for (const ses of sessions) {
      const list = ses.bars;
      const orBars = list.filter((b) => b.min < OPEN_MIN + orMin);
      const orHigh = Math.max(...orBars.map((b) => b.h));
      const orLow = Math.min(...orBars.map((b) => b.l));
      const level = plan.setup === 'level' && plan.orHigh == null ? null : orHigh;
      let ei = -1;
      for (let i = orBars.length; i < list.length; i++) {
        const b = list[i];
        if (b.min + 5 > cutoff) break;
        const lv = level ?? orHigh;
        if (b.c > lv) { ei = i; break; }
      }
      if (ei < 0) continue;
      const entry = list[ei].c;
      let stop;
      if (plan.stopRule === 'or-mid') stop = floorCent((orHigh + orLow) / 2);
      else if (plan.stopRule === 'or-low') stop = floorCent(orLow);
      else if (plan.stopRule === 'atr' && plan.stopValue) { const a = atr(list.slice(0, ei + 1), 14); stop = floorCent(entry - plan.stopValue * a.atr); }
      else stop = floorCent(entry * (1 - stopPct));
      if (!(stop < entry)) continue;
      const risk = entry - stop;
      const target = halfUpCent(entry + R * risk);
      fired++;
      let out = 0, last = entry;
      for (let i = ei + 1; i < list.length; i++) {
        const b = list[i];
        if (b.min + 5 > untilMin) break;
        if (b.l <= stop) { out = -1; break; }
        if (b.h >= target) { out = 1; break; }
        last = b.c;
      }
      if (out === 1) { t++; sumR += R; } else if (out === -1) { s++; sumR -= 1; } else { n++; sumR += (last - entry) / risk; }
    }
    return { sessions: sessions.length, fired, target: t, stop: s, neither: n, avgR: fired ? sumR / fired : 0 };
  }

  // ---------- Budget: Positionsgroesse ----------
  const DEFAULT_CONFIG = {
    budget: 5000, cash_buffer_pct: 10, max_position_pct: 75, max_order_usd: 4000, min_order_usd: 5,
    max_loss_per_trade_usd: 50, max_daily_loss_usd: 150, max_trades_per_day: 3, max_orders_per_day: 10,
    min_reward_risk: 1.0, require_stop: true, no_entries_before: '09:45', no_entries_after: '15:30',
    flat_by: '15:55', paper: true, blocked: [], or_minutes: 15, interval: 5, min_price: 5, min_volume: 1000000,
  };

  /**
   * plan: aus planExit. opts: {nowMs, freshPrice:{price, asOfMs}, limit, cash}
   */
  function sizePosition(plan, cfgIn, opts = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...(cfgIn || {}) };
    const nowMs = opts.nowMs ?? Date.now();
    const today = ny(nowMs).date;
    const refuse = (reason, extra) => ({ ok: false, reason, ...extra });
    if (!plan || !plan.ok) return refuse('Kein gültiger Plan. Erst Stopp und Ziel festlegen.');
    if (plan.side && plan.side !== 'buy') return refuse('Nur Long Trades.');
    if (plan.date && plan.date !== today) return refuse(`Der Plan ist vom ${plan.date}, heute ist ${today}. Bitte neu planen.`);
    const blocked = (cfg.blocked || []).map((s) => String(s).toUpperCase());
    if (blocked.includes(plan.symbol.toUpperCase())) return refuse(`${plan.symbol} steht auf deiner Sperrliste.`);

    let entry = plan.entry, entryNote = 'Einstieg aus dem Plan';
    if (opts.limit) { entry = +opts.limit; entryNote = 'Limit Kurs'; }
    else if (opts.freshPrice && opts.freshPrice.price > entry && nowMs - opts.freshPrice.asOfMs < 15 * 60000) {
      entry = opts.freshPrice.price; entryNote = 'frischer Kurs liegt über dem Plan';
    }
    if (!(plan.stop < entry)) return refuse('Der Stopp liegt nicht unter dem Einstieg.');
    if (!(plan.target > entry)) return refuse('Das Ziel liegt nicht mehr über dem Kurs: die Bewegung ist schon passiert.');
    const risk = round2(entry - plan.stop);
    const rr = (plan.target - entry) / risk;

    const budget = +cfg.budget;
    const cashAfterBuffer = budget * (1 - cfg.cash_buffer_pct / 100);
    const cash = opts.cash != null ? Math.min(cashAfterBuffer, opts.cash) : cashAfterBuffer;
    const f = (x) => Math.max(0, Math.floor(x + 1e-9));
    const limits = [
      { key: 'max_loss', label: 'Max Verlust', math: `${usd0(cfg.max_loss_per_trade_usd)} / ${num(risk, 2)}`, shares: f(cfg.max_loss_per_trade_usd / risk) },
      { key: 'position', label: 'Positionsgrenze', math: `${cfg.max_position_pct} % von ${usd0(budget)} = ${usd0((budget * cfg.max_position_pct / 100))} / ${num(entry, 2)}`, shares: f((budget * cfg.max_position_pct / 100) / entry) },
      { key: 'max_order', label: 'Max Order', math: `${usd0(cfg.max_order_usd)} / ${num(entry, 2)}`, shares: f(cfg.max_order_usd / entry) },
      { key: 'cash', label: 'Bargeld', math: `${usd0(cash)} / ${num(entry, 2)}`, shares: f(cash / entry) },
    ];
    const qty = Math.min(...limits.map((l) => l.shares));
    const decider = limits.find((l) => l.shares === qty);
    decider.decides = true;
    const base = { limits, risk, entry, entryNote, rewardRisk: rr, decider };
    if (qty <= 0) {
      if (decider.key === 'max_loss') return refuse(`Ein Stück riskiert ${usd(risk)}, mehr als dein Max Verlust von ${usd0(cfg.max_loss_per_trade_usd)}. Keine Order.`, base);
      return refuse(`Null Stück passen in die Grenze „${decider.label}“.`, base);
    }
    const notional = round2(qty * entry);
    if (notional < cfg.min_order_usd) return refuse(`Order ${usd0(notional)} liegt unter der Mindestorder ${usd0(cfg.min_order_usd)}.`, base);
    if (rr < cfg.min_reward_risk) return refuse(`Chance zu Risiko ${num(rr, 2)} liegt unter deinem Minimum ${cfg.min_reward_risk}: die Bewegung ist größtenteils passiert.`, base);
    const maxLoss = round2(qty * risk);
    const order = {
      symbol: plan.symbol, side: 'buy', qty: String(qty), type: opts.limit ? 'limit' : 'market', time_in_force: 'day',
      order_class: 'bracket', take_profit_limit_price: plan.target.toFixed(2), stop_loss_stop_price: plan.stop.toFixed(2),
    };
    if (opts.limit) order.limit_price = (+opts.limit).toFixed(2);
    order.why = `${plan.setup === 'orb' ? 'Ausbruch aus der Eröffnungsspanne' : 'Marken Ausbruch'} bei ${plan.symbol}: ${qty} Stück, begrenzt durch ${decider.label} (${qty} × ${num(risk, 2)} = ${usd(maxLoss)} am Stopp)`;
    order.plan = { entry, stop: plan.stop, target: plan.target, risk_per_share: risk, max_loss: maxLoss, setup: plan.setup, entry_time: plan.entryTime != null ? fmtMin(plan.entryTime) : null, flat_by: plan.flatBy, date: plan.date };
    return { ok: true, ...base, qty, notional, maxLoss, order };
  }

  // ---------- Risiko Pruefung ----------
  /**
   * state: {portfolio:{cash, positions:[]}, today:{entries, orders, realizedLoss, openRisk, symbols}}
   */
  function riskCheck(order, cfgIn, state, opts = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...(cfgIn || {}) };
    const nowMs = opts.nowMs ?? Date.now();
    const clock = marketClock(nowMs);
    const checks = [];
    const add = (ok, label, detail) => checks.push({ ok, label, detail });
    const isExit = order.side === 'sell';
    const p = order.plan || {};
    const qty = +order.qty;
    const today = state.today || { entries: 0, orders: 0, realizedLoss: 0, openRisk: 0, symbols: [] };

    add(Number.isInteger(qty) && qty > 0, 'Ganze Stückzahl', `${order.qty}`);
    add(!['option', 'crypto'].includes(order.asset_class), 'Nur Aktien', 'keine Optionen, kein Krypto');
    add(cfg.paper !== false, 'Papiergeld', cfg.paper !== false ? 'Papierdepot' : 'Live ist hier nicht eingebaut');
    add((today.orders || 0) < cfg.max_orders_per_day, 'Orders heute', `${today.orders || 0} von ${cfg.max_orders_per_day}`);

    if (!isExit) {
      const blocked = (cfg.blocked || []).map((s) => String(s).toUpperCase());
      add(!blocked.includes(order.symbol.toUpperCase()), 'Sperrliste', blocked.length ? blocked.join(', ') : 'leer');
      const hasStop = order.order_class === 'bracket' && order.stop_loss_stop_price != null;
      add(!cfg.require_stop || hasStop, 'Stopp vorhanden', hasStop ? usd(+order.stop_loss_stop_price) : 'fehlt');
      const stop = +order.stop_loss_stop_price, tgt = +order.take_profit_limit_price;
      const entryRef = Math.max(+p.entry || 0, opts.freshPrice || 0);
      add(stop < entryRef && tgt > entryRef, 'Bracket sinnvoll', `Stopp ${usd(stop)} < Kurs ${usd(entryRef)} < Ziel ${usd(tgt)}`);
      const loss = round2(qty * (entryRef - stop));
      add(loss <= cfg.max_loss_per_trade_usd + 1e-9, 'Max Verlust je Trade', `${usd(loss)} von ${usd0(cfg.max_loss_per_trade_usd)} (ab ${usd(entryRef)})`);
      const rr = (tgt - entryRef) / (entryRef - stop);
      add(rr >= cfg.min_reward_risk - 1e-9, 'Chance zu Risiko', `${num(rr, 2)} (Minimum ${cfg.min_reward_risk})`);
      const dayRisk = (today.realizedLoss || 0) + (today.openRisk || 0) + loss;
      add(dayRisk <= cfg.max_daily_loss_usd + 1e-9, 'Tagesverlust Grenze', `${usd(dayRisk)} von ${usd0(cfg.max_daily_loss_usd)} (Verluste heute + offenes Risiko + diese Order)`);
      add((today.entries || 0) < cfg.max_trades_per_day, 'Trades heute', `${today.entries || 0} von ${cfg.max_trades_per_day}`);
      const notional = qty * entryRef;
      add(notional <= cfg.max_order_usd + 1e-9, 'Max Order', `${usd(notional)} von ${usd0(cfg.max_order_usd)}`);
      add(notional <= cfg.budget * cfg.max_position_pct / 100 + 1e-9, 'Positionsgrenze', `${usd(notional)} von ${usd0((cfg.budget * cfg.max_position_pct / 100))}`);
      const cash = state.portfolio ? state.portfolio.cash : cfg.budget;
      const buffer = cfg.budget * cfg.cash_buffer_pct / 100;
      add(cash - notional >= buffer - 1e-9, 'Bargeld Puffer', `danach ${usd((cash - notional))}, Puffer ${usd0(buffer)}`);
      add(!(today.symbols || []).includes(order.symbol), 'Keine doppelte Position', (today.symbols || []).includes(order.symbol) ? `${order.symbol} ist schon offen` : 'frei');
      add(!p.date || p.date === clock.date, 'Plan von heute', p.date || 'ohne Datum');
      const nb = hm(cfg.no_entries_before), na0 = hm(cfg.no_entries_after);
      const na = clock.earlyClose ? Math.min(na0, clock.closeMin - 30) : na0;
      const inWin = clock.open && clock.ny.min >= nb && clock.ny.min < na;
      add(inWin, 'Einstiegsfenster', clock.open ? `${fmtHM(nb)} bis ${fmtHM(na)} New York, jetzt ${fmtHM(clock.ny.min)}` : `Börse zu (${clock.reason})`);
    } else {
      add(true, 'Ausstieg', 'Aussteigen wird nie durch Tagesgrenzen blockiert');
    }
    const failed = checks.filter((c) => !c.ok);
    return { pass: failed.length === 0, verdict: failed.length ? 'BLOCK' : 'PASS', checks, failed, at: nowMs };
  }

  // ---------- Papierdepot: Bracket gegen Kerzen pruefen ----------
  /** pos: {entry, stop, target, openedAt (ms)}; bars normalisiert, 5m. */
  function bracketOutcome(pos, bars) {
    for (const b of bars) {
      if (b.t * 1000 < pos.openedAt) continue; // Kerze vor dem Kauf
      // Eine Luecke durch den Stopp fuellt zum Eroeffnungskurs der Kerze (schlechter)
      if (b.l <= pos.stop) return { hit: 'stop', price: Math.min(pos.stop, b.o), t: b.t };
      if (b.h >= pos.target) return { hit: 'target', price: Math.max(pos.target, b.o), t: b.t };
    }
    return null;
  }

  // ---------- Alarme ----------
  /** rule: {type, symbol, price, pct, direction, at, beforeClose, date, rang:{}} */
  function evaluateAlert(rule, ctx) {
    const clock = ctx.clock;
    const today = clock.date;
    if (rule.date && rule.date !== today) return null;
    const rangToday = rule.lastRang && rule.lastRang.slice(0, 10) === today;
    switch (rule.type) {
      case 'above': case 'target': {
        if (rule.rang && !rule.rearm) return null;
        const q = ctx.quotes[rule.symbol]; if (!q) return null;
        if (q.price >= rule.price) return `${rule.symbol} bei ${usd(q.price)}, über ${rule.type === 'target' ? 'dem Ziel ' : ''}${usd((+rule.price))}`;
        return null;
      }
      case 'below': case 'stop': {
        if (rule.rang && !rule.rearm) return null;
        const q = ctx.quotes[rule.symbol]; if (!q) return null;
        if (q.price <= rule.price) return `${rule.symbol} bei ${usd(q.price)}, unter ${rule.type === 'stop' ? 'dem Stopp ' : ''}${usd((+rule.price))}`;
        return null;
      }
      case 'pct_move': {
        if (rangToday) return null;
        const q = ctx.quotes[rule.symbol]; if (!q || !q.prevClose) return null;
        const ch = pct(q.price, rule.ref || q.prevClose);
        const dir = rule.direction || 'any';
        if (Math.abs(ch) >= rule.pct && (dir === 'any' || (dir === 'up' && ch > 0) || (dir === 'down' && ch < 0))) {
          return `${rule.symbol} ${ch >= 0 ? '+' : ''}${num(ch, 2)} % gegen gestern`;
        }
        return null;
      }
      case 'time': {
        if (rangToday || !isTradingDay(today)) return null;
        let at = hm(rule.at);
        if (rule.beforeClose && clock.earlyClose) at -= 180;
        if (clock.ny.min >= at && clock.ny.min < clock.closeMin) return `${fmtHM(at)} New York: ${rule.label || 'Zeitalarm'}`;
        return null;
      }
      case 'opening_bell': {
        if (rangToday) return null;
        return clock.open ? 'Die NYSE hat eröffnet' : null;
      }
      default: return null;
    }
  }

  // ---------- News Schlagworte ----------
  const TAGS = [
    ['Zahlen', /\b(earnings|results|eps|revenue|guidance|quarter|q[1-4]\b|profit|sales)/i],
    ['Analyst', /\b(upgrade|downgrade|price target|analyst|rating|outperform|underperform|overweight|underweight)/i],
    ['Recht', /\b(lawsuit|sue[sd]?|court|settle|probe|investigation|class action|verdict)/i],
    ['Deal', /\b(merger|acquir|acquisition|deal|buyout|takeover|stake|partnership)/i],
    ['Kapital', /\b(offering|buyback|repurchase|dividend|debt|notes|split|raise[sd]?)/i],
    ['Personal', /\b(ceo|cfo|chair|resign|appoint|steps down|hire[sd]?|succeed)/i],
    ['Risiko', /\b(recall|warning|warns|layoff|bankrupt|default|plunge|crash|short seller)/i],
    ['Halt', /\bhalt(ed|s)?\b/i],
    ['Regulierung', /\b(fda|sec\b|ftc|doj|approval|antitrust|regulator|ban|tariff)/i],
    ['Markt', /\b(fed\b|inflation|cpi|jobs report|rates|futures|economy|recession|treasury|dow|s&p|nasdaq)/i],
  ];
  const tagHeadline = (t) => TAGS.filter(([, re]) => re.test(t)).map(([n]) => n);
  const IMPORTANT_8K = {
    '1.03': 'Insolvenz', '1.05': 'Cyber Vorfall', '2.02': 'Quartalszahlen', '2.06': 'Abschreibung',
    '3.01': 'Delisting Hinweis', '4.02': 'Frühere Zahlen nicht verlässlich', '5.02': 'Wechsel im Management',
  };

  const api = {
    round2, floorCent, num, usd, usd0, halfUpCent, ny, marketClock, isTradingDay, closeMinOf, nextTradingDay, hm, fmtMin, fmtHM,
    normalizeBars, regularOnly, groupByDate, rsiWilder, atr, dailySetups, scanDailySymbol, SETUP_LABELS,
    entryCheck, planExit, timeMachine, verdictOf, mulberry32, sizePosition, riskCheck, bracketOutcome,
    evaluateAlert, tagHeadline, IMPORTANT_8K, DEFAULT_CONFIG, HOLIDAYS, EARLY_CLOSE, OPEN_MIN,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TraderEngine = api;
})(typeof self !== 'undefined' ? self : this);
