// src/lib/menuClient.js

const MENU_URL = import.meta.env.VITE_MENU_URL || '/pp-proxy/public/menu';

export async function fetchLiveMenu() {
  console.log('MENU_URL =', MENU_URL);
  const apiKey =
    import.meta.env?.VITE_POS_API_KEY ||
    'w8z$yV!u7#B&E)H@McQfTjWnZr4u7x!A%D*G-JaNdRgUkXp2s5v8y/B?E(H+KbPe';
  const res = await fetch(MENU_URL, {
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
      'X-API-Key': apiKey,
    }
  });
  const contentType = res.headers.get('content-type') || '';
  console.log('[menu] GET', MENU_URL);
  console.log('[menu][debug] status:', res.status, 'content-type:', contentType);

  if (!res.ok) {
    throw new Error(`Menu fetch failed: ${res.status}`);
  }

  const raw = await res.json();
  const topKeys = Object.keys(raw || {});
  console.log('[menu][debug] top-level keys:', topKeys);

  // API is { data: {...real payload...} }
  const api = 'data' in (raw || {}) ? raw.data : raw;
  try { console.log('[menu][client] keys:', Object.keys(api || {})); } catch {}
  const apiKeys = Object.keys(api || {});
  console.log('[menu][debug] api keys (post-unwrap):', apiKeys);

  return api;
}
