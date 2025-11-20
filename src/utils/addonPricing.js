// src/utils/addonPricing.js

/**
 * Convert any menu price into cents.
 * Handles numbers and strings like "$1.50", "1.5", or 1.5.
 */
export const toCents = (value) => {
  if (value == null) return 0;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0;
    if (value >= 100 && Number.isInteger(value)) return value;
    return Math.round(value * 100);
  }

  const cleaned = String(value).trim().replace(/[^0-9.]/g, "");
  if (!cleaned) return 0;

  const n = Number(cleaned);
  if (!Number.isFinite(n)) return 0;

  if (n >= 100 && Number.isInteger(n)) return n;
  return Math.round(n * 100);
};

export const fmt = (cents) => `$ ${(Number(cents || 0) / 100).toFixed(2)}`;

/**
 * Core: resolve add-on price (in cents) for a given size.
 *
 * Priority:
 *  1) addon.prices[sizeKey]
 *  2) addon.price_by_size[sizeKey]
 *  3) addon.price_cents / addon.price
 *  4) 0
 */
export function resolveAddonPriceCents(addon, sizeId = "regular", menu) {
  if (!addon) return 0;

  const sizeKey = (sizeId || "regular").toString().trim().toLowerCase();

  if (addon.prices && addon.prices[sizeKey] != null) {
    return toCents(addon.prices[sizeKey]);
  }

  if (addon.price_by_size && addon.price_by_size[sizeKey] != null) {
    return toCents(addon.price_by_size[sizeKey]);
  }

  if (addon.price_cents != null) {
    const n = Number(addon.price_cents);
    if (Number.isFinite(n)) return n;
  }
  if (addon.price != null) {
    return toCents(addon.price);
  }

  return 0;
}
