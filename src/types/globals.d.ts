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
    __FORCE_MENU_READY__?: boolean | (() => void); // TEMP: remove after code replace
    google?: any;
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
