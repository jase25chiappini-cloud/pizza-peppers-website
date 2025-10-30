// Single source of truth for where the frontend fetches menu data
// In dev, Vite proxies '/public/*' to your Flask app on port 5055.
// In prod (same-origin), keep '/public/menu'. Otherwise, set VITE_MENU_URL.

export const MENU_URL = (import.meta.env.VITE_MENU_URL && String(import.meta.env.VITE_MENU_URL).trim()) || '/public/menu';

let __logged = false;
export function logMenuUrlOnce() {
  if (__logged) return;
  // eslint-disable-next-line no-console
  console.log('Fetching MENU_URL =', MENU_URL);
  __logged = true;
}

