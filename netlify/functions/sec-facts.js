// Quartalszahlen aus den XBRL Daten der SEC (10-Q, 10-K) plus letzte Quartalsmeldung (8-K Punkt 2.02).
// GET /.netlify/functions/sec-facts?symbol=TSLA&quarters=8
// Braucht SEC_USER_AGENT ("Name email@example.com") als Netlify Umgebungsvariable.
const fetch = require('node-fetch');

const SEC_UA = process.env.SEC_USER_AGENT || '';
let tickerMap = null;

async function secJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': SEC_UA, Accept: 'application/json' }, timeout: 9500 });
  if (!res.ok) throw new Error(`SEC ${res.status} bei ${url}`);
  return res.json();
}

const REVENUE_TAGS = [
  'RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet',
  'RevenueFromContractWithCustomerIncludingAssessedTax', 'RevenuesNetOfInterestExpense',
];

/** frame -> Wert, erster Tag in der Liste gewinnt. Nur Dauerwerte (CY2026Q2, CY2025). */
function byFrame(facts, tags, unit) {
  const out = {};
  for (const t of tags) {
    const f = facts[t];
    if (!f || !f.units || !f.units[unit]) continue;
    for (const e of f.units[unit]) {
      if (!e.frame || /I$/.test(e.frame)) continue;
      if (!(e.frame in out)) out[e.frame] = { val: e.val, end: e.end, start: e.start, form: e.form, filed: e.filed, tag: t };
    }
  }
  return out;
}

