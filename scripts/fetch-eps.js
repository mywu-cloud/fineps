// scripts/fetch-eps.js
// Builds the EPS cache used by the front-end (data/eps-twse.json, data/eps-tpex.json)
// so that browsers never have to query FinMind per stock.
//
// Two-stage update, run by GitHub Actions (update-eps.yml):
//
//  1. BULK (cheap, every run): the official TWSE / TPEx OpenAPI endpoints return
//     the latest reported season for the whole market in a handful of requests.
//     Their EPS figure is year-to-date (cumulative), so the single-quarter value
//     is derived as YTD(Q) - sum(Q1..Q-1). Derived values are flagged in
//     `est` (provisional) because weighted share counts can differ slightly
//     from the officially reported single-quarter EPS.
//
//  2. FINMIND (exact figures, capped per run): only for
//       a) stocks whose newest quarter is still provisional (from step 1), and
//       b) stocks still missing the "main" quarter,
//     each throttled by a per-stock `chk` marker so stocks that have not
//     reported yet are not re-queried every run.
//
// The "main" quarter is derived from the data (latest quarter covered by at
// least half of the market), not from the calendar, so the site moves to a new
// quarter automatically as soon as most companies have reported, and the
// "early" (搶先報) quarter is simply the following one.
const fs = require('fs');
const path = require('path');

const FINFO = 'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo';
const FEPS = 'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockFinancialStatements&data_id=';
const TOKEN = process.env.FINMIND_TOKEN || '';
const MAX_FINMIND = parseInt(process.env.MAX_FINMIND || '400', 10); // FinMind calls per run
const RECHECK_HOURS = parseFloat(process.env.RECHECK_HOURS || '20'); // per-stock throttle
const BAD = ['ETF', '存託憑證', '特別股', '受益憑證', '指數股票型', '債券', '基金', '創新板'];
const BATCH = 10;
const DELAY_MS = 350;
const DATA_DIR = path.join(__dirname, '..', 'data');

const TWSE_OA = 'https://openapi.twse.com.tw/v1/opendata/';
const TPEX_OA = 'https://www.tpex.org.tw/openapi/v1/';
// Order matters: earlier sources win when the same company appears twice
// (short company names come from t187ap06_*, t187ap14_L only adds coverage).
const BULK = {
  twse: ['ci', 'basi', 'bd', 'fh', 'ins', 'mim'].map(function (s) { return TWSE_OA + 't187ap06_L_' + s; })
    .concat([TWSE_OA + 't187ap14_L']),
  tpex: ['ci', 'basi', 'bd', 'fh', 'ins', 'mim'].map(function (s) { return TPEX_OA + 'mopsfin_t187ap06_O_' + s; })
};

function ok4(code) { return /^[1-9][0-9]{3,4}$/.test(code); }
function okName(name) { return !BAD.some(function (b) { return (name || '').indexOf(b) >= 0; }); }
function withToken(url) { return TOKEN ? url + (url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + TOKEN : url; }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function r2(v) { return Math.round(v * 100) / 100; }
function num(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}
function qKey(y, q) { return y + '_' + q; }
function parseKey(k) { const p = k.split('_'); return { y: +p[0], q: +p[1] }; }
function nextQ(y, q) { return q === 4 ? { y: y + 1, q: 1 } : { y: y, q: q + 1 }; }
function label(y, q) { return (y % 100) + 'Q' + q; }

// ---------------------------------------------------------------- FinMind
async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok && res.status !== 402) throw new Error('HTTP ' + res.status + ' for ' + url.replace(/token=[^&]+/, 'token=***'));
  return res.json();
}

