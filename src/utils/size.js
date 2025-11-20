// src/utils/size.js
//
// Shared helpers for working with product sizes / references.

/**
 * Normalise a size reference into canonical tokens: mini, regular, large, family, party.
 * @param {string|number|null|undefined} x
 * @returns {string}
 */
export function normalizeSizeRef(x) {
  if (!x) return "regular";
  const s = String(x).toLowerCase();
  if (/mini/.test(s)) return "mini";
  if (/(reg|regular|std|small)/.test(s)) return "regular";
  if (/(lg|large)/.test(s)) return "large";
  if (/(fam|family)/.test(s)) return "family";
  if (/(party|xl|xlarge)/.test(s)) return "party";
  return s;
}

/**
 * Pick a default size for a product, preferring one that looks like "regular".
 * @param {{ sizes?: Array<{ id?:string, ref?:string, name?:string }> }} product
 */
export function defaultSize(product) {
  const sizes = product?.sizes || [];
  if (!sizes.length) return null;
  const regular = sizes.find((s) => /reg/i.test(s?.id || s?.ref || s?.name));
  return regular || sizes[0];
}
