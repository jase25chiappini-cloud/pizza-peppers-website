import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getAuth,
  initializeAuth,
  browserLocalPersistence,
  browserPopupRedirectResolver,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyDijrjZtCvPQiv7x2awqcEFFUiR2L5LKZM",
  authDomain: "pizza-peppers-website.firebaseapp.com",
  projectId: "pizza-peppers-website",
  storageBucket: "pizza-peppers-website.firebasestorage.app",
  messagingSenderId: "531622783727",
  appId: "1:531622783727:web:914452457d4a3904d7091a",
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

let auth;
try {
  auth = getAuth(app);
} catch {
  auth = undefined;
}

const needsInit = !auth || !(auth).hasOwnProperty("_initializationComplete") || !(auth)._initializationComplete;

if (needsInit) {
  try {
    auth = initializeAuth(app, {
      persistence: [browserLocalPersistence],
      popupRedirectResolver: browserPopupRedirectResolver,
    });
  } catch {
    auth = getAuth(app);
  }
}

const db = getFirestore(app);
const storage = getStorage(app);
const FB_READY = true;

export { app, auth, firebaseConfig, db, storage, FB_READY };
