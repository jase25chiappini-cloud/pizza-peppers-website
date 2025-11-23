// src/utils/addonPricing.js

// Normalise size labels so they line up with menu.json keys like "regular", "large", "family"
export function normalizeAddonSizeRef(input) {
  if (!input) return "regular";

  const raw = String(input).trim().toLowerCase();

  if (!raw) return "regular";

  if (raw.includes("party")) return "party";
  if (raw.includes("family")) return "family";
  if (raw.includes("large") || raw.includes("lrg")) return "large";
  if (raw.includes("medium") || raw.includes("med")) return "regular"; // you don't really use medium
  if (raw.includes("mini") || raw.includes("small") || raw.includes("sml")) return "mini";

  if (["regular", "reg", "std", "default"].includes(raw)) return "regular";

  return raw; // last resort, in case menu.json has something custom
}

function parsePriceToCents(value) {
  if (value == null) return 0;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return 0;
    if (value > 0 && value < 5) return Math.round(value * 100);
    return Math.round(value);
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.]/g, "");
    if (!cleaned) return 0;
    const num = Number(cleaned);
    if (!Number.isFinite(num)) return 0;
    if (num > 0 && num < 5) return Math.round(num * 100);
    return Math.round(num);
  }
  return 0;
}

/**
 * Look up the size-aware add-on price from menu.json.
 * - addonOption is a single option from an option_list (eg "fresh basil").
 * - sizeRef is a size label like "regular" | "large" | "family" etc.
 * - menuData is the raw menu object you fetch from the backend.
 */
export function getAddonPriceCents(addonOption, sizeRef, menuData) {
  if (!addonOption || !menuData) return 0;

  const normalizedSize = normalizeAddonSizeRef(sizeRef);

  // Direct prices map on option (preferred)
  if (addonOption.prices && typeof addonOption.prices === "object") {
    const val =
      addonOption.prices[normalizedSize] ??
      addonOption.prices[normalizedSize.toUpperCase()] ??
      addonOption.prices[
        normalizedSize.charAt(0).toUpperCase() + normalizedSize.slice(1)
      ];
    if (val != null) return parsePriceToCents(val);
  }

  // HubRise-style option_pricing
  if (menuData.option_pricing && Array.isArray(menuData.option_pricing)) {
    const listRef =
      addonOption.option_list_ref || addonOption.list_ref || addonOption.ref;
    const optionRef =
      addonOption.ref ||
      addonOption.id ||
      addonOption.value ||
      addonOption.name;

    if (listRef && optionRef) {
      const pricingRow = menuData.option_pricing.find(
        (row) =>
          row.option_list_ref === listRef &&
          (row.option_ref === optionRef ||
            row.option_id === optionRef ||
            row.option_name === optionRef),
      );

      if (pricingRow && pricingRow.prices && typeof pricingRow.prices === "object") {
        const val =
          pricingRow.prices[normalizedSize] ??
          pricingRow.prices[normalizedSize.toUpperCase()] ??
          pricingRow.prices[
            normalizedSize.charAt(0).toUpperCase() + normalizedSize.slice(1)
          ];
        if (val != null) return parsePriceToCents(val);
      }
    }
  }

  // Fallback: flat price on the option
  if (addonOption.price_cents != null) return parsePriceToCents(addonOption.price_cents);
  if (addonOption.price != null) return parsePriceToCents(addonOption.price);

  return 0;
}

/**
 * Convenience: resolve a single add-on's unit price in cents.
 * This is what App.jsx should call so everything is size-aware.
 */
export function resolveAddonPriceCents(addonOption, sizeRef, menuData) {
  return getAddonPriceCents(addonOption, sizeRef, menuData);
}

/**
 * Sum all selected add-ons for a given size.
 * selections is an array of { option, price_cents?, ... }
 */
export function calcExtrasCentsForSize(selections, sizeRef, menuData) {
  if (!Array.isArray(selections) || !selections.length) return 0;

  const normalized = normalizeAddonSizeRef(sizeRef);

  return selections.reduce((sum, sel) => {
    const option = sel.option || sel;
    const explicit = parsePriceToCents(sel.price_cents ?? sel.price);
    const fromMenu = getAddonPriceCents(option, normalized, menuData);

    const cents = explicit || fromMenu;
    return sum + (Number.isFinite(cents) ? cents : 0);
  }, 0);
}
