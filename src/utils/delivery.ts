declare global {
  interface Window {
    __PP_DELIVERY_CONFIG?: {
      serviceablePostcodes?: string[];
      baseDeliveryCents?: number;
    };
    __PP_QUOTE_FOR_POSTCODE?: (pc: string) => number | null;
  }
}

export function extractPostcode(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = String(text).match(/\b(\d{4})\b/);
  return match ? match[1] : null;
}

export function isPostcodeServiceable(postcode: string | null): boolean {
  if (!postcode) return false;
  const cfg = window.__PP_DELIVERY_CONFIG;
  return !!cfg?.serviceablePostcodes?.includes(postcode);
}

export function quoteForPostcode(postcode: string | null): number | null {
  if (!postcode) return null;
  if (typeof window.__PP_QUOTE_FOR_POSTCODE === "function") {
    return window.__PP_QUOTE_FOR_POSTCODE(postcode);
  }
  return window.__PP_DELIVERY_CONFIG?.baseDeliveryCents ?? null;
}

export {};
