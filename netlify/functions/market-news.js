// Schlagzeilen (Yahoo Finance RSS) und SEC Meldungen (8-K) je Ticker.
// GET /.netlify/functions/market-news?symbols=TSLA,NVDA&forms=8-K
// SEC verlangt einen User-Agent mit Name und E-Mail: Netlify Umgebungsvariable
// SEC_USER_AGENT, z. B. "Max Mustermann max@example.com". Ohne sie bleiben
// die Meldungen leer und die Antwort sagt warum.
const fetch = require('node-fetch');

const SEC_UA = process.env.SEC_USER_AGENT || '';
const UA = 'Mozilla/5.0 (kuechen-dashboard trading)';
let tickerMap = null; // Ticker -> CIK, bleibt warm solange die Funktion lebt
let tickerMapAt = 0;

const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&')
  .replace(/<[^>]+>/g, '').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1]) : ''; };

async function yahooNews(symbol) {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, timeout: 8000 });
  if (!res.ok) throw new Error(`Yahoo RSS ${res.status}`);
  const xml = await res.text();
  const items = xml.split(/<item>/i).slice(1).map((chunk) => {
    const it = chunk.split(/<\/item>/i)[0];
    const pub = tag(it, 'pubDate');
    return {
      kind: 'news', symbol, title: tag(it, 'title'), link: tag(it, 'link'), summary: tag(it, 'description').slice(0, 280),
      source: 'Yahoo Finance', time: pub ? Date.parse(pub) : null, id: tag(it, 'guid') || tag(it, 'link'),
    };
  });
  return items.filter((i) => i.title);
}

async function secJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': SEC_UA, Accept: 'application/json' }, timeout: 9000 });
  if (!res.ok) throw new Error(`SEC ${res.status}`);
  return res.json();
}

async function cikFor(symbol) {
  if (!tickerMap || Date.now() - tickerMapAt > 24 * 3600e3) {
    const j = await secJson('https://www.sec.gov/files/company_tickers.json');
    tickerMap = {};
    for (const k of Object.keys(j)) tickerMap[String(j[k].ticker).toUpperCase()] = { cik: j[k].cik_str, name: j[k].title };
    tickerMapAt = Date.now();
  }
  return tickerMap[symbol.replace('-', '.')] || tickerMap[symbol] || null;
}

async function secFilings(symbol, forms) {
  const c = await cikFor(symbol);
  if (!c) return [];
  const cik10 = String(c.cik).padStart(10, '0');
  const j = await secJson(`https://data.sec.gov/submissions/CIK${cik10}.json`);
  const r = (j.filings && j.filings.recent) || {};
  const out = [];
  for (let i = 0; i < (r.form || []).length && out.length < 8; i++) {
    if (!forms.includes(r.form[i])) continue;
    const accn = r.accessionNumber[i];
    const folder = `https://www.sec.gov/Archives/edgar/data/${c.cik}/${accn.replace(/-/g, '')}`;
    const accepted = r.acceptanceDateTime && r.acceptanceDateTime[i];
    out.push({
      kind: 'filing', symbol, form: r.form[i], title: `${r.form[i]} ${c.name}`,
      items: String((r.items && r.items[i]) || '').split(',').map((s) => s.trim()).filter(Boolean),
      filed: r.filingDate[i], time: accepted ? Date.parse(accepted) : Date.parse(r.filingDate[i] + 'T12:00:00Z'),
      link: `${folder}/${r.primaryDocument[i]}`, index: `${folder}/`, source: 'SEC EDGAR', id: accn,
    });
  }
  return out;
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const symbols = String(p.symbols || '').split(',').map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z.\-]{1,8}$/.test(s)).slice(0, 15);
  const forms = String(p.forms || '8-K').split(',').map((s) => s.trim().toUpperCase());
  if (!symbols.length) return json(400, { ok: false, error: 'symbols fehlt' });

  const notes = [];
  if (!SEC_UA) notes.push('SEC Meldungen übersprungen: Netlify Umgebungsvariable SEC_USER_AGENT fehlt ("Name email@example.com").');
  const items = [];
  const errors = {};
  for (const s of symbols) {
    try { items.push(...await yahooNews(s)); } catch (e) { errors[s] = e.message; }
    if (SEC_UA) {
      try { items.push(...await secFilings(s, forms)); } catch (e) { errors[s] = (errors[s] ? errors[s] + '; ' : '') + e.message; }
      await new Promise((r) => setTimeout(r, 150)); // SEC erlaubt 10 pro Sekunde, wir bleiben weit drunter
    }
  }
  items.sort((a, b) => (b.time || 0) - (a.time || 0));
  return json(200, { ok: true, asOf: Date.now(), items, errors, notes });
};

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=120' }, body: JSON.stringify(body) };
}
