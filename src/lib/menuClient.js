// src/lib/menuClient.js
const URL = import.meta.env.VITE_MENU_URL || '/pp-proxy/public/menu';

export async function fetchLiveMenu() {
  console.log('[menu] GET', URL);
  const res = await fetch(URL, { method: 'GET' });
  const ct = res.headers.get('content-type') || '';
  console.log('[menu][debug] status:', res.status, 'content-type:', ct);
  if (!res.ok) throw new Error(`Menu fetch failed: ${res.status}`);
  if (!ct.includes('application/json')) throw new Error('Menu is not JSON');

  const raw = await res.json();
  const topKeys = Object.keys(raw || {});
  console.log('[menu][debug] top-level keys:', topKeys);

  // Unwrap common API envelopes
  const api = raw?.data?.menu || raw?.data || raw || {};
  const apiKeys = Object.keys(api || {});
  console.log('[menu][debug] api keys (post-unwrap):', apiKeys);

  return api;
}
