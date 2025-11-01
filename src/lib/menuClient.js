const TIMEOUT_MS = 12000;

export async function fetchLiveMenu() {
  const url = (import.meta.env.VITE_MENU_URL ?? '/pp-proxy/public/menu');
  console.log('[menu] GET', url);

  const res = await withTimeout(fetch(url, { credentials: 'omit' }), TIMEOUT_MS, 'primary-timeout');
  const ct = res.headers.get('content-type') || '';
  console.log('[menu][debug] status:', res.status, 'content-type:', ct);
  const isJson = /\bjson\b/i.test(ct);

  if (!res.ok) {
    const body = await safeText(res);
    console.error('[menu][debug] non-OK body:', (body || '').slice(0, 500));
    throw new Error(`Menu fetch failed: ${res.status}`);
  }

  const rawText = await res.text();
  let data;
  try {
    data = isJson ? JSON.parse(rawText) : JSON.parse(rawText);
  } catch (e) {
    console.error('[menu][debug] JSON parse failed. First 500 chars:', rawText.slice(0, 500));
    throw new Error('Menu parse failed (invalid JSON)');
  }

  const keys = Object.keys(data || {});
  console.log('[menu][debug] top-level keys:', keys);
  if ('categories' in data) console.log('[menu][debug] categories.len:', (data.categories || []).length);
  if ('products' in data)   console.log('[menu][debug] products.len:', (data.products || []).length);

  return data;
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

function withTimeout(promise, ms, label = 'timeout') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
