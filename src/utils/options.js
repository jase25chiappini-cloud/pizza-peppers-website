// src/utils/options.js
//
// Centralised helpers for: base price, extras eligibility, ingredient edit eligibility,
// and mapping products to option groups from menu data.
//
// Works with the current Pizza Peppers menu shape:
// product = {
//   id, name, category_ref,
//   skus: [{ id, name, price_cents, size_ref?, is_gluten_free? }, ...],
//   option_list_refs?: [ "EXTRAS_REGULAR", "EXTRAS_LARGE", ... ]
// }

/** @typedef {{ id:string, name:string, price_cents:number, size_ref?:string, is_gluten_free?:boolean }} Sku */
/** @typedef {{ id:string, name:string, category_ref:string, skus:Sku[], option_list_refs?:string[] }} Product */

// -------- Category Guards (keep in sync with your menu.json categories) --------
export const __categoryGuards = {
  isPizza: (categoryRef = "") =>
    /pizza/i.test(categoryRef) && !/mini/i.test(categoryRef),
  isMiniPizza: (categoryRef = "") =>
    /mini/i.test(categoryRef) && /pizza/i.test(categoryRef),
  isCalzone: (categoryRef = "") =>
    /calzone/i.test(categoryRef),
  isDrink: (categoryRef = "") =>
    /drink/i.test(categoryRef),
  isSide: (categoryRef = "") =>
    /side|bread|wing|rib|dessert/i.test(categoryRef),
  isMealDeal: (categoryRef = "") =>
    /deal|meal|combo/i.test(categoryRef),
};

// -------- Base price helpers --------
/**
 * Return base price (in cents) for a product, optionally by size/sku id.
 * If sizeOrSkuId is omitted, returns the cheapest sku.
 * @param {Product} product
 * @param {string=} sizeOrSkuId  matches sku.id or sku.size_ref (case-insensitive)
 */
export function getBasePriceCents(product, sizeOrSkuId) {
  const skus = Array.isArray(product?.skus) ? product.skus : [];
  if (skus.length) {
    if (!sizeOrSkuId) {
      return Math.min(...skus.map(s => Number(s?.price_cents || 0)));
    }
    const key = String(sizeOrSkuId).toLowerCase();
    const match = skus.find(s =>
      String(s?.id || "").toLowerCase() === key ||
      String(s?.size_ref || "").toLowerCase() === key ||
      String(s?.size || "").toLowerCase() === key
    );
    if (match) return Number(match?.price_cents || 0);
  }
  const priceMap =
    typeof product?.priceCents === "object" && product?.priceCents
      ? product.priceCents
      : typeof product?.prices === "object" && product?.prices
        ? product.prices
        : null;
  const entries = priceMap ? Object.entries(priceMap) : [];
  if (!entries.length) {
    const fallback =
      product?.price_cents ??
      product?.price ??
      product?.minPriceCents ??
      product?.basePrice ??
      0;
    return Number(fallback || 0);
  }
  if (!sizeOrSkuId) {
    return Math.min(...entries.map(([, cents]) => Number(cents || 0)));
  }
  const normalized = normalizeSizeRef(sizeOrSkuId);
  const matchEntry = entries.find(
    ([label]) => normalizeSizeRef(label) === normalized,
  );
  if (matchEntry) return Number(matchEntry[1] || 0);
  return Number(entries[0][1] || 0);
}

/** Sum selected extras (array of { price_cents:number }) in cents */
export function sumExtrasCents(extras = []) {
  if (!Array.isArray(extras)) return 0;
  return extras.reduce((acc, ex) => acc + Number(ex?.price_cents || 0), 0);
}

// -------- Eligibility helpers --------
/** True if this product supports "edit ingredients" flow */
export function productSupportsIngredientEdit(product) {
  const c = String(product?.category_ref || "");
  if (__categoryGuards.isPizza(c)) return true;
  if (__categoryGuards.isMiniPizza(c)) return true;
  if (__categoryGuards.isCalzone(c)) return true; // allow remove/add sauces, fillings
  return false; // drinks, most sides, and deals themselves: no direct edit
}