function quarterSeries(map) {
  const q = {};
  for (const k of Object.keys(map)) if (/^CY\d{4}Q[1-4]$/.test(k)) q[k] = { ...map[k] };
  // Q4 steht nicht in einem 10-Q: Jahr minus drei Quartale, als abgeleitet markiert
  for (const k of Object.keys(map)) {
    const m = k.match(/^CY(\d{4})$/);
    if (!m) continue;
    const y = m[1];
    const q4 = `CY${y}Q4`;
    if (q[q4]) continue;
    const parts = [1, 2, 3].map((n) => q[`CY${y}Q${n}`]);
    if (parts.every(Boolean)) q[q4] = { val: map[k].val - parts.reduce((a, b) => a + b.val, 0), end: map[k].end, derived: true, form: map[k].form, filed: map[k].filed };
  }
  return q;
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const symbol = String(p.symbol || '').trim().toUpperCase();
  const nQ = Math.min(12, Math.max(4, +p.quarters || 8));
  if (!/^[A-Z.\-]{1,8}$/.test(symbol)) return json(400, { ok: false, error: 'symbol fehlt' });
  if (!SEC_UA) return json(200, { ok: false, error: 'Netlify Umgebungsvariable SEC_USER_AGENT fehlt. Die SEC verlangt Name und E-Mail, z. B. "Max Mustermann max@example.com".' });

  try {
    if (!tickerMap) {
      const j = await secJson('https://www.sec.gov/files/company_tickers.json');
      tickerMap = {};
      for (const k of Object.keys(j)) tickerMap[String(j[k].ticker).toUpperCase()] = { cik: j[k].cik_str, name: j[k].title };
    }
    const c = tickerMap[symbol.replace('-', '.')] || tickerMap[symbol];
    if (!c) return json(200, { ok: false, error: `${symbol} ist bei der SEC nicht gelistet (ausländische Werte melden oft keine 10-Q).` });
    const cik10 = String(c.cik).padStart(10, '0');
    const [facts, subs] = await Promise.all([
      secJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`),
      secJson(`https://data.sec.gov/submissions/CIK${cik10}.json`),
    ]);
    const g = (facts.facts && facts.facts['us-gaap']) || {};
    const rev = quarterSeries(byFrame(g, REVENUE_TAGS, 'USD'));
    const ni = quarterSeries(byFrame(g, ['NetIncomeLoss', 'ProfitLoss'], 'USD'));
    const gp = quarterSeries(byFrame(g, ['GrossProfit'], 'USD'));
    const op = quarterSeries(byFrame(g, ['OperatingIncomeLoss'], 'USD'));
    const eps = quarterSeries(byFrame(g, ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'], 'USD/shares'));

    const keys = [...new Set([...Object.keys(rev), ...Object.keys(ni)])].sort().reverse();
    const prevYear = (k) => k.replace(/^CY(\d{4})/, (_, y) => `CY${+y - 1}`);
    const prevQ = (k) => { const [, y, n] = k.match(/^CY(\d{4})Q(\d)$/); return n === '1' ? `CY${+y - 1}Q4` : `CY${y}Q${+n - 1}`; };
    const v = (s, k) => (s[k] ? s[k].val : null);
    const growth = (a, b) => (a != null && b ? ((a - b) / Math.abs(b)) * 100 : null);
    const quarters = keys.slice(0, nQ).map((k) => {
      const r = v(rev, k);
      return {
        frame: k, end: (rev[k] || ni[k] || {}).end, derived: !!((rev[k] && rev[k].derived) || (ni[k] && ni[k].derived)),
        revenue: r, revenueYoY: growth(r, v(rev, prevYear(k))), revenueQoQ: growth(r, v(rev, prevQ(k))),
        netIncome: v(ni, k), netIncomeYoY: growth(v(ni, k), v(ni, prevYear(k))),
        eps: v(eps, k), epsYoY: growth(v(eps, k), v(eps, prevYear(k))),
        grossMargin: r && v(gp, k) != null ? (v(gp, k) / r) * 100 : null,
        opMargin: r && v(op, k) != null ? (v(op, k) / r) * 100 : null,
        netMargin: r && v(ni, k) != null ? (v(ni, k) / r) * 100 : null,
        oneOff: v(ni, k) != null && v(op, k) != null && v(ni, k) > v(op, k),
      };
    });
    const last4 = keys.slice(0, 4);
    const sum = (s) => (last4.every((k) => s[k]) ? last4.reduce((a, k) => a + s[k].val, 0) : null);
    const ttm = { revenue: sum(rev), netIncome: sum(ni), eps: sum(eps) };

    const r = (subs.filings && subs.filings.recent) || {};
    const link = (i) => `https://www.sec.gov/Archives/edgar/data/${c.cik}/${r.accessionNumber[i].replace(/-/g, '')}/${r.primaryDocument[i]}`;
    let latestReport = null, latestEarnings = null;
    for (let i = 0; i < (r.form || []).length; i++) {
      if (!latestReport && (r.form[i] === '10-Q' || r.form[i] === '10-K')) latestReport = { form: r.form[i], filed: r.filingDate[i], period: r.reportDate[i], link: link(i) };
      if (!latestEarnings && r.form[i] === '8-K' && String(r.items[i] || '').includes('2.02')) {
        latestEarnings = { filed: r.filingDate[i], link: link(i), index: `https://www.sec.gov/Archives/edgar/data/${c.cik}/${r.accessionNumber[i].replace(/-/g, '')}/` };
      }
      if (latestReport && latestEarnings) break;
    }
    const notes = [];
    if (latestReport && quarters[0] && quarters[0].end && latestReport.period > quarters[0].end) {
      notes.push(`Die SEC Daten hängen hinterher: das neueste ${latestReport.form} (Periode bis ${latestReport.period}) ist noch nicht enthalten. Bitte die Meldung selbst lesen.`);
    }
    if (quarters.some((q) => q.derived)) notes.push('Q4 ist abgeleitet: Jahreswert minus drei Quartale. EPS dort nur ungefähr.');
    if (quarters[0] && quarters[0].oneOff) notes.push('Der Nettogewinn liegt über dem operativen Ergebnis: Sondereffekte außerhalb des Geschäfts (Beteiligungen, Steuern) stecken darin.');
    return json(200, { ok: true, symbol, name: c.name, cik: c.cik, quarters, ttm, latestReport, latestEarnings, notes, asOf: Date.now() });
  } catch (e) {
    return json(200, { ok: false, error: e.message });
  }
};

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }, body: JSON.stringify(body) };
}
