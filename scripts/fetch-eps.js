// scripts/fetch-eps.js
// Fetches TaiwanStockInfo + TaiwanStockFinancialStatements (EPS) from FinMind
// and writes cached JSON snapshots (data/eps-twse.json, data/eps-tpex.json)
// used by the front-end so it does not have to re-query FinMind for every
// visit / page load.
const fs = require('fs');
const path = require('path');

const FINFO = 'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo';
const FEPS = 'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockFinancialStatements&data_id=';
const TOKEN = process.env.FINMIND_TOKEN || '';
const BAD = ['ETF', '存託憑證', '特別股', '受益憑證', '指數股票型', '債券', '基金', '創新板'];
const BATCH = 10;
const DELAY_MS = 350;

function ok4(code) { return /^[1-9][0-9]{3,4}$/.test(code); }
function okName(name) { return !BAD.some(function (b) { return (name || '').indexOf(b) >= 0; }); }
function withToken(url) { return TOKEN ? url + (url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + TOKEN : url; }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function parseEpsData(data) {
  const qMap = {};
  for (const d of data) {
    if (d.type !== 'EPS') continue;
    const dt = d.date || '';
    const yr = parseInt(dt.slice(0, 4), 10);
    const mo = parseInt(dt.slice(5, 7), 10);
    const qn = mo <= 3 ? 1 : mo <= 6 ? 2 : mo <= 9 ? 3 : 4;
    const key = yr + '_' + qn;
    const v = d.value == null ? null : parseFloat(String(d.value).replace(/,/g, ''));
    if (qMap[key] === undefined || v != null) qMap[key] = v;
  }
  return qMap;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok && res.status !== 402) throw new Error('HTTP ' + res.status + ' for ' + url);
  return res.json();
}

async function fetchStockList() {
  const d = await fetchJson(withToken(FINFO));
  if (d.status === 402) throw new Error('FinMind quota exceeded while fetching TaiwanStockInfo');
  const rows = (d.data || []).filter(function (s) {
    return ok4(s.stock_id) && okName(s.stock_name) &&
      (s.type === 'twse' || s.type === 'tpex') && okName(s.industry_category || '') &&
      (s.industry_category || '').indexOf('創新') < 0;
  });
  const seen = new Set();
  return rows.filter(function (s) {
    if (seen.has(s.stock_id)) return false;
    seen.add(s.stock_id);
    return true;
  });
}

async function fetchStockEps(stockId, startDate) {
  const url = withToken(FEPS + stockId + '&start_date=' + startDate);
  const d = await fetchJson(url);
  if (d.status === 402) return { quota: true, qMap: {} };
  return { quota: false, qMap: parseEpsData(d.data || []) };
}

async function build(type, stocks, startDate) {
  const out = {};
  let quotaHit = false;
  for (let i = 0; i < stocks.length; i += BATCH) {
    const batch = stocks.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(function (s) {
      return fetchStockEps(s.stock_id, startDate).catch(function () { return { quota: false, qMap: {} }; });
    }));
    batch.forEach(function (s, idx) {
      const r = results[idx];
      if (r.quota) quotaHit = true;
      out[s.stock_id] = {
        name: s.stock_name || s.stock_id,
        industry: s.industry_category || '',
        quarters: r.qMap
      };
    });
    console.log('[' + type + '] ' + Math.min(i + BATCH, stocks.length) + '/' + stocks.length);
    if (quotaHit) {
      console.warn('[' + type + '] FinMind quota hit, stopping early at ' + i);
      break;
    }
    if (i + BATCH < stocks.length) await sleep(DELAY_MS);
  }
  return out;
}

function currentQuarterLabel() {
  const now = new Date();
  const tw = new Date(now.getTime() + 8 * 3600000);
  const y = tw.getUTCFullYear();
  const m = tw.getUTCMonth() + 1;
  const q = m <= 3 ? 1 : m <= 6 ? 2 : m <= 9 ? 3 : 4;
  return { year: y, q: q, label: (y % 100) + 'Q' + q };
}

async function main() {
  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const list = await fetchStockList();
  const twse = list.filter(function (s) { return s.type === 'twse'; });
  const tpex = list.filter(function (s) { return s.type === 'tpex'; });
  const startDate = (new Date().getFullYear() - 4) + '-01-01';
  const latest = currentQuarterLabel();

  const twseData = await build('twse', twse, startDate);
  const tpexData = await build('tpex', tpex, startDate);

  function payload(stocks) {
    return { updatedAt: new Date().toISOString(), latestQuarter: latest, stocks: stocks };
  }

  fs.writeFileSync(path.join(outDir, 'eps-twse.json'), JSON.stringify(payload(twseData)));
  fs.writeFileSync(path.join(outDir, 'eps-tpex.json'), JSON.stringify(payload(tpexData)));
  console.log('Done. TWSE:', Object.keys(twseData).length, 'TPEx:', Object.keys(tpexData).length);
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