async function fetchStockList() {
  try {
    const d = await fetchJson(withToken(FINFO));
    if (d.status !== 200) throw new Error('status ' + d.status);
    const seen = new Set();
    return (d.data || []).filter(function (s) {
      if (!ok4(s.stock_id) || !okName(s.stock_name) || !okName(s.industry_category || '')) return false;
      if ((s.industry_category || '').indexOf('創新') >= 0) return false;
      if (s.type !== 'twse' && s.type !== 'tpex') return false;
      if (seen.has(s.stock_id)) return false;
      seen.add(s.stock_id);
      return true;
    });
  } catch (e) {
    console.warn('TaiwanStockInfo unavailable (' + e.message + '), falling back to cached universe');
    return null;
  }
}

function parseEpsData(data) {
  const qMap = {};
  for (const d of data) {
    if (d.type !== 'EPS') continue;
    const dt = d.date || '';
    const yr = parseInt(dt.slice(0, 4), 10);
    const mo = parseInt(dt.slice(5, 7), 10);
    const key = qKey(yr, mo <= 3 ? 1 : mo <= 6 ? 2 : mo <= 9 ? 3 : 4);
    const v = num(d.value);
    if (qMap[key] === undefined || v != null) qMap[key] = v;
  }
  return qMap;
}

async function fetchStockEps(stockId, startDate) {
  const d = await fetchJson(withToken(FEPS + stockId + '&start_date=' + startDate));
  if (d.status === 402) return { quota: true, qMap: {} };
  return { quota: false, qMap: parseEpsData(d.data || []) };
}

// ---------------------------------------------------------------- Bulk OpenAPI
async function fetchBulkOne(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (fineps cache bot)',
          Accept: 'application/json'
        }
      });
      const txt = await res.text();
      const arr = JSON.parse(txt); // TPEx intermittently answers with an HTML 404 page
      if (!Array.isArray(arr)) throw new Error('not an array');
      return arr;
    } catch (e) {
      if (attempt === 4) { console.warn('bulk failed: ' + url + ' (' + e.message + ')'); return []; }
      await sleep(2500 * attempt);
    }
  }
  return [];
}

function normBulk(x) {
  const epsKey = Object.keys(x).find(function (k) { return k.indexOf('每股盈餘') >= 0; });
  const roc = parseInt(x['年度'] || x.Year, 10);
  return {
    code: String(x['公司代號'] || x.SecuritiesCompanyCode || '').trim(),
    name: String(x['公司名稱'] || x.CompanyName || '').trim(),
    industry: String(x['產業別'] || '').trim(),
    y: roc ? roc + 1911 : null,
    q: parseInt(x['季別'] || x.Season, 10) || null,
    ytd: epsKey ? num(x[epsKey]) : null
  };
}

async function fetchBulk(market) {
  const out = {};
  for (const url of BULK[market]) {
    const arr = await fetchBulkOne(url);
    let n = 0;
    arr.forEach(function (x) {
      const b = normBulk(x);
      if (!ok4(b.code) || !b.y || !b.q || b.ytd == null || out[b.code]) return;
      out[b.code] = b;
      n++;
    });
    console.log('[' + market + '] bulk ' + url.split('/').pop() + ': ' + n);
    await sleep(800);
  }
  return out;
}

// Merge bulk YTD figures into the cache as provisional single-quarter values.
function mergeBulk(market, stocks, bulk) {
  let filled = 0, skipped = 0;
  Object.keys(bulk).forEach(function (code) {
    const b = bulk[code];
    let s = stocks[code];
    if (!s) {
      s = stocks[code] = { name: b.name, industry: b.industry, quarters: {} };
    }
    if (!s.quarters) s.quarters = {};
    const key = qKey(b.y, b.q);
    const isEst = s.est && s.est[key];
    if (s.quarters[key] != null && !isEst) return; // exact (FinMind) value already there
    let prev = 0;
    for (let i = 1; i < b.q; i++) {
      const v = s.quarters[qKey(b.y, i)];
      if (v == null) { skipped++; return; } // cannot derive single quarter yet
      prev += v;
    }
    s.quarters[key] = r2(b.ytd - prev);
    s.est = s.est || {};
    s.est[key] = 1;
    filled++;
  });
  console.log('[' + market + '] bulk merged: ' + filled + ' provisional values, ' + skipped + ' not derivable');
}

