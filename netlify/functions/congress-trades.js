// Aktienmeldungen von Abgeordneten (STOCK Act): Index des House Clerk.
// GET /.netlify/functions/congress-trades?year=2026&member=pelosi&since=2026-10-01
// Liest https://disclosures-clerk.house.gov/public_disc/financial-pdfs/<YEAR>FD.zip,
// packt die XML Datei aus und gibt die Periodic Transaction Reports (Typ P) zurueck,
// jeweils mit Link zum PDF. Die PDFs selbst werden hier nicht gelesen.
const fetch = require('node-fetch');
const zlib = require('zlib');

const cache = {}; // year -> { at, filings }

/** Kleine ZIP Leseroutine: sucht das zentrale Verzeichnis und packt eine Datei aus. */
function unzipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP ohne Verzeichnis');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP Verzeichnis kaputt');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({
      name,
      read() {
        const ln = buf.readUInt16LE(local + 26), le = buf.readUInt16LE(local + 28);
        const start = local + 30 + ln + le;
        const data = buf.slice(start, start + csize);
        if (method === 0) return data;
        if (method === 8) return zlib.inflateRawSync(data);
        throw new Error(`ZIP Methode ${method} nicht unterstützt`);
      },
    });
    p += 46 + nameLen + extraLen + commLen;
  }
  return entries;
}

function parseIndex(xml, year) {
  const out = [];
  const get = (s, t) => { const m = s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return m ? m[1].trim() : ''; };
  for (const chunk of xml.split('<Member>').slice(1)) {
    const m = chunk.split('</Member>')[0];
    const type = get(m, 'FilingType');
    const [mo, d, y] = get(m, 'FilingDate').split('/');
    const filed = y ? `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}` : '';
    const docId = get(m, 'DocID');
    out.push({
      prefix: get(m, 'Prefix'), first: get(m, 'First'), last: get(m, 'Last'), suffix: get(m, 'Suffix'),
      district: get(m, 'StateDst'), type, filed, docId,
      pdf: type === 'P'
        ? `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`
        : `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}/${docId}.pdf`,
    });
  }
  return out;
}

async function loadYear(year) {
  const c = cache[year];
  if (c && Date.now() - c.at < 30 * 60e3) return c.filings;
  const res = await fetch(`https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (kuechen-dashboard trading)' }, timeout: 9000,
  });
  if (!res.ok) throw new Error(`House Clerk ${res.status}`);
  const buf = await res.buffer();
  const xmlEntry = unzipEntries(buf).find((e) => /\.xml$/i.test(e.name));
  if (!xmlEntry) throw new Error('keine XML im ZIP');
  const filings = parseIndex(xmlEntry.read().toString('utf8'), year);
  cache[year] = { at: Date.now(), filings };
  return filings;
}

function matchMember(f, q) {
  if (!q) return true;
  const s = q.toLowerCase().replace(/^hon\.?\s*/, '').trim();
  const full = `${f.first} ${f.last}`.toLowerCase();
  if (s.includes(',')) { const [last, first] = s.split(',').map((x) => x.trim()); return f.last.toLowerCase() === last && f.first.toLowerCase().startsWith(first); }
  return f.last.toLowerCase() === s || full === s || full.includes(s);
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const year = /^\d{4}$/.test(p.year || '') ? +p.year : new Date().getUTCFullYear();
  const type = p.type === undefined ? 'P' : p.type;
  const members = String(p.member || '').split('|').map((s) => s.trim()).filter(Boolean);
  const since = /^\d{4}-\d{2}-\d{2}$/.test(p.since || '') ? p.since : '';
  try {
    let filings = await loadYear(year);
    // Im Januar auch das Vorjahr, damit Dezember Meldungen nicht fehlen
    if (new Date().getUTCMonth() === 0 && !p.year) { try { filings = filings.concat(await loadYear(year - 1)); } catch (e) { /* egal */ } }
    let list = filings.filter((f) => (!type || f.type === type) && (!since || f.filed >= since));
    if (members.length) list = list.filter((f) => members.some((m) => matchMember(f, m)));
    list.sort((a, b) => (a.filed < b.filed ? 1 : a.filed > b.filed ? -1 : 0));
    return json(200, { ok: true, year, count: list.length, filings: list.slice(0, 200), asOf: Date.now() });
  } catch (e) {
    return json(200, { ok: false, error: e.message });
  }
};

module.exports.unzipEntries = unzipEntries;
module.exports.parseIndex = parseIndex;

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=900' }, body: JSON.stringify(body) };
}
