// scripts/fetch-prices.js
// Snapshots closing prices for the whole market into data/prices.json with two
// bulk requests (TWSE STOCK_DAY_ALL + TPEx mainboard quotes), so the front-end
// can show prices immediately without per-stock FinMind calls.
// A market whose request fails keeps its previous snapshot.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'prices.json');
const TWSE = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
const TPEX = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes';

function ok4(code) { return /^[1-9][0-9]{3,4}$/.test(code); }
function num(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ROC date "1151008" -> "2026-10-08"
function rocDate(s) {
  s = String(s || '').trim();
  if (!/^\d{7}$/.test(s)) return '';
  return (parseInt(s.slice(0, 3), 10) + 1911) + '-' + s.slice(3, 5) + '-' + s.slice(5, 7);
}

async function getJson(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (fineps cache bot)', Accept: 'application/json' } });
      const arr = JSON.parse(await res.text());
      if (!Array.isArray(arr) || !arr.length) throw new Error('empty');
      return arr;
    } catch (e) {
      if (attempt === 4) { console.warn('failed: ' + url + ' (' + e.message + ')'); return null; }
      await sleep(2500 * attempt);
    }
  }
  return null;
}

function build(arr, f) {
  const p = {};
  let date = '';
  arr.forEach(function (x) {
    const code = String(x[f.code] || '').trim();
    if (!ok4(code)) return;
    const close = num(x[f.close]);
    if (close == null || close <= 0) return;
    p[code] = [close, num(x[f.chg])];
    const d = rocDate(x.Date);
    if (d > date) date = d;
  });
  return { date: date, n: Object.keys(p).length, p: p };
}

async function main() {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* first run */ }
  const out = { updatedAt: new Date().toISOString(), twse: prev.twse || null, tpex: prev.tpex || null };

  const tw = await getJson(TWSE);
  if (tw) out.twse = build(tw, { code: 'Code', close: 'ClosingPrice', chg: 'Change' });
  const tp = await getJson(TPEX);
  if (tp) out.tpex = build(tp, { code: 'SecuritiesCompanyCode', close: 'Close', chg: 'Change' });

  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(out));
  console.log('TWSE ' + (out.twse ? out.twse.date + ' ' + out.twse.n : 'n/a') +
    ', TPEx ' + (out.tpex ? out.tpex.date + ' ' + out.tpex.n : 'n/a'));
}

main().catch(function (e) { console.error(e); process.exit(1); });
