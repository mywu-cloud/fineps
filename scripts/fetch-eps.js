// scripts/fetch-eps.js
// Fetches TaiwanStockInfo + TaiwanStockFinancialStatements (EPS) from FinMind
// and writes cached JSON snapshots (data/eps-twse.json, data/eps-tpex.json)
// used by the front-end so it does not have to re-query FinMind for every
// visit / page load.
//
// Resumable design: stocks that already have a non-null EPS value for the
// current "target quarter" (the most recently completed calendar quarter,
// e.g. 26Q2 as of Aug 2026) are skipped entirely - no FinMind call is made
// for them. Only stocks whose target-quarter field is still blank (not yet
// fetched, or not yet announced) are queried. This keeps API usage low and
// lets the cache fill in gradually across multiple scheduled runs, mirroring
// the "check DB first, fetch only if blank" logic requested for the site.
const fs = require('fs');
const path = require('path');

const FINFO = 'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo';
const FEPS = 'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockFinancialStatements&data_id=';
const TOKEN = process.env.FINMIND_TOKEN || '';
const BAD = ['ETF', '存託憑證', '特別股', '受益憑證', '指數股票型', '債券', '基金', '創新板'];
const BATCH = 10;
const DELAY_MS = 350;
const DATA_DIR = path.join(__dirname, '..', 'data');

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

function loadExisting(file) {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
    const j = JSON.parse(raw);
    return (j && j.stocks) ? j.stocks : {};
  } catch (e) {
    return {};
  }
}

// Target quarter = most recently *completed* calendar quarter (Taiwan time).
// e.g. today is 2026-08-07 (calendar Q3) -> target is 2026 Q2 (26Q2), which is
// the quarter companies are currently reporting.
function targetQuarter() {
  const now = new Date();
  const tw = new Date(now.getTime() + 8 * 3600000);
  let y = tw.getUTCFullYear();
  const m = tw.getUTCMonth() + 1;
  const curQ = m <= 3 ? 1 : m <= 6 ? 2 : m <= 9 ? 3 : 4;
  let q = curQ - 1;
  if (q < 1) { q = 4; y -= 1; }
  return { year: y, q: q, key: y + '_' + q, label: (y % 100) + 'Q' + q };
}

async function build(type, stocks, startDate, cache, tq) {
  const out = {};
  const needFetch = [];
  stocks.forEach(function (s) {
    const cached = cache[s.stock_id];
    if (cached && cached.quarters && cached.quarters[tq.key] != null) {
      out[s.stock_id] = cached; // already have target quarter -> reuse, no API call
    } else {
      needFetch.push(s);
    }
  });
  console.log('[' + type + '] ' + (stocks.length - needFetch.length) + '/' + stocks.length + ' already cached for ' + tq.label + ', fetching ' + needFetch.length + ' remaining');
  let quotaHit = false;
  for (let i = 0; i < needFetch.length; i += BATCH) {
    const batch = needFetch.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(function (s) {
      return fetchStockEps(s.stock_id, startDate).catch(function () { return { quota: false, qMap: {} }; });
    }));
    batch.forEach(function (s, idx) {
      const r = results[idx];
      if (r.quota) { quotaHit = true; return; }
      out[s.stock_id] = {
        name: s.stock_name || s.stock_id,
        industry: s.industry_category || '',
        quarters: r.qMap
      };
    });
    console.log('[' + type + '] fetched ' + Math.min(i + BATCH, needFetch.length) + '/' + needFetch.length);
    if (quotaHit) {
      console.warn('[' + type + '] FinMind quota hit, stopping early at ' + i + '/' + needFetch.length);
      break;
    }
    if (i + BATCH < needFetch.length) await sleep(DELAY_MS);
  }
  // Stocks not yet reached this run (due to quota) keep their old cache entry
  // if any, so we never lose previously fetched history.
  needFetch.forEach(function (s) {
    if (!out[s.stock_id] && cache[s.stock_id]) out[s.stock_id] = cache[s.stock_id];
  });
  return out;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tq = targetQuarter();
  console.log('Target quarter: ' + tq.label);
  const list = await fetchStockList();
  const twse = list.filter(function (s) { return s.type === 'twse'; });
  const tpex = list.filter(function (s) { return s.type === 'tpex'; });
  const startDate = (new Date().getFullYear() - 4) + '-01-01';

  const twseCache = loadExisting('eps-twse.json');
  const tpexCache = loadExisting('eps-tpex.json');

  const twseData = await build('twse', twse, startDate, twseCache, tq);
  const tpexData = await build('tpex', tpex, startDate, tpexCache, tq);

  function payload(stocks) {
    return { updatedAt: new Date().toISOString(), targetQuarter: tq, stocks: stocks };
  }

  fs.writeFileSync(path.join(DATA_DIR, 'eps-twse.json'), JSON.stringify(payload(twseData)));
  fs.writeFileSync(path.join(DATA_DIR, 'eps-tpex.json'), JSON.stringify(payload(tpexData)));

  function coverage(stocks) {
    const total = Object.keys(stocks).length;
    let have = 0;
    Object.keys(stocks).forEach(function (id) {
      if (stocks[id].quarters && stocks[id].quarters[tq.key] != null) have++;
    });
    return have + '/' + total;
  }
  console.log('Done. TWSE ' + tq.label + ' coverage: ' + coverage(twseData) + ', TPEx ' + tq.label + ' coverage: ' + coverage(tpexData));
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
