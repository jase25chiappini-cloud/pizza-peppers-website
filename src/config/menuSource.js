// Single source of truth for where the frontend fetches menu data
// In dev, Vite proxies '/public/*' to your Flask app on port 5055.
// In prod (same-origin), keep '/public/menu'. Otherwise, set VITE_MENU_URL.

// src/config/menuSource.js
export const MENU_URL = import.meta.env.VITE_MENU_URL || '/pp-proxy/public/menu';
let __logged = false;
export function logMenuUrlOnce() {
  if (!__logged) {
    console.log('MENU_URL =', MENU_URL);
    __logged = true;
  }
}
