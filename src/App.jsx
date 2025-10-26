import React, { useState, createContext, useContext, useMemo, useEffect, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
// import { formatId, getImagePath } from './utils/helpers';
import { extrasData } from './data/menuData';
import Menu from './components/Menu';
import { CartProvider, useCart } from './context/CartContext';
import QuickNav from './components/QuickNav';
import { ThemeProvider } from './context/ThemeContext';
import ThemeSwitcher from './components/ThemeSwitcher';
import ItemDetailPanel from './components/ItemDetailPanel';
import OrderSummaryPanel from './components/OrderSummaryPanel';
// import useGoogleMaps from './hooks/useGoogleMaps';
import { initializeApp, getApps, getApp } from "firebase/app";
import { 
  getAuth, 
  onAuthStateChanged, 
  GoogleAuthProvider, 
  OAuthProvider,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signInWithPopup,
  signOut 
} from 'firebase/auth';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  linkWithCredential,
  PhoneAuthProvider,
  updateProfile
} from 'firebase/auth';

import { getFirestore, doc, getDoc, setDoc } from 'firebase/firestore';



// --- 1. FIREBASE CONFIGURATION ---
const firebaseConfig = {
  apiKey: "AIzaSyDijrjZtCvPQiv7x2awqcEFFUiR2L5LKZM",
  authDomain: "pizza-peppers-website.firebaseapp.com",
  projectId: "pizza-peppers-website",
  storageBucket: "pizza-peppers-website.firebasestorage.app",
  messagingSenderId: "531622783727",
  appId: "1:531622783727:web:914452457d4a3904d7091a"
};

// Initialize Firebase and Auth (safe for HMR and clear naming)
const fbApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

// --- AUTH CONTEXT (Firebase + local session) ---
const AuthContext = createContext();
function useAuth() { return useContext(AuthContext); }

function AuthProvider({ children }) {
  const LOCAL_KEY = 'pp_session_v1';

  const [firebaseUser, setFirebaseUser] = useState(null);
  const [localUser, setLocalUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null'); }
    catch { return null; }
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(getAuth(), (u) => {
      setFirebaseUser(u || null);
      setLoading(false);
    });
    return unsub;
  }, []);

  // ---- public auth actions ----
  const loginWithGoogle = () => signInWithPopup(getAuth(), new GoogleAuthProvider());
  const loginWithApple  = () => signInWithPopup(getAuth(), new OAuthProvider('apple.com'));

  // Called by your password modal on success
  const loginLocal = (phone, displayName = '') => {
    const u = { uid: `local:${phone}`, phoneNumber: phone, displayName };
    setLocalUser(u);
    localStorage.setItem(LOCAL_KEY, JSON.stringify(u));
  };

  const logoutLocal = () => {
    setLocalUser(null);
    localStorage.removeItem(LOCAL_KEY);
  };

  const logout = async () => {
    try { await signOut(getAuth()); } catch {}
    logoutLocal();
  };

  // prefer Firebase user; fall back to local user
  const currentUser = firebaseUser || localUser;

  const value = {
    currentUser,
    loginWithGoogle,
    loginWithApple,
    loginLocal,     // <-- expose to Login modal
    logout,
  };

  return <AuthContext.Provider value={value}>{!loading && children}</AuthContext.Provider>;
}

// --- Icons (place ABOVE LoginModal) ---
const GoogleIcon = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" style={{ marginRight: '1rem' }}>
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
);

const AppleIcon = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" style={{ marginRight: '1rem' }}>
    <path d="M19.05 17.55C18.8 18.09 18.45 18.75 18 19.35C17.5 19.95 17.05 20.55 16.5 21C16 21.5 15.45 21.8 14.85 22.05C14.25 22.3 13.65 22.5 13 22.5C12.3 22.5 11.7 22.3 11.1 22.05C10.5 21.8 10 21.5 9.45 21C8.95 20.5 8.45 19.95 7.95 19.35C7.5 18.75 7.15 18.1 6.9 17.55C6.3 16.5 6 15.35 6 14.1C6 12.8 6.3 11.65 6.9 10.65C7.2 10.05 7.6 9.45 8.1 8.85C8.6 8.25 9.15 7.7 9.75 7.2C10.35 6.7 11 6.4 11.65 6.15C12.3 5.9 13 5.8 13.75 5.8C14.45 5.8 15.15 6 15.8 6.3C15.15 6.75 14.65 7.35 14.3 8.1C14 8.85 13.85 9.6 13.85 10.35C13.85 11.25 14.05 12.1 14.45 12.9C14.85 13.7 15.4 14.35 16.1 14.85C16.8 15.35 17.6 15.6 18.5 15.6C18.8 15.6 19.05 15.55 19.25 15.5C19.5 15.45 19.7 15.4 19.9 15.35C20.9 14.85 21.7 14.15 22.35 13.25C21.9 12.95 21.45 12.7 21 12.5C20.5 12.3 20 12.15 19.45 12.05C18.75 11.85 18.05 11.75 17.3 11.75C16.45 11.75 15.65 11.9 14.9 12.2C14.15 12.5 13.5 12.95 12.95 13.55C12.4 14.15 11.95 14.8 11.6 15.5C11.25 16.2 11.05 16.95 11.05 17.75C11.05 18.05 11.1 18.3 11.2 18.5C11.3 18.7 11.45 18.85 11.65 18.95C12.2 19.25 12.8 19.4 13.45 19.4C14.1 19.4 14.7 19.2 15.25 18.8C15.8 18.4 16.25 17.9 16.6 17.3C16.95 16.7 17.2 16.05 17.35 15.35C16.45 15.1 15.7 14.65 15.1 13.95C14.5 13.25 14.2 12.45 14.2 11.55C14.2 10.7 14.4 9.9 14.8 9.15C15.2 8.4 15.8 7.8 16.6 7.35C16.9 7.15 17.2 7.05 17.5 7.05C17.8 7.05 18.05 7.1 18.25 7.2C18.5 7.3 18.7 7.45 18.85 7.65C17.95 8.1 17.2 8.7 16.6 9.45C16 10.2 15.7 11.05 15.7 12C15.7 12.8 15.9 13.5 16.3 14.1C16.7 14.7 17.2 15.15 17.85 15.45C18.1 15.55 18.3 15.6 18.45 15.6C18.5 15.6 18.5 15.6 18.5 15.6C18.5 15.6 18.5 15.6 18.5 15.6C19.4 15.6 20.2 15.35 20.9 14.85C20.65 16.1 20 17 19.05 17.55Z" fill="currentColor"/>
  </svg>
);

const PhoneIcon = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" style={{ marginRight: '1rem' }} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
  </svg>
);