// ---------------------------------------------------------------- Quarters
function coverage(stocks) {
  const c = {};
  Object.keys(stocks).forEach(function (id) {
    const qs = stocks[id].quarters || {};
    Object.keys(qs).forEach(function (k) { if (qs[k] != null) c[k] = (c[k] || 0) + 1; });
  });
  return c;
}

// Latest quarter reported by at least half of the market.
function mainQuarter(cov, total) {
  const keys = Object.keys(cov).sort(function (a, b) {
    const A = parseKey(a), B = parseKey(b);
    return (A.y * 10 + A.q) - (B.y * 10 + B.q);
  });
  let best = null;
  keys.forEach(function (k) { if (cov[k] >= total * 0.5) best = k; });
  if (!best) return null;
  const p = parseKey(best);
  return { year: p.y, q: p.q, key: best, label: label(p.y, p.q) };
}

function qInfo(y, q) { return { year: y, q: q, key: qKey(y, q), label: label(y, q) }; }

// Fallback when the cache is empty: the most recently completed calendar quarter.
function calendarQuarter() {
  const tw = new Date(Date.now() + 8 * 3600000);
  let y = tw.getUTCFullYear();
  let q = Math.floor(tw.getUTCMonth() / 3); // 0..3 -> previous quarter
  if (q < 1) { q = 4; y -= 1; }
  return qInfo(y, q);
}

// ---------------------------------------------------------------- Main
function loadExisting(file) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
    return (j && j.stocks) ? j.stocks : {};
  } catch (e) {
    return {};
  }
}

function needsCheck(s, key, nowMs) {
  return !(s && s.chk && s.chk.key === key && nowMs - s.chk.at < RECHECK_HOURS * 3600000);
}

