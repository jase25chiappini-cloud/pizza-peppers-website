/// <reference types="vite/client" />

export {};

// Ambient declaration for window globals
declare global {
  interface Window {
    __PP_ONERROR_TAP?: any;
    __PP_DIAG_MARK?: any;
    __menu_api?: any;
    __menu_tx?: any;
    __APP_RENDER_TAP?: any;
    /** Debug/dev flag to force menu readiness in the UI bootstrap */
    __FORCE_MENU_READY?: boolean | (() => void);
    google?: any;
    __pp_transformMenu?: (raw: any) => any;
    __PP_DELIVERY_BOUNDS_SW?: LatLng;
    __PP_DELIVERY_BOUNDS_NE?: LatLng;
    __PP_DELIVERY_CONFIG?: PpDeliveryConfig;
    __PP_QUOTE_FOR_POSTCODE?: (postcode: string) => number;
    /**
     * Dev helper attached by AuthProvider for debugging auth state.
     */
    __PP_AUTH_DEBUG__?: () => void;
    __PP_AUTH_DUMP__?: () => void;
  }

  interface ImportMetaEnv {
    readonly VITE_GOOGLE_MAPS_API_KEY?: string;
    // add any other envs you use, e.g.:
    // readonly VITE_API_BASE?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

// --- Delivery globals used in App.jsx ---
type LatLng = { lat: number; lng: number };

interface PpDeliveryConfig {
  getBounds: () => { sw: LatLng; ne: LatLng };
  getAllowedPostcodes: () => Set<string>;
  getAllowedSuburbs: () => Set<string>;
  getExtractPostcode: () => ((address: string) => string | null) | null;
  isPlaceInDeliveryArea: (place: unknown, extractPostcodeFn?: (addr: any) => string | null) => boolean;
  quoteForPostcode: (postcode: string) => {
    ok: boolean;
    fee_cents?: number;
    eta_min?: number;
    reason?: string;
  };
}

export {};