// --- Login modal (inline) ---
// --- Login modal (inline, password-first with optional OTP verify) ---
function LoginModal({ onClose, onGoogle, onApple, auth }) {
  // UI state
  const { loginLocal } = useAuth();

  const [view, setView] = React.useState("choices"); // "choices" | "phone"
  const [mode, setMode] = React.useState("login");   // "login" | "signup"

  // Phone/password fields
  const [phone, setPhone] = React.useState("");
  const [phone2, setPhone2] = React.useState(""); // confirm (signup)
  const [password, setPassword] = React.useState("");
  const [password2, setPassword2] = React.useState(""); // confirm (signup)

  // Optional OTP verify (non-blocking)
  const [otpOpen, setOtpOpen] = React.useState(false);
  const [otp, setOtp] = React.useState("");
  const [codeSent, setCodeSent] = React.useState(false);

  // Misc
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState("");
  const [ok, setOk] = React.useState("");
  const recaptchaMounted = React.useRef(false);

  // ---- tiny "account store" in localStorage (prototype only) ----
  const STORAGE_KEY = "pp_users_v1";
  const normalizePhone = (s) => {
    if (!s) return "";
    let x = s.replace(/\s+/g, "");
    if (x.startsWith("00")) x = "+" + x.slice(2);
    if (!x.startsWith("+") && /^\d+$/.test(x)) x = "+" + x; // allow raw digits
    return x;
  };
  const getUsers = () => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
    catch { return {}; }
  };
  const saveUsers = (obj) => localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));

  // ---- optional: OTP via Firebase phone (not required to log in) ----
  React.useEffect(() => {
    return () => {
      if (window.__ppRecaptcha && window.__ppRecaptcha.clear) {
        try { window.__ppRecaptcha.clear(); } catch {}
      }
      window.__ppRecaptcha = null;
      window.__ppConfirmation = null;
    };
  }, []);

  const ensureRecaptcha = () => {
    if (recaptchaMounted.current) return;
    window.__ppRecaptcha = new RecaptchaVerifier(auth, 'recaptcha-container-modal', {
      size: 'normal',
      theme: 'dark',
    });
    recaptchaMounted.current = true;
  };

  const sendCode = async (e) => {
    e?.preventDefault();
    setErr(""); setOk("");
    try {
      setLoading(true);
      ensureRecaptcha();
      const ph = normalizePhone(phone);
      if (!ph.startsWith("+") || ph.length < 8) throw new Error("Enter a valid phone (with country code).");
      const confirmation = await signInWithPhoneNumber(auth, ph, window.__ppRecaptcha);
      window.__ppConfirmation = confirmation;
      setCodeSent(true);
      setOk("Code sent. Check your SMS.");
    } catch (error) {
      setErr(error?.message || "Failed to send code");
    } finally {
      setLoading(false);
    }
  };

  const verifyCode = async (e) => {
    e?.preventDefault();
    setErr(""); setOk("");
    try {
      setLoading(true);
      if (!window.__ppConfirmation) throw new Error("Please send the code first.");
      const res = await window.__ppConfirmation.confirm(otp);
      if (res?.user) setOk("Number verified ✅ (optional).");
    } catch (error) {
      setErr(error?.message || "Invalid code");
    } finally {
      setLoading(false);
    }
  };

  // ---- auth submit (password-first, OTP optional) ----
 const submitLogin = (e) => {
  e.preventDefault();
  setErr(""); setOk("");
  const ph = normalizePhone(phone);
  if (!ph) return setErr("Please enter your phone.");
  if (!password) return setErr("Please enter your password.");

  const users = getUsers();
  const entry = users[ph];
  if (!entry) return setErr("No account found for that number. Please sign up.");
  if (entry.pw !== password) return setErr("Incorrect password.");

  // ✅ create local session so Navbar sees you as logged in
  loginLocal(ph);
  setOk("Welcome back!");
  setTimeout(onClose, 300);
};


  const submitSignup = (e) => {
  e.preventDefault();
  setErr(""); setOk("");

  const ph1 = normalizePhone(phone);
  const ph2 = normalizePhone(phone2);
  if (!ph1 || !ph2) return setErr("Please enter and confirm your phone.");
  if (ph1 !== ph2) return setErr("Phone numbers do not match.");
  if (!password || !password2) return setErr("Please enter and confirm your password.");
  if (password !== password2) return setErr("Passwords do not match.");
  if (password.length < 6) return setErr("Password must be at least 6 characters.");

  const users = getUsers();
  if (users[ph1]) return setErr("An account with this number already exists. Try logging in.");

  users[ph1] = { pw: password, createdAt: Date.now() };
  saveUsers(users);

  // ✅ immediately sign them in locally
  loginLocal(ph1);
  setOk("Account created 🎉 You’re all set.");
  setTimeout(onClose, 400);
};

  // ---- visuals ----
  const buttonStyle = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '100%', padding: '0.9rem', marginBottom: '1rem',
    borderRadius: '0.75rem', border: '1px solid var(--border-color)',
    backgroundColor: 'var(--background-dark)', color: 'var(--text-light)',
    fontSize: '1rem', fontFamily: 'var(--font-heading)', cursor: 'pointer',
    transition: 'background-color 0.2s'
  };

  const fieldStyle = {
    width: '100%', padding: '0.85rem', borderRadius: '0.6rem',
    border: '1px solid var(--border-color)', backgroundColor: 'var(--border-color)',
    color: 'var(--text-light)'
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '560px', width: '95%',
          padding: '1.25rem 1.5rem',
          overflow: 'hidden'
        }}
      >
        <div className="modal-header" style={{ borderBottom: 'none', paddingBottom: 0 }}>
          <h3 className="panel-title" style={{ fontSize: '1.6rem' }}>Login or Sign Up</h3>
          <button onClick={onClose} className="quantity-btn" style={{width: '2.5rem', height: '2.5rem'}}>×</button>
        </div>

        <div className="modal-body" style={{ overflowX: 'hidden', paddingTop: '0.75rem' }}>
          {view === "choices" && (
            <>
              <div style={{ display: 'grid', gap: '0.75rem', marginTop: '0.5rem' }}>
                <button style={buttonStyle} onClick={onGoogle}><GoogleIcon />Continue with Google</button>
                <button style={buttonStyle} onClick={onApple}><AppleIcon />Continue with Apple</button>
                <button style={buttonStyle} onClick={() => setView("phone")}><PhoneIcon />Continue with Phone</button>
              </div>
              <p style={{textAlign: 'center', color: 'var(--text-medium)', fontSize: '0.85rem', marginTop: '0.5rem'}}>
                By continuing, you agree to our Terms and Conditions.
              </p>
            </>
          )}

          {view === "phone" && (
            <div style={{ marginTop: '0.5rem' }}>
              {/* Tabs */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '0.5rem',
                marginBottom: '1rem'
              }}>
                <button
                  onClick={() => { setMode("login"); setErr(""); setOk(""); }}
                  style={{
                    ...buttonStyle,
                    marginBottom: 0,
                    backgroundColor: mode === "login" ? 'var(--background-dark)' : 'transparent',
                    border: mode === "login" ? '1px solid var(--brand-neon-green)' : '1px solid var(--border-color)'
                  }}
                >
                  Log in
                </button>
                <button
                  onClick={() => { setMode("signup"); setErr(""); setOk(""); }}
                  style={{
                    ...buttonStyle,
                    marginBottom: 0,
                    backgroundColor: mode === "signup" ? 'var(--background-dark)' : 'transparent',
                    border: mode === "signup" ? '1px solid var(--brand-neon-green)' : '1px solid var(--border-color)'
                  }}
                >
                  Sign up
                </button>
              </div>

              {/* Forms */}
              {mode === "login" ? (
                <form onSubmit={submitLogin} style={{ display: 'grid', gap: '0.85rem' }}>
                  <label htmlFor="phone-login" style={{ color: 'var(--text-medium)', fontSize: '0.95rem' }}>
                    Phone (with country code)
                  </label>
                  <input
                    id="phone-login"
                    type="tel"
                    placeholder="+61 412 345 678"
                    autoComplete="tel"
                    inputMode="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    style={fieldStyle}
                  />
                  <label htmlFor="pw-login" style={{ color: 'var(--text-medium)', fontSize: '0.95rem' }}>
                    Password
                  </label>
                  <input
                    id="pw-login"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={fieldStyle}
                  />

                  {err && <p style={{ color: 'tomato', margin: 0 }}>{err}</p>}
                  {ok && <p style={{ color: 'var(--brand-neon-green)', margin: 0 }}>{ok}</p>}

                  <button type="submit" className="place-order-button" disabled={loading} style={{ opacity: loading ? 0.6 : 1 }}>
                    {loading ? "Please wait..." : "Log in"}
                  </button>

                  {/* Optional OTP verify (non-blocking) */}
                  <details
                    open={otpOpen}
                    onToggle={(e) => setOtpOpen(e.currentTarget.open)}
                    style={{ marginTop: '0.25rem' }}
                  >
                    <summary style={{ cursor: 'pointer', color: 'var(--text-medium)' }}>
                      Verify number (optional)
                    </summary>
                    <div style={{ display: 'grid', gap: '0.6rem', marginTop: '0.5rem' }}>
                      {!codeSent ? (
                        <>
                          <div id="recaptcha-container-modal" />
                          <button onClick={sendCode} type="button" className="simple-button" disabled={loading} style={{opacity: loading ? 0.6 : 1}}>
                            Send verification code
                          </button>
                        </>
                      ) : (
                        <>
                          <label htmlFor="otp-login" style={{ color: 'var(--text-medium)', fontSize: '0.9rem' }}>
                            Enter code
                          </label>
                          <input
                            id="otp-login"
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            maxLength={6}
                            value={otp}
                            onChange={(e) => setOtp(e.target.value)}
                            style={fieldStyle}
                          />
                          <button onClick={verifyCode} type="button" className="simple-button" disabled={loading} style={{opacity: loading ? 0.6 : 1}}>
                            Verify code
                          </button>
                        </>
                      )}
                    </div>
                  </details>
                </form>
              ) : (
                <form onSubmit={submitSignup} style={{ display: 'grid', gap: '0.85rem' }}>
                  <label htmlFor="phone1" style={{ color: 'var(--text-medium)', fontSize: '0.95rem' }}>
                    Phone (with country code)
                  </label>
                  <input
                    id="phone1"
                    type="tel"
                    placeholder="+61 412 345 678"
                    autoComplete="tel"
                    inputMode="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    style={fieldStyle}
                  />

                  <label htmlFor="phone2" style={{ color: 'var(--text-medium)', fontSize: '0.95rem' }}>
                    Confirm phone
                  </label>
                  <input
                    id="phone2"
                    type="tel"
                    placeholder="+61 412 345 678"
                    autoComplete="tel"
                    inputMode="tel"
                    value={phone2}
                    onChange={(e) => setPhone2(e.target.value)}
                    style={fieldStyle}
                  />

                  <label htmlFor="pw1" style={{ color: 'var(--text-medium)', fontSize: '0.95rem' }}>
                    Password
                  </label>
                  <input
                    id="pw1"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={fieldStyle}
                  />

                  <label htmlFor="pw2" style={{ color: 'var(--text-medium)', fontSize: '0.95rem' }}>
                    Confirm password
                  </label>
                  <input
                    id="pw2"
                    type="password"
                    autoComplete="new-password"
                    value={password2}
                    onChange={(e) => setPassword2(e.target.value)}
                    style={fieldStyle}
                  />

                  {err && <p style={{ color: 'tomato', margin: 0 }}>{err}</p>}
                  {ok && <p style={{ color: 'var(--brand-neon-green)', margin: 0 }}>{ok}</p>}

                  <button type="submit" className="place-order-button" disabled={loading} style={{ opacity: loading ? 0.6 : 1 }}>
                    {loading ? "Please wait..." : "Create account"}
                  </button>

                  {/* Optional OTP verify (non-blocking) */}
                  <details
                    open={otpOpen}
                    onToggle={(e) => setOtpOpen(e.currentTarget.open)}
                    style={{ marginTop: '0.25rem' }}
                  >
                    <summary style={{ cursor: 'pointer', color: 'var(--text-medium)' }}>
                      Verify number (optional)
                    </summary>
                    <div style={{ display: 'grid', gap: '0.6rem', marginTop: '0.5rem' }}>
                      {!codeSent ? (
                        <>
                          <div id="recaptcha-container-modal" />
                          <button onClick={sendCode} type="button" className="simple-button" disabled={loading} style={{opacity: loading ? 0.6 : 1}}>
                            Send verification code
                          </button>
                        </>
                      ) : (
                        <>
                          <label htmlFor="otp-signup" style={{ color: 'var(--text-medium)', fontSize: '0.9rem' }}>
                            Enter code
                          </label>
                          <input
                            id="otp-signup"
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            maxLength={6}
                            value={otp}
                            onChange={(e) => setOtp(e.target.value)}
                            style={fieldStyle}
                          />
                          <button onClick={verifyCode} type="button" className="simple-button" disabled={loading} style={{opacity: loading ? 0.6 : 1}}>
                            Verify code
                          </button>
                        </>
                      )}
                    </div>
                  </details>
                </form>
              )}

              <button
                onClick={() => { setView("choices"); setErr(""); setOk(""); }}
                className="simple-button"
                style={{ marginTop: '1rem', background: 'transparent', border: '1px solid var(--border-color)' }}
              >
                ← All sign-in options
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProfileModal({ onClose }) {
  const { currentUser } = useAuth();
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");

  const defaultAvatar = "/pizza-peppers-logo.jpg";

  const [form, setForm] = React.useState({
    displayName: "",
    phoneNumber: "",
    photoURL: "",
    addressLine1: "",
    addressLine2: "",
    suburb: "",
    state: "",
    postcode: "",
    paymentLabel: "",   // e.g. “Visa •••• 4242” or “Pay on pickup”
    paymentBrand: "",   // e.g. “visa”
    paymentLast4: "",   // e.g. “4242”
    paymentExp: "",     // e.g. “12/26”
  });

  // Load existing profile (or seed from auth)
  React.useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (!currentUser) return;
        const ref = doc(db, "users", currentUser.uid);
        const snap = await getDoc(ref);

        const seed = {
          displayName: currentUser.displayName || "",
          phoneNumber: currentUser.phoneNumber || "",
          photoURL: currentUser.photoURL || "",
        };

        if (snap.exists()) {
          const data = snap.data();
          if (mounted) {
            setForm(prev => ({ ...prev, ...seed, ...data }));
          }
        } else {
          if (mounted) setForm(prev => ({ ...prev, ...seed }));
        }
      } catch (e) {
        console.error(e);
        if (mounted) setError("Failed to load profile.");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [currentUser]);

  const onChange = (e) => {
    const { name, value } = e.target;
    setForm(prev => ({ ...prev, [name]: value }));
  };

  const onSave = async (e) => {
    e.preventDefault();
    setError("");
    try {
      setSaving(true);
      if (!currentUser) throw new Error("Not logged in");
      // Don’t store raw card numbers here. This is only metadata/labels.
      const ref = doc(db, "users", currentUser.uid);
      await setDoc(ref, { ...form }, { merge: true });
      onClose();
    } catch (e) {
      console.error(e);
      setError(e?.message || "Failed to save profile");
    } finally {
      setSaving(false);
    }
  };

  const avatarSrc = form.photoURL?.trim() ? form.photoURL : defaultAvatar;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: "640px",       // larger than login modal
          width: "92vw",
          overflow: "hidden"
        }}
      >
        <div className="modal-header">
          <h3 className="panel-title">Your Profile</h3>
          <button onClick={onClose} className="quantity-btn" style={{ width: '2.5rem', height: '2.5rem' }}>×</button>
        </div>

        <div className="modal-body" style={{ paddingBottom: "0.25rem" }}>
          {loading ? (
            <p style={{ color: 'var(--text-medium)' }}>Loading...</p>
          ) : (
            <form onSubmit={onSave} style={{ display: "grid", gap: "1rem" }}>
              {/* Top section: avatar + basics */}
              <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "1rem", alignItems: "center" }}>
                <img
                  src={avatarSrc}
                  alt="Profile"
                  style={{ width: 120, height: 120, borderRadius: "50%", objectFit: "cover", border: "1px solid var(--border-color)" }}
                />
                <div style={{ display: "grid", gap: "0.75rem" }}>
                  <div>
                    <label style={{ display: "block", color: "var(--text-medium)", fontSize: "0.9rem", marginBottom: 6 }}>
                      Profile name
                    </label>
                    <input
                      name="displayName"
                      type="text"
                      value={form.displayName}
                      onChange={onChange}
                      placeholder="e.g. Sam Pepper"
                      style={{ width: "100%", padding: "0.75rem", borderRadius: "0.5rem", border: "1px solid var(--border-color)", background: "var(--border-color)", color: "var(--text-light)" }}
                    />
                  </div>

                  <div>
                    <label style={{ display: "block", color: "var(--text-medium)", fontSize: "0.9rem", marginBottom: 6 }}>
                      Phone number
                    </label>
                    <input
                      name="phoneNumber"
                      type="tel"
                      value={form.phoneNumber}
                      onChange={onChange}
                      placeholder="+61 412 345 678"
                      style={{ width: "100%", padding: "0.75rem", borderRadius: "0.5rem", border: "1px solid var(--border-color)", background: "var(--border-color)", color: "var(--text-light)" }}
                    />
                  </div>

                  <div>
                    <label style={{ display: "block", color: "var(--text-medium)", fontSize: "0.9rem", marginBottom: 6 }}>
                      Profile photo URL (optional)
                    </label>
                    <input
                      name="photoURL"
                      type="url"
                      value={form.photoURL}
                      onChange={onChange}
                      placeholder="https://…"
                      style={{ width: "100%", padding: "0.75rem", borderRadius: "0.5rem", border: "1px solid var(--border-color)", background: "var(--border-color)", color: "var(--text-light)" }}
                    />
                  </div>
                </div>
              </div>

              {/* Address */}
              <div className="info-box">
                <h4 style={{ marginTop: 0, marginBottom: "0.75rem", color: "var(--brand-neon-green)", fontFamily: "var(--font-heading)" }}>Delivery address</h4>

                <div style={{ display: "grid", gap: "0.75rem" }}>
                  <input
                    name="addressLine1"
                    type="text"
                    value={form.addressLine1}
                    onChange={onChange}
                    placeholder="Address line 1"
                    style={{ width: "100%", padding: "0.75rem", borderRadius: "0.5rem", border: "1px solid var(--border-color)", background: "var(--border-color)", color: "var(--text-light)" }}
                  />
                  <input
                    name="addressLine2"
                    type="text"
                    value={form.addressLine2}
                    onChange={onChange}
                    placeholder="Address line 2 (optional)"
                    style={{ width: "100%", padding: "0.75rem", borderRadius: "0.5rem", border: "1px solid var(--border-color)", background: "var(--border-color)", color: "var(--text-light)" }}
                  />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 160px 160px", gap: "0.75rem" }}>
                    <input
                      name="suburb"
                      type="text"
                      value={form.suburb}
                      onChange={onChange}
                      placeholder="Suburb"
                      style={{ width: "100%", padding: "0.75rem", borderRadius: "0.5rem", border: "1px solid var(--border-color)", background: "var(--border-color)", color: "var(--text-light)" }}
                    />
                    <input
                      name="state"
                      type="text"
                      value={form.state}
                      onChange={onChange}
                      placeholder="State"
                      style={{ width: "100%", padding: "0.75rem", borderRadius: "0.5rem", border: "1px solid var(--border-color)", background: "var(--border-color)", color: "var(--text-light)" }}
                    />
                    <input
                      name="postcode"
                      type="text"
                      value={form.postcode}
                      onChange={onChange}
                      placeholder="Postcode"
                      style={{ width: "100%", padding: "0.75rem", borderRadius: "0.5rem", border: "1px solid var(--border-color)", background: "var(--border-color)", color: "var(--text-light)" }}
                    />
                  </div>
                </div>
              </div>

              {/* Payment (metadata only) */}
              <div className="info-box">
                <h4 style={{ marginTop: 0, marginBottom: "0.75rem", color: "var(--brand-neon-green)", fontFamily: "var(--font-heading)" }}>Payment method</h4>
                <p style={{ marginTop: 0, color: "var(--text-medium)", fontSize: "0.9rem" }}>
                  For security, we only store a label/summary here. (To accept online cards, wire this to Stripe or similar.)
                </p>

                <div style={{ display: "grid", gap: "0.75rem" }}>
                  <input
                    name="paymentLabel"
                    type="text"
                    value={form.paymentLabel}
                    onChange={onChange}
                    placeholder='e.g. "Visa •••• 4242" or "Pay on pickup"'
                    style={{ width: "100%", padding: "0.75rem", borderRadius: "0.5rem", border: "1px solid var(--border-color)", background: "var(--border-color)", color: "var(--text-light)" }}
                  />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem" }}>
                    <input
                      name="paymentBrand"
                      type="text"
                      value={form.paymentBrand}
                      onChange={onChange}
                      placeholder="Brand (visa/mastercard)"
                      style={{ width: "100%", padding: "0.75rem", borderRadius: "0.5rem", border: "1px solid var(--border-color)", background: "var(--border-color)", color: "var(--text-light)" }}
                    />
                    <input
                      name="paymentLast4"
                      type="text"
                      value={form.paymentLast4}
                      onChange={onChange}
                      placeholder="Last 4"
                      style={{ width: "100%", padding: "0.75rem", borderRadius: "0.5rem", border: "1px solid var(--border-color)", background: "var(--border-color)", color: "var(--text-light)" }}
                    />
                    <input
                      name="paymentExp"
                      type="text"
                      value={form.paymentExp}
                      onChange={onChange}
                      placeholder="Expiry (MM/YY)"
                      style={{ width: "100%", padding: "0.75rem", borderRadius: "0.5rem", border: "1px solid var(--border-color)", background: "var(--border-color)", color: "var(--text-light)" }}
                    />
                  </div>
                </div>
              </div>

              {error && <p style={{ color: "tomato", margin: 0 }}>{error}</p>}
              <button type="submit" className="place-order-button" disabled={saving} style={{ opacity: saving ? 0.6 : 1 }}>
                {saving ? "Saving…" : "Save profile"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}


