// src/firebase.js (guarded initializer with FB_READY)
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

// --- pull from Vite env (exposed at build-time) ---
const env = import.meta.env || {};

const cfg = {
  apiKey: env.VITE_FB_API_KEY,
  authDomain: env.VITE_FB_AUTH_DOMAIN || "pizza-peppers-website.firebaseapp.com",
  projectId: env.VITE_FB_PROJECT_ID || "pizza-peppers-website",
  storageBucket: env.VITE_FB_BUCKET || "pizza-peppers-website.appspot.com",
  messagingSenderId: env.VITE_FB_MSG_SENDER_ID,
  appId: env.VITE_FB_APP_ID,
};

// minimal validation — apiKey & appId are mandatory for Auth
const REQUIRED = ["VITE_FB_API_KEY", "VITE_FB_APP_ID", "VITE_FB_MSG_SENDER_ID"];
const missing = REQUIRED.filter((k) => !env[k]);
export const FB_READY = missing.length === 0;

// Initialize only when ready. Otherwise export undefined singletons (tolerant UI)
let _app;
let _auth;
let _db;
let _storage;

try {
  if (FB_READY) {
    _app = initializeApp(cfg);
    _auth = getAuth(_app);
    _db = getFirestore(_app);
    _storage = getStorage(_app);
  } else {
    if (import.meta.env && import.meta.env.DEV) {
      console.warn('[Firebase] Env not configured; Firebase features disabled (OK for local dev).');
    }
  }
} catch (e) {
  console.error("[Firebase] Initialization error:", e);
}

export const app = _app;
export const auth = _auth;
export const db = _db;
export const storage = _storage;
