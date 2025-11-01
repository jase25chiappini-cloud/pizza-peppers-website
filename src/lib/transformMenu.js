// src/lib/transformMenu.js

/**
 * transformMenu(api): turns your API shape
 * { categories[], products[], option_lists[], ... }
 * into UI-ready:
 * {
 *   categories: [
 *     { name, ref, items: [ { id, name, description, sizes|null, prices:{} } ] }
 *   ]
 * }
 */
export function transformMenu(api) {
  if (!api || typeof api !== 'object') {
    console.warn('[menu][transform] bad api input');
    return { categories: [] };
  }

  const categories = Array.isArray(api.categories) ? api.categories : [];
  const products   = Array.isArray(api.products)   ? api.products   : [];

  console.log(
    `[menu][transform] input counts: categories=${categories.length} products=${products.length}`
  );

  // Auto-detect keys we can rely on
  const catRefKey   = ['ref','id','_id'].find(k => categories.some(c => k in c)) || 'ref';
  const catNameKey  = ['name','title','label'].find(k => categories.some(c => k in c)) || 'name';
  const prodCatKey  = ['category_ref','categoryRef','categoryId','category_id']
                        .find(k => products.some(p => k in p)) || 'category_ref';

  console.log(
    `[menu][transform] keys: category.ref=${catRefKey} category.name=${catNameKey} product.categoryRef=${prodCatKey}`
  );

  // Build index categoryRef -> products[]
  const byCat = new Map();
  for (const p of products) {
    const cref = p?.[prodCatKey];
    if (!cref) continue;
    if (!byCat.has(cref)) byCat.set(cref, []);
    byCat.get(cref).push(p);
  }

  // Helpers
  const parsePrice = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') {
      // strip anything that's not a digit or dot: "$19.50" -> "19.50"
      const cleaned = v.replace(/[^\d.]/g, '');
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  const normalizeSkusToPrices = (skus) => {
    // Supports either array of {size, price} or object map {size: price}
    const prices = {};
    if (Array.isArray(skus)) {
      for (const s of skus) {
        const sizeKey = s?.size ?? s?.name ?? s?.id ?? 'default';
        const price   = parsePrice(s?.price ?? s?.price_cents);
        if (price != null) prices[String(sizeKey)] = price;
      }
    } else if (skus && typeof skus === 'object') {
      for (const [k, v] of Object.entries(skus)) {
        const price = parsePrice(v);
        if (price != null) prices[String(k)] = price;
      }
    }
    return prices;
  };

  const uiCats = categories.map(cat => {
    const ref  = String(cat?.[catRefKey] ?? '');
    const name = String((cat?.[catNameKey] ?? ref) || 'Category');
    const prods = byCat.get(ref) || [];

    const items = prods.map(p => {
      // Try to find a sku container key
      const skuKey = ['skus','sizes','price_map','prices'].find(k => (p && typeof p === 'object' && k in p));
      const prices = skuKey ? normalizeSkusToPrices(p[skuKey]) : {};
      const sizes  = Object.keys(prices).length ? Object.keys(prices) : null;

      return {
        id: p?.id ?? p?.ref ?? p?._id ?? `${ref}:${p?.name ?? 'item'}`,
        name: p?.name ?? p?.title ?? 'Item',
        description: p?.description ?? '',
        sizes,
        prices,
        // You can carry extras/ingredients/etc. later as needed
      };
    });

    return { name, ref, items };
  });

  console.log(`[menu][transform] output categories=${uiCats.length}`);
  return { categories: uiCats };
}