const deliveryZones = {
  'sheidow park': 8.40,
  'woodcroft': 8.40,
  'christie downs': 12.60,
  'trott park': 8.40,
  'happy valley': 8.40,
  "o'halloran hill": 8.40,
  'hallett cove': 12.60,
  'hackham west': 12.60,
  'huntfield heights': 12.60,
  'morphett vale': 8.40,
  'lonsdale': 12.60,
  'old reynella': 8.40,
  'hackham': 12.60,
  'reynella': 8.40,
  'onkaparinga hills': 12.60,
  'reynella east': 8.40,
  'aberfoyle park': 12.60
};

// --- CSS STYLES ---
function AppStyles() {
  const styles = `
    /* --- THEME & FONT VARIABLES --- */
    :root {
      --font-heading: 'Poppins', sans-serif;
      --font-body: 'Roboto', sans-serif;
      --brand-pink: #D92682;
      --brand-green-cta: #00A756;
      --brand-neon-green: #ADF000;
      --background-dark: #111827;
      --background-light: #1f2937;
      --border-color: #374151;
      --text-light: #f3f4f6;
      --text-medium: #9ca3af;

      /* Animation properties */
      --glow-neon: 0 0 5px var(--brand-neon-green), 0 0 10px var(--brand-neon-green), 0 0 15px var(--brand-neon-green);
      --glow-pink: 0 0 5px var(--brand-pink), 0 0 10px var(--brand-pink);
    }
    [data-theme='light'] {
      --brand-neon-green: #008a45;
      --background-dark: #f9fafb;
      --background-light: #ffffff;
      --border-color: #e5e7eb;
      --text-light: #111827;
      --text-medium: #6b7280;
      --glow-neon: 0 0 8px var(--brand-neon-green);
      --glow-pink: 0 0 8px var(--brand-pink);
    }
    [data-theme='dark'] {
      --background-dark: #000000;
      --background-light: #111111;
      --border-color: #2b2b2b;
      --text-medium: #888888;
      --glow-neon: 0 0 8px var(--brand-neon-green), 0 0 15px var(--brand-neon-green), 0 0 25px var(--brand-neon-green);
      --glow-pink: 0 0 8px var(--brand-pink), 0 0 15px var(--brand-pink);
    }
    
    /* --- GENERAL & LAYOUT STYLES --- */
    html { scroll-behavior: smooth; }
    body {
      background-color: var(--background-dark);
      background-image: radial-gradient(ellipse at 70% 30%, var(--background-light) 0%, var(--background-dark) 60%);
      color: var(--text-light);
      font-family: var(--font-body);
      margin: 0;
      transition: background-color 0.3s, color 0.3s;
    }
    .app-grid-layout { display: grid; grid-template-columns: 1fr; }
    @media (min-width: 1024px) { .app-grid-layout { grid-template-columns: minmax(0, 1fr) 35%; } }
    .main-content-area { padding: 1.5rem; }
    .right-sidebar { display: none; }
    @media (min-width: 1024px) { .right-sidebar { display: block; position: sticky; top: 0; height: 100vh; } }
    
    /* --- COMPONENT STYLES --- */
    .order-panel-container {
      background-color: rgba(17, 17, 17, 0.6); 
      backdrop-filter: blur(10px);
      padding: 1.5rem;
      height: 100%;
      border-left: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      border-radius: 0;
    }
    h1, h2, h3, h4, .panel-title, .card-item-name {
      font-family: var(--font-heading);
    }
    .category-title {
      font-size: 1.75rem;
      font-weight: 700;
      text-shadow: var(--glow-neon);
      border-image: linear-gradient(to right, var(--brand-neon-green), transparent) 1;
      border-width: 0 0 2px 0;
      border-style: solid;
    }
    .menu-grid { 
      display: grid; 
      grid-template-columns: repeat(1, 1fr); 
      gap: 1.5rem; 
    }
    @media (min-width: 640px) { .menu-grid { grid-template-columns: repeat(2, 1fr); } }
    @media (min-width: 1024px) { .menu-grid { grid-template-columns: repeat(3, 1fr); } }
    @media (min-width: 1280px) { .menu-grid { grid-template-columns: repeat(4, 1fr); } }

    /* Menu Cards */
    .menu-item-card {
      background: linear-gradient(145deg, var(--background-light), #1a2331);
      border-radius: 0.75rem;
      border: 1px solid var(--border-color);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: transform 0.3s ease, box-shadow 0.3s ease;
      aspect-ratio: 4 / 5; 
    }
    .menu-item-card:hover {
      transform: translateY(-8px) scale(1.03);
      box-shadow: 0 10px 20px rgba(0,0,0,0.4), 0 0 15px var(--brand-neon-green);
    }
    .card-image-container {
      height: 60%;
      width: 100%;
      background-color: var(--border-color);
    }
    .card-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .card-text-container {
      padding: 0.75rem;
      flex-grow: 1;
      display: flex;
      flex-direction: column;
    }
    .card-item-name { 
      color: var(--brand-neon-green); 
      text-shadow: 0 0 5px var(--brand-neon-green); 
      margin-top: 0;
      margin-bottom: 0.25rem;
    }
    .card-item-description {
      font-size: 0.8rem;
      color: var(--text-medium);
      margin: 0;
      flex-grow: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    /* Buttons & Interactive Elements */
    .place-order-button, .simple-button, .quantity-btn {
      transition: all 0.2s ease-in-out;
      will-change: transform;
      border: none;
      cursor: pointer;
      border-radius: 0.5rem;
    }
    .place-order-button {
      background: linear-gradient(90deg, var(--brand-green-cta), #00c766);
      box-shadow: 0 4px 15px -5px var(--brand-green-cta);
      font-family: var(--font-heading);
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: white;
      padding: 0.75rem 1rem;
      width: 100%;
    }
    .place-order-button:hover {
      transform: scale(1.05);
      box-shadow: 0 6px 20px -5px var(--brand-green-cta);
    }
    .place-order-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }
    .quantity-btn {
        background-color: var(--border-color);
        border-radius: 50%;
        width: 2rem;
        height: 2rem;
        font-size: 1.25rem;
        color: var(--text-light);
    }
    .quantity-btn:hover { background-color: #4b5563; }
    .quantity-btn:active { transform: scale(0.95); }
    
    /* Input Fields */
    input[type="text"] {
      background-color: var(--border-color);
      border: 1px solid #4b5563;
      border-radius: 0.25rem;
      color: var(--text-light);
      padding: 0.75rem;
      transition: all 0.2s ease;
      font-family: var(--font-body);
    }
    input[type="text"]:focus {
      outline: none;
      border-color: var(--brand-pink);
      box-shadow: var(--glow-pink);
    }
    
    /* Quick Navigation */
    .quick-nav-container {
      background-color: rgba(17, 24, 39, 0.8);
      backdrop-filter: blur(8px);
    }
    .quick-nav-item a.active-nav-link {
      color: var(--brand-neon-green);
      border-bottom-color: var(--brand-neon-green);
      text-shadow: 0 0 8px var(--brand-neon-green);
    }
    .about-panel-list-item { 
      background-color: var(--background-dark); 
      padding: 1rem; 
      border-radius: 0.5rem; 
      margin-bottom: 1rem; 
      border: 1px solid var(--border-color); 
      transition: border-color 0.2s; 
    }
    .about-panel-list-item:hover { 
      border-color: var(--brand-pink); 
    }
    .about-panel-list-item a, .about-panel-list-item button { 
      color: var(--text-light); 
      text-decoration: none; 
      background: none; 
      border: none; 
      padding: 0; 
      font-size: inherit; 
      cursor: pointer; 
      display: block; 
      width: 100%; 
      text-align: left; 
    }
    .about-panel-list-item h4 { 
      margin: 0 0 0.25rem 0; 
      color: var(--brand-neon-green); 
      font-family: var(--font-heading); 
    }
    .about-panel-list-item p { 
      margin: 0; 
      color: var(--text-medium); 
      font-family: var(--font-body); 
    }
    
    /* --- FUTURISTIC FOOTER STYLES --- */
    @keyframes scan-glow {
      0% { left: -10%; }
      100% { left: 110%; }
    }
    .site-footer {
      padding: 3rem 1rem;
      margin-top: 4rem;
      border-top: 1px solid var(--border-color);
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .footer-text {
      font-family: 'Orbitron', sans-serif;
      font-size: 0.8rem;
      color: var(--text-medium);
      text-transform: uppercase;
      letter-spacing: 2px;
      position: relative;
      overflow: hidden;
      -webkit-mask-image: linear-gradient(to right, transparent, black 20%, black 80%, transparent);
      mask-image: linear-gradient(to right, transparent, black 20%, black 80%, transparent);
    }
    .footer-text::after {
      content: '';
      position: absolute;
      top: -50%;
      width: 20px;
      height: 200%;
      background: linear-gradient(to right, transparent, #00d8ff, transparent);
      box-shadow: 0 0 10px #00d8ff, 0 0 20px #00d8ff;
      animation: scan-glow 3s linear 1s infinite;
    }
    
    /* Sub-panel styles */
    .sub-panel-view { display: flex; flex-direction: column; height: 100%; }
    .sub-panel-header { margin-bottom: 1rem; }
    .sub-panel-back-button { all: unset; color: var(--text-medium); cursor: pointer; font-weight: 500; margin-bottom: 1rem; }
    .sub-panel-back-button:hover { color: var(--brand-pink); }
    .sub-panel-content { flex-grow: 1; overflow-y: auto; }
    
    .info-box { background-color: var(--background-dark); border-radius: 0.5rem; padding: 1rem; margin-bottom: 1rem; border: 1px solid var(--border-color); }
    .info-box p { margin: 0 0 0.5rem 0; color: var(--text-medium); }
    .info-box p:last-child { margin-bottom: 0; }
    .info-box strong { color: var(--text-light); font-weight: 600; }
    
    .cart-total-section { margin-top: auto; padding: 1.5rem 0 0; border-top: 2px solid var(--border-color); background: linear-gradient(to top, rgba(0,0,0,0.2), transparent); }
    
    /* Other Styles */
    .panel-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 1rem; color: var(--brand-neon-green); }
    .cart-items-list, .detail-panel-body { flex-grow: 1; overflow-y: auto; padding-right: 0.5rem; }
    .cart-item { display: flex; justify-content: space-between; align-items: center; font-size: 0.875rem; border-bottom: 1px solid var(--border-color); padding: 0.75rem 0.25rem; cursor: pointer; }
    .total-price-display { font-family: var(--font-heading); font-size: 1.5rem; font-weight: 700; display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
    .detail-image { width: 100%; height: 12rem; object-fit: cover; border-radius: 0.5rem; background-color: var(--border-color); }
    .size-quantity-row { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem; border: 1px solid var(--border-color); border-radius: 0.5rem; margin-bottom: 0.5rem; transition: all 0.3s ease-in-out; }
    .size-quantity-row.glowing-border { border-color: var(--brand-neon-green); box-shadow: 0 0 10px 2px var(--brand-neon-green); }
    .disabled-option { opacity: 0.35; pointer-events: none; background-color: rgba(0,0,0,0.1); }
    .gluten-free-toggle {  display: flex; justify-content: space-between; align-items: center;  padding: 0.75rem 0; border-bottom: 1px solid var(--border-color);  }
    .quantity-controls { display: flex; align-items: center; gap: 0.75rem; }
    .simple-button { width: 100%; background-color: var(--border-color); color: var(--text-light); padding: 0.75rem 1rem; font-weight: 500; margin-top: 0.5rem; }
    .modal-overlay { position: fixed; inset: 0; background-color: rgba(0,0,0,0.7); display: flex; justify-content: center; align-items: center; z-index: 100; }
    .modal-content { 
  background-color: var(--background-light);
  padding: 1.5rem;
  border-radius: 0.75rem;
  width: 92vw;
  max-width: 640px; /* was 500px */
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden; /* prevents side scrollbars */
}
.modal-body { overflow-y: auto; padding: 1rem 0; }
 { 
  background-color: var(--background-light);
  padding: 1.5rem;
  border-radius: 0.75rem;
  width: 92vw;
  max-width: 640px; /* was 500px */
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden; /* prevents side scrollbars */
}
.modal-body { overflow-y: auto; padding: 1rem 0; }
 { 
  background-color: var(--background-light);
  padding: 1.5rem;
  border-radius: 0.75rem;
  width: 92vw;
  max-width: 640px; /* was 500px */
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden; /* prevents side scrollbars */
}
.modal-body { overflow-y: auto; padding: 1rem 0; }
 { 
  background-color: var(--background-light);
  padding: 1.5rem;
  border-radius: 0.75rem;
  width: 92vw;
  max-width: 640px; /* was 500px */
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden; /* prevents side scrollbars */
}
.modal-body { overflow-y: auto; padding: 1rem 0; }
 { background-color: var(--background-light); padding: 1.5rem; border-radius: 0.75rem; width: 90%; max-width: 500px; max-height: 80vh; display: flex; flex-direction: column; }
    .modal-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 1rem; }
    .modal-body { overflow-y: auto; padding: 1rem 0; }
    .quick-nav-list { list-style: none; padding: 0; margin: 0; display: flex; gap: 0.5rem; overflow-x: auto; white-space: nowrap; scrollbar-width: none; -ms-overflow-style: none; }
    .quick-nav-list::-webkit-scrollbar { display: none; }
    .quick-nav-item a { display: block; padding: 0.5rem 1rem; color: var(--text-medium); text-decoration: none; font-weight: 500; border-bottom: 2px solid transparent; }
  `;
  return <style>{styles}</style>;
}

