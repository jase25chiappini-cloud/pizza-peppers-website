// src/config/delivery.js

// Map + bounds (rough box around southern suburbs so the map fits nicely)
export const DELIVERY_BOUNDS_SW = { lat: -35.2000, lng: 138.4800 };
export const DELIVERY_BOUNDS_NE = { lat: -35.0000, lng: 138.6100 };

// Suburbs & fees (exact list provided)
const SUBURB_FEES = {
  "Sheidow Park": 8.40,
  "Woodcroft": 8.40,
  "Christie Downs": 12.60,
  "Trott Park": 8.40,
  "Happy Valley": 8.40,
  "O'Halloran Hill": 8.40,
  "Hallett Cove": 12.60,
  "Hackham West": 12.60,
  "Huntfield Heights": 12.60,
  "Morphett Vale": 8.40,
  "Lonsdale": 12.60,
  "Old Reynella": 8.40,
  "Hackham": 12.60,
  "Reynella": 8.40,
  "Onkaparinga Hills": 12.60,
  "Reynella East": 8.40,
  "Aberfoyle Park": 12.60,
};

// Postcode ? min fee (derived from the suburbs above)
const POSTCODE_MIN_FEE = {
  5158: 8.40,
  5159: 8.40,
  5160: 12.60,
  5161: 8.40,
  5162: 8.40,
  5163: 12.60,
  5164: 12.60,
};

// Public lists used by the UI (About ? Delivery Areas)
export const DELIVERY_ZONES = [
  {
    name: "Zone A — $8.40",
    fee_cents: 840,
    suburbs: [
      "Sheidow Park",
      "Woodcroft",
      "Trott Park",
      "Happy Valley",
      "O'Halloran Hill",
      "Morphett Vale",
      "Old Reynella",
      "Reynella",
      "Reynella East",
    ],
    postcodes: ["5158", "5159", "5161", "5162"],
  },
  {
    name: "Zone B — $12.60",
    fee_cents: 1260,
    suburbs: [
      "Christie Downs",
      "Hallett Cove",
      "Hackham West",
      "Huntfield Heights",
      "Lonsdale",
      "Hackham",
      "Onkaparinga Hills",
      "Aberfoyle Park",
    ],
    postcodes: ["5158", "5159", "5160", "5163", "5164"],
  },
];

// Helpers the app expects
export function getAllowedPostcodes() {
  return new Set(Object.keys(POSTCODE_MIN_FEE));
}
export function getAllowedSuburbs() {
  return new Set(Object.keys(SUBURB_FEES).map((s) => s.toUpperCase()));
}

// Used by Places autocomplete filtering when available
export function extractPostcode(components) {
  const pc = components?.find(
    (c) => Array.isArray(c.types) && c.types.includes("postal_code")
  );
  return pc?.long_name || pc?.short_name || null;
}

// Quote by postcode — About panel uses this via window.__PP_QUOTE_FOR_POSTCODE
export function quoteForPostcode(pc) {
  const code = String(pc ?? "").trim();
  if (!Object.prototype.hasOwnProperty.call(POSTCODE_MIN_FEE, code)) {
    return { ok: false, reason: "OUT_OF_AREA" };
  }
  return {
    ok: true,
    fee_cents: Math.round(POSTCODE_MIN_FEE[code] * 100),
    eta_min: 40,
  };
}
