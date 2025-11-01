// src/data/normalizeMenu.js

/**
 * Input (catalog v2) shape (abridged):
 * {
 *   categories: [{ id, ref, name, sort, ... }],
 *   products: [{ id, category_ref, name, description, skus: [{id,name,price}], image, ... }],
 *   option_lists: [{ id, ref, name, options: [...] }]
 * }
 *
 * Output shape (UI-ready):
 * {
 *   categories: [
 *     {
 *       id, ref, name, sort,
 *       items: [
 *         {
 *           id, ref, name, description,
 *           image,
 *           sizes: [{ id, name, price_cents }],
 *           basePrice_cents
 *         }
 *       ]
 *     }
 *   ],
 *   optionListsByRef: { [ref]: {...raw list...} }
 * }
 */

const toCents = (v) => {
  if (v == null) return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 100);
  const cleaned = String(v).replace(/[^0-9.\-]/g, '').trim();
  const num = Number(cleaned);
  return Number.isFinite(num) ? Math.round(num * 100) : 0;
};

const by = (arr, key) => {
  const map = Object.create(null);
  for (const entry of Array.isArray(arr) ? arr : []) {
    const lookupKey = entry?.[key];
    if (!lookupKey) continue;
    map[lookupKey] = entry;
  }
  return map;
};

export function normalizeCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object') {
    return { categories: [], optionListsByRef: {} };
  }

  const cats = Array.isArray(catalog.categories) ? catalog.categories.slice() : [];
  const prods = Array.isArray(catalog.products) ? catalog.products.slice() : [];
  const optionListsByRef = by(catalog.option_lists || [], 'ref');

  const productsByCategoryRef = Object.create(null);
  for (const product of prods) {
    const cref = product?.category_ref || product?.category || product?.categoryId || product?.category_id;
    if (!cref) continue;
    const key = String(cref);
    if (!productsByCategoryRef[key]) productsByCategoryRef[key] = [];
    productsByCategoryRef[key].push(product);
  }

  const outCategories = cats
    .slice()
    .sort((a, b) => (a?.sort ?? 9999) - (b?.sort ?? 9999))
    .map((cat) => {
      const catKey = cat?.ref != null ? String(cat.ref) : cat?.id != null ? String(cat.id) : null;
      const rawItems = catKey ? productsByCategoryRef[catKey] || [] : [];
      const items = rawItems.map((prod) => {
        const skus = Array.isArray(prod?.skus) ? prod.skus : [];
        const sizes = skus.map((sku) => ({
          id: sku?.id || `${prod?.id || prod?.ref || 'sku'}:${sku?.name || 'regular'}`,
          name: sku?.name || 'Regular',
          price_cents: toCents(sku?.price),
        })).filter((sku) => typeof sku.price_cents === 'number');

        const basePrice_cents = sizes.length
          ? Math.min(...sizes.map((s) => s.price_cents))
          : toCents(prod?.price);

        return {
          id: prod?.id || prod?.ref || `${cat?.ref || 'cat'}:${prod?.name || 'item'}`,
          ref: prod?.ref || prod?.id,
          name: prod?.name || prod?.title || 'Menu Item',
          description: prod?.description || '',
          image: prod?.image || null,
          sizes,
          basePrice_cents,
        };
      });

      return {
        id: cat?.id || cat?.ref,
        ref: cat?.ref || cat?.id,
        name: cat?.name || cat?.title || 'Category',
        sort: cat?.sort ?? 9999,
        items,
      };
    });

  return { categories: outCategories, optionListsByRef };
}

const CACHE_KEY = 'pp_menu_v2_cache';
const CACHE_VER = 3;

export function getCachedMenu() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.__ver !== CACHE_VER) return null;
    return parsed?.data || null;
  } catch {
    return null;
  }
}

export function setCachedMenu(data) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ __ver: CACHE_VER, data }));
  } catch {
    // Ignore quota errors
  }
}

export function currency(cents) {
  const value = (typeof cents === 'number' ? cents : 0) / 100;
  return `$${value.toFixed(2)}`;
}
