// Single source of truth for where the frontend fetches menu data
// In dev, Vite proxies '/public/*' to your Flask app on port 5055.
// In prod (same-origin), keep '/public/menu'. Otherwise, set VITE_MENU_URL.

// Live-only. No fallbacks, no substitutes.
export const MENU_URL = (import.meta.env.VITE_MENU_URL ?? '/pp-proxy/public/menu');
let _once = false;
export function logMenuUrlOnce() {
  if (_once) return;
  _once = true;
  // eslint-disable-next-line no-console
  console.log('[menu] Fetching MENU_URL =', MENU_URL);
}