// --- MODAL COMPONENTS ---
function ExtrasModal({ onSave, onCancel, initialExtras = {} }) {
  const [selectedExtras, setSelectedExtras] = useState(initialExtras);

  const handleExtrasChange = (extra, amount) => {
    const currentQty = selectedExtras[extra.name]?.qty || 0;
    const newQty = Math.max(0, currentQty + amount);
    if (newQty > 0) {
      setSelectedExtras(prev => ({ ...prev, [extra.name]: { ...extra, qty: newQty } }));
    } else {
      const newExtras = { ...selectedExtras };
      delete newExtras[extra.name];
      setSelectedExtras(newExtras);
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="panel-title">Add Extras</h3>
          <button onClick={onCancel} className="quantity-btn" style={{width: '2.5rem', height: '2.5rem'}}>×</button>
        </div>
        <div className="modal-body">
          {Object.entries(extrasData).map(([category, extras]) => (
            <div key={category}>
              <h4 className="modal-category-title">{category}</h4>
              {extras.map(extra => (
                <div key={extra.name} className="modal-item-row">
                  <div>
                    <span style={{textTransform: 'capitalize'}}>{extra.name}</span>
                    <span style={{color: '#9ca3af', marginLeft: '0.5rem'}}>+${extra.price.toFixed(2)}</span>
                  </div>
                  <div className="quantity-controls">
                    <button className="quantity-btn" onClick={() => handleExtrasChange(extra, -1)} disabled={!selectedExtras[extra.name]}>-</button>
                    <span>{selectedExtras[extra.name]?.qty || 0}</span>
                    <button className="quantity-btn" onClick={() => handleExtrasChange(extra, 1)}>+</button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="modal-footer">
          <button onClick={() => onSave(selectedExtras)} className="place-order-button">Save Extras</button>
        </div>
      </div>
    </div>
  );
}

function EditIngredientsModal({ item, onSave, onCancel, initialRemoved = [] }) {
  const [removedIngredients, setRemovedIngredients] = useState(new Set(initialRemoved));
  const handleToggle = (ingredient) => {
    setRemovedIngredients(prev => {
      const newSet = new Set(prev);
      if (newSet.has(ingredient)) { newSet.delete(ingredient); } else { newSet.add(ingredient); }
      return newSet;
    });
  };
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="panel-title">Edit Ingredients</h3>
          <button onClick={onCancel} className="quantity-btn" style={{width: '2.5rem', height: '2.5rem'}}>×</button>
        </div>
        <div className="modal-body">
          {item.ingredients?.map(ingredient => (
            <div key={ingredient} className="modal-item-row">
              <label htmlFor={ingredient} style={{textTransform: 'capitalize'}}>{ingredient}</label>
              <input
                type="checkbox"
                id={ingredient}
                checked={!removedIngredients.has(ingredient)}
                onChange={() => handleToggle(ingredient)}
              />
            </div>
          ))}
        </div>
        <div className="modal-footer">
          <button onClick={() => onSave(Array.from(removedIngredients))} className="place-order-button">Save Ingredients</button>
        </div>
      </div>
    </div>
  );
}

function OpeningHoursView({ onBack }) {
  return (
    <div className="sub-panel-view">
      <div className="sub-panel-header">
        <button onClick={onBack} className="sub-panel-back-button">&#8592; Back</button>
        <h3 className="panel-title">Opening Hours</h3>
      </div>
      <div className="sub-panel-content" style={{lineHeight: '1.8'}}>
        <p><strong>Monday:</strong> Closed</p>
        <p><strong>Tuesday:</strong> 05:00 PM - 08:45 PM</p>
        <p><strong>Wednesday:</strong> 05:00 PM - 08:45 PM</p>
        <p><strong>Thursday:</strong> 05:00 PM - 08:45 PM</p>
        <p><strong>Friday:</strong> 05:00 PM - 08:45 PM</p>
        <p><strong>Saturday:</strong> 05:00 PM - 08:45 PM</p>
        <p><strong>Sunday:</strong> 05:00 PM - 07:45 PM</p>
      </div>
    </div>
  );
}

// ADD THIS NEW COMPONENT
function DeliveryAreasView({ onBack }) {
  return (
    <div className="sub-panel-view">
      <div className="sub-panel-header">
        <button onClick={onBack} className="sub-panel-back-button">&#8592; Back</button>
        <h3 className="panel-title">Delivery Areas</h3>
      </div>
      <div className="sub-panel-content">
        {Object.entries(deliveryZones).map(([suburb, price]) => (
          <div
            key={suburb}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '0.5rem 0',
              textTransform: 'capitalize',
              borderBottom: '1px solid var(--border-color)'
            }}
          >
            <p style={{margin: 0}}>{suburb}</p>
            <p style={{margin: 0}}>${price.toFixed(2)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// REPLACE your old AboutPanel with this new version
function AboutPanel({ isMapsLoaded }) {
  const [currentView, setCurrentView] = useState('main'); // 'main', 'hours', or 'delivery'
  const mapRef = useRef(null);
  const storeLocation = { lat: -35.077, lng: 138.515 };

  useEffect(() => {
    if (isMapsLoaded && mapRef.current && currentView === 'main') {
      const map = new window.google.maps.Map(mapRef.current, {
        center: storeLocation,
        zoom: 15,
        disableDefaultUI: true,
        styles: [
          { "featureType": "all", "elementType": "geometry", "stylers": [{ "color": "#242f3e" }] },
          { "featureType": "all", "elementType": "labels.text.stroke", "stylers": [{ "lightness": -80 }] },
          { "featureType": "administrative", "elementType": "labels.text.fill", "stylers": [{ "color": "#746855" }] },
          { "featureType": "administrative.locality", "elementType": "labels.text.fill", "stylers": [{ "color": "#d59563" }] },
          { "featureType": "poi", "elementType": "labels.text.fill", "stylers": [{ "color": "#d59563" }] },
          { "featureType": "poi.park", "elementType": "geometry", "stylers": [{ "color": "#263c3f" }] },
          { "featureType": "poi.park", "elementType": "labels.text.fill", "stylers": [{ "color": "#6b9a76" }] },
          { "featureType": "road", "elementType": "geometry.fill", "stylers": [{ "color": "#2b3544" }] },
          { "featureType": "road", "elementType": "labels.text.fill", "stylers": [{ "color": "#9ca5b3" }] },
          { "featureType": "road.arterial", "elementType": "geometry", "stylers": [{ "color": "#374151" }] },
          { "featureType": "road.highway", "elementType": "geometry", "stylers": [{ "color": "#746855" }] },
          { "featureType": "road.highway", "elementType": "labels.text.fill", "stylers": [{ "color": "#f3d19c" }] },
          { "featureType": "road.local", "elementType": "geometry", "stylers": [{ "color": "#374151" }] },
          { "featureType": "transit", "elementType": "geometry", "stylers": [{ "color": "#2f3948" }] },
          { "featureType": "transit.station", "elementType": "labels.text.fill", "stylers": [{ "color": "#d59563" }] },
          { "featureType": "water", "elementType": "geometry", "stylers": [{ "color": "#17263c" }] },
          { "featureType": "water", "elementType": "labels.text.fill", "stylers": [{ "color": "#515c6d" }] },
          { "featureType": "water", "elementType": "labels.text.stroke", "stylers": [{ "lightness": -20 }] }
        ]
      });
      new window.google.maps.Marker({ position: storeLocation, map: map, title: 'Pizza Peppers' });
    }
  }, [isMapsLoaded, currentView]);

  if (currentView === 'hours') return <OpeningHoursView onBack={() => setCurrentView('main')} />;
  if (currentView === 'delivery') return <DeliveryAreasView onBack={() => setCurrentView('main')} />;

  return (
    <>
      <h2 className="panel-title">About Pizza Peppers</h2>
      <div className="about-panel-list-item">
        <h4>Our Location</h4>
        <p>123 Pizza Lane, Reynella SA 5161</p>
        <div
          ref={mapRef}
          style={{ height: '200px', width: '100%', borderRadius: '0.5rem', marginTop: '1rem', background: 'var(--border-color)' }}
        />
      </div>
      <div className="about-panel-list-item">
        <a href="tel:0883877700">
          <h4>Call Us</h4>
          <p>(08) 8387 7700</p>
        </a>
      </div>
      <div className="about-panel-list-item">
        <button onClick={() => setCurrentView('hours')}>
          <h4>Opening Hours</h4>
          <p>View our weekly trading hours</p>
        </button>
      </div>
      <div className="about-panel-list-item">
        <button onClick={() => setCurrentView('delivery')}>
          <h4>Delivery Areas</h4>
          <p>See suburbs and delivery fees</p>
        </button>
      </div>
      <div className="about-panel-list-item">
        <Link to="/terms">
          <h4>Terms & Conditions</h4>
          <p>View our terms of service</p>
        </Link>
      </div>
    </>
  );
}

function TermsPage() {
  const headingStyle = { fontFamily: 'var(--font-heading)', color: 'var(--brand-neon-green)', marginTop: '2.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', scrollMarginTop: '6rem' };
  const subHeadingStyle = { fontFamily: 'var(--font-heading)', color: 'var(--brand-neon-green)', marginTop: '1.5rem' };
  const pStyle = { lineHeight: '1.7', color: 'var(--text-medium)' };
  const listStyle = { ...pStyle, paddingLeft: '1.5rem' };
  const tocLinkStyle = { color: 'var(--brand-pink)', textDecoration: 'none', fontWeight: '500' };

  const tocItems = [
    "Registration", "Collection Notice", "Accuracy, completeness and timeliness of information",
    "Promotions and competitions", "Orders and processing", "Price and Payment",
    "Customer Reviews & Ratings", "Linked sites", "Intellectual property rights",
    "Warranties and disclaimers", "Liability", "Jurisdiction and governing law", "Privacy Policy"
  ];

  const generateId = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  return (
    <div style={{ padding: '1.5rem', maxWidth: '800px', margin: '0 auto', fontFamily: 'var(--font-body)' }}>
      <h1 style={{...headingStyle, borderBottom: 'none', textAlign: 'center'}}>Terms & Conditions</h1>

      {/* --- TABLE OF CONTENTS --- */}
      <div className="info-box" style={{marginBottom: '3rem', padding: '1.5rem'}}>
        <h4 style={{fontFamily: 'var(--font-heading)', color: 'var(--brand-neon-green)', marginTop: 0, marginBottom: '1rem', textAlign: 'center'}}>Table of Contents</h4>
        <ul style={{paddingLeft: '1.5rem', margin: 0, columns: 2, listStyleType: 'none'}}>
          {tocItems.map((item, index) => (
            <li key={item} style={{marginBottom: '0.75rem'}}>
              <a href={`#${generateId(item)}`} style={tocLinkStyle}>{index < 12 ? `${index + 1}. ` : ''}{item}</a>
            </li>
          ))}
        </ul>
      </div>
      
      <p style={pStyle}>Thank you for visiting our website. This website is owned and operated by Next Order Pty Ltd. (ACN 627 375 535). By accessing and/or using this website and related services, you agree to these Terms and Conditions, which include our Privacy Policy (Terms). You should review our Privacy Policy and these Terms carefully and immediately cease using our website if you do not agree to these Terms.</p>
      <p style={pStyle}>In these Terms, 'us', 'we' and 'our' means Next Order Pty Ltd.</p>

      <h3 id={generateId(tocItems[0])} style={headingStyle}>1. Registration</h3>
      <p style={pStyle}>You must be a registered member to make orders, reservations and access certain features of our website. When you register and activate your account, you will provide us with personal information such as your name, mobile number and address. You must ensure that this information is accurate and current. We will handle all personal information we collect in accordance with our Privacy Policy.</p>
      <p style={pStyle}>To create an account, you must be:</p>
      <ul style={listStyle}>
        <li>(a) at least 18 years of age;</li>
        <li>(b) possess the legal right and ability to enter into a legally binding agreement with us; and</li>
        <li>(c) agree and warrant to use the website in accordance with these Terms.</li>
      </ul>

      <h3 id={generateId(tocItems[1])} style={headingStyle}>2. Collection Notice</h3>
      <p style={pStyle}>We collect personal information about you in order to process your orders, reservations and for purposes otherwise set out in our Privacy Policy. We may disclose that information to third parties that help us deliver our services (including information technology suppliers, communication suppliers and our Restaurants) or as required by law. If you do not provide this information, we may not be able to provide all of our services to you.</p>
      <p style={pStyle}>Our Privacy Policy explains:</p>
      <ul style={listStyle}>
        <li>(i) how we store and use, and how you may access and correct your personal information;</li>
        <li>(ii) how you can lodge a complaint regarding the handling of your personal information; and</li>
        <li>(iii) how we will handle any complaint.</li>
      </ul>
      <p style={pStyle}>By providing your personal information to us, you consent to the collection, use, storage and disclosure of that information as described in the Privacy Policy and these Terms.</p>

      <h3 id={generateId(tocItems[2])} style={headingStyle}>3. Accuracy, completeness and timeliness of information</h3>
      <p style={pStyle}>The information on our website is not comprehensive and is intended to provide a summary of the subject matter covered. While we use all reasonable attempts to ensure the accuracy and completeness of the information on our website, live waiting times displayed for delivery and pickup are estimates only as set out in our Delivery Policy. We may, from time to time and without notice, change or add to the website (including the Terms) or the information, products or services described in it. However, we do not undertake to keep the website updated. We are not liable to you or anyone else if errors occur in the information on the website or if that information is not up-to-date.</p>

      <h3 id={generateId(tocItems[3])} style={headingStyle}>4. Promotions and competitions</h3>
      <p style={pStyle}>For certain campaigns, promotions or contests, additional terms and conditions may apply. If you want to participate in such a campaign, promotion or contest, you need to agree to the relevant terms and conditions applicable to that campaign, promotion or contest. In case of any inconsistency between such terms and conditions and these Terms, those terms and conditions will prevail.</p>
      
      <h3 id={generateId(tocItems[4])} style={headingStyle}>5. Orders and processing</h3>
      <h4 style={subHeadingStyle}>5.1 Placing your Order</h4>
      <p style={pStyle}>Once you select the Products you wish to order from the menu and provide other required information, you will be given the opportunity to submit your Order by clicking or selecting the "Order", "Proceed to Payment", "Confirm and Pay" or similar button. It is important that you check all the information that you enter and correct any errors before clicking or selecting this button; once you do so we will process your Order and errors cannot be corrected.</p>
      <h4 style={subHeadingStyle}>5.2 Minimum Order Amount</h4>
      <p style={pStyle}>If a minimum order amount is in place, you may not place an order until the value of your Order equals or exceeds that amount. The minimum order amount must be met after applying any discounts or specials that reduce the total Order amount.</p>
      <h4 style={subHeadingStyle}>5.3 Amending or cancelling your Order</h4>
      <p style={pStyle}>Once you submit your Order and your payment has been authorised, you will not be entitled to change or cancel your Order online. If you wish to change or cancel your Order, you may contact the Restaurant directly. However, there is no guarantee that the Restaurant will agree to your requests as they may have already started to process your Order.</p>
      <h4 style={subHeadingStyle}>5.4 Payment authorisation</h4>
      <p style={pStyle}>Where any payment you make is not authorised, your Order will not be processed by or communicated to the Restaurant.</p>
      <h4 style={subHeadingStyle}>5.5 Processing your Order and Restaurant rejections</h4>
      <p style={pStyle}>On receipt of your Order, we will begin processing it by sending it to the Restaurant and may notify you by SMS that your Order has been received and is being processed. The restaurant has the discretion to reject Orders at any time because they are too busy, due to weather conditions or for any other reason.</p>
      <h4 style={subHeadingStyle}>5.6 Delivery of your Order</h4>
      <p style={pStyle}>Delivery will be provided by the Restaurant. Estimated times for deliveries and collections are provided by the Restaurant and are only estimates. While the Restaurant will try their best to meet these estimates, we make no guarantee that Orders will be delivered or will be available for collection within the estimated times.</p>
      
      <h3 id={generateId(tocItems[5])} style={headingStyle}>6. Price and Payment</h3>
      <h4 style={subHeadingStyle}>6.1 Taxes and delivery costs</h4>
      <p style={pStyle}>Prices for individual menu items will be as quoted on the Website in Australian dollars. These prices include any applicable taxes but may exclude delivery costs and any online payment administration charge.</p>
      <h4 style={subHeadingStyle}>6.2 Payment methods</h4>
      <p style={pStyle}>Payment for Orders must be made by an accepted credit or debit card through the Website or in cash to the Restaurant at the point of collection or delivery to you.</p>
      <h4 style={subHeadingStyle}>6.3 Card payments</h4>
      <p style={pStyle}>If you pay by credit or debit card, you may be required to show the card to the Restaurant at the time of delivery as proof of identification. Delays with the processing of card payments may result in delays in sums being deducted from your bank account or charged to your credit or debit card.</p>
      <h4 style={subHeadingStyle}>6.4 Credit and discount vouchers</h4>
      <p style={pStyle}>A credit or discount may apply to your Order if you use a promotional voucher or code recognised by the Website and endorsed by the Restaurant.</p>
      <h4 style={subHeadingStyle}>6.5 Rejected Orders</h4>
      <p style={pStyle}>Once you have submitted an Order that you are paying for by credit or debit card and your payment has been authorised, you will be charged the full amount of your Order. If your Order is subsequently rejected by the Restaurant, your bank or card issuer will refund the relevant amount. This may take between 3 to 5 working days (or longer, depending on your bank or card issuer).</p>

      <h3 id={generateId(tocItems[6])} style={headingStyle}>7. Customer Reviews & Ratings</h3>
      <p style={pStyle}>You are responsible for review content and ratings. By submitting a review you agree that content provided is true and accurate.</p>

      <h3 id={generateId(tocItems[7])} style={headingStyle}>8. Linked sites</h3>
      <p style={pStyle}>Our website may contain links to websites operated by third parties. Those links are provided for convenience and may not remain current or be maintained. We do not endorse and are not responsible for the content on those linked websites.</p>

      <h3 id={generateId(tocItems[8])} style={headingStyle}>9. Intellectual property rights</h3>
      <p style={pStyle}>(a) Unless otherwise indicated, we own or license all rights, title and interest (including copyright, designs, patents, trademarks and other intellectual property rights) in this website and in all of the material made available on this website.</p>
      <p style={pStyle}>(b) Your use of this website does not grant or transfer any rights, title or interest to you in relation to this website or its Content. Any reproduction or redistribution of this website or the Content is prohibited and may result in civil and criminal penalties.</p>
      
      <h3 id={generateId(tocItems[9])} style={headingStyle}>10. Warranties and disclaimers</h3>
      <p style={pStyle}>To the maximum extent permitted by law, including the Australian Consumer Law, we make no warranties or representations about this website or the Content, including but not limited to warranties or representations that they will be complete, accurate or up-to-date, that access will be uninterrupted or error-free or free from viruses, or that this website will be secure.</p>

      <h3 id={generateId(tocItems[10])} style={headingStyle}>11. Liability</h3>
      <p style={pStyle}>To the maximum extent permitted by law, including the Australian Consumer Law, in no event shall we be liable for any direct and indirect loss, damage or expense which may be suffered due to your use of our website and/or the information or materials contained on it.</p>
      
      <h3 id={generateId(tocItems[11])} style={headingStyle}>12. Jurisdiction and governing law</h3>
      <p style={pStyle}>Your use of the website and these Terms are governed by the law of Victoria and you submit to the non-exclusive jurisdiction of the courts exercising jurisdiction in Victoria.</p>

      <h2 id={generateId(tocItems[12])} style={{...headingStyle, marginTop: '4rem'}}>Privacy Policy</h2>
      <p style={pStyle}>In this Privacy Policy, 'us' 'we' or 'our' means Next Order Pty Ltd (ACN 627 375 535) and our related bodies corporate. We are committed to respecting your privacy. Our Privacy Policy sets out how we collect, use, store and disclose your personal information.</p>
      
      <h4 style={subHeadingStyle}>What personal information do we collect?</h4>
      <p style={pStyle}>We may collect personal information such as your name, street address, telephone number, credit card information, device ID, and other details you provide to us through our website or app.</p>
      
      <h4 style={subHeadingStyle}>Why do we collect, use and disclose personal information?</h4>
      <p style={pStyle}>We may collect, hold, use and disclose your personal information to enable you to access and use our website, to operate and improve our services, to send you service and marketing messages, and to comply with our legal obligations.</p>
      
      <h4 style={subHeadingStyle}>Do we use your personal information for direct marketing?</h4>
      <p style={pStyle}>We may send you direct marketing communications. You may opt-out of receiving marketing materials from us by contacting us at privacy@nextorder.com.au.</p>
      
      <h4 style={subHeadingStyle}>To whom do we disclose your personal information?</h4>
      <p style={pStyle}>We may disclose personal information to our employees, third party suppliers, service providers, and as required by law. We may disclose personal information outside of Australia to cloud providers located in India and the United States of America.</p>
      
      <h4 style={subHeadingStyle}>Using our website and cookies</h4>
      <p style={pStyle}>We may collect personal information about you when you use and access our website. We may also use 'cookies' or other similar tracking technologies on our website that help us track your website usage and remember your preferences.</p>
      
      <h4 style={subHeadingStyle}>Security</h4>
      <p style={pStyle}>We take reasonable steps to protect your personal information from misuse, interference and loss, as well as unauthorised access, modification or disclosure.</p>

      <h4 style={subHeadingStyle}>Making a complaint</h4>
      <p style={pStyle}>If you think we have breached the Privacy Act, you can contact us at privacy@nextorder.com.au. We will acknowledge your complaint and respond to you within a reasonable period of time.</p>
      
      <Link to="/" style={{color: 'var(--brand-pink)', marginTop: '3rem', display: 'inline-block', fontWeight: 'bold', textDecoration: 'none', fontSize: '1.1rem'}}>
        &#8592; Back to Menu
      </Link>
    </div>
  );
}

// --- NAVBAR COMPONENT ---
function Navbar({ onAboutClick, onMenuClick, onLoginClick, onProfileClick }) {

  const { cart } = useCart();
  const { currentUser, logout } = useAuth();
  const totalItems = useMemo(() => cart.reduce((sum, item) => sum + item.qty, 0), [cart]);

  const firstName =
  (currentUser?.displayName && currentUser.displayName.split(' ')[0]) ||
  (currentUser?.phoneNumber ? currentUser.phoneNumber : 'there');

  return (
    <nav style={{ backgroundColor: 'var(--background-dark)', padding: '0.5rem 1.5rem', borderBottom: `1px solid var(--brand-pink)`, position: 'sticky', top: 0, zIndex: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          <ThemeSwitcher />
          <Link to="/" onClick={onMenuClick} style={{ textDecoration: 'none', display: 'flex', alignItems: 'center' }}>
            <img src="/pizza-peppers-logo.jpg" alt="Pizza Peppers Logo" style={{ height: '3.5rem' }} />
          </Link>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          <Link to="/" onClick={onMenuClick} style={{ color: 'var(--text-light)', textDecoration: 'none', fontWeight: '500' }}>Menu</Link>
          <button onClick={onAboutClick} style={{all: 'unset', color: 'var(--text-light)', cursor: 'pointer', fontWeight: '500'}}>About Us</button>
          <button onClick={onMenuClick} style={{all: 'unset', color: 'var(--text-light)', cursor: 'pointer', fontWeight: '500'}}>Cart ({totalItems})</button>
          {currentUser ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <span style={{ color: 'var(--text-medium)', fontSize: '0.9rem' }}>Hi, {firstName}</span>
                <button
                  onClick={onProfileClick}
                  style={{ all: 'unset', color: 'var(--brand-neon-green)', cursor: 'pointer', fontWeight: '600' }}
                  >
                Profile
            </button>
              <button
                onClick={logout}
                style={{ all: 'unset', color: 'var(--brand-pink)', cursor: 'pointer', fontWeight: '500' }}
              >
              Logout
          </button>
        </div>
      ) : (
        <button onClick={onLoginClick} style={{all: 'unset', color: 'var(--brand-neon-green)', cursor: 'pointer', fontWeight: '700'}}>
        Login
        </button>
      )}

        </div>
      </div>
    </nav>
  );
}

// ADD THIS ENTIRE BLOCK AFTER YOUR Navbar COMPONENT
function Footer() {
  return (
    <footer className="site-footer">
      <p className="footer-text">Forged by Ashmore Co</p>
    </footer>
  );
}

// --- PAGE COMPONENT ---
function Home({ menuData, handleItemClick }) {
  const [activeCategory, setActiveCategory] = useState('');
  useEffect(() => { /* ... existing scroll logic ... */ }, []);
  return (
    <>
      <QuickNav menuData={menuData} activeCategory={activeCategory} />
      <Menu menuData={menuData} onItemClick={handleItemClick} />
    </>
  );
}

// --- LAYOUT COMPONENT ---
function AppLayout({ isMapsLoaded }) {

  const { loginWithGoogle, loginWithApple } = useAuth();

  const { addToCart, removeFromCart } = useCart();

  // Dynamic menu
  const [menuData, setMenuData] = useState({ categories: [] });
  const [isLoading, setIsLoading] = useState(true);

  const [selectedItem, setSelectedItem] = useState(null);
  const [editingIndex, setEditingIndex] = useState(null);
  const [isExtrasModalOpen, setIsExtrasModalOpen] = useState(false);
  const [isIngredientsModalOpen, setIsIngredientsModalOpen] = useState(false);
  const [customizingItem, setCustomizingItem] = useState(null);
  const [rightPanelView, setRightPanelView] = useState('order');
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);

  // NEW DATA FETCHING LOGIC (USING PROXY)
  useEffect(() => {
    const fetchMenu = async () => {
      try {
        const MENU_URL = '/public/menu'; // DEV: force via Vite proxy (no CORS)
        console.log('Fetching MENU_URL =', MENU_URL);
        const response = await fetch(MENU_URL);

        if (!response.ok) {
          throw new Error(`Server responded with an error: ${response.status}`);
        }

        const jsonResponse = await response.json();
        const rawData = jsonResponse.data;

        const transformedMenu = {
          categories: rawData.categories.map(category => {
            const items = rawData.products
              .filter(p => p.category_ref === category.ref)
              .map(product => {
                const sizes = product.skus.map(sku => sku.name.charAt(0).toUpperCase() + sku.name.slice(1));
                const prices = product.skus.reduce((acc, sku) => {
                  const key = sku.name.charAt(0).toUpperCase() + sku.name.slice(1);
                  const toNumber = (val) =>
                    typeof val === 'number' ? val : parseFloat(String(val).replace(/[^\d.]/g, ''));
                  acc[key] = toNumber(sku.price);
                  return acc;
                }, {});

                return {
                  name: product.name,
                  description: product.description,
                  sizes: sizes.length > 1 ? sizes : null,
                  prices: sizes.length > 1 ? prices : { Default: prices.Default ?? Object.values(prices)[0] },
                  ingredients: product.ingredients || [],
                };
              });
            return { name: category.name, items: items };
          })
        };
        
        setMenuData(transformedMenu);
        setIsLoading(false);

      } catch (error) {
        console.error("Failed to fetch menu:", error);
        setIsLoading(false);
      }
    };

    fetchMenu();
  }, []);

  const handleItemClick = (item) => {
    if (selectedItem && selectedItem.name === item.name) {
      setSelectedItem(null);
      setCustomizingItem(null);
      setEditingIndex(null);
    } else {
      setSelectedItem(item);
      setCustomizingItem({ ...item, extras: {}, removedIngredients: [] });
      setEditingIndex(null);
    }
  };

  const handleEditItem = (item, index) => {
    setSelectedItem(item);
    setCustomizingItem({ ...item });
    setEditingIndex(index);
  };

  const handleClosePanel = (itemsToAdd, isGlutenFree) => {
    if (itemsToAdd && itemsToAdd.length > 0) {
      const extrasPrice = Object.values(customizingItem.extras || {}).reduce((sum, extra) => sum + extra.price * extra.qty, 0);
      const finalItems = itemsToAdd.map(({ size, qty }) => ({
        ...selectedItem,
        size,
        qty,
        price: selectedItem.prices[size] + (isGlutenFree && size === 'Large' ? 4.00 : 0) + extrasPrice,
        isGlutenFree: isGlutenFree && size === 'Large',
        extras: customizingItem.extras,
        removedIngredients: customizingItem.removedIngredients
      }));
      if (editingIndex !== null) removeFromCart(editingIndex);
      addToCart(finalItems);
    }
    setSelectedItem(null);
    setEditingIndex(null);
    setCustomizingItem(null);
  };

  const handleSaveExtras = (newExtras) => {
    setCustomizingItem(prev => ({ ...prev, extras: newExtras }));
    setIsExtrasModalOpen(false);
  };

  const handleSaveIngredients = (newRemoved) => {
    setCustomizingItem(prev => ({ ...prev, removedIngredients: newRemoved }));
    setIsIngredientsModalOpen(false);
  };

  const showOrderPanel = () => {
    setSelectedItem(null);
    setRightPanelView('order');
  };

  const showAboutPanel = () => {
    setSelectedItem(null);
    setRightPanelView('about');
  };

  return (
    <>
      {isExtrasModalOpen && customizingItem && (
        <ExtrasModal
          onSave={handleSaveExtras}
          onCancel={() => setIsExtrasModalOpen(false)}
          initialExtras={customizingItem.extras}
        />
      )}
      {isIngredientsModalOpen && customizingItem && (
        <EditIngredientsModal
          item={customizingItem}
          onSave={handleSaveIngredients}
          onCancel={() => setIsIngredientsModalOpen(false)}
          initialRemoved={customizingItem.removedIngredients}
        />
      )}
      {isLoginModalOpen && (
        <LoginModal
          auth={auth}
          onClose={() => setIsLoginModalOpen(false)}
          onGoogle={loginWithGoogle}
          onApple={loginWithApple}
        />
      )}
      {isProfileOpen && <ProfileModal onClose={() => setIsProfileOpen(false)} />}
      


      <div className="app-grid-layout">
        <div className="left-pane">
          <Navbar
           onAboutClick={showAboutPanel}
           onMenuClick={showOrderPanel}
           onLoginClick={() => setIsLoginModalOpen(true)}
           onProfileClick={() => setIsProfileOpen(true)}
          />

          <main className="main-content-area">
            {isLoading ? (
              <p style={{ textAlign: 'center', fontSize: '1.2rem', marginTop: '4rem' }}>Loading menu...</p>
            ) : (
              <Routes>
                <Route path="/" element={<Home menuData={menuData} handleItemClick={handleItemClick} />} />
                <Route path="/terms" element={<TermsPage />} />
              </Routes>
            )}
            <Footer />
          </main>
        </div>
        <div className="right-sidebar">
          <div className="order-panel-container">
            {selectedItem ? (
              <ItemDetailPanel
                item={selectedItem}
                onClose={handleClosePanel}
                editingIndex={editingIndex}
                editingItem={customizingItem}
                onOpenExtras={() => setIsExtrasModalOpen(true)}
                onOpenIngredients={() => setIsIngredientsModalOpen(true)}
              />
            ) : rightPanelView === 'about' ? (
              <AboutPanel isMapsLoaded={isMapsLoaded} />
            ) : (
              <OrderSummaryPanel onEditItem={handleEditItem} isMapsLoaded={isMapsLoaded} />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// --- MAIN APP ---
function App() {
  const [isMapsLoaded, setIsMapsLoaded] = useState(false);
  const scriptLoaded = useRef(false);

  useEffect(() => {
    if (scriptLoaded.current) return;
    const googleMapsApiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    if (googleMapsApiKey) {
      const script = document.createElement('script');
      script.id = 'google-maps-script';
      script.src = `https://maps.googleapis.com/maps/api/js?key=${googleMapsApiKey}&libraries=places&loading=async`;
      script.async = true;
      script.onload = () => setIsMapsLoaded(true);
      document.head.appendChild(script);
      scriptLoaded.current = true;
    }
  }, []);

  return (
    <Router>
      <ThemeProvider>
        <AuthProvider>
          <CartProvider>
            <AppStyles />
            <AppLayout isMapsLoaded={isMapsLoaded} />
              <div  
                id="recaptcha-container-root"
                style={{ position: 'fixed', bottom: 0, right: 0, zIndex: 1 }}
              />
          </CartProvider>
        </AuthProvider>
      </ThemeProvider>
    </Router>
  );
}

export default App;