/** True if this product supports paid extras (add-ons) */
export function productSupportsExtras(product) {
  const c = String(product?.category_ref || "");
  if (__categoryGuards.isDrink(c)) return false;
  if (__categoryGuards.isSide(c)) return false;
  // pizzas, mini pizzas, calzones typically allow extras
  if (__categoryGuards.isPizza(c)) return true;
  if (__categoryGuards.isMiniPizza(c)) return true;
  if (__categoryGuards.isCalzone(c)) return true;
  // meal deals: extras are usually applied to the child pizzas, not the deal line
  if (__categoryGuards.isMealDeal(c)) return false;
  return false;
}

// -------- Option-group resolver --------
/**
 * Decide which option lists apply to this product, based on the product's own
 * option_list_refs if present, otherwise using category heuristics.
 *
 * @param {Product} product
 * @param {{ option_lists?: Array<{ id:string, name:string, ref:string }> }} menuData  (optional; pass if you want validation)
 * @returns {string[]} array of option_list_refs (ids/refs) to use
 */
export function getApplicableOptionGroups(product, menuData) {
  const explicit = Array.isArray(product?.option_list_refs)
    ? product.option_list_refs.filter(Boolean)
    : [];
  if (explicit.length) return explicit;

  const c = String(product?.category_ref || "");
  // Heuristics fallback - adjust to your actual refs used in menu.json
  // Common pattern in your data: EXTRAS_REGULAR/LARGE/FAMILY/PARTY for pizzas.
  if (__categoryGuards.isPizza(c)) {
    // size-sensitive extras groups
    const sizeRefs = new Set((product?.skus || []).map(s => String(s?.size_ref || "").toUpperCase()));
    const groups = [];
    if (sizeRefs.has("REGULAR")) groups.push("EXTRAS_REGULAR");
    if (sizeRefs.has("LARGE"))   groups.push("EXTRAS_LARGE");
    if (sizeRefs.has("FAMILY"))  groups.push("EXTRAS_FAMILY");
    if (sizeRefs.has("PARTY"))   groups.push("EXTRAS_PARTY");
    return groups.length ? groups : ["EXTRAS_REGULAR"]; // conservative fallback
  }
  if (__categoryGuards.isMiniPizza(c)) {
    return ["EXTRAS_MINI", "INGREDIENT_TOGGLES_MINI"].filter(Boolean);
  }
  if (__categoryGuards.isCalzone(c)) {
    return ["CALZONE_SAUCES", "CALZONE_EXTRAS"].filter(Boolean);
  }
  if (__categoryGuards.isDrink(c)) {
    return []; // no extras for drinks
  }
  if (__categoryGuards.isMealDeal(c)) {
    return []; // extras applied at child-item level, not the deal line
  }
  if (__categoryGuards.isSide(c)) {
    return []; // keep sides simple unless explicitly configured
  }
  return [];
}

// ---------- GF / Size helpers ----------
/** Normalise a size token for comparisons (REGULAR/LARGE/FAMILY/PARTY/MINI etc.) */
export function normalizeSizeRef(x) {
  return String(x || "").trim().toUpperCase();
}

/** In our rules, GF is only allowed for LARGE */
export function isGfAllowedForSize(sizeRef) {
  return normalizeSizeRef(sizeRef) === "LARGE";
}

/**
 * If GF is on, force the selected size to LARGE if available.
 * Returns a {sizeRef, coerced:boolean}.
 */
export function enforceGfSize(product, selectedSizeRef) {
  const skus = Array.isArray(product?.skus) ? product.skus : [];
  const hasLarge =
    skus.some((s) =>
      isGfAllowedForSize(s?.size_ref || s?.size || s?.name),
    ) ||
    (Array.isArray(product?.sizes) &&
      product.sizes.some((size) => isGfAllowedForSize(size)));
  if (!hasLarge) {
    // If product has no LARGE sku, we can't offer GF anyway.
    return { sizeRef: selectedSizeRef, coerced: false };
  }
  if (!isGfAllowedForSize(selectedSizeRef)) {
    return { sizeRef: "LARGE", coerced: true };
  }
  return { sizeRef: selectedSizeRef, coerced: false };
}

// -------- Add-on grouping helpers --------
/**
 * Group add-ons into readable categories for a given product.
 * @param {Product} product
 * @param {Record<string, { ref:string, name?:string, group?:string, items?:any[] }>} optionListsMap
 */