async function runFinMind(market, stocks, list, mq, eq, startDate, budget) {
  const nowMs = Date.now();
  const prio = [], rest = [];
  list.forEach(function (info) {
    const s = stocks[info.stock_id];
    // a) provisional (bulk-derived) values -> confirm with FinMind
    const estKeys = s && s.est ? Object.keys(s.est) : [];
    if (estKeys.length) {
      const k = estKeys.sort().pop();
      if (needsCheck(s, k, nowMs)) prio.push({ info: info, key: k });
      return;
    }
    // b) missing the main quarter (new listing, or not fetched yet)
    if (mq && !(s && s.quarters && s.quarters[mq.key] != null) && needsCheck(s, mq.key, nowMs)) {
      rest.push({ info: info, key: mq.key });
    }
  });
  const todo = prio.concat(rest).slice(0, budget.left);
  console.log('[' + market + '] FinMind todo: ' + todo.length + ' (provisional ' + prio.length + ', missing ' + mq.label + ' ' + rest.length + ', budget ' + budget.left + ')');

  for (let i = 0; i < todo.length && !budget.quota; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(function (t) {
      return fetchStockEps(t.info.stock_id, startDate).catch(function () { return { quota: false, qMap: null }; });
    }));
    budget.left -= batch.length;
    batch.forEach(function (t, idx) {
      const r = results[idx];
      if (r.quota) { budget.quota = true; return; }
      const id = t.info.stock_id;
      const s = stocks[id] || (stocks[id] = { name: '', industry: '', quarters: {} });
      s.name = t.info.stock_name || s.name || id;
      s.industry = t.info.industry_category || s.industry || '';
      if (!s.quarters) s.quarters = {};
      if (r.qMap) {
        Object.keys(r.qMap).forEach(function (k) {
          if (r.qMap[k] == null) return;
          s.quarters[k] = r.qMap[k];
          if (s.est) delete s.est[k];
        });
      }
      if (s.est && !Object.keys(s.est).length) delete s.est;
      if (s.quarters[t.key] != null && !(s.est && s.est[t.key])) delete s.chk;
      else s.chk = { key: t.key, at: Date.now() };
    });
    if (budget.quota) { console.warn('[' + market + '] FinMind quota hit at ' + i + '/' + todo.length); break; }
    if (i + BATCH < todo.length) await sleep(DELAY_MS);
  }
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const list = await fetchStockList();
  const startDate = (new Date().getFullYear() - 4) + '-01-01';
  const budget = { left: MAX_FINMIND, quota: false };
  const result = {};

  for (const market of ['twse', 'tpex']) {
    const file = 'eps-' + market + '.json';
    const cache = loadExisting(file);

    // Universe: FinMind list when available (drops delisted stocks), plus any
    // company present in today's bulk data.
    let stocks = {};
    let mList;
    if (list) {
      mList = list.filter(function (s) { return s.type === market; });
      mList.forEach(function (s) {
        const c = cache[s.stock_id] || { quarters: {} };
        c.name = s.stock_name || c.name || s.stock_id;
        c.industry = s.industry_category || c.industry || '';
        stocks[s.stock_id] = c;
      });
    } else {
      stocks = cache;
      mList = Object.keys(cache).map(function (id) {
        return { stock_id: id, stock_name: cache[id].name, industry_category: cache[id].industry };
      });
    }

    const bulk = await fetchBulk(market);
    Object.keys(bulk).forEach(function (code) {
      if (!stocks[code] && cache[code]) stocks[code] = cache[code];
    });
    mergeBulk(market, stocks, bulk);
    Object.keys(bulk).forEach(function (code) {
      if (!mList.some(function (s) { return s.stock_id === code; })) {
        mList.push({ stock_id: code, stock_name: stocks[code].name, industry_category: stocks[code].industry });
      }
    });

    let mq = mainQuarter(coverage(stocks), Object.keys(stocks).length) || calendarQuarter();
    if (TOKEN || process.env.FINMIND_ANON === '1') {
      await runFinMind(market, stocks, mList, mq, null, startDate, budget);
      mq = mainQuarter(coverage(stocks), Object.keys(stocks).length) || mq;
    } else {
      console.log('[' + market + '] no FINMIND_TOKEN, skipping FinMind stage');
    }
    const n = nextQ(mq.year, mq.q);
    const eq = qInfo(n.y, n.q);
    const cov = coverage(stocks);
    result[market] = { stocks: stocks, mq: mq, eq: eq, cov: cov };
    console.log('[' + market + '] main ' + mq.label + ' ' + (cov[mq.key] || 0) + '/' + Object.keys(stocks).length +
      ', early ' + eq.label + ' ' + (cov[eq.key] || 0));
  }

  // Both markets share the same main quarter (whichever is further along), so
  // the TWSE and TPEx tabs never disagree about "最新季度".
  const best = [result.twse.mq, result.tpex.mq].sort(function (a, b) {
    return (b.year * 10 + b.q) - (a.year * 10 + a.q);
  })[0];
  const n = nextQ(best.year, best.q);
  const early = qInfo(n.y, n.q);
  const now = new Date().toISOString();
  ['twse', 'tpex'].forEach(function (market) {
    const r = result[market];
    const payload = {
      updatedAt: now,
      mainQuarter: best,
      earlyQuarter: early,
      targetQuarter: best, // kept for backward compatibility
      coverage: { main: r.cov[best.key] || 0, early: r.cov[early.key] || 0, total: Object.keys(r.stocks).length },
      stocks: r.stocks
    };
    fs.writeFileSync(path.join(DATA_DIR, 'eps-' + market + '.json'), JSON.stringify(payload));
  });
  console.log('Done. main=' + best.label + ' early=' + early.label + ' FinMind calls used=' + (MAX_FINMIND - budget.left));
}

if (require.main === module) {
  main().catch(function (err) {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, normBulk, mergeBulk, coverage, mainQuarter, parseEpsData };
