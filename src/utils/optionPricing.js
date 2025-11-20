// src/utils/optionPricing.js
// Size-aware prices for add-ons/options coming from menu.json.

// Normalizes a size id/ref to canonical keys
export function normalizeSizeRef(sizeRef) {
  if (!sizeRef) return "regular";
  const s = String(sizeRef).toLowerCase();
  if (/mini/.test(s)) return "mini";
  if (/default|base/.test(s)) return "regular";
  if (/reg|regular|std|small/.test(s)) return "regular";
  if (/lg|large/.test(s)) return "large";
  if (/fam|family/.test(s)) return "family";
  if (/party|xl|xlarge/.test(s)) return "party";
  return s;
}

// Returns a price in cents for a single option given the active size.
export function priceForOption(option, sizeRef) {
  if (!option) return 0;
  const key = normalizeSizeRef(sizeRef);

  const bySize = option?.price_by_size;
  if (bySize && typeof bySize === "object") {
    if (bySize[key] != null) return Number(bySize[key]) || 0;
  }

  if (
    option?.prices &&
    !Array.isArray(option.prices) &&
    typeof option.prices === "object"
  ) {
    if (option.prices[key] != null) return Number(option.prices[key]) || 0;
  }

  if (Array.isArray(option?.prices)) {
    const hit = option.prices.find(
      (entry) => normalizeSizeRef(entry?.size) === key,
    );
    if (hit && hit.price_cents != null) return Number(hit.price_cents) || 0;
  }

  if (option?.price_cents != null) return Number(option.price_cents) || 0;
  if (option?.price != null) {
    const val =
      typeof option.price === "string"
        ? Number(option.price.replace(/[^0-9.]/g, "")) * 100
        : Number(option.price) * 100;
    if (Number.isFinite(val)) return Math.round(val);
  }
  if (option?.amount != null) {
    const dollars = Number(option.amount);
    if (Number.isFinite(dollars)) return Math.round(dollars * 100);
  }

  return 0;
}

export function formatCents(cents) {
  const amount = Number(cents || 0) / 100;
  return amount.toLocaleString(undefined, {
    style: "currency",
    currency: "AUD",
  });
}