export function groupAddonsForProduct(product, optionListsMap = {}) {
  const rawRefs =
    [
      product?.option_lists,
      product?.option_list_refs,
      product?.optionListRefs,
      product?.optionLists,
    ].find((arr) => Array.isArray(arr)) || [];
  const refs = rawRefs
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object") {
        return (
          entry.ref ||
          entry.id ||
          entry.name ||
          entry.value ||
          entry.label ||
          null
        );
      }
      return null;
    })
    .filter(Boolean);
  const lists = refs.length
    ? refs
        .map((ref) => optionListsMap?.[ref] || optionListsMap?.[ref?.toString()])
        .filter(Boolean)
    : [];
  const all = [];
  for (const list of lists) {
    const baseGroup = list?.group || inferGroupFromName(list?.name || list?.ref || "");
    const items = Array.isArray(list?.items)
      ? list.items
      : Array.isArray(list?.options)
        ? list.options
        : [];
    for (const item of items) {
      if (!item) continue;
      const ref =
        item.ref ||
        item.id ||
        item.value ||
        item.name;
      if (!ref) continue;
      all.push({
        ...item,
        ref,
        __group: item.group || baseGroup,
      });
    }
  }
  if (!all.length) return [];
  const byGroup = new Map();
  for (const it of all) {
    const g = it.__group || "Extras";
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(it);
  }
  const order = ["Toppings", "Sauces", "Sides", "Drinks", "Extras"];
  const result = [];
  for (const key of order) {
    if (byGroup.has(key)) result.push({ label: key, items: byGroup.get(key) });
  }
  for (const [label, items] of byGroup.entries()) {
    if (!order.includes(label)) result.push({ label, items });
  }
  return result;
}

function inferGroupFromName(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("topping")) return "Toppings";
  if (n.includes("sauce")) return "Sauces";
  if (n.includes("drink")) return "Drinks";
  if (n.includes("side")) return "Sides";
  return "Extras";
}

// Group base ingredients into tidy sections for the UI
export function groupIngredientsForProduct(product) {
  const raw =
    Array.isArray(product?.ingredients) && product.ingredients.length
      ? product.ingredients
      : [];
  const normalized = raw
    .map((ing) =>
      typeof ing === "string"
        ? { name: ing, ref: ing }
        : ing && typeof ing === "object"
          ? {
              ...ing,
              ref:
                ing.ref ||
                ing.id ||
                ing.value ||
                ing.name ||
                ing.label,
            }
          : null,
    )
    .filter((ing) => ing && (ing.name || ing.ref));
  const infer = (name = "") => {
    const n = String(name).toLowerCase();
    if (n.includes("cheese")) return "Cheeses";
    if (
      n.includes("meat") ||
      n.includes("ham") ||
      n.includes("bacon") ||
      n.includes("pepperoni") ||
      n.includes("sausage")
    )
      return "Meats";
    if (n.includes("sauce")) return "Sauces";
    const vegKeywords = [
      "onion",
      "capsicum",
      "mushroom",
      "olive",
      "tomato",
      "pineapple",
      "spinach",
      "veg",
      "pepper",
    ];
    if (vegKeywords.some((k) => n.includes(k))) return "Vegetables";
    return "Base";
  };
  const byGroup = new Map();
  for (const ing of normalized) {
    const group = ing.group || infer(ing.name || ing.ref);
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(ing);
  }
  const order = ["Base", "Sauces", "Cheeses", "Meats", "Vegetables"];
  const result = [];
  for (const key of order) {
    if (byGroup.has(key)) result.push({ label: key, items: byGroup.get(key) });
  }
  for (const [label, items] of byGroup.entries()) {
    if (!order.includes(label)) result.push({ label, items });
  }
  return result;
}

export default {
  __categoryGuards,
  getBasePriceCents,
  sumExtrasCents,
  productSupportsIngredientEdit,
  productSupportsExtras,
  getApplicableOptionGroups,
  normalizeSizeRef,
  isGfAllowedForSize,
  enforceGfSize,
  groupAddonsForProduct,
  groupIngredientsForProduct,
};
