// src/hooks/useMenu.js
import { useEffect, useMemo, useState } from 'react';
import { normalizeCatalog, getCachedMenu, setCachedMenu } from '../data/normalizeMenu.js';

const productImages = import.meta.glob('../assets/**', { eager: true });

const resolveImage = (image) => {
  if (!image) return null;
  if (/^https?:\/\//i.test(image)) return image;
  const target = image.replace(/^\.\//, '');
  for (const key of Object.keys(productImages)) {
    const fileName = key.split('/').pop();
    if (!fileName) continue;
    if (fileName === target || fileName === `${target}.png` || fileName === `${target}.jpg` || fileName === `${target}.jpeg`) {
      const mod = productImages[key];
      if (mod && typeof mod === 'object' && 'default' in mod) return mod.default;
    }
  }
  return null;
};

async function fetchWithRetry(url, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i += 1) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 300 * (i + 1)));
    }
  }
  throw lastErr || new Error('Fetch failed');
}

export function useMenu() {
  const cached = useMemo(() => getCachedMenu(), []);
  const [menu, setMenu] = useState(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const MENU_ENDPOINT = import.meta.env.VITE_MENU_URL || '/pp-proxy/public/menu';

    (async () => {
      try {
        const raw = await fetchWithRetry(MENU_ENDPOINT);
        let normalized = normalizeCatalog(raw);
        normalized = {
          ...normalized,
          categories: normalized.categories.map((category) => ({
            ...category,
            items: category.items.map((item) => ({
              ...item,
              image: resolveImage(item.image) || item.image,
            })),
          })),
        };

        if (!cancelled) {
          setMenu(normalized);
          setCachedMenu(normalized);
          setLoading(false);
          setError(null);
          console.info('[menu] normalized & cached');
        }
      } catch (err) {
        console.warn('[menu] fetch failed; falling back to cache if available', err);
        const fallback = getCachedMenu();
        if (!cancelled) {
          if (fallback) {
            setMenu(fallback);
            setLoading(false);
          } else {
            setError(err);
            setLoading(false);
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { menu, loading, error };
}
