// src/config/delivery.js
// Delivery configuration for Pizza Peppers - consumed by App.jsx via dynamic import.
// Keep this as plain ESM so Vite can include it in both browser and SSR contexts.

// Optional map bounds for Google Places bias (Adelaide-ish example).
export const DELIVERY_BOUNDS_SW = { lat: -35.2000, lng: 138.4000 };
export const DELIVERY_BOUNDS_NE = { lat: -34.6500, lng: 138.8000 };

// Allowed suburbs (case-insensitive). Update these to match your actual delivery footprint.
export const DELIVERY_ALLOWED_SUBURBS = [
  "Prospect",
  "Kilburn",
  "Mawson Lakes",
  "Modbury",
  "Salisbury",
  "Pooraka",
  "Findon",
  "Woodville",
  "Seaton",
  "Henley Beach",
  "Fulham",
  "North Adelaide",
  "Adelaide",
  "Norwood",
  "Kensington",
  "Magill",
];

// Allowed postcodes. Keep this list tight - AddressHelper enforces it on selection/save.
export const DELIVERY_ALLOWED_POSTCODES = [
  "5000",
  "5006",
  "5007",
  "5008",
  "5009",
  "5010",
  "5011",
  "5012",
  "5022",
  "5024",
  "5082",
  "5095",
  "5092",
  "5108",
];

// Optional: zone definitions (suburbs/postcodes + fee). Extend or remove as needed.
export const DELIVERY_ZONES = [
  { suburbs: ["Prospect", "Kilburn"], postcodes: ["5082"], fee: 0 },
  { suburbs: ["Mawson Lakes", "Pooraka"], postcodes: ["5095"], fee: 3.0 },
  { suburbs: ["Modbury"], postcodes: ["5092"], fee: 4.0 },
  { suburbs: ["Salisbury"], postcodes: ["5108"], fee: 5.0 },
  // Add additional zones as required.
];

// Helper: extract a postcode from a Google Places address string/components.
export function extractPostcode(address) {
  if (!address) return null;
  const match = String(address).match(/(\b\d{4}\b)(?!.*\b\d{4}\b)/);
  return match ? match[1] : null;
}

// Helper: simple fee lookup by postcode (optional).
export function quoteForPostcode(postcode) {
  const code = String(postcode ?? "").trim();
  if (!code || !DELIVERY_ALLOWED_POSTCODES.includes(code)) {
    return { ok: false, reason: "OUT_OF_AREA" };
  }

  let fee = 0;
  for (const zone of DELIVERY_ZONES) {
    if (Array.isArray(zone.postcodes) && zone.postcodes.includes(code)) {
      fee = Number(zone.fee || 0);
      break;
    }
  }

  return {
    ok: true,
    fee_cents: Math.round(fee * 100),
    eta_min: 40,
  };
}

if (typeof window !== "undefined") {
  window.__PP_DELIVERY_CONFIG = {
    serviceablePostcodes: ["5159", "5162", "5049", "5051"],
    baseDeliveryCents: 600,
  };
  window.__PP_QUOTE_FOR_POSTCODE = (pc) => {
    const code = String(pc || "").trim();
    if (!code) return null;
    if (["5159", "5162"].includes(code)) return 500;
    if (["5049", "5051"].includes(code)) return 700;
    return window.__PP_DELIVERY_CONFIG?.baseDeliveryCents ?? 600;
  };
}
