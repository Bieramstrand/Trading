// Kerzen und Kurse von Yahoo Finance (frei, inoffiziell, kann verzoegert sein).
// GET /.netlify/functions/market-chart?symbols=TSLA,NVDA&range=1d&interval=5m
// Antwort: { ok, asOf, data: { TSLA: { meta, bars:[{t,o,h,l,c,v}] } | { error } } }
const fetch = require('node-fetch');

const HOSTS = ['https://query2.finance.yahoo.com', 'https://query1.finance.yahoo.com'];
const RANGES = new Set(['1d', '2d', '5d', '1mo', '3mo', '6mo', '1y', '60d']);
const INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '1h', '1d']);
const UA = 'Mozilla/5.0 (kuechen-dashboard trading)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchChart(symbol, range, interval) {
  const qs = `range=${range}&interval=${interval}&includePrePost=false`;
  let lastErr = 'keine Antwort';
  for (let attempt = 0; attempt < HOSTS.length + 1; attempt++) {
    const host = HOSTS[Math.min(attempt, HOSTS.length - 1)];
    try {
      const res = await fetch(`${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 8000,
      });
      if (res.status === 429) { lastErr = 'Yahoo bremst (429)'; await sleep(1500); continue; }
      if (res.status >= 500) { lastErr = `Yahoo Fehler ${res.status}`; continue; }
      const json = await res.json();
      const r = json && json.chart && json.chart.result && json.chart.result[0];
      if (!r) {
        const e = json && json.chart && json.chart.error;
        return { error: e ? e.description || e.code : `keine Daten (${res.status})` };
      }
      const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
      const ts = r.timestamp || [];
      const bars = [];
      for (let i = 0; i < ts.length; i++) {
        if (q.close == null || q.close[i] == null) continue;
        bars.push({ t: ts[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume ? q.volume[i] || 0 : 0 });
      }
      const m = r.meta || {};
      return {
        meta: {
          symbol: m.symbol, name: m.shortName || m.longName || null, currency: m.currency,
          exchange: m.fullExchangeName || m.exchangeName, price: m.regularMarketPrice,
          prevClose: m.chartPreviousClose ?? m.previousClose, regularPrevClose: m.previousClose ?? null,
          time: m.regularMarketTime, volume: m.regularMarketVolume ?? null,
          dayHigh: m.regularMarketDayHigh ?? null, dayLow: m.regularMarketDayLow ?? null,
          instrumentType: m.instrumentType,
        },
        bars,
      };
    } catch (e) {
      lastErr = e.message;
    }
  }
  return { error: lastErr };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const symbols = String(p.symbols || p.symbol || '')
    .split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9.^=\-]{1,12}$/.test(s));
  const range = RANGES.has(p.range) ? p.range : '1d';
  const interval = INTERVALS.has(p.interval) ? p.interval : '5m';
  if (!symbols.length) return json(400, { ok: false, error: 'symbols fehlt' });
  if (symbols.length > 25) return json(400, { ok: false, error: 'höchstens 25 Werte pro Abruf' });

  const results = await pool(symbols, 6, (s) => fetchChart(s, range, interval));
  const data = {};
  symbols.forEach((s, i) => { data[s] = results[i]; });
  return json(200, { ok: true, asOf: Date.now(), range, interval, data }, interval === '1d' ? 300 : 30);
};

function json(status, body, maxAge = 0) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${maxAge}` },
    body: JSON.stringify(body),
  };
}
