// Cloudflare Pages Function: CORS proxy for TWSE, TPEx and FinMind APIs
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const target = url.searchParams.get('url');
  if (!target) {
    return new Response('Missing url param', { status: 400 });
  }
  // Handle CORS preflight
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }
  const allowed = [
    'openapi.twse.com.tw',
    'api.finmindtrade.com',
    'www.tpex.org.tw',
    'mis.twse.com.tw',
  ];
  let targetUrl;
  try { targetUrl = new URL(target); } catch(e) {
    return new Response('Invalid url', { status: 400 });
  }
  const ok = allowed.some(h => targetUrl.hostname === h);
  if (!ok) {
    return new Response('Forbidden', { status: 403 });
  }
  const isTPEx = targetUrl.hostname === 'www.tpex.org.tw';
  const reqHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
  };
  if (isTPEx) {
    reqHeaders['Referer'] = 'https://www.tpex.org.tw/';
    reqHeaders['Origin'] = 'https://www.tpex.org.tw';
  }
  const resp = await fetch(target, { headers: reqHeaders });
  const body = await resp.arrayBuffer();
  return new Response(body, {
    status: resp.status,
    headers: {
      'Content-Type': resp.headers.get('Content-Type') || 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    }
  });
}
