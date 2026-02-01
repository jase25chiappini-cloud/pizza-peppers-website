import React, {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Routes, Route, Link, useNavigate, useLocation } from "react-router-dom";

import {
  FB_READY,
  app as firebaseApp,
  auth as firebaseAuth,
  db as firebaseDb,
  storage as firebaseStorage,
} from "./firebase";
import {
  GoogleAuthProvider,
  OAuthProvider,
  signOut as fbSignOut,
  signInWithPhoneNumber,
  RecaptchaVerifier,
  signInWithRedirect,
  getRedirectResult,
  signInWithPopup,
  onIdTokenChanged,
  updateProfile,
  setPersistence,
  browserLocalPersistence,
} from "firebase/auth";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import {
  ref as storageRef,
  uploadBytes,
  getDownloadURL,
} from "firebase/storage";
import {
  dumpFirebaseLocalStorage,
  logAuthConfig,
  labelUser,
} from "./utils/authDebug";
import { OVERRIDE_POSTCODES } from "./config/deliveryOverrides";
import { quoteForPostcode as _quoteForPostcode } from "./config/delivery";
import {
  getApplicableOptionGroups,
  productSupportsIngredientEdit,
  productSupportsExtras,
  __categoryGuards,
  normalizeSizeRef as normalizeProductSizeRef,
  isGfAllowedForSize,
  enforceGfSize,
  groupIngredientsForProduct,
} from "./utils/options";
import {
  normalizeAddonSizeRef,
  resolveAddonPriceCents,
  calcExtrasCentsForSize,
} from "./utils/addonPricing";
import {
  normalizeSizeRef as normalizeMenuSizeRef,
  defaultSize,
} from "./utils/size";
import AdminPanelPage from "./AdminPanel";
import ppBanner from "./assets/pizza-peppers-banner.png";
const HALF_HALF_FORCED_ITEM = {
  id: "half_half",
  name: "The Half & Half Pizza",
  description: "Can't decide? Pick two favorites! (Custom Builder)",
  category: "Pizza",
  price: 0,
  isHalfHalf: true,
  image: "half-half.jpg",
  available: true,
};

const _toCentsFromMenuSurcharge = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;

  // menu.json typically stores surcharge in dollars (e.g. 2), not cents.
  // If it's big, assume it's already cents.
  if (n >= 50) return Math.round(n);
  return Math.round(n * 100);
};

const _lookupHalfHalfSurchargeCents = (menuRows, half) => {
  if (!half) return 0;

  // Prefer the actual menu row so we read menu.json's field reliably.
  const row =
    (Array.isArray(menuRows) &&
      (menuRows.find((r) => String(r?.id) === String(half?.id)) ||
        menuRows.find((r) => String(r?.name) === String(half?.name)))) ||
    null;

  const v =
    row?.half_and_half_surcharge ??
    row?.half_and_half_surcharge_cents ??
    half?.half_and_half_surcharge ??
    half?.half_and_half_surcharge_cents ??
    0;

  return _toCentsFromMenuSurcharge(v);
};

// ----------------- PROFILE STORAGE (shared) -----------------
const PROFILE_UPDATED_EVENT = "pp-profile-updated";

// ----------------- FEATURE FLAGS (shared) -----------------
const FEATURE_FLAGS_UPDATED_EVENT = "pp-featureflags-updated";
const FEATURE_LOYALTY_ENABLED_KEY = "pp_feature_loyalty_enabled";

function readLoyaltyFeatureEnabled() {
  try {
    const v = window.localStorage.getItem(FEATURE_LOYALTY_ENABLED_KEY);
    if (v == null) return true; // default ON
    return v === "1" || v === "true";
  } catch {
    return true;
  }
}

function notifyProfileUpdated(user) {
  try {
    if (typeof window === "undefined") return;
    const detail = { key: getLocalProfileStorageKey(user) };
    window.dispatchEvent(new CustomEvent(PROFILE_UPDATED_EVENT, { detail }));
  } catch {}
}

function getStableUserKey(user) {
  if (!user) return null;
  return user.uid || user.email || user.phoneNumber || null;
}

function getLocalProfileStorageKey(user) {
  const k = getStableUserKey(user);
  return k ? `pp_profile_${k}` : null;
}

function readLocalProfile(user) {
  const key = getLocalProfileStorageKey(user);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      const cleaned = scrubBadAddressFields(parsed);
      if (JSON.stringify(cleaned) !== JSON.stringify(parsed)) {
        try {
          localStorage.setItem(key, JSON.stringify(cleaned));
        } catch {}
      }
      return cleaned;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeLocalProfile(user, data) {
  const key = getLocalProfileStorageKey(user);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(data || {}));
    notifyProfileUpdated(user);
  } catch (e) {
    console.warn("[profile] local save failed", e?.message || e);
  }
}

function useLocalProfile(user) {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const onUpdate = (event) => {
      const detailKey = event?.detail?.key || null;
      const myKey = getLocalProfileStorageKey(user);
      if (detailKey && myKey && detailKey !== myKey) return;
      setTick((t) => t + 1);
    };
    window.addEventListener(PROFILE_UPDATED_EVENT, onUpdate);
    return () => window.removeEventListener(PROFILE_UPDATED_EVENT, onUpdate);
  }, [user?.uid, user?.email, user?.phoneNumber]);

  return React.useMemo(
    () => readLocalProfile(user),
    [user?.uid, user?.email, user?.phoneNumber, tick],
  );
}

// --- PP Scroll Lock (prevents random stuck scrolling on mobile) ---
function ppLockBodyScroll() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const body = document.body;

  const key = "__ppScrollLockCount";
  const count = (window[key] || 0) + 1;
  window[key] = count;

  // only apply on first lock
  if (count === 1) {
    body.classList.add("pp-scroll-locked");
  }
}

function ppUnlockBodyScroll() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const body = document.body;

  const key = "__ppScrollLockCount";
  const next = Math.max(0, (window[key] || 0) - 1);
  window[key] = next;

  // only remove when fully unlocked
  if (next === 0) {
    body.classList.remove("pp-scroll-locked");
  }
}

function pickProfileName(profile, user) {
  return (
    String(profile?.displayName || "").trim() ||
    String(user?.displayName || "").trim() ||
    String(profile?.name || "").trim() ||
    ""
  );
}

function pickProfilePhone(profile, user) {
  return (
    String(profile?.phoneNumber || "").trim() ||
    String(profile?.phone || "").trim() ||
    String(user?.phoneNumber || "").trim() ||
    ""
  );
}

function normalizeAddressText(val) {
  if (val == null) return "";

  if (typeof val === "string") {
    const s = val.trim();
    if (s.toLowerCase() === "[object object]") return "";
    return s;
  }

  if (typeof val === "object") {
    const candidate =
      val.formattedAddress ??
      val.formatted_address ??
      val.description ??
      val.address ??
      val.addressLine1 ??
      val.line ??
      (val.displayName && val.displayName.text) ??
      "";

    if (typeof candidate === "string") return candidate.trim();
    if (candidate && typeof candidate === "object") {
      const t =
        candidate.text ??
        candidate.value ??
        candidate.line ??
        candidate.addressLine1 ??
        "";
      return typeof t === "string" ? t.trim() : "";
    }

    return "";
  }

  return "";
}

function pickProfileAddress(profile) {
  const line1 = normalizeAddressText(
    profile?.addressLine1 || profile?.address || "",
  );
  const suburb = String(profile?.suburb || "").trim();
  const state = String(profile?.state || "").trim();
  const postcode = String(profile?.postcode || "").trim();

  const tail = [suburb, state, postcode].filter(Boolean).join(" ");
  return [line1, tail].filter(Boolean).join(", ").trim();
}

function scrubBadAddressFields(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const next = { ...obj };

  const fix = (k) => {
    const v = next[k];
    if (v == null) return;
    if (typeof v === "string") {
      if (v.trim().toLowerCase() === "[object object]") next[k] = "";
      return;
    }
    next[k] = "";
  };

  fix("addressLine1");
  fix("address");
  return next;
}

// --- RESTORED HALF & HALF COMPONENT ---
const HalfAndHalfSelector = ({
  menuItems,
  menuData,
  onAddItemToOrder,
  selectedItem,
  setSelectedItem,
  registerExternalPizzaApply = null,
  useExternalMenuSelection = false,
  hidePizzaPicker = false,
  compactUiMode = false,
  initialHalfA = null,
  initialHalfB = null,
  initialSizeRef = "LARGE",
  initialIsGlutenFree = false,
  initialQty = 1,
  lockedSizeRef = null,
  onRequestChangeHalf = null,
}) => {
  const [activeHalf, setActiveHalf] = React.useState("A");
  const [sizeRef, setSizeRef] = React.useState(initialSizeRef || "LARGE");
  const [halfA, setHalfA] = React.useState(initialHalfA || null);
  const [halfB, setHalfB] = React.useState(initialHalfB || null);
  const [halfSelectionSide, setHalfSelectionSide] = React.useState("A");
  const [pendingHalfA, setPendingHalfA] = React.useState(null);
  const [pendingHalfB, setPendingHalfB] = React.useState(null);
  const [isNarrowScreen, setIsNarrowScreen] = React.useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 1023.98px)").matches;
  });
  // --- Mobile wizard step (authoritative) ---
  const [wizardStep, setWizardStep] = React.useState("A"); // "A" | "B" | "CONFIRM"
  const wizardStepRef = React.useRef("A");

  // keep ref synced (normal render path)
  React.useEffect(() => {
    wizardStepRef.current = wizardStep;
  }, [wizardStep]);

  // whenever halves change, derive the correct step (prevents desync)
  React.useEffect(() => {
    if (!isNarrowScreen) return;

    const next =
      !halfA ? "A" :
      !halfB ? "B" :
      "CONFIRM";

    if (wizardStepRef.current !== next) {
      wizardStepRef.current = next;
      setWizardStep(next);
    }
  }, [isNarrowScreen, halfA, halfB]);
  const [halfEditorSide, setHalfEditorSide] = React.useState(null);
  const [halfEditorItem, setHalfEditorItem] = React.useState(null);
  const [halfEditorInitialModal, setHalfEditorInitialModal] = React.useState(null);
  const [halfEditorSuppressPanel, setHalfEditorSuppressPanel] = React.useState(false);
  const [isHalfGlutenFree, setIsHalfGlutenFree] = React.useState(
    !!initialIsGlutenFree,
  );
  const [halfQty, setHalfQty] = React.useState(() => {
    const q = Number(initialQty || 1);
    return Number.isFinite(q) && q > 0 ? q : 1;
  });
 
  React.useEffect(() => {
    if (initialSizeRef) setSizeRef(initialSizeRef);
    if (initialHalfA) setHalfA(initialHalfA);
    if (initialHalfB) setHalfB(initialHalfB);
    setIsHalfGlutenFree(!!initialIsGlutenFree);
    {
      const q = Number(initialQty || 1);
      setHalfQty(Number.isFinite(q) && q > 0 ? q : 1);
    }
  }, [initialHalfA, initialHalfB, initialSizeRef, initialIsGlutenFree, initialQty]);


  // compactUiMode is ONLY for the meal-deal overlay / tight layouts
  const compactUi = !!compactUiMode;
  // Mobile compact (meal deal overlay): prefer ONE scroll container (not body + footer split)
  const singleScrollMode = isNarrowScreen;

  // For this new pattern: we pick from the MENU (external), not inside the builder.
  const allowInlinePicker =
    !useExternalMenuSelection && !hidePizzaPicker;

  const halfBodyRef = React.useRef(null);
  const halfOptionsRef = React.useRef(null);
  const panelScrollRef = React.useRef(null);

  const scrollToHalfOptions = React.useCallback(() => {
    const target = halfOptionsRef.current;
    if (!target) return;
    try {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      // small offset so it doesn't kiss the top
      requestAnimationFrame(() => window.scrollBy(0, -12));
    } catch {}
  }, []);

  React.useEffect(() => {
    // Only lock page scroll when the half/half UI is truly in an overlay (meal deal compact)
    if (!compactUiMode) return;
    ppLockBodyScroll();
    return () => ppUnlockBodyScroll();
  }, [compactUiMode]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(max-width: 1023.98px)");
    const onChange = (event) => setIsNarrowScreen(event.matches);
    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else mql.addListener(onChange);
    setIsNarrowScreen(mql.matches);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", onChange);
      else mql.removeListener(onChange);
    };
  }, []);

  // Mobile: always start Half & Half at the very top (prevents spawning mid pizza list)
  React.useEffect(() => {
    if (!isNarrowScreen) return;

    const hardTop = () => {
      try {
        // Main scroll container on mobile (THIS is the one that matters)
        panelScrollRef.current?.scrollTo?.({ top: 0, left: 0, behavior: "auto" });
        if (panelScrollRef.current) panelScrollRef.current.scrollTop = 0;
      } catch {}

      try {
        // Defensive: inner body ref (sometimes used by older code paths)
        halfBodyRef.current?.scrollTo?.({ top: 0, left: 0, behavior: "auto" });
        if (halfBodyRef.current) halfBodyRef.current.scrollTop = 0;
      } catch {}

      try {
        // Defensive: modal panel wrapper (in case the browser scrolls it)
        const modalPanel = document.querySelector(".pp-halfhalf-modal__panel");
        modalPanel?.scrollTo?.({ top: 0, left: 0, behavior: "auto" });
        if (modalPanel) modalPanel.scrollTop = 0;
      } catch {}
    };

    // Run twice to beat layout/image settling
    const r1 = requestAnimationFrame(hardTop);
    const t1 = window.setTimeout(hardTop, 60);

    return () => {
      try { cancelAnimationFrame(r1); } catch {}
      try { window.clearTimeout(t1); } catch {}
    };
  }, [isNarrowScreen]);


  const resetHalf = React.useCallback(
    (side) => {
      if (side === "A") {
        setHalfA(null);
        setPendingHalfA(null);
      } else {
        setHalfB(null);
        setPendingHalfB(null);
      }
      // If the editor is open for this side, close it.
      if (halfEditorSide === side) {
        setHalfEditorItem(null);
        setHalfEditorSide(null);
        setHalfEditorInitialModal(null);
        setHalfEditorSuppressPanel(false);
      }
      setHalfSelectionSide(side);
      if (isNarrowScreen) {
        const next = !halfA ? "A" : !halfB ? "B" : "CONFIRM";
        wizardStepRef.current = next;
        setWizardStep(next);
      }
    },
    [halfEditorSide, isNarrowScreen, halfA, halfB],
  );

  // --- Size handling for Half & Half builder ---
  const collectSizesFor = React.useCallback((source) => {
    if (!source) return [];

    if (Array.isArray(source.rawSizes) && source.rawSizes.length) {
      return source.rawSizes;
    }

    if (Array.isArray(source.sizes) && source.sizes.length) {
      return source.sizes.map((entry, idx) =>
        typeof entry === "object"
          ? entry
          : {
              id: entry || `size-${idx}`,
              name: entry || `Option ${idx + 1}`,
              ref: normalizeMenuSizeRef(entry || `Option ${idx + 1}`),
            },
      );
    }

    return [];
  }, []);

  const halfSizeOptions = React.useMemo(() => {
    const all = [...collectSizesFor(halfA), ...collectSizesFor(halfB)];
    if (!all.length) return [];

    const seen = new Set();
    const deduped = [];

    all.forEach((entry, idx) => {
      if (!entry) return;
      const baseLabel =
        entry.name || entry.label || entry.id || getSizeSourceId(entry) || "";
      const normalizedLabel =
        typeof baseLabel === "string" && baseLabel.trim().length
          ? normalizeMenuSizeRef(baseLabel)
          : "";
      const fallbackKey =
        normalizedLabel ||
        (typeof entry.ref === "string" && entry.ref.trim().length
          ? normalizeMenuSizeRef(entry.ref)
          : "") ||
        (typeof entry.id === "string" && entry.id.trim().length
          ? normalizeMenuSizeRef(entry.id)
          : "");
      const key = fallbackKey || `SIZE-${idx}`;
      if (seen.has(key)) return;
      seen.add(key);
      deduped.push(entry);
    });

    return deduped;
  }, [halfA, halfB, collectSizesFor]);

  const allowedHHSizeSet = React.useMemo(
    () => _halfHalfAllowedSizeSet(menuData),
    [menuData],
  );

  const [selectedSizeKey, setSelectedSizeKey] = React.useState("LARGE");

  const defaultSizeRefs = React.useMemo(() => {
    const inOrder = ["REGULAR", "LARGE", "FAMILY", "PARTY"];
    const filtered = inOrder.filter((k) =>
      allowedHHSizeSet.has(normalizeAddonSizeRef(k)),
    );
    return filtered.length ? filtered : ["LARGE", "FAMILY", "PARTY"];
  }, [allowedHHSizeSet]);

  const lockedNorm = lockedSizeRef ? normalizeAddonSizeRef(lockedSizeRef) : null;

  const sizeSelectorOptions = React.useMemo(() => {
    const source = halfSizeOptions.length ? halfSizeOptions : defaultSizeRefs;

    const opts = source.map((sizeOrLabel, idx) => {
      const label =
        typeof sizeOrLabel === "string"
          ? sizeOrLabel
          : sizeOrLabel.name ||
            sizeOrLabel.label ||
            sizeOrLabel.id ||
            getSizeSourceId(sizeOrLabel) ||
            `Option ${idx + 1}`;

      const key = label;

      const refValueSource =
        typeof sizeOrLabel === "string"
          ? sizeOrLabel
          : sizeOrLabel.ref ||
            normalizeMenuSizeRef(label) ||
            normalizeMenuSizeRef(getSizeSourceId(sizeOrLabel) || label) ||
            label ||
            "Default";

      return {
        id:
          (typeof sizeOrLabel === "string" ? sizeOrLabel : sizeOrLabel.id) ||
          key ||
          `size-${idx}`,
        key,
        label,
        refValue:
          typeof refValueSource === "string"
            ? refValueSource.toUpperCase()
            : "DEFAULT",
      };
    });

    const allowedFiltered = opts.filter((o) => {
      const token = o.refValue || o.key || o.label || "Default";
      return allowedHHSizeSet.has(normalizeAddonSizeRef(token));
    });

    const lockedFiltered = lockedNorm
      ? allowedFiltered.filter(
          (o) =>
            normalizeAddonSizeRef(o.refValue || o.key || o.label) === lockedNorm,
        )
      : allowedFiltered;

    return lockedFiltered;
  }, [halfSizeOptions, defaultSizeRefs, lockedNorm, allowedHHSizeSet]);

  const hasDynamicSizeOptions = halfSizeOptions.length > 0;

  const getCurrentSizeToken = React.useCallback(() => {
    if (lockedNorm) return lockedNorm;
    if (sizeSelectorOptions.length) {
      return (
        selectedSizeKey ||
        sizeSelectorOptions[0]?.key ||
        sizeSelectorOptions[0]?.label ||
        "Default"
      );
    }
    return sizeRef || "Default";
  }, [sizeSelectorOptions, selectedSizeKey, sizeRef, lockedNorm]);

  const activeSizeLabel = React.useMemo(() => {
    if (halfSizeOptions.length) {
      const match = halfSizeOptions.find((size, idx) => {
        const label =
          size.name ||
          size.label ||
          size.id ||
          getSizeSourceId(size) ||
          `Option ${idx + 1}`;
        return label === selectedSizeKey;
      });

      if (match) {
        return (
          match.name ||
          match.label ||
          match.id ||
          getSizeSourceId(match) ||
          "Half & Half"
        );
      }
    }

    if (selectedItem?.size) {
      return (
        selectedItem.size.name ||
        selectedItem.size.ref ||
        selectedItem.size.id ||
        null
      );
    }

    return null;
  }, [halfSizeOptions, selectedSizeKey, selectedItem]);

  React.useEffect(() => {
    const labelFor = (entry) =>
      entry?.name ||
      entry?.label ||
      entry?.id ||
      getSizeSourceId(entry) ||
      "Default";

    if (lockedNorm) {
      if (halfSizeOptions.length) {
        const lockedMatch = halfSizeOptions.find((size) => {
          const label = labelFor(size);
          const refCandidate =
            size.ref ||
            normalizeMenuSizeRef(label) ||
            normalizeMenuSizeRef(getSizeSourceId(size) || label) ||
            label ||
            "Default";
          return normalizeAddonSizeRef(refCandidate) === lockedNorm;
        });
        const key = lockedMatch ? labelFor(lockedMatch) : lockedNorm;
        setSelectedSizeKey(key);
      } else {
        setSelectedSizeKey(lockedNorm);
      }
      setSizeRef(lockedNorm);
      return;
    }

    if (!halfSizeOptions.length) {
      setSelectedSizeKey("LARGE");
      setSizeRef("LARGE");
      return;
    }

    const allowedHalfSizeOptions = halfSizeOptions.filter((size) => {
      const label =
        size?.name || size?.label || size?.id || getSizeSourceId(size) || "Default";
      const refCandidate =
        size?.ref ||
        normalizeMenuSizeRef(label) ||
        normalizeMenuSizeRef(getSizeSourceId(size) || label) ||
        label ||
        "Default";
      return allowedHHSizeSet.has(normalizeAddonSizeRef(refCandidate));
    });

    const pool = allowedHalfSizeOptions.length
      ? allowedHalfSizeOptions
      : halfSizeOptions;

    const preferredLarge = pool.find((size) => {
      const label = labelFor(size);
      return (
        typeof label === "string" && label.toUpperCase().includes("LARGE")
      );
    });

    const defaultChoice =
      preferredLarge ||
      defaultSize({ sizes: pool }) ||
      pool[0];

    const key = labelFor(defaultChoice);
    setSelectedSizeKey(key);

    const derivedRef =
      defaultChoice.ref ||
      normalizeMenuSizeRef(key) ||
      normalizeMenuSizeRef(getSizeSourceId(defaultChoice) || key) ||
      key ||
      "LARGE";

    if (typeof derivedRef === "string") {
      setSizeRef(derivedRef.toUpperCase());
    }
  }, [halfSizeOptions, lockedNorm, setSizeRef, allowedHHSizeSet]);

  const applyHalfEditorResult = React.useCallback(
    (itemsToAdd, isGlutenFree, addOnSelections = []) => {
      const base =
        halfEditorItem ||
        (halfEditorSide === "A" ? pendingHalfA : pendingHalfB);
      if (!base) return;

      const firstEntry =
        Array.isArray(itemsToAdd) && itemsToAdd.length > 0
          ? itemsToAdd[0]
          : null;
      const sizePayload = firstEntry?.size;
      const qtyPayload = firstEntry?.qty;

      const resolveSizeRecord = () => {
        if (sizePayload) return sizePayload;
        if (base.size) return base.size;
        const match =
          Array.isArray(halfSizeOptions) && halfSizeOptions.length
            ? halfSizeOptions.find((s) => {
                const key =
                  s.name ||
                  s.label ||
                  s.id ||
                  getSizeSourceId(s) ||
                  "Default";
                return key === selectedSizeKey;
              })
            : null;
        if (match) return makeSizeRecord(match, "Regular");
        return { id: "half_half_size", name: "Half & Half" };
      };

      const enriched = {
        ...base,
        size: resolveSizeRecord(),
        qty: qtyPayload || base.qty || 1,
        isGlutenFree: !!isGlutenFree,
        add_ons: (addOnSelections || []).map((opt) => ({ ...opt })),
        removedIngredients:
          halfEditorItem?.removedIngredients ||
          base.removedIngredients ||
          [],
      };

      if (halfEditorSide === "A") {
        setHalfA(enriched);
        setPendingHalfA(enriched);
      } else if (halfEditorSide === "B") {
        setHalfB(enriched);
        setPendingHalfB(enriched);
      }

      if (halfEditorSide === "A") {
        setHalfSelectionSide("B");
      }
    },
    [
      halfEditorItem,
      halfEditorSide,
      pendingHalfA,
      pendingHalfB,
      halfSizeOptions,
      selectedSizeKey,
    ],
  );

  // Resolve pizza image (explicit image first, fallback to generated asset)
  const resolveHalfImage = React.useCallback((p) => {
    const target = p?.product || p;
    if (!target) return getProductImageUrl({ name: "Half & Half" });
    const normalizedTarget = typeof target === "string" ? { name: target } : target;
    return (
      getProductImageUrl(normalizedTarget) ||
      getProductImageUrl({ name: normalizedTarget?.name }) ||
      getProductImageUrl({ name: "Half & Half" })
    );
  }, []);

  const svgSizeLabel = ((sizeRef || selectedSizeKey) || "").toLowerCase();
  const pizzaStageSize = svgSizeLabel || "regular";

  // Half/Half hero pizza model sizing (responds to ALL sizes).
  // We keep the stage capped for mobile, and use scale for visual size changes.
  let hhHeroScale = 1;
  if (svgSizeLabel.includes("party")) {
    hhHeroScale = 1.28;
  } else if (svgSizeLabel.includes("family")) {
    hhHeroScale = 1.2;
  } else if (svgSizeLabel.includes("large")) {
    hhHeroScale = 1.1;
  } else if (svgSizeLabel.includes("mini") || svgSizeLabel.includes("small")) {
    hhHeroScale = 0.88;
  }

  // Slightly smaller base stage in meal-deal overlay so it fits; scale still reflects selection.
  const hhStageCssSize = `min(78vw, ${compactUi ? 280 : 320}px)`;

  const pizzaOptions = React.useMemo(() => {
    if (!Array.isArray(menuItems)) return [];

    return menuItems.filter((p) => {
      if (!p) return false;
      if (p.id === "half_half") return false;

      const isPizzaType =
        p.__categoryType === "pizza" ||
        p.category === "Pizza";
      if (!isPizzaType) return false;

      if (p.__categoryRef === "MINI_PIZZAS") return false;

      if (p.allowHalf === false) return false;

      return true;
    });
  }, [menuItems]);
  const filteredPizzaOptions = React.useMemo(() => pizzaOptions, [pizzaOptions]);

  const HH_GLOW_PAD = 10; // viewBox units of padding for glow (try 12-14 if needed)
  const hhViewBox = `${-HH_GLOW_PAD} ${-HH_GLOW_PAD} ${100 + HH_GLOW_PAD * 2} ${100 + HH_GLOW_PAD * 2}`;

  const price = React.useMemo(() => {
    // No price until both halves are chosen
    if (!halfA || !halfB) return 0;

    const getPriceCentsForSize = (prod, sizeKey) => {
      if (!prod) return 0;
      const key = sizeKey || "Default";

      // Prefer size-specific price map (REGULAR/LARGE/FAMILY/PARTY)
      if (prod.priceCents && typeof prod.priceCents === "object") {
        if (Number.isFinite(prod.priceCents[key])) return prod.priceCents[key];
        if (Number.isFinite(prod.priceCents.Default)) return prod.priceCents.Default;
      }

      // Fallbacks for older shapes
      if (Number.isFinite(prod.minPriceCents)) return prod.minPriceCents;
      if (Number.isFinite(prod.price_cents)) return prod.price_cents;
      if (Number.isFinite(prod.price)) return prod.price;

      // Last-ditch helper if defined
      if (typeof getBasePriceCents === "function") {
        const base = getBasePriceCents(prod);
        if (Number.isFinite(base)) return base;
      }

      return 0;
    };

    const centsA = getPriceCentsForSize(halfA, selectedSizeKey);
    const centsB = getPriceCentsForSize(halfB, selectedSizeKey);

    const currentSizeToken = getCurrentSizeToken() || selectedSizeKey || "Default";
    const normalizedSizeRef = normalizeAddonSizeRef(currentSizeToken);

    const addOnTotal = (half) => {
      if (!half || !Array.isArray(half.add_ons) || !half.add_ons.length) {
        return 0;
      }
      return (
        calcExtrasCentsForSize(half.add_ons, normalizedSizeRef, menuData) || 0
      );
    };

    const totalA = centsA + addOnTotal(halfA);
    const totalB = centsB + addOnTotal(halfB);

    const basePrice = Math.max(totalA, totalB);

    const isLarge = (normalizedSizeRef || "").toString().toUpperCase() === "LARGE";
    const aGf = halfA ? getGfSurchargeCentsForProduct(halfA, menuData) : 0;
    const bGf = halfB ? getGfSurchargeCentsForProduct(halfB, menuData) : 0;
    const gfUpchargeCents = isHalfGlutenFree && isLarge ? Math.max(aGf, bGf) : 0;

    const hhSurchargeCents = Math.max(
      _lookupHalfHalfSurchargeCents(menuItems, halfA || pendingHalfA),
      _lookupHalfHalfSurchargeCents(menuItems, halfB || pendingHalfB),
    );

    return basePrice + gfUpchargeCents + hhSurchargeCents;
  }, [
    halfA,
    halfB,
    pendingHalfA,
    pendingHalfB,
    selectedSizeKey,
    menuData,
    menuItems,
    getCurrentSizeToken,
    isHalfGlutenFree,
  ]);

  const summarizeHalf = React.useCallback(
    (half) => {
      if (!half) {
        return {
          addOnNames: [],
          removedNames: [],
          addOnsCents: 0,
        };
      }

      const sizeToken = getCurrentSizeToken() || selectedSizeKey || "Default";
      const sizeRefNorm = normalizeAddonSizeRef(sizeToken);

      const addOnNames = Array.isArray(half.add_ons)
        ? half.add_ons
            .map((o) => o?.name || o?.ref || "")
            .filter(Boolean)
        : [];

      const removedNames = Array.isArray(half.removedIngredients)
        ? half.removedIngredients.filter(Boolean)
        : [];

      const addOnsCents =
        Array.isArray(half.add_ons) && half.add_ons.length
          ? (calcExtrasCentsForSize(half.add_ons, sizeRefNorm, menuData) || 0)
          : 0;

      return { addOnNames, removedNames, addOnsCents };
    },
    [getCurrentSizeToken, selectedSizeKey, menuData],
  );

  const fmtList = (arr, max = 4) => {
    const list = Array.isArray(arr) ? arr.filter(Boolean) : [];
    if (!list.length) return "";
    if (list.length <= max) return list.join(", ");
    return `${list.slice(0, max).join(", ")} +${list.length - max} more`;
  };

  const sumA = React.useMemo(() => summarizeHalf(halfA), [summarizeHalf, halfA]);
  const sumB = React.useMemo(() => summarizeHalf(halfB), [summarizeHalf, halfB]);

  const handleAdd = () => {
    if (!halfA || !halfB) return;

    const currentSizeToken = getCurrentSizeToken() || selectedSizeKey || "Default";
    const normalizedSizeRef = normalizeAddonSizeRef(currentSizeToken);
    const isLarge = (normalizedSizeRef || "").toString().toUpperCase() === "LARGE";
    const hhSurchargeCents = Math.max(
      _lookupHalfHalfSurchargeCents(menuItems, halfA),
      _lookupHalfHalfSurchargeCents(menuItems, halfB),
    );

    // Construct a synthetic "Half & Half" item and send it through the same pipeline
    const halfHalfItem = {
      id: "half_half_custom",
      name: "Half & Half Custom",
      isHalfHalf: true,
      category: "Pizza",
      description: `Half ${halfA.name} / Half ${halfB.name}`,
      halfA,
      halfB,
      isGlutenFree: isHalfGlutenFree && isLarge,
      qty: halfQty,
      // price is in cents, based on the more expensive half plus GF upcharge
      price_cents: price,
      price: price,
      halfHalfSurchargeCents: hhSurchargeCents,
      size: (() => {
        const match =
          Array.isArray(halfSizeOptions) && halfSizeOptions.length
            ? halfSizeOptions.find((s) => {
                const key =
                  s.name ||
                  s.label ||
                  s.id ||
                  getSizeSourceId(s) ||
                  "Default";
                return key === selectedSizeKey;
              })
            : null;

        if (match) {
          return makeSizeRecord(match, "Regular");
        }

        return { id: "half_half_size", name: "Half & Half" };
      })(),
    };

    onAddItemToOrder(halfHalfItem);
    setSelectedItem(null);
  };

  const handlePizzaSelect = React.useCallback(
    (e, pizza) => {
      if (e) e.stopPropagation();
      if (!pizza) return;

      const sizeToken =
        pizza.size || getCurrentSizeToken() || selectedSizeKey || "Default";
      const sizeRecord = makeSizeRecord(sizeToken, "Large");

      const base = {
        ...pizza,
        qty: 1,
        size: sizeRecord,
        add_ons: [],
        removedIngredients: [],
      };

      if (isNarrowScreen) {
        const stepNow = wizardStepRef.current || wizardStep;

        // Always fill the step we are currently on (never rely on halfSelectionSide)
        if (stepNow === "A") {
          setHalfSelectionSide("A");
          wizardStepRef.current = "B";
          setWizardStep("B");

          setPendingHalfA(base);
          setHalfA(base);

          // Move focus to Pizza 2.
          setHalfSelectionSide("B");
          return;
        }

        if (stepNow === "B") {
          setHalfSelectionSide("B");
          wizardStepRef.current = "CONFIRM";
          setWizardStep("CONFIRM");

          setPendingHalfB(base);
          setHalfB(base);

          // Default to showing Pizza 1 as active once both are chosen.
          setHalfSelectionSide("A");

          // Jump up so the confirm view is visible
          try {
            halfBodyRef.current?.scrollTo?.({ top: 0, behavior: "smooth" });
          } catch {}
          return;
        }

        // CONFIRM step: treat taps as "replace the active half"
        if (halfSelectionSide === "B") {
          setPendingHalfB(base);
          setHalfB(base);
        } else {
          setPendingHalfA(base);
          setHalfA(base);
        }
        return;
      }

      if (halfSelectionSide === "A") {
        setPendingHalfA(base);
        setHalfA(base);
        setHalfSelectionSide("B");
      } else {
        setPendingHalfB(base);
        setHalfB(base);
        setHalfSelectionSide("A");
      }

      // never open ItemDetailPanel on selection
      setHalfEditorItem(null);
      setHalfEditorSide(null);
      setHalfEditorInitialModal(null);
      setHalfEditorSuppressPanel(false);
    },
    [
      halfSelectionSide,
      isNarrowScreen,
      wizardStep,
      getCurrentSizeToken,
      selectedSizeKey,
      scrollToHalfOptions,
    ],
  );

  const openHalfEditorForSide = React.useCallback(
    (side, modal) => {
      const base =
        side === "A" ? halfA || pendingHalfA : halfB || pendingHalfB;
      if (!base) return;

      const sizeToken =
        base.size ||
        getCurrentSizeToken() ||
        base?.size?.id ||
        base?.size?.name ||
        "Default";
      setHalfSelectionSide(side);
      setHalfEditorSide(side);
      setHalfEditorInitialModal(modal || null);
      setHalfEditorSuppressPanel(true);
      setHalfEditorItem({
        ...base,
        qty: base.qty || 1,
        add_ons: Array.isArray(base.add_ons)
          ? base.add_ons.map((opt) => ({ ...opt }))
          : [],
        removedIngredients: Array.isArray(base.removedIngredients)
          ? [...base.removedIngredients]
          : base.removedIngredients || [],
        size: sizeToken,
      });
    },
    [halfA, halfB, pendingHalfA, pendingHalfB, getCurrentSizeToken],
  );

  const handleQuickModalSettled = React.useCallback(() => {
    if (halfEditorItem && halfEditorSide === "A") {
      setHalfA((prev) => ({
        ...(prev || {}),
        ...halfEditorItem,
        add_ons: Array.isArray(halfEditorItem.add_ons)
          ? halfEditorItem.add_ons.map((opt) => ({ ...opt }))
          : [],
        removedIngredients: Array.isArray(halfEditorItem.removedIngredients)
          ? [...halfEditorItem.removedIngredients]
          : [],
      }));
    } else if (halfEditorItem && halfEditorSide === "B") {
      setHalfB((prev) => ({
        ...(prev || {}),
        ...halfEditorItem,
        add_ons: Array.isArray(halfEditorItem.add_ons)
          ? halfEditorItem.add_ons.map((opt) => ({ ...opt }))
          : [],
        removedIngredients: Array.isArray(halfEditorItem.removedIngredients)
          ? [...halfEditorItem.removedIngredients]
          : [],
      }));
    }

    setHalfEditorSuppressPanel(false);
    setHalfEditorItem(null);
    setHalfEditorSide(null);
    setHalfEditorInitialModal(null);
  }, [halfEditorItem, halfEditorSide, setHalfA, setHalfB]);

  React.useEffect(() => {
    if (!registerExternalPizzaApply) return;
    if (!useExternalMenuSelection) return;
    const externalHandler = (pizza) => {
      handlePizzaSelect(null, pizza);
    };

    registerExternalPizzaApply(externalHandler);
    return () => registerExternalPizzaApply(null);
  }, [registerExternalPizzaApply, useExternalMenuSelection, handlePizzaSelect]);

  const hasHalfA = React.useMemo(
    () => Boolean(halfA || pendingHalfA),
    [halfA, pendingHalfA],
  );
  const hasHalfB = React.useMemo(
    () => Boolean(halfB || pendingHalfB),
    [halfB, pendingHalfB],
  );

  const currentSizeTokenForGF =
    getCurrentSizeToken() || selectedSizeKey || "Default";
  const normalizedSizeForGF = normalizeAddonSizeRef(currentSizeTokenForGF);
  const isLargeSize =
    (normalizedSizeForGF || "").toString().toUpperCase() === "LARGE";

  const setHalfSide = React.useCallback((side) => {
    setHalfSelectionSide(side === "B" ? "B" : "A");
  }, []);

  const sideThumbStyle = React.useMemo(() => {
    return {
      transform: halfSelectionSide === "B" ? "translateX(100%)" : "translateX(0%)",
    };
  }, [halfSelectionSide]);

  // --- Half & Half CTA (keep outside JSX to avoid fragment/adjacent errors)
  const ctaPad = compactUi
    ? "0.38rem 0.50rem calc(0.38rem + env(safe-area-inset-bottom))"
    : "0.75rem 0.75rem calc(0.75rem + env(safe-area-inset-bottom))";

  const ctaBtnPad = compactUi ? "0.46rem 0.64rem" : "0.7rem 0.9rem";
  const ctaBtnFont = compactUi ? "0.8rem" : "0.9rem";

  // Only allow adding once both pizzas are picked
  const addDisabled = !halfA || !halfB;

  const mobilePickTarget =
    isNarrowScreen && wizardStep !== "CONFIRM"
      ? (wizardStep === "A" ? "LEFT" : "RIGHT")
      : (halfSelectionSide === "A" ? "LEFT" : "RIGHT");

  return (
    <div
      ref={panelScrollRef}
      className="pp-halfhalf-panel"
      data-compact={compactUi ? "1" : "0"}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        position: "relative",
        minHeight: 0,
        overflowY: singleScrollMode ? "auto" : "visible",
        WebkitOverflowScrolling: "touch",
      }}
    >
      <button
        onClick={() => setSelectedItem(null)}
        className="quantity-btn"
        style={{
          position: "absolute",
          top: "1.5rem",
          right: "1.5rem",
          zIndex: 10,
        }}
        title="Close"
      >
        &times;
      </button>

      <div
      className="detail-image-wrapper pp-halfhalf-hero"
      style={{
        width: "100%",
        flex: "0 0 auto",
        marginBottom: compactUi ? "0.35rem" : "0.75rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        boxSizing: "border-box",
        }}
      >
        <div
          className="relative pp-halfhalf-heroStage"
          data-size={pizzaStageSize}
          data-side={halfSelectionSide}
          style={
            /** @type {any} */ ({
              position: "relative",
              width: hhStageCssSize,
              height: hhStageCssSize,
              flex: "0 0 auto",
              ["--pp-hh-scale"]: hhHeroScale,
            })
          }
        >
          <svg
            width="100%"
            height="100%"
            viewBox={hhViewBox}
            className="drop-shadow-2xl pp-halfhalf-svg"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              transition: "all 0.25s ease",
              display: "block",
              overflow: "visible",
            }}
          >
            <defs>
              <radialGradient id="cheeseGrad" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#ffed90" />
                <stop offset="100%" stopColor="#f0b429" />
              </radialGradient>
              <filter id="ppHalo" x="-70%" y="-70%" width="240%" height="240%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="3.2" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <linearGradient id="ppHaloStroke" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="rgb(190,242,100)" stopOpacity="0.15" />
                <stop offset="45%" stopColor="rgb(255,255,255)" stopOpacity="0.20" />
                <stop offset="55%" stopColor="rgb(190,242,100)" stopOpacity="0.22" />
                <stop offset="100%" stopColor="rgb(190,242,100)" stopOpacity="0.14" />
              </linearGradient>
              <filter id="ppRingGlow" x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="1.2" result="blur" />
                <feColorMatrix
                  in="blur"
                  type="matrix"
                  values="
                    0 0 0 0 0.745
                    0 0 0 0 0.949
                    0 0 0 0 0.392
                    0 0 0 0.55 0"
                  result="glow"
                />
                <feMerge>
                  <feMergeNode in="glow" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              {/* Dark neon green, heavy feathering, but fades out before container edge */}
              <filter id="ppHaloDeep" x="-180%" y="-180%" width="460%" height="460%">
                {/* wide cloud */}
                <feGaussianBlur in="SourceGraphic" stdDeviation="11.5" result="b1" />

                {/* tint to dark neon green */}
                <feColorMatrix
                  in="b1"
                  type="matrix"
                  values="
                    0 0 0 0 0.00
                    0 0 0 0 0.85
                    0 0 0 0 0.18
                    0 0 0 0 0.85 0"
                  result="c1"
                />

                {/* IMPORTANT: compress alpha so the far edges die off sooner */}
                <feComponentTransfer in="c1" result="a1">
                  <feFuncA type="gamma" amplitude="1" exponent="1.65" offset="0" />
                </feComponentTransfer>

                <feComponentTransfer in="a1" result="a1dim">
                  <feFuncA type="linear" slope="0.72" intercept="0" />
                </feComponentTransfer>

                {/* extra feather */}
                <feGaussianBlur in="a1dim" stdDeviation="7.4" result="b2" />

                {/* tighter core for depth */}
                <feGaussianBlur in="SourceGraphic" stdDeviation="3.6" result="core" />
                <feColorMatrix
                  in="core"
                  type="matrix"
                  values="
                    0 0 0 0 0.00
                    0 0 0 0 0.85
                    0 0 0 0 0.18
                    0 0 0 0 0.55 0"
                  result="coreTint"
                />
                <feComponentTransfer in="coreTint" result="coreA">
                  <feFuncA type="gamma" amplitude="1" exponent="1.35" offset="0" />
                </feComponentTransfer>

                <feMerge>
                  <feMergeNode in="b2" />
                  <feMergeNode in="coreA" />
                </feMerge>
              </filter>

              {/* Feather the thin outline too (soft edge, still crisp) */}
              <filter id="ppLineFeather" x="-80%" y="-80%" width="260%" height="260%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="1.8" result="lb" />
                <feMerge>
                  <feMergeNode in="lb" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              {(halfA || pendingHalfA) && (
                <pattern
                  id="halfAImagePattern"
                  patternUnits="objectBoundingBox"
                  width="1"
                  height="1"
                >
                  <image
                    href={resolveHalfImage(halfA || pendingHalfA)}
                    x="0"
                    y="0"
                    width="100"
                    height="100"
                    preserveAspectRatio="xMidYMid slice"
                  />
                </pattern>
              )}
              {(halfB || pendingHalfB) && (
                <pattern
                  id="halfBImagePattern"
                  patternUnits="objectBoundingBox"
                  width="1"
                  height="1"
                >
                  <image
                    href={resolveHalfImage(halfB || pendingHalfB)}
                    x="0"
                    y="0"
                    width="100"
                    height="100"
                    preserveAspectRatio="xMidYMid slice"
                  />
                </pattern>
              )}
            </defs>
            <circle cx="50" cy="50" r="48" fill="#d97706" stroke="#92400e" strokeWidth="1" />
            <circle cx="50" cy="50" r="44" fill="url(#cheeseGrad)" />
            <g
              onClick={(e) => {
                e.stopPropagation();
                setHalfSelectionSide("A");
              }}
              className={[
                "pp-halfhalf-half",
                halfSelectionSide === "A" ? "is-active" : "",
              ].join(" ")}
              style={{ opacity: halfSelectionSide === "A" ? 1 : 0.78 }}
            >
              <path
                d="M50,50 L50,6 A44,44 0 0,0 50,94 Z"
                fill={halfA || pendingHalfA ? "url(#halfAImagePattern)" : "#fff"}
                fillOpacity={halfA || pendingHalfA ? "1" : "0.3"}
              />
              <path
                d="M50,50 L50,6 A44,44 0 0,0 50,94 Z"
                className={[
                  "pp-halfhalf-halfGlow",
                  halfSelectionSide === "A" ? "is-active" : "",
                ].join(" ")}
                fill="none"
                pointerEvents="none"
              />
              <path
                d="M50,50 L50,6 A44,44 0 0,0 50,94 Z"
                className={[
                  "pp-halfhalf-halfLine",
                  halfSelectionSide === "A" ? "is-active" : "",
                ].join(" ")}
                fill="none"
                pointerEvents="none"
              />
              {!halfA && !pendingHalfA && (
                <text
                  x="25"
                  y="52"
                  fontSize="4"
                  textAnchor="middle"
                  fill="#92400e"
                  fontWeight="bold"
                >
                  SELECT
                </text>
              )}
            </g>

            <g
              onClick={(e) => {
                e.stopPropagation();
                setHalfSelectionSide("B");
              }}
              className={[
                "pp-halfhalf-half",
                halfSelectionSide === "B" ? "is-active" : "",
              ].join(" ")}
              style={{ opacity: halfSelectionSide === "B" ? 1 : 0.78 }}
            >
              <path
                d="M50,50 L50,6 A44,44 0 0,1 50,94 Z"
                fill={halfB || pendingHalfB ? "url(#halfBImagePattern)" : "#fff"}
                fillOpacity={halfB || pendingHalfB ? "1" : "0.3"}
              />
              <path
                d="M50,50 L50,6 A44,44 0 0,1 50,94 Z"
                className={[
                  "pp-halfhalf-halfGlow",
                  halfSelectionSide === "B" ? "is-active" : "",
                ].join(" ")}
                fill="none"
                pointerEvents="none"
              />
              <path
                d="M50,50 L50,6 A44,44 0 0,1 50,94 Z"
                className={[
                  "pp-halfhalf-halfLine",
                  halfSelectionSide === "B" ? "is-active" : "",
                ].join(" ")}
                fill="none"
                pointerEvents="none"
              />
              {!halfB && !pendingHalfB && (
                <text
                  x="75"
                  y="52"
                  fontSize="4"
                  textAnchor="middle"
                  fill="#92400e"
                  fontWeight="bold"
                >
                  SELECT
                </text>
              )}
            </g>

            <line x1="50" y1="4" x2="50" y2="96" stroke="#fff" strokeWidth="1" strokeDasharray="2 2" />
            <circle cx="50" cy="50" r="8" fill="#fff" stroke="#d97706" strokeWidth="2" />
            <text
              x="50"
              y="50.4"
              fontSize="7.2"
              fontWeight="900"
              textAnchor="middle"
              dominantBaseline="middle"
              fill="#d97706"
            >
              &
            </text>
          </svg>
        </div>
        {isNarrowScreen && (
          <div className="pp-hh-heroHint">
            <span className="pp-hh-heroHintPill">
              {halfSelectionSide === "A" ? (
                <>
                  Editing LEFT {"\uD83D\uDC48"}
                </>
              ) : (
                <>
                  Editing RIGHT {"\uD83D\uDC49"}
                </>
              )}
            </span>
            <span className="pp-hh-heroHintSub">Tap a half to switch</span>
          </div>
        )}
      </div>

      <div
        className="detail-panel-body pp-halfhalf-body"
        ref={halfBodyRef}
        style={{
          flex: singleScrollMode ? "0 0 auto" : "1 1 auto",
          minHeight: 0,
          overflowY: singleScrollMode ? "visible" : (isNarrowScreen ? "auto" : "visible"),
          WebkitOverflowScrolling: "touch",
          paddingRight: "0.25rem",
          paddingBottom: compactUi ? "0.9rem" : "1.75rem",
        }}
      >
        {isNarrowScreen && (
          <div className="pp-hh-wizTop">
            <div className="pp-hh-wizRow">
              <div className="pp-hh-wizStep">
                {wizardStep === "A"
                  ? "Step 1 of 3"
                  : wizardStep === "B"
                  ? "Step 2 of 3"
                  : "Step 3 of 3"}
                <span className="pp-hh-wizDot">{"\u2022"}</span>
                {wizardStep === "A"
                  ? "Pick LEFT half"
                  : wizardStep === "B"
                  ? "Pick RIGHT half"
                  : "Confirm & add"}
              </div>

              <div className="pp-hh-wizGoal">
                {wizardStep === "A" ? (
                  <>
                    Pizza 1 (Left) {"\uD83D\uDC48"}
                  </>
                ) : wizardStep === "B" ? (
                  <>
                    Pizza 2 (Right) {"\uD83D\uDC49"}
                  </>
                ) : (
                  <>
                    Ready {EM.CHECK}
                  </>
                )}
              </div>
            </div>

            <div className="pp-hh-wizCards">
              <button
                type="button"
                className={[
                  "pp-hh-wizCard",
                  halfA || pendingHalfA ? "is-filled" : "is-empty",
                  halfSelectionSide === "A" ? "is-active" : "",
                ].join(" ")}
                onClick={() => {
                  setHalfSelectionSide("A");
                }}
              >
                <div className="pp-hh-wizCardTop">
                  <span className="pp-hh-wizCardTag">LEFT</span>
                  {halfA || pendingHalfA ? (
                    <span className="pp-hh-wizCheck">{"\u2713"}</span>
                  ) : null}
                </div>
                <div className="pp-hh-wizCardName">
                  {halfA?.name || pendingHalfA?.name || "Pizza 1 not selected"}
                </div>
              </button>

              <button
                type="button"
                className={[
                  "pp-hh-wizCard",
                  halfB || pendingHalfB ? "is-filled" : "is-empty",
                  halfSelectionSide === "B" ? "is-active" : "",
                ].join(" ")}
                onClick={() => {
                  setHalfSelectionSide("B");
                }}
              >
                <div className="pp-hh-wizCardTop">
                  <span className="pp-hh-wizCardTag">RIGHT</span>
                  {halfB || pendingHalfB ? (
                    <span className="pp-hh-wizCheck">{"\u2713"}</span>
                  ) : null}
                </div>
                <div className="pp-hh-wizCardName">
                  {halfB?.name || pendingHalfB?.name || "Pizza 2 not selected"}
                </div>
              </button>
            </div>

            {wizardStep !== "CONFIRM" ? (
              <div className="pp-hh-wizHint">
                Tap a pizza below to fill the{" "}
                <b>{wizardStep === "A" ? "LEFT" : "RIGHT"}</b> half.
              </div>
            ) : (
              <div className="pp-hh-wizHint">
                Both halves selected {"\u2014"} use the buttons above to edit{" "}
                {"\uD83E\uDDC5"}
                {"\uD83E\uDDC0"}
              </div>
            )}
          </div>
        )}

        {/* Size selector - pill-style controls for the Half & Half pizza size */}
        <div
          style={{
            marginTop: compactUi ? "0.45rem" : "0.85rem",
            marginBottom: compactUi ? "0.65rem" : "1.2rem",
          }}
        >
          <div
            style={{
              fontSize: "0.7rem",
              letterSpacing: "0.21em",
              textTransform: "uppercase",
              color: "#a5b4fc",
              textAlign: "center",
              marginBottom: "0.65rem",
              fontWeight: 630,
            }}
          >
            Choose size
          </div>

          <div style={{ display: "flex", justifyContent: "center" }}>
            <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.45rem",
              borderRadius: "999px",
              border: "1px solid var(--border-color)",
              background: "var(--panel)",
              padding: compactUi ? "0.35rem 0.65rem" : "0.45rem 0.85rem",
              boxShadow: "var(--shadow-card)",
            }}
          >
              {sizeSelectorOptions.map((option) => {
                const isActive = hasDynamicSizeOptions
                  ? selectedSizeKey === option.key
                  : sizeRef === option.refValue;
                const optionRefValue =
                  (option.refValue || option.key || option.label || "Default")
                    ?.toString()
                    .toUpperCase();
                const lockedByGlutenFree =
                  isHalfGlutenFree && optionRefValue !== "LARGE";
                const lockedByMealDeal =
                  lockedNorm &&
                  normalizeAddonSizeRef(optionRefValue) !== lockedNorm;
                const isDisabled = lockedByGlutenFree || lockedByMealDeal;

                return (
                  <button
                    key={option.id}
                    disabled={isDisabled}
                    aria-disabled={isDisabled}
                    type="button"
                    onClick={() => {
                      if (isDisabled) return;
                      const fallbackKey = option.key || "Default";
                      const fallbackRef = option.refValue || fallbackKey;
                      setSelectedSizeKey(fallbackKey);
                      setSizeRef(
                        typeof fallbackRef === "string"
                          ? fallbackRef.toUpperCase()
                          : "DEFAULT",
                      );
                    }}
                    style={{
                      border: "none",
                      outline: "none",
                      cursor: isDisabled ? "not-allowed" : "pointer",
                      borderRadius: "999px",
                      padding: "0.4rem 0.95rem",
                      fontSize: "0.78rem",
                      fontWeight: 730,
                      letterSpacing: "0.095em",
                      textTransform: "uppercase",
                      transition: "all 0.2s ease",
                      color: isDisabled
                        ? "var(--text-medium)"
                        : isActive
                        ? "#0f172a"
                        : "var(--text-light)",
                      background: isDisabled
                        ? "var(--panel)"
                        : isActive
                        ? "var(--brand-neon-green)"
                        : "var(--background-light)",
                      boxShadow: isDisabled
                        ? "inset 0 0 0 1px var(--border-color)"
                        : isActive
                        ? "0 0 20px rgba(190,242,100,0.82)"
                        : "inset 0 0 0 1px var(--border-color)",
                    }}
                  >
                    {typeof option.label === "string"
                      ? option.label.toLowerCase()
                      : "default"}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        {/* Half selector (slider) */}
        {!isNarrowScreen ? (
          <div
            className="pp-halfhalf-sideSwitch"
            data-active={halfSelectionSide}
            role="tablist"
            aria-label="Select half to edit"
          >
            <div className="pp-halfhalf-sideThumb" aria-hidden="true" style={sideThumbStyle} />

            <button
              type="button"
              className={[
                "pp-halfhalf-sideBtn",
                halfSelectionSide === "A" ? "is-active" : "",
              ].join(" ")}
              aria-pressed={halfSelectionSide === "A"}
              onClick={() => {
                setHalfSide("A");
                if (isNarrowScreen) scrollToHalfOptions();
              }}
              title="Edit Pizza 1 (left)"
            >
              Pizza 1 <span className="pp-halfhalf-sideMeta">Left</span>
              {hasHalfA ? <span className="pp-halfhalf-sideCheck">*</span> : null}
            </button>

            <button
              type="button"
              className={[
                "pp-halfhalf-sideBtn",
                halfSelectionSide === "B" ? "is-active" : "",
              ].join(" ")}
              aria-pressed={halfSelectionSide === "B"}
              onClick={() => {
                setHalfSide("B");
                if (isNarrowScreen) scrollToHalfOptions();
              }}
              title="Edit Pizza 2 (right)"
            >
              Pizza 2 <span className="pp-halfhalf-sideMeta">Right</span>
              {hasHalfB ? <span className="pp-halfhalf-sideCheck">*</span> : null}
            </button>
          </div>
        ) : null}
        {!isNarrowScreen || wizardStep === "CONFIRM" ? (
          <div className="pp-hh-detailsCard">
          <div className="pp-hh-detailsHeader">
            <div className="pp-hh-detailsTitle">Half &amp; Half</div>
            <div className="pp-hh-detailsSub">
              {halfA && halfB
                ? `${halfA.name} / ${halfB.name}`
                : "Select both halves to continue"}
            </div>
          </div>

          <div className="pp-hh-sharedCard">
            <div
              style={{
                fontSize: "0.74rem",
                letterSpacing: "0.13em",
                textTransform: "uppercase",
                color: "#c4b5fd",
                marginBottom: "0.5rem",
              }}
            >
              Shared settings
            </div>
            <div
              style={{
                display: "flex",
                gap: "0.8rem",
                flexWrap: "wrap",
                alignItems: "stretch",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setIsHalfGlutenFree((prev) => {
                    const next = !prev;
                    if (next) {
                      setSelectedSizeKey("LARGE");
                      setSizeRef("LARGE");
                    }
                    return next;
                  });
                }}
                className={[
                  "pp-hh-gfToggle",
                  isHalfGlutenFree ? "is-on" : "",
                ].join(" ")}
                style={{ flex: "1 1 220px" }}
                title="Applies gluten free base to the full pizza"
              >
                {isHalfGlutenFree
                  ? "Gluten free base (ON)"
                  : "Gluten free base (Large only)"}
              </button>

              <div className="pp-hh-qtyRow" style={{ flex: "1 1 200px" }}>
                <div className="pp-hh-qtyLabel">Quantity</div>
                <button
                  type="button"
                  onClick={() => setHalfQty((q) => (q > 1 ? q - 1 : 1))}
                  className="pp-hh-qtyBtn"
                >
                  -
                </button>
                <div className="pp-hh-qtyValue">{halfQty}</div>
                <button
                  type="button"
                  onClick={() => setHalfQty((q) => (q < 99 ? q + 1 : q))}
                  className="pp-hh-qtyBtn"
                >
                  +
                </button>
              </div>
            </div>
          </div>

          <div className="pp-hh-halvesGrid">
            <section
              className={`pp-hh-halfCol ${halfSelectionSide === "A" ? "is-active" : ""}`}
            >
              <div className="pp-hh-halfHeader">
                <div className="pp-hh-halfLabel">Pizza 1</div>
                {halfSelectionSide === "A" ? (
                  <span className="pp-hh-activePill">Active</span>
                ) : (
                  <span />
                )}
              </div>

              <div className="pp-hh-halfName">
                {halfA ? halfA.name : "No pizza selected"}
              </div>
              <div className="pp-hh-halfDesc">
                {halfA?.description || "Pick Pizza 1 from the Half & Half menu."}
              </div>
              <div className="pp-hh-verify">
                <div className="pp-hh-verifyRow">
                  <span className="pp-hh-chip pp-hh-chip--addons">
                    ✅ Add-ons: {sumA.addOnNames.length ? fmtList(sumA.addOnNames) : "None"}
                    {sumA.addOnsCents > 0 ? ` (+${currency(sumA.addOnsCents)})` : ""}
                  </span>
                </div>
                <div className="pp-hh-verifyRow">
                  <span className="pp-hh-chip pp-hh-chip--removed">
                    🚫 Removed: {sumA.removedNames.length ? fmtList(sumA.removedNames) : "None"}
                  </span>
                </div>
              </div>

              <div className="pp-hh-actions">
                <button
                  type="button"
                  onClick={() => openHalfEditorForSide("A", "ingredients")}
                  disabled={!hasHalfA}
                  className="pp-hh-actionBtn pp-hh-actionBtn--neutral"
                >
                  🧅 Edit ingredients
                </button>
                <button
                  type="button"
                  onClick={() => openHalfEditorForSide("A", "addons")}
                  disabled={!hasHalfA}
                  className="pp-hh-actionBtn pp-hh-actionBtn--warn"
                >
                  🧀 Add-ons
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (typeof onRequestChangeHalf === "function") {
                      onRequestChangeHalf("A");
                      return;
                    }
                    resetHalf("A");
                    if (isNarrowScreen) {
                      try {
                        scrollToHalfOptions();
                      } catch {}
                    }
                    if (!allowInlinePicker) {
                      try {
                        scrollToHalfOptions();
                      } catch {}
                    }
                  }}
                  disabled={!hasHalfA}
                  className="pp-hh-actionBtn pp-hh-actionBtn--neutral"
                >
                  🔁 Change pizza
                </button>
                <button
                  type="button"
                  onClick={() => resetHalf("A")}
                  disabled={!hasHalfA}
                  className="pp-hh-actionBtn pp-hh-actionBtn--danger"
                >
                  🗑️ Reset half
                </button>
              </div>
            </section>

            <div className="pp-hh-divider" aria-hidden="true" />

            <section
              className={`pp-hh-halfCol pp-hh-halfCol--right ${
                halfSelectionSide === "B" ? "is-active" : ""
              }`}
            >
              <div className="pp-hh-halfHeader">
                {halfSelectionSide === "B" ? (
                  <span className="pp-hh-activePill">Active</span>
                ) : (
                  <span />
                )}
                <div className="pp-hh-halfLabel">Pizza 2</div>
              </div>

              <div className="pp-hh-halfName">
                {halfB ? halfB.name : "No pizza selected"}
              </div>
              <div className="pp-hh-halfDesc">
                {halfB?.description || "Pick Pizza 2 from the Half & Half menu."}
              </div>
              <div className="pp-hh-verify">
                <div className="pp-hh-verifyRow">
                  <span className="pp-hh-chip pp-hh-chip--addons">
                    ✅ Add-ons: {sumB.addOnNames.length ? fmtList(sumB.addOnNames) : "None"}
                    {sumB.addOnsCents > 0 ? ` (+${currency(sumB.addOnsCents)})` : ""}
                  </span>
                </div>
                <div className="pp-hh-verifyRow">
                  <span className="pp-hh-chip pp-hh-chip--removed">
                    🚫 Removed: {sumB.removedNames.length ? fmtList(sumB.removedNames) : "None"}
                  </span>
                </div>
              </div>

              <div className="pp-hh-actions">
                <button
                  type="button"
                  onClick={() => openHalfEditorForSide("B", "ingredients")}
                  disabled={!hasHalfB}
                  className="pp-hh-actionBtn pp-hh-actionBtn--neutral"
                >
                  🧅 Edit ingredients
                </button>
                <button
                  type="button"
                  onClick={() => openHalfEditorForSide("B", "addons")}
                  disabled={!hasHalfB}
                  className="pp-hh-actionBtn pp-hh-actionBtn--warn"
                >
                  🧀 Add-ons
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (typeof onRequestChangeHalf === "function") {
                      onRequestChangeHalf("B");
                      return;
                    }
                    resetHalf("B");
                    if (isNarrowScreen) {
                      try {
                        scrollToHalfOptions();
                      } catch {}
                    }
                    if (!allowInlinePicker) {
                      try {
                        scrollToHalfOptions();
                      } catch {}
                    }
                  }}
                  disabled={!hasHalfB}
                  className="pp-hh-actionBtn pp-hh-actionBtn--neutral"
                >
                  🔁 Change pizza
                </button>
                <button
                  type="button"
                  onClick={() => resetHalf("B")}
                  disabled={!hasHalfB}
                  className="pp-hh-actionBtn pp-hh-actionBtn--danger"
                >
                  🗑️ Reset half
                </button>
              </div>
            </section>
          </div>
        </div>
        ) : null}
        
          <div
            ref={halfOptionsRef}
            style={{
              borderTop: "1px solid rgba(148,163,184,0.2)",
              paddingTop: "1.25rem",
            }}
          >
            {allowInlinePicker && (
              <>
                {isNarrowScreen && (
                  <div className="pp-hh-mobileBanner">
                    {wizardStep !== "CONFIRM" ? (
                      <>
                        <div className="pp-hh-mobileBanner__title">
                          {wizardStep === "A"
                            ? "1️⃣ Select Pizza 1 (Left) 🍕"
                            : "2️⃣ Select Pizza 2 (Right) 🍕"}
                        </div>
                        <div className="pp-hh-mobileBanner__sub">
                          {wizardStep === "A"
                            ? "Tap a pizza below to fill the LEFT half."
                            : "Tap a pizza below to fill the RIGHT half."}
                        </div>

                        {wizardStep === "B" && (
                          <button
                            type="button"
                            className="pp-hh-mobileBanner__back"
                            onClick={() => {
                              // Go back to step A and clear A (so it truly restarts step A)
                              wizardStepRef.current = "A";
                              setWizardStep("A");
                              resetHalf("A");
                            }}
                          >
                            ⬅️ Back to Pizza 1
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <div className="pp-hh-mobileBanner__title">
                          ✅ Confirm Half & Half
                        </div>
                        <div className="pp-hh-mobileBanner__sub">
                          Review your halves above. Use "Change" buttons to adjust.
                        </div>
                        <button
                          type="button"
                          className="pp-hh-mobileBanner__back"
                          onClick={() => {
                            // Restart the whole wizard
                            wizardStepRef.current = "A";
                            setWizardStep("A");
                            resetHalf("A");
                            resetHalf("B");
                          }}
                        >
                          🔁 Start over
                        </button>
                      </>
                    )}
                  </div>
                )}

                {/* Desktop header stays as-is */}
                {!isNarrowScreen && (
                  <div
                    style={{
                      fontSize: "0.65rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.18em",
                      color: "#a5b4fc",
                      marginBottom: "0.75rem",
                    }}
                  >
                    {`Choose pizza for ${halfSelectionSide === "A" ? "Pizza 1" : "Pizza 2"}`}
                  </div>
                )}

                {/* Show the list when: desktop OR mobile step is A/B */}
                {(!isNarrowScreen || wizardStep !== "CONFIRM") && (
                  <div
                    className={[
                      "pp-halfhalf-options",
                      isNarrowScreen ? "pp-hh-pickGrid" : "",
                    ].join(" ")}
                  >
                    {(isNarrowScreen ? filteredPizzaOptions : pizzaOptions).map((p) => {
                      const isSelected =
                        halfA?.id === p.id ||
                        pendingHalfA?.id === p.id ||
                        halfB?.id === p.id ||
                        pendingHalfB?.id === p.id;

                      const img = getProductImageUrl(p);

                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={(e) => handlePizzaSelect(e, p)}
                          className={[
                            "pp-halfhalf-option",
                            isNarrowScreen ? "pp-hh-pickCard" : "",
                            isSelected ? "pp-halfhalf-option--selected is-selected" : "",
                          ].join(" ")}
                          aria-label={`Select ${p.name} for the ${mobilePickTarget} half`}
                        >
                          {isNarrowScreen ? (
                            <>
                              <div className="pp-hh-pickThumbWrap" aria-hidden="true">
                                <img className="pp-hh-pickThumb" src={img} alt="" />
                                <div className="pp-hh-pickBadge">
                                  Fills {mobilePickTarget}{" "}
                                  {mobilePickTarget === "LEFT"
                                    ? "\uD83D\uDC48"
                                    : "\uD83D\uDC49"}
                                </div>
                              </div>

                              <div className="pp-hh-pickBody">
                                <div className="pp-hh-pickName">{p.name}</div>
                                <div className="pp-hh-pickDesc">{p.description}</div>

                                <div className="pp-hh-pickRow">
                                  <span className="pp-hh-pickHint">
                                    {isSelected ? "Already chosen" : "Tap to select"}
                                  </span>

                                  <span className="pp-hh-pickAction">
                                    {isSelected ? "Replace \u267B" : "Add \u2795"}
                                  </span>
                                </div>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="pp-halfhalf-option__text">
                                <div className="pp-halfhalf-option__name">{p.name}</div>
                                <div className="pp-halfhalf-option__desc">{p.description}</div>
                              </div>
                              <div className="pp-halfhalf-option__plus">+</div>
                            </>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}

              </>
            )}
          </div>
        </div>

      <div
        className="pp-halfhalf-cta"
        style={{
          position: "relative",
          marginTop: compactUi ? "6px" : "10px",
          padding: ctaPad,
          borderTop: "1px solid rgba(148,163,184,0.18)",
        }}
      >
        <button
          type="button"
          onClick={handleAdd}
          disabled={addDisabled}
          className="place-order-button"
          style={{
            opacity: addDisabled ? 0.5 : 1,
            cursor: addDisabled ? "not-allowed" : "pointer",
            padding: ctaBtnPad,
            fontSize: ctaBtnFont,
            lineHeight: 1.15,
            whiteSpace: "normal",
          }}
        >
          Add Half & Half
        </button>
      </div>

      {halfEditorItem && (
        isNarrowScreen ? (
          <div className="pp-hh-editorModal" role="dialog" aria-modal="true">
            <div
              className="pp-hh-editorModal__backdrop"
              onClick={() => {
                setHalfEditorItem(null);
                setHalfEditorSide(null);
                setHalfEditorInitialModal(null);
                setHalfEditorSuppressPanel(false);
              }}
            />
            <div className="pp-hh-editorModal__panel">
              <ItemDetailPanel
                item={halfEditorItem}
                menuData={menuData}
                onClose={() => {
                  // No base panel shown (suppressBasePanel=true), but TS requires onClose.
                  // If user taps outside, we already close via the backdrop.
                }}
                editingIndex={null}
                editingItem={halfEditorItem}
                onSaveIngredients={(newRemoved) => {
                  setHalfEditorItem((prev) =>
                    prev ? { ...prev, removedIngredients: newRemoved || [] } : prev,
                  );
                }}
                onApplyAddOns={(newAddOns) => {
                  setHalfEditorItem((prev) =>
                    prev ? { ...prev, add_ons: newAddOns || [] } : prev,
                  );
                }}
                initialModal={halfEditorInitialModal}
                suppressBasePanel={true}
                onModalsSettled={handleQuickModalSettled}
                forcedPriceSizeRef={getCurrentSizeToken()}
                compactHalfMode
                lockQty
              />
            </div>
          </div>
        ) : (
          <ItemDetailPanel
            item={halfEditorItem}
            menuData={menuData}
            onClose={() => {
              // No base panel shown (suppressBasePanel=true), but TS requires onClose.
              // If user taps outside, we already close via the backdrop.
            }}
            editingIndex={null}
            editingItem={halfEditorItem}
            onSaveIngredients={(newRemoved) => {
              setHalfEditorItem((prev) =>
                prev ? { ...prev, removedIngredients: newRemoved || [] } : prev,
              );
            }}
            onApplyAddOns={(newAddOns) => {
              setHalfEditorItem((prev) =>
                prev ? { ...prev, add_ons: newAddOns || [] } : prev,
              );
            }}
            initialModal={halfEditorInitialModal}
            suppressBasePanel={true}
            onModalsSettled={handleQuickModalSettled}
            forcedPriceSizeRef={getCurrentSizeToken()}
            compactHalfMode
            lockQty
          />
        )
      )}
    </div>
  );
};
// --- END RESTORED COMPONENT ---

// ------------------------------
// Meal Deal Builder (bundle UI)
// ------------------------------
const MEAL_SLOT_LABELS = {
  pizza: "Pizza",
  drink: "Drink",
  dessert: "Dessert",
  side: "Side",
  calzone: "Calzone",
  pasta: "Pasta",
};
// Emoji rendered via Unicode escapes (prevents "??" if a file is saved with a bad encoding).
const EM = {
  MEAL: "\uD83C\uDF71",        // bento
  PLUS: "\u2795",              // plus
  CART: "\uD83D\uDED2",        // cart
  RECEIPT: "\uD83E\uDDFE",     // receipt
  PARTY: "\uD83C\uDF89",       // party
  PENCIL: "\u270F\uFE0F",      // pencil
  CHECK: "\u2705",             // check
  DOTS: "\u2026",              // ellipsis
  PUZZLE: "\uD83E\uDDE9",      // puzzle
  CROWN: "\uD83D\uDC51",       // crown
};
const MEAL_SLOT_EMOJI = {
  pizza: "\uD83C\uDF55",     // pizza
  drink: "\uD83E\uDD64",     // drink
  dessert: "\uD83C\uDF70",   // dessert
  side: "\uD83E\uDD56",      // side
  pasta: "\uD83C\uDF5D",     // pasta
  calzone: "\uD83E\uDD5F",   // calzone
};
const slotEmojiFor = (step) => {
  const key = String(step?.slotKey || "").toLowerCase();
  return MEAL_SLOT_EMOJI[key] || EM.PUZZLE;
};

function _prettySizeToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return "";
  const t = raw.toLowerCase();
  if (t === "no_size" || t === "no size") return "No size";
  if (t === "regular") return "Regular";
  if (t === "large") return "Large";
  if (t === "family") return "Family";
  if (t === "party") return "Party";
  if (t === "mini") return "Mini";
  return raw;
}

function _slotKey(slot) {
  return String(slot?.slot || slot?.type || slot?.choice || "item")
    .trim()
    .toLowerCase();
}

function _slotAllowedSizes(slot) {
  const allowed =
    (Array.isArray(slot?.allowed_sizes) && slot.allowed_sizes) ||
    (Array.isArray(slot?.allowedSizes) && slot.allowedSizes) ||
    [];
  if (allowed.length) return allowed;
  if (slot?.size) return [slot.size];
  return [];
}

function _expandBundleSlots(slots) {
  const steps = [];
  (slots || []).forEach((slot, slotIdx) => {
    const qty = Math.max(1, Number(slot?.qty || 1));
    for (let i = 0; i < qty; i++) {
      const key = _slotKey(slot);
      const labelBase =
        MEAL_SLOT_LABELS[key] ||
        key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

      const allowedSizes = _slotAllowedSizes(slot);
      const sizeHint = allowedSizes.length ? ` (${_prettySizeToken(allowedSizes[0])})` : "";

      const label = qty > 1 ? `${labelBase} ${i + 1}${sizeHint}` : `${labelBase}${sizeHint}`;

      steps.push({
        slot,
        slotIdx,
        idxInSlot: i,
        qtyInSlot: qty,
        key: `${key}-${slotIdx}-${i}`,
        label,
        slotKey: key,
      });
    }
  });
  return steps;
}

function _flattenMenuProducts(menuData) {
  const cats = menuData?.categories || [];
  const out = [];
  cats.forEach((c) => (c?.items || []).forEach((p) => out.push(p)));
  return out;
}

function _restrictItemToSlotSizes(preparedItem, slot) {
  const allowed = _slotAllowedSizes(slot);
  if (!preparedItem || !allowed.length) return preparedItem;

  const allowedSet = new Set(allowed.map((s) => normalizeAddonSizeRef(s)));
  const rawSizes = Array.isArray(preparedItem.rawSizes) ? preparedItem.rawSizes : [];
  if (!rawSizes.length) return preparedItem;

  const filtered = rawSizes.filter((sz) => {
    const id = getSizeSourceId(sz) || sz?.name || "";
    const norm = normalizeAddonSizeRef(id);
    return allowedSet.has(norm);
  });

  if (!filtered.length) return preparedItem;

  return {
    ...preparedItem,
    rawSizes: filtered,
    sizes: filtered.map((s) => s?.name || getSizeSourceId(s) || "Default"),
  };
}

function _computeBundleExtrasCents(bundleItems, menuData) {
  let cents = 0;
  (bundleItems || []).forEach((bi) => {
    if (!bi) return;
    const sizeToken =
      bi?.size?.id || bi?.size?.ref || bi?.size?.name || "Default";
    const sizeRef = normalizeAddonSizeRef(sizeToken);
    const addOns = Array.isArray(bi.add_ons) ? bi.add_ons : [];
    let extraCents = calcExtrasCentsForSize(addOns, sizeRef, menuData) || 0;

    if (bi.isHalfHalf && (bi.halfA || bi.halfB)) {
      const a = Array.isArray(bi?.halfA?.add_ons) ? bi.halfA.add_ons : [];
      const b = Array.isArray(bi?.halfB?.add_ons) ? bi.halfB.add_ons : [];
      const aC = calcExtrasCentsForSize(a, sizeRef, menuData) || 0;
      const bC = calcExtrasCentsForSize(b, sizeRef, menuData) || 0;
      // Match your half/half pricing behavior: charge the higher side only
      extraCents += Math.max(aC, bC);
    }

    cents += extraCents;

    const isLarge = normalizeProductSizeRef(sizeRef) === "LARGE";
    if (bi.isGlutenFree && isLarge) {
      let gfCents = getGfSurchargeCentsForProduct(bi, menuData);
      if (bi.isHalfHalf && (bi.halfA || bi.halfB)) {
        const a = bi.halfA ? getGfSurchargeCentsForProduct(bi.halfA, menuData) : 0;
        const b = bi.halfB ? getGfSurchargeCentsForProduct(bi.halfB, menuData) : 0;
        gfCents = Math.max(a, b);
      }
      cents += gfCents;
    }

    if (bi.isHalfHalf) {
      const s = Number(bi.halfHalfSurchargeCents);
      if (Number.isFinite(s) && s > 0) cents += s;
    }
  });
  return cents;
}

function _filterMenuDataForMealStep(menuData, step, opts = {}) {
  if (!menuData || !Array.isArray(menuData.categories) || !step?.slot) return menuData;

  const slot = step.slot || {};
  const catRefs = Array.isArray(slot.category_refs) ? slot.category_refs : [];
  const catSet = new Set(catRefs.map((s) => String(s).toUpperCase()));

  const prodRefs = Array.isArray(slot.product_refs) ? slot.product_refs : [];
  const prodSet = new Set(prodRefs.map((s) => String(s)));

  const contains = slot?.baseline?.productNameContains;
  const needle = contains ? String(contains).toLowerCase() : "";

  const search = String(opts.search || "").trim().toLowerCase();
  const activeCat = String(opts.activeCategoryRef || "").toUpperCase();
  const hideHalfHalf = !!opts.hideHalfHalf;

  const categories = (menuData.categories || [])
    .filter((cat) => {
      const ref = String(cat?.ref || cat?.id || "").toUpperCase();
      if (!ref) return false;
      if (activeCat && ref !== activeCat) return false;
      if (!catSet.size) return true;
      return catSet.has(ref);
    })
    .map((cat) => {
      let items = Array.isArray(cat?.items) ? cat.items.filter(Boolean) : [];
      items = items.filter((p) => p?.enabled !== false);
      items = items.filter(
        (p) => !(p?.bundle && Array.isArray(p.bundle.slots) && p.bundle.slots.length),
      );
      if (hideHalfHalf) {
        items = items.filter(
          (p) => !(p?.id === "half_half" || p?.isHalfHalf === true),
        );
      }
      if (prodSet.size) items = items.filter((p) => prodSet.has(String(p?.id)));
      if (needle) items = items.filter((p) => String(p?.name || "").toLowerCase().includes(needle));
      if (search) items = items.filter((p) => String(p?.name || "").toLowerCase().includes(search));

      return { ...cat, items };
    })
    .filter((cat) => Array.isArray(cat?.items) && cat.items.length > 0);

  return { ...(menuData || {}), categories };
}

// ------------------------------
// Half & Half: ONLY show eligible pizzas in the main menu while the builder is open
// ------------------------------
function _halfHalfAllowedSizeSet(menuData) {
  const api = (menuData && (menuData.raw || menuData)) || {};
  const globals = api.globals || {};
  const settings = api.settings || {};

  // Prefer settings if present; otherwise fall back to globals; otherwise default.
  const rawSizes =
    (Array.isArray(settings.half_allowed_sizes) && settings.half_allowed_sizes) ||
    (Array.isArray(settings.halfHalfSizes) && settings.halfHalfSizes) ||
    (Array.isArray(globals.halfHalfSizes) && globals.halfHalfSizes) ||
    ["large", "family", "party"];

  // menu.json may include "regular", but Half & Half must not allow it.
  const normalized = rawSizes
    .map((s) => normalizeAddonSizeRef(s))
    .filter((s) => s && s !== "REGULAR");

  const fallback = ["LARGE", "FAMILY", "PARTY"].map((s) => normalizeAddonSizeRef(s));
  return new Set(normalized.length ? normalized : fallback);
}

function _productHasAnyAllowedHalfHalfSize(product, allowedSizeSet) {
  if (!product) return false;
  const candidates = [];

  // skus: { name|size }
  if (Array.isArray(product.skus)) {
    product.skus.forEach((sku) => candidates.push(sku?.size || sku?.name));
  }

  // sizes can be strings or objects depending on stage in the pipeline
  if (Array.isArray(product.sizes)) {
    product.sizes.forEach((s) => {
      if (typeof s === "string") candidates.push(s);
      else candidates.push(s?.size || s?.name || s?.id || s?.ref);
    });
  }

  // priceCents keys often mirror sizes too
  if (product.priceCents && typeof product.priceCents === "object") {
    Object.keys(product.priceCents).forEach((k) => candidates.push(k));
  }

  return candidates
    .filter(Boolean)
    .some((token) => allowedSizeSet.has(normalizeAddonSizeRef(token)));
}

function _filterMenuDataForHalfHalf(menuData) {
  if (!menuData || !Array.isArray(menuData.categories)) return menuData;

  const allowedSizeSet = _halfHalfAllowedSizeSet(menuData);

  const categories = (menuData.categories || [])
    .map((cat) => {
      const ref = String(cat?.ref || cat?.id || "").toUpperCase();
      if (!ref) return null;

      // Match the same rule you already use for click-routing: must be a real pizza category (not mini).
      if (!ref.endsWith("_PIZZAS")) return null;
      if (ref === "MINI_PIZZAS") return null;

      const catAllowHalf = cat?.allowHalf ?? cat?.allow_half ?? undefined;

      const items = (cat.items || [])
        .filter(Boolean)
        .filter((p) => p?.enabled !== false)
        .filter((p) => {
          const allowHalf = p?.allowHalf ?? p?.allow_half ?? catAllowHalf;
          if (allowHalf === false) return false; // explicit "no"
          return _productHasAnyAllowedHalfHalfSize(p, allowedSizeSet);
        });

      if (!items.length) return null;
      return { ...cat, items };
    })
    .filter(Boolean);

  return { ...(menuData || {}), categories };
}

const MealDealBuilderPanel = ({
  item,
  menuData,
  prepareItemForPanel,
  editingIndex,
  onCommit,
  onCancel,
  registerExternalMealItemApply,
  onMenuFilterChange,
  isMobile: isMobileProp = false,
  onCommitAndReview = null,
}) => {
  const [isViewportMobile, setIsViewportMobile] = React.useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return !!isMobileProp;
    return window.matchMedia("(max-width: 1023.98px)").matches;
  });

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(max-width: 1023.98px)");
    const onChange = (e) => setIsViewportMobile(!!e.matches);

    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else mql.addListener(onChange);

    setIsViewportMobile(!!mql.matches);

    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", onChange);
      else mql.removeListener(onChange);
    };
  }, []);

  const isMobile = typeof window === "undefined" ? !!isMobileProp : isViewportMobile;
  const [halfHalfMode, setHalfHalfMode] = React.useState(null); // "mobile" | "desktop" | null
  const halfHalfOpenMobile = halfHalfMode === "mobile";
  const halfHalfOpenDesktop = halfHalfMode === "desktop";
  const openHalfHalfForView = React.useCallback(() => {
    setHalfHalfMode(isMobile ? "mobile" : "desktop");
  }, [isMobile]);
  const closeHalfHalf = React.useCallback(() => {
    setHalfHalfMode(null);
  }, []);
  const slots = Array.isArray(item?.bundle?.slots) ? item.bundle.slots : [];
  const steps = React.useMemo(() => _expandBundleSlots(slots), [slots]);

  const [activeStep, setActiveStep] = React.useState(0);
  const [search, setSearch] = React.useState("");
  const [editorItem, setEditorItem] = React.useState(null);
  const [editorForcedSizeRef, setEditorForcedSizeRef] = React.useState(null);
  const [halfHalfSeed, setHalfHalfSeed] = React.useState(null);
  const [hhMealStage, setHhMealStage] = React.useState("review"); // "pick" | "review"
  const [hhMealPickSide, setHhMealPickSide] = React.useState("A"); // "A" | "B"
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const halfHalfApplyPizzaRef = React.useRef(null);
  const [activeCategoryRef, setActiveCategoryRef] = React.useState(null);
  const listRef = React.useRef(null);
  const registerExternalMealHalfHalfPizzaApply = React.useCallback((fnOrNull) => {
    halfHalfApplyPizzaRef.current = fnOrNull || null;
  }, []);

  const existingBundle = Array.isArray(item?.bundle_items) ? item.bundle_items : [];

  const [bundleItems, setBundleItems] = React.useState(() => {
    const init = Array(steps.length).fill(null);
    for (let i = 0; i < Math.min(init.length, existingBundle.length); i++) {
      init[i] = existingBundle[i] || null;
    }
    return init;
  });

  React.useEffect(() => {
    const init = Array(steps.length).fill(null);
    const existing = Array.isArray(item?.bundle_items) ? item.bundle_items : [];
    for (let i = 0; i < Math.min(init.length, existing.length); i++) {
      init[i] = existing[i] || null;
    }
    setBundleItems(init);
    setActiveStep(0);
    setSearch("");
    setEditorItem(null);
    setEditorForcedSizeRef(null);
    setHalfHalfSeed(null);
    setHhMealStage("review");
    setHhMealPickSide("A");
    setActiveCategoryRef(null);
    setPickerOpen(false);
  }, [item?.id, steps.length]);

  const allProducts = React.useMemo(() => _flattenMenuProducts(menuData), [menuData]);

  const resolveMealDealChosenBg = React.useCallback(
    (chosen) => {
      if (!chosen) return "";

      // Half & Half: use one of the halves if present, otherwise the Half & Half image
      if (chosen.isHalfHalf || String(chosen.id || "").includes("half_half")) {
        const h = chosen.halfA || chosen.halfB || "Half & Half";
        return getProductImageUrl(typeof h === "string" ? { name: h } : h);
      }

      // Normal item: prefer the real product (has image filename), fallback to name slug
      const prod =
        allProducts.find((p) => String(p?.id) === String(chosen.id)) ||
        allProducts.find((p) => String(p?.name) === String(chosen.name)) ||
        null;

      return getProductImageUrl(prod || { name: chosen.name || chosen.id });
    },
    [allProducts],
  );

  const step = steps[activeStep] || null;
  const inferMealPizzaSizeFromDeal = React.useCallback(() => {
    const text = [
      item?.description || "",
      ...(Array.isArray(item?.ingredients) ? item.ingredients : []),
    ]
      .join(" ")
      .toLowerCase();

    if (text.includes("party")) return "PARTY";
    if (text.includes("family")) return "FAMILY";
    if (text.includes("large")) return "LARGE";
    if (text.includes("regular")) return "REGULAR";
    return null;
  }, [item?.description, item?.ingredients]);

  const getForcedSizeForStep = React.useCallback((s) => {
    const allowed = _slotAllowedSizes(s?.slot);
    if (allowed.length) return normalizeMenuSizeRef(allowed[0]);

    if (String(s?.slotKey || "").toLowerCase() === "pizza") {
      const inferred = inferMealPizzaSizeFromDeal();
      if (inferred) return inferred;
    }

    return null;
  }, [inferMealPizzaSizeFromDeal]);

  const hhAllowedForThisStep = React.useMemo(() => {
    if (!step) return false;

    // Only relevant for pizza slots
    const slotKey = String(step.slotKey || "").toLowerCase();
    if (slotKey !== "pizza") return false;

    // Half/Half allowed sizes from menu.json (helper excludes REGULAR)
    const hhSet = _halfHalfAllowedSizeSet(menuData);

    // If the step forces a single size, use it; otherwise use all allowed sizes
    const forced = getForcedSizeForStep(step);
    const slotSizes = forced ? [forced] : _slotAllowedSizes(step.slot);

    return slotSizes.some((s) => hhSet.has(normalizeAddonSizeRef(s)));
  }, [step, menuData, getForcedSizeForStep]);

  const warnHHNotAllowed = React.useCallback(() => {
    try {
      window.alert("Half & Half isn't available for Regular-size meal deals.");
    } catch {}
  }, []);

  const forcedHalfHalfSizeRef = React.useMemo(() => {
    if (!step) return null;
    const allowed = _slotAllowedSizes(step.slot);
    if (allowed.length) return normalizeMenuSizeRef(allowed[0]);
    return null;
  }, [step]);

  const stepMenuData = React.useMemo(
    () =>
      _filterMenuDataForMealStep(menuData, step, {
        search,
        activeCategoryRef,
        hideHalfHalf: !hhAllowedForThisStep,
      }),
    [menuData, step, search, activeCategoryRef, hhAllowedForThisStep],
  );

  const halfHalfMenuRows = React.useMemo(() => {
    const cats = Array.isArray(stepMenuData?.categories) ? stepMenuData.categories : [];
    const rows = [];
    cats.forEach((cat) => {
      const catAllowHalf = cat?.allowHalf ?? cat?.allow_half ?? undefined;
      const ref = String(cat?.ref || cat?.id || "").toUpperCase();
      const isPizzaCat = ref.endsWith("_PIZZAS") && ref !== "MINI_PIZZAS";
      (cat?.items || []).forEach((item) => {
        rows.push({
          ...item,
          category: isPizzaCat ? "Pizza" : (item.category || item.categoryName || item.category),
          __categoryType: isPizzaCat ? "pizza" : (cat?.type || undefined),
          __categoryRef: ref || cat?.ref,
          allowHalf: item?.allowHalf ?? item?.allow_half ?? catAllowHalf,
        });
      });
    });
    return rows;
  }, [stepMenuData]);

  // Half/Half pick stage should show ALL eligible pizzas (not just the active meal-deal category chip)
  const hhPickBaseMenuData = React.useMemo(() => {
    return _filterMenuDataForMealStep(menuData, step, {
      search: "",
      activeCategoryRef: null,
    });
  }, [menuData, step]);

  const hhPickMenuData = React.useMemo(() => {
    return _filterMenuDataForHalfHalf(hhPickBaseMenuData);
  }, [hhPickBaseMenuData]);

  const stepCategoryOptions = React.useMemo(() => {
    const cats = Array.isArray(stepMenuData?.categories) ? stepMenuData.categories : [];
    return cats
      .map((c) => {
        const ref = String(c?.ref || c?.id || "").toUpperCase();
        if (!ref) return null;
        return {
          ref,
          name: c?.name || c?.ref || c?.id || ref,
          count: Array.isArray(c?.items) ? c.items.length : 0,
        };
      })
      .filter(Boolean);
  }, [stepMenuData]);

  React.useEffect(() => {
    if (!stepCategoryOptions.length) {
      setActiveCategoryRef(null);
      return;
    }
    setActiveCategoryRef((prev) => {
      const prevNorm = prev ? String(prev).toUpperCase() : "";
      const allowed = new Set(stepCategoryOptions.map((o) => o.ref));
      if (prevNorm && allowed.has(prevNorm)) return prevNorm;
      return stepCategoryOptions[0].ref;
    });
  }, [activeStep, item?.id, stepCategoryOptions]);

  React.useEffect(() => {
    try {
      if (listRef.current) listRef.current.scrollTop = 0;
    } catch {}
  }, [activeCategoryRef, activeStep]);

  const openEditorForProduct = React.useCallback(
    (product, stepOverride = null, stepIndexOverride = null) => {
      const s = stepOverride || step;
      const idx =
        Number.isFinite(stepIndexOverride) ? stepIndexOverride : activeStep;
      if (!product || !s) return;
      const prepared = _restrictItemToSlotSizes(
        prepareItemForPanel(product),
        s.slot,
      );
      const forced = getForcedSizeForStep(s);
      setEditorForcedSizeRef(forced);

      const existing = bundleItems[idx];
      const forcedSizes = _slotAllowedSizes(s.slot);
      const forcedSizeToken = forcedSizes.length ? forcedSizes[0] : null;

      setEditorItem({
        ...prepared,
        qty: 1,
        size:
          existing?.size ||
          forcedSizeToken ||
          prepared?.rawSizes?.[0] ||
          prepared?.sizes?.[0] ||
          "Default",
        add_ons: Array.isArray(existing?.add_ons) ? existing.add_ons.map((x) => ({ ...x })) : [],
        removedIngredients: Array.isArray(existing?.removedIngredients) ? [...existing.removedIngredients] : [],
        isGlutenFree: !!existing?.isGlutenFree,
      });
    },
    [prepareItemForPanel, step, bundleItems, activeStep, getForcedSizeForStep],
  );

  const pickProductForStep = React.useCallback(
    (product) => {
      if (!product || !step) return;

      if (
        (product.id === "half_half" || product.isHalfHalf) &&
        String(step.slotKey || "").toLowerCase() === "pizza"
      ) {
        if (!hhAllowedForThisStep) {
          warnHHNotAllowed();
          return;
        }
        setPickerOpen(false);
        setEditorItem(null);
        if (isMobile) {
          const forced = forcedHalfHalfSizeRef || getForcedSizeForStep(step) || "LARGE";
          setHalfHalfSeed({
            halfA: null,
            halfB: null,
            sizeRef: String(forced).toUpperCase(),
            isGlutenFree: false,
            qty: 1,
          });
          setHhMealPickSide("A");
          setHhMealStage("pick");
          openHalfHalfForView();
          return;
        }

        setHalfHalfSeed(null);
        setHhMealStage("review");
        openHalfHalfForView();
        return;
      }

      setPickerOpen(false);
      openEditorForProduct(product);
    },
    [
      step,
      openEditorForProduct,
      isMobile,
      openHalfHalfForView,
      forcedHalfHalfSizeRef,
      getForcedSizeForStep,
      setHhMealPickSide,
      setHhMealStage,
      hhAllowedForThisStep,
      warnHHNotAllowed,
    ],
  );

  const openEditForChosen = React.useCallback(
    (idx) => {
      const s = steps[idx];
      const chosen = bundleItems[idx];
      if (!s || !chosen) return;

      // Half & Half special case
      if (chosen.isHalfHalf || String(chosen.id || "").includes("half_half")) {
        setActiveStep(idx);
        setPickerOpen(false);
        setEditorItem(null);
        setHalfHalfSeed({
          halfA: chosen.halfA || null,
          halfB: chosen.halfB || null,
          sizeRef: (chosen.size?.ref || chosen.size?.id || chosen.size?.name || "LARGE")
            .toString()
            .toUpperCase(),
          isGlutenFree: !!chosen.isGlutenFree,
          qty: Number(chosen.qty || 1),
        });
        setHhMealStage("review");
        setHhMealPickSide("A");
        openHalfHalfForView();
        return;
      }

      // Find original product to preserve menu rules
      const prod =
        allProducts.find((p) => String(p?.id) === String(chosen.id)) ||
        allProducts.find((p) => String(p?.name) === String(chosen.name));

      setActiveStep(idx);

      if (prod) {
        openEditorForProduct(prod, s, idx);
      } else {
        // Fallback: open picker if product not found
        setPickerOpen(true);
      }
    },
    [
      steps,
      bundleItems,
      allProducts,
      openEditorForProduct,
      setActiveStep,
      setPickerOpen,
      setEditorItem,
      setHalfHalfSeed,
      setHhMealStage,
      setHhMealPickSide,
      openHalfHalfForView,
    ],
  );

  const pickHalfForMealDeal = React.useCallback(
    (menuItem) => {
      if (!menuItem || !step) return;

      const prepared = prepareItemForPanel(menuItem);
      if (!prepared) return;

      const forced = (
        forcedHalfHalfSizeRef ||
        halfHalfSeed?.sizeRef ||
        getForcedSizeForStep(step) ||
        "LARGE"
      )
        .toString()
        .toUpperCase();

      const sizeRec = makeSizeRecord(forced);

      const base = {
        ...prepared,
        qty: 1,
        size: sizeRec,
        add_ons: [],
        removedIngredients: [],
      };

      // Build the next seed synchronously so we can decide whether we still need the other half.
      const prevSeed = halfHalfSeed || { halfA: null, halfB: null, sizeRef: forced };
      const nextSeed = {
        ...prevSeed,
        sizeRef: forced,
        ...(hhMealPickSide === "A" ? { halfA: base } : { halfB: base }),
      };

      setHalfHalfSeed(nextSeed);

      // If BOTH halves exist after this pick, go straight to review/editor.
      if (nextSeed.halfA && nextSeed.halfB) {
        setHhMealPickSide("A");
        setHhMealStage("review");
        return;
      }

      // Otherwise continue picking the missing half.
      if (!nextSeed.halfA) {
        setHhMealPickSide("A");
      } else {
        setHhMealPickSide("B");
      }
      setHhMealStage("pick");
    },
    [
      prepareItemForPanel,
      step,
      hhMealPickSide,
      forcedHalfHalfSizeRef,
      halfHalfSeed,
      getForcedSizeForStep,
    ],
  );

  const applyEditorResult = React.useCallback(
    (itemsToAdd, isGlutenFree, addOnSelections = []) => {
      const first = Array.isArray(itemsToAdd) && itemsToAdd.length ? itemsToAdd[0] : null;
      if (!first || !editorItem || !step) return;

      const sizeInfo = makeSizeRecord(first.size || editorItem.size || "Default");
      const sizeRef = normalizeAddonSizeRef(sizeInfo.id || sizeInfo.name);
      const isLarge = normalizeProductSizeRef(sizeRef) === "LARGE";

      const chosen = {
        id: editorItem.id,
        name: editorItem.name,
        category_ref: editorItem.category_ref || editorItem.categoryRef,
        bundle_slot: step.slotKey,
        size: sizeInfo,
        qty: 1,
        isGlutenFree: !!isGlutenFree && isLarge,
        add_ons: (addOnSelections || []).map((opt) => ({ ...opt })),
        removedIngredients: Array.isArray(editorItem.removedIngredients)
          ? [...editorItem.removedIngredients]
          : [],
      };

      setBundleItems((prev) => {
        const next = [...prev];
        next[activeStep] = chosen;
        const nextEmpty = next.findIndex((x) => !x);
        if (nextEmpty !== -1) setActiveStep(nextEmpty);
        return next;
      });
    },
    [editorItem, step, activeStep],
  );

  const commitHalfHalfToBundleStep = React.useCallback(
    (halfHalfItem) => {
      if (!halfHalfItem || !step) return;

      // Force meal-slot sizing rules if this slot restricts size
      const forcedSizes = _slotAllowedSizes(step.slot);
      const forcedSizeToken = forcedSizes.length ? forcedSizes[0] : null;

      let sizeInfo = makeSizeRecord(halfHalfItem.size || "Default");
      if (forcedSizeToken) {
        const forced = makeSizeRecord(forcedSizeToken);
        const allowed = normalizeAddonSizeRef(forced.id || forced.name);
        const chosen = normalizeAddonSizeRef(sizeInfo.id || sizeInfo.name);
        if (allowed && chosen !== allowed) sizeInfo = forced;
      }

      const sizeRef = normalizeAddonSizeRef(sizeInfo.id || sizeInfo.name);
      const isLarge = normalizeProductSizeRef(sizeRef) === "LARGE";

      const normalizeHalf = (h) =>
        h
          ? {
              ...h,
              size: sizeInfo,
              qty: 1,
            }
          : null;

      const chosen = {
        id: halfHalfItem.id || "half_half_custom",
        name: halfHalfItem.name || "Half & Half",
        bundle_slot: step.slotKey,
        category_ref: "CUSTOM_HALF_HALF",
        size: sizeInfo,
        qty: 1,
        isGlutenFree: !!halfHalfItem.isGlutenFree && isLarge,
        add_ons: [], // root add-ons not used; halves carry their own
        removedIngredients: [],
        isHalfHalf: true,
        halfHalfSurchargeCents: Number(halfHalfItem?.halfHalfSurchargeCents) || 0,
        halfA: normalizeHalf(halfHalfItem.halfA),
        halfB: normalizeHalf(halfHalfItem.halfB),
      };

      setBundleItems((prev) => {
        const next = [...prev];
        next[activeStep] = chosen;
        const nextEmpty = next.findIndex((x) => !x);
        if (nextEmpty !== -1) setActiveStep(nextEmpty);
        return next;
      });

      closeHalfHalf();
    },
    [step, activeStep, closeHalfHalf],
  );

  React.useEffect(() => {
    if (typeof onMenuFilterChange !== "function") return;
    onMenuFilterChange({
      step,
      activeCategoryRef,
      search,
      halfHalfMode: !isMobile && !!halfHalfOpenDesktop,
      hideHalfHalf: !hhAllowedForThisStep,
    });
  }, [
    onMenuFilterChange,
    step,
    activeCategoryRef,
    search,
    isMobile,
    halfHalfOpenDesktop,
    hhAllowedForThisStep,
  ]);

  React.useEffect(() => {
    return () => {
      if (typeof onMenuFilterChange === "function") onMenuFilterChange(null);
    };
  }, [onMenuFilterChange]);

  React.useEffect(() => {
    if (!registerExternalMealItemApply) return;

    const handler = (product) => {
      if (!product || !step) return;
      if (product?.enabled === false) return;
      // Prevent opening Half & Half in meal deals that are Regular-only
      if ((product?.id === "half_half" || product?.isHalfHalf) && !hhAllowedForThisStep) {
        warnHHNotAllowed();
        return;
      }
      // If the Meal Deal -> Half & Half overlay is open, route eligible pizza clicks into it
      if (halfHalfOpenDesktop && halfHalfApplyPizzaRef.current) {
        const categoryRef = String(product.category_ref || product.categoryRef || "").toUpperCase();
        const allowedHalfSizes = _halfHalfAllowedSizeSet(menuData);
        const allowHalfFlag = (product?.allowHalf ?? product?.allow_half ?? true) !== false;
        const isPizzaForHalfHalf =
          categoryRef.endsWith("_PIZZAS") &&
          categoryRef !== "MINI_PIZZAS" &&
          allowHalfFlag &&
          _productHasAnyAllowedHalfHalfSize(product, allowedHalfSizes);

        if (isPizzaForHalfHalf) {
          const prepared = prepareItemForPanel(product);
          halfHalfApplyPizzaRef.current(prepared);
        }
        return; // don't let the meal-deal step handler consume the click
      }
      if (product?.id === "half_half" || product?.isHalfHalf) {
        // Only valid when the current slot is a pizza slot
        if (String(step.slotKey || "").toLowerCase() !== "pizza") return;
        setEditorItem(null);
        setHalfHalfSeed(null);
        openHalfHalfForView();
        return;
      }
      if (product?.bundle && Array.isArray(product.bundle.slots) && product.bundle.slots.length)
        return;

      const pCat = String(product.category_ref || product.categoryRef || "").toUpperCase();
      const activeCat = String(activeCategoryRef || "").toUpperCase();
      if (activeCat && pCat !== activeCat) return;

      const catRefs = Array.isArray(step.slot?.category_refs) ? step.slot.category_refs : [];
      if (catRefs.length) {
        const allowed = new Set(catRefs.map((s) => String(s).toUpperCase()));
        if (!allowed.has(pCat)) return;
      }

      const prodRefs = Array.isArray(step.slot?.product_refs) ? step.slot.product_refs : [];
      if (prodRefs.length) {
        const allowed = new Set(prodRefs.map((s) => String(s)));
        if (!allowed.has(String(product.id))) return;
      }

      const contains = step.slot?.baseline?.productNameContains;
      if (contains) {
        const needle = String(contains).toLowerCase();
        if (!String(product.name || "").toLowerCase().includes(needle)) return;
      }

      const q = String(search || "").trim().toLowerCase();
      if (q && !String(product.name || "").toLowerCase().includes(q)) return;

      openEditorForProduct(product);
    };

    registerExternalMealItemApply(handler);
    return () => registerExternalMealItemApply(null);
  }, [
    registerExternalMealItemApply,
    openEditorForProduct,
    step,
    activeCategoryRef,
    search,
    setEditorItem,
    openHalfHalfForView,
    halfHalfOpenDesktop,
    menuData,
    prepareItemForPanel,
    hhAllowedForThisStep,
    warnHHNotAllowed,
  ]);

  // Mobile: when meal-deal overlays are open, prevent scroll/taps leaking to the page behind.
  React.useEffect(() => {
    if (!isMobile) return;
    const open = !!pickerOpen || !!editorItem || !!halfHalfOpenMobile;
    if (!open) return;
    ppLockBodyScroll();
    return () => ppUnlockBodyScroll();
  }, [isMobile, pickerOpen, editorItem, halfHalfOpenMobile]);

  const isComplete = steps.length > 0 && bundleItems.every(Boolean);

  const baseMealCents = React.useMemo(() => minPriceCents(item) || 0, [item]);
  const extrasCents = React.useMemo(
    () => _computeBundleExtrasCents(bundleItems, menuData),
    [bundleItems, menuData],
  );
  const totalCents = baseMealCents + extrasCents;

  const filledCount = React.useMemo(
    () => (Array.isArray(bundleItems) ? bundleItems.filter(Boolean).length : 0),
    [bundleItems],
  );
  const progressPct = steps.length
    ? Math.round((filledCount / steps.length) * 100)
    : 0;
  const activeChosen = bundleItems[activeStep] || null;

  const commitMeal = () => {
    if (!isComplete) return;
    const payload = {
      ...item,
      qty: 1,
      size: { id: "Default", name: "Default", ref: normalizeMenuSizeRef("Default") },
      price: totalCents / 100,
      price_cents: totalCents,
      add_ons: [],
      removedIngredients: [],
      bundle_items: bundleItems.map((x) => ({ ...x })),
      __bundle_editing_index: editingIndex ?? null,
    };
    onCommit?.(payload);
  };

  if (!slots.length) {
    return (
      <div style={{ padding: "1rem" }}>
        <h3 className="panel-title">{item?.name || "Meal deal"}</h3>
        <p style={{ color: "var(--text-medium)" }}>
          This item has no bundle slots in menu.json.
        </p>
        <button type="button" className="simple-button" onClick={onCancel}>
          Close
        </button>
      </div>
    );
  }

  const overlays = (
    <>
      {isMobile && pickerOpen && (
        <div
          className="pp-mealpick"
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10050,
            background: "rgba(2, 6, 23, 0.72)",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
            display: "flex",
            flexDirection: "column",
            padding:
              "calc(0.85rem + env(safe-area-inset-top)) 0 calc(0.85rem + env(safe-area-inset-bottom))",
          }}
          onClick={() => setPickerOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              flex: "1 1 auto",
              minHeight: 0,
              paddingInline: "0.9rem",
              boxSizing: "border-box",
              width: "100%",
              maxWidth: 980,
              margin: "0 auto",
            }}
          >
            <div
              style={{
                height: "100%",
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                borderRadius: 18,
                background: "var(--pp-surface, var(--panel))",
                border: "1px solid var(--border-color)",
                boxShadow: "var(--shadow-modal)",
                overflow: "hidden",
              }}
            >
              <div className="pp-mealpick__head">
                <div>
                  <div className="pp-mealpick__title">Choose item</div>
                  <div className="pp-mealpick__sub">{step?.label || ""}</div>
                </div>

                <button
                  type="button"
                  className="simple-button"
                  style={{ width: "auto", paddingInline: "1rem" }}
                  onClick={() => setPickerOpen(false)}
                >
                  Back
                </button>
              </div>

              <div
                className="pp-mealpick__body"
                style={{
                  flex: "1 1 auto",
                  minHeight: 0,
                  overflowY: "auto",
                  WebkitOverflowScrolling: "touch",
                }}
              >
                {stepCategoryOptions.length > 1 && (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "0.4rem",
                      marginBottom: "0.65rem",
                    }}
                  >
                    {stepCategoryOptions.map((cat) => {
                      const isActive =
                        String(activeCategoryRef || "").toUpperCase() === cat.ref;
                      return (
                        <button
                          key={cat.ref}
                          type="button"
                          className="simple-button"
                          style={{
                            width: "auto",
                            padding: "0.35rem 0.65rem",
                            borderRadius: "999px",
                            fontSize: "0.8rem",
                            fontWeight: 800,
                            border: isActive
                              ? "1px solid rgba(190,242,100,0.65)"
                              : "1px solid var(--border-color)",
                            background: isActive
                              ? "rgba(190,242,100,0.10)"
                              : "var(--panel)",
                          }}
                          onClick={() => setActiveCategoryRef(cat.ref)}
                        >
                          {cat.name}
                        </button>
                      );
                    })}
                  </div>
                )}

                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search items..."
                  style={{ width: "100%", marginBottom: "0.85rem" }}
                />

                <div className="pp-mealpick__grid">
                  {(stepMenuData?.categories || []).flatMap((cat) =>
                    (cat.items || []).map((p) => {
                      if (!p) return null;
                      if (!hhAllowedForThisStep && (p.id === "half_half" || p.isHalfHalf))
                        return null;
                      const img = getProductImageUrl(p);
                      return (
                        <div
                          key={p.id || `${cat.ref}-${p.name}`}
                          className="pp-mealpick__card"
                          onClick={() => pickProductForStep(p)}
                          role="button"
                          tabIndex={0}
                        >
                          <img className="pp-mealpick__img" src={img} alt={p.name} />
                          <div className="pp-mealpick__meta">
                            <div className="pp-mealpick__name">{p.name}</div>
                            <div className="pp-mealpick__desc">{p.description}</div>
                          </div>
                        </div>
                      );
                    }),
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {editorItem && (
        <div
          className={
            "pp-md-editorOverlay " + (isMobile ? "" : "pp-md-editorOverlay--inpanel")
          }
          style={
            isMobile
              ? {
                  position: "fixed",
                  inset: 0,
                  zIndex: 10060,
                  background: "rgba(2, 6, 23, 0.72)",
                  backdropFilter: "blur(4px)",
                  WebkitBackdropFilter: "blur(4px)",
                  display: "flex",
                  alignItems: "stretch",
                  justifyContent: "center",
                  padding:
                    "calc(0.85rem + env(safe-area-inset-top)) 0 calc(0.85rem + env(safe-area-inset-bottom))",
                }
              : undefined
          }
          onClick={(e) => {
            if (isMobile && e.target === e.currentTarget) {
              setEditorItem(null);
              setEditorForcedSizeRef(null);
              return;
            }
            e.stopPropagation();
          }}
        >
          <div
            className={
              "pp-md-editorShell " + (isMobile ? "" : "pp-md-editorShell--inpanel")
            }
            style={
              isMobile
                ? {
                    width: "100%",
                    maxWidth: 980,
                    margin: "0 auto",
                    paddingInline: "0.9rem",
                    boxSizing: "border-box",
                    height: "100%",
                    minHeight: 0,
                    display: "flex",
                  }
                : undefined
            }
            onClick={(e) => e.stopPropagation()}
          >
            {isMobile ? (
              <div
                style={{
                  height: "100%",
                  width: "100%",
                  minHeight: 0,
                  borderRadius: 18,
                  background: "var(--pp-surface, var(--panel))",
                  border: "1px solid var(--border-color)",
                  boxShadow: "var(--shadow-modal)",
                  overflow: "hidden",
                }}
              >
                <ItemDetailPanel
                  item={editorItem}
                  menuData={menuData}
                  editingIndex={null}
                  editingItem={editorItem}
                  variant="mealdeal_pick"
                  lockQty
                  forcedPriceSizeRef={
                    editorForcedSizeRef
                      ? normalizeMenuSizeRef(editorForcedSizeRef)
                      : null
                  }
                  lockSize={Boolean(editorForcedSizeRef)}
                  primaryActionLabel={
                    bundleItems[activeStep]
                      ? `${EM.CHECK} Update selection`
                      : `${EM.CHECK} Confirm selection`
                  }
                  onSaveIngredients={(newRemoved) => {
                    setEditorItem((prev) =>
                      prev ? { ...prev, removedIngredients: newRemoved || [] } : prev,
                    );
                  }}
                  onApplyAddOns={(newAddOns) => {
                    setEditorItem((prev) =>
                      prev ? { ...prev, add_ons: newAddOns || [] } : prev,
                    );
                  }}
                  onClose={(itemsToAdd, isGlutenFree, addOnSelections = []) => {
                    if (itemsToAdd && itemsToAdd.length > 0) {
                      applyEditorResult(itemsToAdd, isGlutenFree, addOnSelections);
                    }
                    setEditorItem(null);
                    setEditorForcedSizeRef(null);
                  }}
                />
              </div>
            ) : (
              <ItemDetailPanel
                item={editorItem}
                menuData={menuData}
                editingIndex={null}
                editingItem={editorItem}
                variant="mealdeal_pick"
                lockQty
                forcedPriceSizeRef={
                  editorForcedSizeRef
                    ? normalizeMenuSizeRef(editorForcedSizeRef)
                    : null
                }
                lockSize={Boolean(editorForcedSizeRef)}
                primaryActionLabel={
                  bundleItems[activeStep]
                    ? `${EM.CHECK} Update selection`
                    : `${EM.CHECK} Confirm selection`
                }
                onSaveIngredients={(newRemoved) => {
                  setEditorItem((prev) =>
                    prev ? { ...prev, removedIngredients: newRemoved || [] } : prev,
                  );
                }}
                onApplyAddOns={(newAddOns) => {
                  setEditorItem((prev) =>
                    prev ? { ...prev, add_ons: newAddOns || [] } : prev,
                  );
                }}
                onClose={(itemsToAdd, isGlutenFree, addOnSelections = []) => {
                  if (itemsToAdd && itemsToAdd.length > 0) {
                    applyEditorResult(itemsToAdd, isGlutenFree, addOnSelections);
                  }
                  setEditorItem(null);
                  setEditorForcedSizeRef(null);
                }}
              />
            )}
          </div>
        </div>
      )}

      {!isMobile && halfHalfOpenDesktop && (
        <div
          className="pp-md-hhOverlay--inpanel"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeHalfHalf();
          }}
          role="dialog"
          aria-modal="true"
        >
          <div className="pp-md-hhShell--inpanel" onClick={(e) => e.stopPropagation()}>
            <HalfAndHalfSelector
              menuItems={halfHalfMenuRows}
              menuData={menuData}
              selectedItem={HALF_HALF_FORCED_ITEM}
              setSelectedItem={(v) => {
                if (v == null) closeHalfHalf();
              }}
              registerExternalPizzaApply={registerExternalMealHalfHalfPizzaApply}
              useExternalMenuSelection
              hidePizzaPicker
              initialHalfA={halfHalfSeed?.halfA || null}
              initialHalfB={halfHalfSeed?.halfB || null}
              initialSizeRef={
                (forcedHalfHalfSizeRef || halfHalfSeed?.sizeRef || "LARGE")
                  .toString()
                  .toUpperCase()
              }
              initialIsGlutenFree={!!halfHalfSeed?.isGlutenFree}
              initialQty={Number(halfHalfSeed?.qty || 1)}
              lockedSizeRef={forcedHalfHalfSizeRef}
              onAddItemToOrder={(hh) => commitHalfHalfToBundleStep(hh)}
            />
          </div>
        </div>
      )}

      {halfHalfOpenMobile && (
        <div
          style={
            isMobile
              ? {
                  position: "fixed",
                  inset: 0,
                  zIndex: 10120,
                  background: "var(--pp-surface, var(--panel))",
                  display: "flex",
                  flexDirection: "column",
                }
              : {
                  position: "fixed",
                  inset: 0,
                  zIndex: 10120,
                  background: "rgba(2, 6, 23, 0.72)",
                  backdropFilter: "blur(4px)",
                  WebkitBackdropFilter: "blur(4px)",
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "center",
                  padding: "1.2rem 1rem",
                }
          }
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className={
              "order-panel-container pp-mealdeal-halfhalf " +
              (isMobile ? "pp-mealdeal-halfhalf--full" : "")
            }
            style={
              isMobile
                ? {
                    width: "100%",
                    height: "100dvh",
                    minHeight: "100vh",
                    maxWidth: "100%",
                    margin: 0,
                    borderRadius: 0,
                    padding: "1rem",
                    background: "var(--pp-surface, var(--panel))",
                    border: "none",
                    boxShadow: "none",
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                  }
                : {
                    width: "95%",
                    maxWidth: 760,
                    margin: "0 auto",
                    position: "relative",
                    height: "88vh",
                    maxHeight: "88vh",
                    minHeight: 0,
                    overflow: "auto",
                    padding: "1.05rem 1.2rem",
                    borderRadius: "22px",
                    background: "var(--pp-surface)",
                    border: "1px solid var(--border-color)",
                    boxShadow: "var(--shadow-modal)",
                    display: "flex",
                    flexDirection: "column",
                  }
            }
            onClick={(e) => e.stopPropagation()}
          >
            {isMobile && hhMealStage === "pick" ? (
              <div className="pp-hh-mealPick">
                <div className="pp-hh-pickNotice" style={{ margin: 0 }}>
                  <div className="pp-hh-pickNotice__top">
                    <div>
                      <div className="pp-hh-pickNotice__kicker">
                        {"\uD83C\uDF55"} Half & Half {"\u2014"} Selection Mode
                      </div>
                      <div className="pp-hh-pickNotice__title">
                        Pick <b>two</b> pizzas for your meal deal
                      </div>
                    </div>

                    <button
                      type="button"
                      className="pp-hh-pickNotice__exit"
                      onClick={() => {
                        closeHalfHalf();
                        setHalfHalfSeed(null);
                        setHhMealPickSide("A");
                        setHhMealStage("review");
                      }}
                    >
                      {"\u2715"} Exit
                    </button>
                  </div>

                  <div className="pp-hh-pickNotice__stepRow">
                    <div className="pp-hh-pickNotice__stepPill">
                      Step {hhMealPickSide === "A" ? "1" : "2"} / 2
                    </div>
                    <div className="pp-hh-pickNotice__nextPill">
                      Next:{" "}
                      <b>
                        {hhMealPickSide === "A"
                          ? `Pizza 1 (Left) ${"\uD83D\uDC48"}`
                          : `Pizza 2 (Right) ${"\uD83D\uDC49"}`}
                      </b>
                    </div>
                  </div>

                  <div className="pp-hh-pickNotice__progress" aria-hidden="true">
                    <div
                      className={[
                        "pp-hh-pickNotice__seg",
                        halfHalfSeed?.halfA ? "is-done" : "is-active",
                      ].join(" ")}
                    />
                    <div
                      className={[
                        "pp-hh-pickNotice__seg",
                        halfHalfSeed?.halfB
                          ? "is-done"
                          : hhMealPickSide === "B"
                          ? "is-active"
                          : "",
                      ].join(" ")}
                    />
                  </div>

                  <div className="pp-hh-pickNotice__hint">
                    Tap a pizza below to fill the{" "}
                    <b>{hhMealPickSide === "A" ? "LEFT" : "RIGHT"}</b> half.
                  </div>
                </div>

                <div className="pp-hh-mealPickBody">
                  <Menu
                    menuData={hhPickMenuData}
                    onItemClick={(p) => pickHalfForMealDeal(p)}
                  />
                </div>
              </div>
            ) : (
              <HalfAndHalfSelector
                menuItems={halfHalfMenuRows}
                menuData={menuData}
                selectedItem={HALF_HALF_FORCED_ITEM}
                setSelectedItem={(v) => {
                  if (v == null) {
                    closeHalfHalf();
                    setHalfHalfSeed(null);
                    setHhMealPickSide("A");
                    setHhMealStage("review");
                  }
                }}
                compactUiMode={isMobile}
                initialHalfA={halfHalfSeed?.halfA || null}
                initialHalfB={halfHalfSeed?.halfB || null}
                initialSizeRef={
                  (forcedHalfHalfSizeRef || halfHalfSeed?.sizeRef || "LARGE")
                    .toString()
                    .toUpperCase()
                }
                initialIsGlutenFree={!!halfHalfSeed?.isGlutenFree}
                initialQty={Number(halfHalfSeed?.qty || 1)}
                lockedSizeRef={forcedHalfHalfSizeRef}
                registerExternalPizzaApply={
                  isMobile ? null : registerExternalMealHalfHalfPizzaApply
                }
                useExternalMenuSelection={!isMobile}
                hidePizzaPicker={!isMobile}
                onRequestChangeHalf={
                  isMobile
                    ? (side) => {
                        setHhMealStage("pick");
                        setHhMealPickSide(side === "B" ? "B" : "A");
                        setHalfHalfSeed((prev) => {
                          const next = { ...(prev || {}) };
                          if (side === "A") next.halfA = null;
                          else next.halfB = null;
                          return next;
                        });
                      }
                    : null
                }
                onAddItemToOrder={(hh) => {
                  commitHalfHalfToBundleStep(hh);
                  setHalfHalfSeed(null);
                  setHhMealPickSide("A");
                  setHhMealStage("review");
                }}
              />
            )}
          </div>
        </div>
      )}
    </>
  );

  const mobileBody = (
    <div
      className="pp-mdm"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        position: "relative",
        // The whole meal-deal editor scrolls on mobile.
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
        overscrollBehavior: "contain",
        // Keep content clear of the phone bottom safe-area.
        paddingBottom: "calc(1rem + env(safe-area-inset-bottom))",
      }}
    >
      <header className="pp-mdm-head">
        <div className="pp-mdm-kicker">{EM.MEAL} MEAL DEAL</div>
        <div className="pp-mdm-title">{item?.name || "Build your meal"}</div>

        <div className="pp-mdm-metaRow">
          <div className="pp-mdm-pill">
            {filledCount}/{steps.length} selected
          </div>
          <div className="pp-mdm-pill pp-mdm-pill--price">{currency(totalCents)}</div>
        </div>

        <div className="pp-mdm-progressTrack" aria-hidden="true">
          <div className="pp-mdm-progressFill" style={{ width: `${progressPct}%` }} />
        </div>

        <button
          type="button"
          className="quantity-btn pp-mdm-closeBtn"
          onClick={onCancel}
          title="Exit meal deal"
          aria-label="Exit meal deal"
        >
          <span aria-hidden="true" className="pp-mdm-closeIcon">&times;</span>
          <span className="pp-mdm-closeText">Exit</span>
        </button>
      </header>

      <section className="pp-mdm-next">
        {!isComplete ? (
          <>
            <div className="pp-mdm-nextTop">
              <div>
                <div className="pp-mdm-nextLabel">Next up</div>
                <div className="pp-mdm-nextSlot">{step?.label || ""}</div>
              </div>
              <div className={["pp-mdm-status", activeChosen ? "is-filled" : ""].join(" ")}>
                {activeChosen ? EM.CHECK : EM.DOTS}
              </div>
            </div>

            <div className="pp-mdm-nextValue">
              {activeChosen
                ? `${activeChosen.name} ${formatSizeSuffix(activeChosen.size)}`
                : "Not selected yet"}
            </div>

            <button
              type="button"
              className="place-order-button"
              onClick={() => setPickerOpen(true)}
              style={{ marginTop: "0.85rem" }}
            >
              {EM.PLUS} Choose {step?.label || "item"}
            </button>
          </>
        ) : (
          <>
            <div className="pp-mdm-nextTop">
              <div>
                <div className="pp-mdm-nextLabel">All done {EM.PARTY}</div>
                <div className="pp-mdm-nextSlot">Everything selected</div>
              </div>
              <div className={["pp-mdm-status", "is-filled"].join(" ")}>
                {EM.CHECK}
              </div>
            </div>

            <div className="pp-mdm-nextValue">
              Tap any item below to edit {EM.PENCIL}
            </div>
          </>
        )}
      </section>

      <section
        className="pp-mdm-list"
        style={{
          flex: "0 0 auto",
        }}
      >
        <div className="pp-mdm-listTitle">Selected so far</div>

        {steps.map((s, idx) => {
          const chosen = bundleItems[idx];
          if (!chosen) return null;
          const bg = resolveMealDealChosenBg(chosen);

          return (
            <button
              key={s.key}
              type="button"
              className={["pp-mdm-row", bg ? "pp-mdm-row--bg" : ""].join(" ")}
              style={
                bg
                  ? (/** @type {any} */ ({ ["--pp-md-row-bg"]: `url("${bg}")` }))
                  : undefined
              }
              onClick={() => openEditForChosen(idx)}
            >
              <div className="pp-mdm-rowLeft">
                <div className="pp-mdm-rowSlot">{s.label}</div>
                <div className="pp-mdm-rowValue">
                  {chosen.name} {formatSizeSuffix(chosen.size)}
                </div>
              </div>
              <div className="pp-mdm-rowRight">Change -&gt;</div>
            </button>
          );
        })}

        {!bundleItems.some(Boolean) && (
          <div className="pp-mdm-empty">
            Nothing selected yet. Start with the "Next up" button above.
          </div>
        )}
      </section>

      <div
        className="cart-total-section"
        style={{
          flex: "0 0 auto",
          paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))",
        }}
      >
        <div style={{ color: "var(--text-medium)", fontSize: "0.9rem" }}>
          Base: {currency(baseMealCents)}
          {extrasCents > 0 ? `  + extras: ${currency(extrasCents)}` : ""}
        </div>

        {!isComplete ? (
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
            <button
              type="button"
              className="simple-button"
              onClick={() => {
                const nextEmpty = bundleItems.findIndex((x) => !x);
                if (nextEmpty !== -1) {
                  setActiveStep(nextEmpty);
                  setPickerOpen(true);
                }
              }}
            >
              {EM.PLUS} Keep selecting
            </button>

            <button
              type="button"
              className="place-order-button"
              disabled
              style={{ opacity: 0.55 }}
            >
              {EM.CART} Add meal {"\u2014"} {currency(totalCents)}
            </button>
          </div>
        ) : (
          <div style={{ marginTop: "0.75rem" }}>
            <div className="pp-mdm-footerActions pp-mdm-footerActions--complete">
              <button
                type="button"
                className="place-order-button"
                onClick={commitMeal}
              >
                {EM.CART} Add meal {"\u2014"} {currency(totalCents)}
              </button>

              <button
                type="button"
                className="simple-button"
                onClick={onCancel}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {overlays}
    </div>
  );

  const desktopBody = (
    <div
      className={["pp-md-root", halfHalfOpenDesktop ? "pp-md-root--hhopen" : ""].join(" ")}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        position: "relative",
        minHeight: 0,
      }}
    >
      <header className="pp-md-head">
        <div className="pp-md-headRow">
          <div>
            <div className="pp-md-kicker">{EM.MEAL} MEAL DEAL BUILDER</div>
            <h2 className="pp-md-title">Build {item?.name} {EM.PUZZLE}</h2>
            <div className="pp-md-sub">
              Pick what's included. You can edit each item before adding.
            </div>
          </div>

          <div className="pp-md-headActions">
            <div className="pp-md-pricePill" title="Meal deal total (base + extras)">
              {currency(totalCents)}
            </div>
            <button
              type="button"
              className="quantity-btn pp-md-closeBtn"
              onClick={onCancel}
              title="Close"
              aria-label="Close"
            >
              &times;
            </button>
          </div>
        </div>

        <div className="pp-md-progress">
          <div className="pp-md-progressTrack">
            <div className="pp-md-progressFill" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="pp-md-progressMeta">
            {filledCount}/{steps.length} selected - {progressPct}%
          </div>
        </div>
      </header>

      <section className="pp-md-steps">
        {steps.map((s, idx) => {
          const chosen = bundleItems[idx];
          const active = idx === activeStep;
          const bg = chosen ? resolveMealDealChosenBg(chosen) : "";
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => {
                setActiveStep(idx);
                if (isMobile) setPickerOpen(true);
              }}
              className={[
                "pp-md-stepCard",
                bg ? "pp-md-stepCard--bg" : "",
                active ? "is-active" : "",
                chosen ? "is-filled" : "",
              ].join(" ")}
              style={
                bg
                  ? (/** @type {any} */ ({ ["--pp-md-row-bg"]: `url("${bg}")` }))
                  : undefined
              }
            >
              <div className="pp-md-stepTop">
                <div className="pp-md-stepLabel">
                  <span className="pp-md-stepNum">{idx + 1}</span>
                  <span className="pp-md-stepText">{s.label}</span>
                </div>

                <div className="pp-md-stepStatus" aria-hidden="true">{chosen ? EM.CHECK : EM.PLUS}</div>
              </div>

              <div className="pp-md-stepValue">
                {chosen ? `${chosen.name} ${formatSizeSuffix(chosen.size)}` : "Not selected"}
              </div>
            </button>
          );
        })}
      </section>

      <section className="pp-md-active">
        <div className="pp-md-activeHead">
          <div>
            <div className="pp-md-activeKicker">
              Step {activeStep + 1} of {steps.length}
            </div>
            <div className="pp-md-activeTitle">
              {slotEmojiFor(step)} {step?.label || ""}
            </div>
          </div>

          <div className={["pp-md-activePill", activeChosen ? "is-filled" : ""].join(" ")}>
            {activeChosen ? "Selected" : "Choose"}
          </div>
        </div>

        <div className="pp-md-activeBody">
          <div className="pp-md-activeSummary">
            {activeChosen ? (
              <>
                <div className="pp-md-activeName">{activeChosen.name}</div>
                <div className="pp-md-activeMeta">
                  {formatSizeSuffix(activeChosen.size)}{" "}
                  {activeChosen.isGlutenFree ? <span className="pp-md-gfTag">GF</span> : null}
                </div>
              </>
            ) : (
              <div className="pp-md-activeEmpty">
                Pick something below to fill this step 👇
              </div>
            )}
          </div>

          <div className="pp-md-filters">
            {stepCategoryOptions.length > 1 ? (
              <div className="pp-md-chipRow">
                {stepCategoryOptions.map((cat) => {
                  const isActive =
                    String(activeCategoryRef || "").toUpperCase() === cat.ref;
                  return (
                    <button
                      key={cat.ref}
                      type="button"
                      onClick={() => setActiveCategoryRef(cat.ref)}
                      className={["pp-md-chip", isActive ? "is-active" : ""].join(" ")}
                    >
                      {cat.name}
                    </button>
                  );
                })}
              </div>
            ) : null}

            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search items..."
              className="pp-md-search"
            />
          </div>
        </div>
      </section>

      <div ref={listRef} className="pp-md-body">
        <div className="pp-md-bodyHint">
          {halfHalfOpenDesktop ? (
            "Half & Half is open — select pizzas from the menu to fill LEFT then RIGHT."
          ) : (
            <>
              Select an item for <b>{step?.label || "this step"}</b>
            </>
          )}
        </div>
      </div>

      <div className="cart-total-section" style={{ marginTop: "auto" }}>
        <div style={{ color: "var(--text-medium)", fontSize: "0.9rem" }}>
          Base: {currency(baseMealCents)}
          {extrasCents > 0 ? `  + extras: ${currency(extrasCents)}` : ""}
        </div>

        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
          <button
            type="button"
            className="simple-button"
            disabled={activeStep <= 0}
            onClick={() => setActiveStep((s) => Math.max(0, s - 1))}
          >
            Back
          </button>

          <button
            type="button"
            className="place-order-button"
            disabled={!isComplete}
            onClick={commitMeal}
            style={{ opacity: isComplete ? 1 : 0.55 }}
          >
            {EM.CART} Add meal {"\u2014"} {currency(totalCents)}
          </button>
          {isComplete && (
            <button
              type="button"
              className="simple-button"
              onClick={onCancel}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {overlays}
    </div>
  );

  return isMobile ? mobileBody : desktopBody;
};

if (typeof window !== "undefined") {
  console.log(
    "[PP][AuthDBG] window.origin:",
    window.location.origin,
    "authDomain:",
    "pizza-peppers-website.firebaseapp.com",
  );
}

/**
 * @typedef {{ lat: number, lng: number }} LatLng
 * @typedef {{ sw: LatLng, ne: LatLng }} Bounds
 *
 * @typedef {Object} PpDeliveryConfig
 * @property {() => Bounds} getBounds
 * @property {() => Set<string>} getAllowedPostcodes
 * @property {() => Set<string>} getAllowedSuburbs
 * @property {() => ((addr:any)=> (string|null)) | null} getExtractPostcode
 * @property {(place:any, extractPostcodeFn?: (ac:any)=> (string|null)) => boolean} isPlaceInDeliveryArea
 * @property {(pc:string) => { ok:boolean, fee_cents?:number, eta_min?:number, reason?:string }} quoteForPostcode
 */

/**
 * @type {Window & {
 *   __PP_DELIVERY_CONFIG?: PpDeliveryConfig,
 *   __PP_QUOTE_FOR_POSTCODE?: (pc: string) => number,
 *   __PP_DELIVERY_BOUNDS_SW?: LatLng,
 *   __PP_DELIVERY_BOUNDS_NE?: LatLng
 * }}
 */
const w = typeof window !== "undefined" ? window : /** @type {any} */ ({});

const ABOUT_LOCATION_TEXT = "Shop 16/217 Pimpala Rd, Woodcroft SA 5042";
const ABOUT_PHONE_DISPLAY = "(08) 8387 7700";
const ABOUT_PHONE_LINK = "0883877700";
const ABOUT_STORE_LOCATION = { lat: -35.10311870124038, lng: 138.5551734980128 };
// Display strings (exactly as requested)
const HOURS_DISPLAY = [
  { d: "Monday", h: "Closed" },
  { d: "Tuesday", h: "05:00 PM - 08:45 PM" },
  { d: "Wednesday", h: "05:00 PM - 08:45 PM" },
  { d: "Thursday", h: "05:00 PM - 08:45 PM" },
  { d: "Friday", h: "05:00 PM - 08:45 PM" },
  { d: "Saturday", h: "05:00 PM - 08:45 PM" },
  { d: "Sunday", h: "05:00 PM - 07:45 PM" },
];

// Open/closed evaluation in Australia/Adelaide TZ
const ADEL_TZ = "Australia/Adelaide";
// JS getDay(): 0=Sun - 6=Sat
const OPEN_WINDOWS_ADEL = {
  0: [17 * 60, 19 * 60 + 45], // Sunday
  1: null, // Monday closed
  2: [17 * 60, 20 * 60 + 45], // Tue
  3: [17 * 60, 20 * 60 + 45], // Wed
  4: [17 * 60, 20 * 60 + 45], // Thu
  5: [17 * 60, 20 * 60 + 45], // Fri
  6: [17 * 60, 20 * 60 + 45], // Sat
};
// Scheduling slot windows (local Adelaide time, mins since midnight)
const PICKUP_SLOT_START_MINS = 17 * 60 + 15; // 5:15pm  (pickup only)
const PICKUP_SLOT_END_MINS = 20 * 60 + 45; // 8:45pm  (pickup only)
const DELIVERY_SLOT_START_MINS = 17 * 60 + 45; // 5:45pm (delivery unchanged)
const DELIVERY_SLOT_END_MINS = 20 * 60 + 30; // 8:30pm (delivery unchanged)

function _zonedParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const m = {};
  for (const p of parts) {
    if (p.type !== "literal") m[p.type] = p.value;
  }
  const year = Number(m.year);
  const month = Number(m.month);
  const day = Number(m.day);
  const hour = Number(m.hour);
  const minute = Number(m.minute);
  const second = Number(m.second);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0-6
  return { year, month, day, hour, minute, second, weekday };
}

function _timeZoneOffsetMinutes(date, timeZone) {
  const z = _zonedParts(date, timeZone);
  const asUTC = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return (asUTC - date.getTime()) / 60000;
}

function _zonedTimeToUtc(parts, timeZone) {
  const utcGuess = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour || 0,
      parts.minute || 0,
      parts.second || 0,
    ),
  );
  const off1 = _timeZoneOffsetMinutes(utcGuess, timeZone);
  const d1 = new Date(utcGuess.getTime() - off1 * 60000);
  const off2 = _timeZoneOffsetMinutes(d1, timeZone);
  return off2 === off1 ? d1 : new Date(utcGuess.getTime() - off2 * 60000);
}

function getNextOpeningUtcAdelaide(nowDate = new Date()) {
  const now = _zonedParts(nowDate, ADEL_TZ);
  const nowMins = now.hour * 60 + now.minute;
  const base = new Date(Date.UTC(now.year, now.month - 1, now.day));

  for (let offset = 0; offset < 8; offset++) {
    const dayIndex = (now.weekday + offset) % 7;
    const win = OPEN_WINDOWS_ADEL[dayIndex];
    if (!win) continue;
    const [startMins, endMins] = win;

    if (offset === 0) {
      if (nowMins < startMins) {
        // later today
      } else if (nowMins <= endMins) {
        // open right now -> no "next opening" needed for preorders
        return null;
      } else {
        // after close -> check next days
        continue;
      }
    }

    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + offset);
    const hour = Math.floor(startMins / 60);
    const minute = startMins % 60;
    return _zonedTimeToUtc(
      { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour, minute, second: 0 },
      ADEL_TZ,
    );
  }
  return null;
}

function _adelNow() {
  // Convert current instant into Adelaide wall-clock time
  return new Date(new Date().toLocaleString("en-AU", { timeZone: ADEL_TZ }));
}
function isOpenNowAdelaide(nowDate = new Date()) {
  const d = _zonedParts(nowDate, ADEL_TZ);
  const day = d.weekday;
  const mins = d.hour * 60 + d.minute;
  const win = OPEN_WINDOWS_ADEL[day];
  if (!win) return false;
  const [start, end] = win;
  return mins >= start && mins <= end;
}

const quoteForPostcodeSafe = (() => {
  if (
    typeof window !== "undefined" &&
    typeof window.__PP_QUOTE_FOR_POSTCODE === "function"
  ) {
    return (pc) => {
      const val = window.__PP_QUOTE_FOR_POSTCODE(pc);
      if (typeof val === "number") {
        return { ok: true, fee_cents: val, eta_min: 40 };
      }
      return val;
    };
  }
  return _quoteForPostcode;
})();

// --- DELIVERY SERVICE AREA + WHITELIST ---
const DELIVERY_BOUNDS_SW = { lat: -35.2, lng: 138.4 };
const DELIVERY_BOUNDS_NE = { lat: -34.65, lng: 138.8 };

const FALLBACK_ALLOWED_SUBURBS = [
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
const FALLBACK_ALLOWED_POSTCODES = [
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

let DELIVERY_ALLOWED_SUBURBS = new Set(
  FALLBACK_ALLOWED_SUBURBS.map((s) => String(s).trim().toUpperCase()).filter(
    Boolean,
  ),
);
let DELIVERY_ALLOWED_POSTCODES = new Set(
  FALLBACK_ALLOWED_POSTCODES.map((p) => String(p)),
);
let deliveryExtractPostcode = null;

function quoteForPostcode(postcode) {
  const code = String(postcode ?? "").trim();

  if (!code || !DELIVERY_ALLOWED_POSTCODES.has(code)) {
    return { ok: false, reason: "OUT_OF_AREA" };
  }

  const fee = 0;
  return {
    ok: true,
    fee_cents: Math.round(fee * 100),
    eta_min: 40,
  };
}

/**
 * UI-friendly wrapper returning fee_cents as a number (defaults to 0).
 */
function quoteForPostcodeCents(postcode) {
  try {
    const result = quoteForPostcode(postcode);
    if (typeof result === "number") return result;
    if (result && result.ok && typeof result.fee_cents === "number") {
      return result.fee_cents;
    }
  } catch {}
  return 0;
}

// Dev shim: ensure window delivery config exists so local builds don't explode
if (typeof window !== "undefined") {
  w.__PP_DELIVERY_BOUNDS_SW = w.__PP_DELIVERY_BOUNDS_SW ?? DELIVERY_BOUNDS_SW;
  w.__PP_DELIVERY_BOUNDS_NE = w.__PP_DELIVERY_BOUNDS_NE ?? DELIVERY_BOUNDS_NE;
  /** @type {PpDeliveryConfig} */
  const devCfg = {
    getBounds: () => ({
      sw: { ...DELIVERY_BOUNDS_SW },
      ne: { ...DELIVERY_BOUNDS_NE },
    }),
    getAllowedPostcodes: () => new Set(FALLBACK_ALLOWED_POSTCODES.map(String)),
    getAllowedSuburbs: () =>
      new Set(FALLBACK_ALLOWED_SUBURBS.map((s) => String(s).toUpperCase())),
    getExtractPostcode: () => (addr) => {
      if (!addr) return null;
      const match = String(addr).match(/\b\d{4}\b/);
      return match ? match[0] : null;
    },
    isPlaceInDeliveryArea: () => true,
    quoteForPostcode,
  };
  w.__PP_DELIVERY_CONFIG = w.__PP_DELIVERY_CONFIG ?? devCfg;
  w.__PP_QUOTE_FOR_POSTCODE =
    w.__PP_QUOTE_FOR_POSTCODE ?? quoteForPostcodeCents;
}

function syncDeliveryGlobals() {
  if (typeof window === "undefined") return;
  const swOverride = window.__PP_DELIVERY_BOUNDS_SW || DELIVERY_BOUNDS_SW;
  const neOverride = window.__PP_DELIVERY_BOUNDS_NE || DELIVERY_BOUNDS_NE;
  /** @type {PpDeliveryConfig} */
  const cfg = {
    getBounds: () => ({
      sw: { ...swOverride },
      ne: { ...neOverride },
    }),
    getAllowedSuburbs: () => DELIVERY_ALLOWED_SUBURBS,
    getAllowedPostcodes: () => DELIVERY_ALLOWED_POSTCODES,
    getExtractPostcode: () => deliveryExtractPostcode,
    isPlaceInDeliveryArea,
    quoteForPostcode,
  };
  w.__PP_DELIVERY_CONFIG = cfg;
  try {
    window.dispatchEvent(new CustomEvent("pp:delivery-config-updated"));
  } catch {}
}

function isPredictionInDeliveryArea(prediction) {
  if (!prediction) return false;
  const cfg = /** @type {PpDeliveryConfig | null | undefined} */ (
    typeof window !== "undefined" ? window.__PP_DELIVERY_CONFIG : undefined
  );
  const allowedSuburbs = cfg?.getAllowedSuburbs?.() || DELIVERY_ALLOWED_SUBURBS;
  const haystack = [
    prediction.structured_formatting?.main_text,
    prediction.structured_formatting?.secondary_text,
    prediction.description,
  ]
    .filter(Boolean)
    .join(" | ")
    .toUpperCase();
  if (!haystack) return false;
  for (const suburb of allowedSuburbs) {
    if (haystack.includes(suburb)) return true;
  }
  return false;
}

function isPlaceInDeliveryArea(place, extractPostcodeFn = null) {
  if (!place) return false;
  const cfg = /** @type {PpDeliveryConfig | null | undefined} */ (
    typeof window !== "undefined" ? window.__PP_DELIVERY_CONFIG : undefined
  );
  const postcodes = cfg?.getAllowedPostcodes?.() || DELIVERY_ALLOWED_POSTCODES;
  const allowedSuburbs = cfg?.getAllowedSuburbs?.() || DELIVERY_ALLOWED_SUBURBS;

  let postcode = null;
  try {
    if (extractPostcodeFn && place?.address_components) {
      postcode = extractPostcodeFn(place.address_components);
    } else if (place?.address_components) {
      const pcComp = place.address_components.find(
        (c) => Array.isArray(c.types) && c.types.includes("postal_code"),
      );
      postcode = pcComp?.long_name || pcComp?.short_name || null;
    }
  } catch (err) {
    console.warn("[delivery] postcode extraction failed", err);
  }
  if (postcode && postcodes.has(String(postcode))) return true;

  const localityComp = place?.address_components?.find(
    (c) => Array.isArray(c.types) && c.types.includes("locality"),
  );
  const localityName = localityComp?.long_name || localityComp?.short_name;
  if (localityName && allowedSuburbs.has(String(localityName).toUpperCase()))
    return true;
  return false;
}

// Detect when popups are risky/blocked by COOP/COEP or browser policies
syncDeliveryGlobals();

// Lazy-load delivery config so the bundle can boot even if the file is missing during HMR.
(async () => {
  try {
    const module = await import("./config/delivery.js");
    if (module?.DELIVERY_ZONES?.length) {
      const subs = new Set();
      const pcs = new Set();
      for (const zone of module.DELIVERY_ZONES) {
        (zone.suburbs || []).forEach((s) => {
          const normalised = String(s).trim().toUpperCase();
          if (normalised) subs.add(normalised);
        });
        (zone.postcodes || []).forEach((p) => {
          const normalised = String(p).trim();
          if (normalised) pcs.add(normalised);
        });
      }
      if (subs.size) DELIVERY_ALLOWED_SUBURBS = subs;
      if (pcs.size) DELIVERY_ALLOWED_POSTCODES = pcs;
    }
    if (module?.DELIVERY_BOUNDS_SW && module?.DELIVERY_BOUNDS_NE) {
      if (typeof window !== "undefined") {
        w.__PP_DELIVERY_BOUNDS_SW = module.DELIVERY_BOUNDS_SW;
        w.__PP_DELIVERY_BOUNDS_NE = module.DELIVERY_BOUNDS_NE;
      }
    }
    if (typeof module?.extractPostcode === "function") {
      deliveryExtractPostcode = module.extractPostcode;
    }
    if (
      typeof module?.quoteForPostcode === "function" &&
      typeof window !== "undefined"
    ) {
      const toCents = (pc) => {
        try {
          const r = module.quoteForPostcode(pc);
          if (typeof r === "number") return r;
          if (r && r.ok && typeof r.fee_cents === "number") return r.fee_cents;
        } catch {}
        return 0;
      };
      w.__PP_QUOTE_FOR_POSTCODE = toCents;
    }
  } catch (error) {
    if (import.meta?.env?.MODE === "development") {
      console.info("[delivery] Using fallback delivery whitelist.", error);
    }
  } finally {
    syncDeliveryGlobals();
  }
})();
const app = firebaseApp;
const auth = firebaseAuth;
const db = firebaseDb;
const storage = firebaseStorage;

const firebaseFallback = {
  app: null,
  auth: null,
  db: null,
  storage: null,
  onIdTokenChanged: () => () => {},
  signInWithPhoneNumber: async () => {
    throw new Error("Firebase not configured");
  },
  RecaptchaVerifier,
  updateProfile,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  ref: storageRef,
  uploadBytes,
  getDownloadURL,
};

async function getFirebaseSdk() {
  if (!FB_READY || !app || !auth || !db || !storage) {
    return firebaseFallback;
  }
  return {
    app,
    auth,
    db,
    storage,
    onIdTokenChanged,
    signInWithPhoneNumber,
    RecaptchaVerifier,
    updateProfile,
    doc,
    getDoc,
    setDoc,
    updateDoc,
    ref: storageRef,
    uploadBytes,
    getDownloadURL,
  };
}

function getFirebaseGuard() {
  return typeof getFirebaseSdk === "function"
    ? getFirebaseSdk
    : async () => firebaseFallback;
}

const getFirebase = getFirebaseGuard();

// ---- money utils ----
const toCents = (v) => {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 100);
  const s = String(v).replace(/[^0-9.]/g, "");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
};
function currency(valueCents) {
  const value = Number(valueCents || 0) / 100;
  if (!Number.isFinite(value)) return "$0.00";
  return value.toLocaleString("en-AU", { style: "currency", currency: "AUD" });
}

// --- GF surcharge (menu.json-driven) ---
function getGfSurchargeCentsForProduct(productLike, menuData) {
  const apiRoot = (menuData && menuData.raw) || menuData || {};
  const products = Array.isArray(apiRoot?.products) ? apiRoot.products : [];

  const id = productLike?.id || productLike?.product_id || productLike?.ref || null;
  const name = productLike?.name ? String(productLike.name) : null;

  const base =
    (id ? products.find((p) => p && p.id === id) : null) ||
    (name ? products.find((p) => p && String(p.name) === name) : null) ||
    productLike ||
    null;

  const raw =
    base?.gluten_free_surcharge ??
    base?.glutenFreeSurcharge ??
    base?.gf_surcharge ??
    null;

  const cents = toCents(raw);
  if (Number.isFinite(cents) && cents >= 0) return cents;

  // Optional global fallback if you ever add it later
  const g = apiRoot?.globals || {};
  const gRaw = g.gfSurcharge ?? g.gluten_free_surcharge ?? g.glutenFreeSurcharge ?? null;
  const gCents = toCents(gRaw);
  if (Number.isFinite(gCents) && gCents >= 0) return gCents;

  // Safety fallback to old behavior if menu doesn't specify
  return 400; // $4.00
}


// Returns the minimum price (in cents) across all sizes for a product
function minPriceCents(item) {
  if (item?.priceCents && typeof item.priceCents === "object") {
    const vals = Object.values(item.priceCents).filter((v) =>
      Number.isFinite(v),
    );
    if (vals.length) return Math.min(...vals);
  }
  if (item?.priceBySize && typeof item.priceBySize === "object") {
    const vals = Object.values(item.priceBySize || {});
    const filtered = vals.filter((v) => Number.isFinite(v));
    if (filtered.length) return Math.min(...filtered);
  }
  if (Number.isFinite(item?.minPriceCents)) return item.minPriceCents;
  return 0;
}

// Base price helper used across panels (prevents "getBasePriceCents is not defined")
function getBasePriceCents(product, sizeToken = "Default") {
  if (!product) return 0;

  // Prefer transformed menu shape: priceCents map
  const priceMap =
    product.priceCents && typeof product.priceCents === "object"
      ? product.priceCents
      : null;
  if (priceMap) {
    const direct = priceMap[sizeToken];
    if (Number.isFinite(direct)) return direct;

    // Try common normalized keys
    const up = String(sizeToken || "").toUpperCase();
    if (Number.isFinite(priceMap[up])) return priceMap[up];

    const def = priceMap.Default;
    if (Number.isFinite(def)) return def;
  }

  // Fallback: raw menu shape: skus array with {name/size, price}
  if (Array.isArray(product.skus) && product.skus.length) {
    const wanted = String(sizeToken || "").toLowerCase();
    const hit =
      product.skus.find(
        (s) => String(s?.name || s?.size || "").toLowerCase() === wanted,
      ) ||
      product.skus.find(
        (s) => String(s?.name || s?.size || "").toLowerCase() === "regular",
      ) ||
      product.skus[0];

    const cents = toCents(hit?.price_cents ?? hit?.price ?? hit?.amount ?? hit?.value);
    if (Number.isFinite(cents)) return cents;
  }

  // Last resort: minimum price
  return minPriceCents(product) || 0;
}

function SizePriceDisclaimer({ className = "" }) {
  return (
    <p className={`mt-1 text-xs opacity-60 ${className}`.trim()}>
      Prices vary by pizza size.
    </p>
  );
}

function getAddonKey(addon) {
  if (!addon) return null;
  if (typeof addon === "string") return addon;
  return (
    addon?.ref ||
    addon?.id ||
    addon?.value ||
    addon?.name ||
    addon?.label ||
    null
  );
}

// Price helper for menu-based add-ons
function parsePriceToCents(raw) {
  if (raw == null || raw === "") return 0;
  const clean = String(raw).replace(/[^0-9.]/g, "");
  const val = parseFloat(clean);
  if (!Number.isFinite(val)) return 0;
  if (val < 500) return Math.round(val * 100);
  return Math.round(val);
}

function fallbackOptionPrice(addon, menuData, sizeId = "regular") {
  if (!addon) return 0;
  const norm = normalizeAddonSizeRef(sizeId || "regular");

  if (
    typeof addon.price_cents === "number" &&
    Number.isFinite(addon.price_cents) &&
    addon.price_cents > 0
  ) {
    return Math.round(addon.price_cents);
  }
  if (
    typeof addon.unitCents === "number" &&
    Number.isFinite(addon.unitCents) &&
    addon.unitCents > 0
  ) {
    return Math.round(addon.unitCents);
  }

  if (addon.prices && typeof addon.prices === "object") {
    const raw =
      addon.prices[norm] ??
      addon.prices[norm.toLowerCase?.()] ??
      addon.prices[norm.toUpperCase?.()];
    const cents = parsePriceToCents(raw);
    if (cents > 0) return cents;
  }

  const sourceMenu = (menuData && menuData.raw) || menuData || {};
  const rawLists = Array.isArray(sourceMenu.option_lists)
    ? sourceMenu.option_lists
    : Array.isArray(menuData?.option_lists)
      ? menuData.option_lists
      : [];

  if (rawLists.length) {
    const listRef =
      addon.option_list_ref || addon.list_ref || addon.__listRef || null;
    const addonKey = (
      addon.ref ||
      addon.id ||
      addon.value ||
      addon.name ||
      ""
    )
      .toString()
      .trim()
      .toLowerCase();

    const listsToCheck = rawLists.filter((list) => {
      if (!list) return false;
      if (!listRef) return true;
      const lr = listRef.toString().trim().toLowerCase();
      const listId = (
        list.ref ||
        list.id ||
        list.name ||
        ""
      )
        .toString()
        .trim()
        .toLowerCase();
      return listId === lr;
    });

    for (const list of listsToCheck) {
      const options = list.options || list.items || [];
      for (const opt of options) {
        const key = (
          opt.ref ||
          opt.id ||
          opt.value ||
          opt.name ||
          ""
        )
          .toString()
          .trim()
          .toLowerCase();

        if (!addonKey || key !== addonKey) continue;

        if (opt.prices && typeof opt.prices === "object") {
          const raw =
            opt.prices[norm] ??
            opt.prices[norm.toLowerCase?.()] ??
            opt.prices[norm.toUpperCase?.()];
          const cents = parsePriceToCents(raw);
          if (cents > 0) return cents;
        }

        if (
          typeof opt.price_cents === "number" &&
          Number.isFinite(opt.price_cents) &&
          opt.price_cents > 0
        ) {
          return Math.round(opt.price_cents);
        }
        if (opt.amount != null || opt.price != null) {
          const cents = parsePriceToCents(opt.amount ?? opt.price);
          if (cents > 0) return cents;
        }
      }
    }
  }

  if (addon.amount != null || addon.price != null) {
    const cents = parsePriceToCents(addon.amount ?? addon.price);
    if (cents > 0) return cents;
  }

  return 0;
}

// --- Add-ons category grouping (driven by option_list_refs / list names) ---

// Map option_list_ref -> nice label
const ADDON_LIST_LABELS = {
  EXTRAS_CHEESE: "Extra Cheese",
  EXTRAS_MEAT: "Extra Meat",
  EXTRAS_SEAFOOD: "Extra Seafood",
  EXTRAS_VEGGIES: "Extra Veggies",
  EXTRAS_SAUCE: "Extra Sauce",
  EXTRAS_SPICES__HERBS: "Extra Spices & Herbs",
  EXTRAS_OTHERS: "Others",
  OTHERS: "Others",
};

// Sort order for groups
const ADDON_LIST_ORDER = [
  "EXTRAS_CHEESE",
  "EXTRAS_MEAT",
  "EXTRAS_SEAFOOD",
  "EXTRAS_VEGGIES",
  "EXTRAS_SAUCE",
  "EXTRAS_SPICES__HERBS",
  "EXTRAS_OTHERS",
  "OTHERS",
];

function toTitleCaseLabel(raw) {
  if (!raw) return "";
  return String(raw)
    .replace(/^EXTRAS?_/, "")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function groupAddonsForModal(optionsFlat = []) {
  const byRef = new Map();

  for (const opt of optionsFlat || []) {
    const refRaw =
      opt.option_list_ref || opt.list_ref || opt.__listRef || "";
    const ref = String(refRaw || "").trim();
    if (!ref) continue;

    let group = byRef.get(ref);
    if (!group) {
      const labelFromRef = ADDON_LIST_LABELS[ref];
      const labelFromList = opt.__listName;
      const fallback = labelFromRef || labelFromList || toTitleCaseLabel(ref);

      group = {
        ref,
        label: fallback,
        options: [],
      };
      byRef.set(ref, group);
    }
    group.options.push(opt);
  }

  const groups = Array.from(byRef.values()).filter(
    (g) => g.options && g.options.length > 0,
  );

  groups.sort((a, b) => {
    const ia = ADDON_LIST_ORDER.indexOf(a.ref);
    const ib = ADDON_LIST_ORDER.indexOf(b.ref);
    const sa = ia === -1 ? 999 : ia;
    const sb = ib === -1 ? 999 : ib;
    if (sa !== sb) return sa - sb;
    return a.label.localeCompare(b.label);
  });

  return groups;
}

const norm = (s) =>
  String(s || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");

async function uploadAvatarAndSaveProfile(file, user) {
  const sdk = await getFirebase();
  if (!sdk.storage || !sdk.db || !user) {
    throw new Error("Uploads unavailable (Firebase not configured).");
  }
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const key = `users/${user.uid}/avatar_${Date.now()}.${ext}`;
  const r = sdk.ref(sdk.storage, key);
  const snap = await sdk.uploadBytes(r, file, {
    contentType: file.type || "image/jpeg",
  });
  const url = await sdk.getDownloadURL(snap.ref);
  await sdk.updateDoc(sdk.doc(sdk.db, "users", user.uid), { photoURL: url });
  return url;
}

async function clearBadPhotoUrlIfNeeded(user) {
  try {
    if (!user || !user.photoURL) return;
    const sdk = await getFirebase();
    if (!sdk?.db) return;
    if (
      typeof user.photoURL === "string" &&
      user.photoURL.includes("firebasestorage.app")
    ) {
      await sdk.updateDoc(sdk.doc(sdk.db, "users", user.uid), {
        photoURL: null,
      });
    }
  } catch (err) {
    console.warn("clearBadPhotoUrlIfNeeded() ignored:", err);
  }
}
/*** -------------------------------------------------------------
 *  INLINE MODULES (moved from /context and /menu)
 *  - AppContext (Provider + hook)
 *  Keep these above components so everything can use them.
 *  ------------------------------------------------------------ */

/* 1) AppContext */
const AppContext = createContext({
  currentUser: null,
  loginWithGoogle: async () => {},
  loginWithApple: async () => {},
  loginLocal: () => ({}),
  signupLocal: () => ({}),
  logout: async () => {},
});

function AppProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null);

  const loginWithGoogle = useCallback(async () => {
    return;
  }, []);
  const loginWithApple = useCallback(async () => {
    return;
  }, []);
  const loginLocal = useCallback((phone, displayName) => {
    const user = {
      uid: `local_${Date.now()}`,
      phone,
      displayName: displayName || "",
    };
    setCurrentUser(user);
    return { ok: true, user };
  }, []);
  const signupLocal = useCallback(({ phone, displayName }) => {
    const user = {
      uid: `local_${Date.now()}`,
      phone,
      displayName: displayName || "",
    };
    setCurrentUser(user);
    return { ok: true, user };
  }, []);
  const logout = useCallback(async () => {
    setCurrentUser(null);
  }, []);

  const value = useMemo(
    () => ({
      currentUser,
      loginWithGoogle,
      loginWithApple,
      loginLocal,
      signupLocal,
      logout,
    }),
    [
      currentUser,
      loginWithGoogle,
      loginWithApple,
      loginLocal,
      signupLocal,
      logout,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function useApp() {
  return useContext(AppContext);
}

const _normalizeBase = (raw) => {
  const s = String(raw || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
};

const PP_MENU_BASE_URL = _normalizeBase(import.meta.env.VITE_PP_MENU_BASE_URL);
const PP_IMAGES_BASE_URL = _normalizeBase(import.meta.env.VITE_PP_IMAGES_BASE_URL);
const PP_ENABLE_APPLE_LOGIN =
  String(import.meta?.env?.VITE_PP_ENABLE_APPLE_LOGIN || "").toLowerCase() ===
  "true";

// Back-compat: if you still set only VITE_PP_POS_BASE_URL, use it as fallback
const PP_POS_BASE_URL = _normalizeBase(
  import.meta.env.VITE_PP_POS_BASE_URL || import.meta.env.VITE_PP_RENDER_BASE_URL,
);

const MENU_BASE = PP_MENU_BASE_URL || PP_POS_BASE_URL;
const IMG_BASE = PP_IMAGES_BASE_URL || PP_POS_BASE_URL;

const slugify = (text) =>
  String(text || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/&/g, "")
    .replace(/[^\w\-]+/g, "")
    .replace(/\-\-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

const _isAbsUrl = (s) => /^https?:\/\//i.test(String(s || ""));

const _extractUploadFilename = (val) => {
  const s = String(val || "").trim();
  if (!s) return "";
  if (_isAbsUrl(s)) return s;

  const cleaned = s.replace(/^\/+/, "");
  const idx = cleaned.toLowerCase().lastIndexOf("static/uploads/");
  if (idx !== -1) {
    return cleaned.slice(idx + "static/uploads/".length);
  }
  return cleaned;
};

const getProductImageUrl = (p, base = IMG_BASE || "") => {
  const baseUrl = base || "";
  const raw = p?.image || "";
  const name = p?.name || "";

  const extracted = _extractUploadFilename(raw);

  if (_isAbsUrl(extracted)) return extracted;
  if (extracted) return `${baseUrl}/static/uploads/${extracted}`;

  return `${baseUrl}/static/uploads/${slugify(name)}.jpg`;
};

const PP_PROXY_PREFIX = (import.meta.env.VITE_PP_PROXY_PREFIX || "/pp-proxy").replace(/\/+$/, "");

const getProductImageUrlCandidates = (p) => {
  const list = [
    getProductImageUrl(p, IMG_BASE),
    getProductImageUrl(p, ""),
    getProductImageUrl(p, PP_PROXY_PREFIX),
  ].filter(Boolean);

  return Array.from(new Set(list)); // de-dupe
};

function getImagePath(productOrName) {
  if (!productOrName) return FALLBACK_IMAGE_URL;

  if (typeof productOrName === "string") {
    return getProductImageUrl({ name: productOrName }, IMG_BASE || "");
  }

  return getProductImageUrl(productOrName, IMG_BASE || "");
}

// ----------------- MENU PIPELINE (stable) -----------------

// ----------------- ORDER PIPELINE (send website orders to POS) -----------------

const ORDER_INGEST_URL = String(import.meta.env.VITE_PP_ORDER_INGEST_URL || "").trim();

const PP_ORDER_OUTBOX_KEY = "pp_order_outbox_v1";

function _safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function enqueueOrder(orderPayload) {
  try {
    const cur = _safeJsonParse(localStorage.getItem(PP_ORDER_OUTBOX_KEY), []);
    const next = Array.isArray(cur) ? cur.slice() : [];
    next.push({ ts: Date.now(), payload: orderPayload });
    localStorage.setItem(PP_ORDER_OUTBOX_KEY, JSON.stringify(next));
    return next.length;
  } catch (e) {
    console.warn("[PP][OrderOutbox] enqueue failed", e);
    return 0;
  }
}

function readOutbox() {
  try {
    const cur = _safeJsonParse(localStorage.getItem(PP_ORDER_OUTBOX_KEY), []);
    return Array.isArray(cur) ? cur : [];
  } catch {
    return [];
  }
}

function writeOutbox(items) {
  try {
    localStorage.setItem(PP_ORDER_OUTBOX_KEY, JSON.stringify(items || []));
  } catch {}
}

async function postJson(url, body, timeoutMs = 12000) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const t = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller?.signal,
    });

    const text = await res.text().catch(() => "");
    const json = text ? _safeJsonParse(text, null) : null;

    if (!res.ok) {
      const msg = (json && (json.error || json.message)) || text || `HTTP ${res.status}`;
      throw new Error(msg);
    }

    return json ?? { ok: true };
  } finally {
    if (t) clearTimeout(t);
  }
}

async function sendWebsiteOrderToPos(orderPayload) {
  if (!ORDER_INGEST_URL) {
    throw new Error("Missing VITE_PP_ORDER_INGEST_URL");
  }
  return postJson(ORDER_INGEST_URL, orderPayload, 15000);
}

async function flushOrderOutboxOnce() {
  const items = readOutbox();
  if (!items.length) return { ok: true, sent: 0 };

  const keep = [];
  let sent = 0;

  for (const item of items) {
    if (!item || !item.payload) continue;
    try {
      await sendWebsiteOrderToPos(item.payload);
      sent += 1;
    } catch (e) {
      // keep anything that fails; we'll retry later
      keep.push(item);
    }
  }

  writeOutbox(keep);
  return { ok: true, sent, remaining: keep.length };
}
const MENU_URL = import.meta.env.DEV
  ? `${PP_PROXY_PREFIX}/public/menu`
  : `${MENU_BASE}/public/menu`;

// Defensive unwrap so we handle {categories,...} or {data:{...}} or {menu:{...}}
function unwrapMenuApi(raw) {
  const root = raw && typeof raw === "object" ? raw : {};
  const maybe = root.menu || root.data || root;
  const api = {
    categories: Array.isArray(maybe.categories) ? maybe.categories : [],
    products: Array.isArray(maybe.products) ? maybe.products : [],
    option_lists: Array.isArray(maybe.option_lists)
      ? maybe.option_lists
      : Array.isArray(maybe.optionLists)
        ? maybe.optionLists
        : [],
    globals: maybe.globals || {},
    settings: maybe.settings || {},
    delivery_zones: Array.isArray(maybe.delivery_zones)
      ? maybe.delivery_zones
      : Array.isArray(maybe.deliveryZones)
        ? maybe.deliveryZones
        : [],
  };
  try {
    console.log("[menu][client] keys:", Object.keys(api));
  } catch {}
  return api;
}

async function fetchMenu(url = MENU_URL) {
  console.log("[menu] GET", url);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const ct = res.headers.get("content-type") || "";
  console.log("[menu][debug] status:", res.status, "content-type:", ct);

  // If backend/proxy is missing, Render will return HTML 404.
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Menu fetch failed (${res.status}) from ${url}: ${text.slice(0, 80)}`);
  }

  // Guard against HTML being returned.
  if (!ct.includes("application/json")) {
    const text = await res.text().catch(() => "");
    throw new Error(`Menu response not JSON from ${url}: ${text.slice(0, 80)}`);
  }

  const raw = await res.json();
  return unwrapMenuApi(raw);
}

// cfg: choose keys from API (kept compatible with your JSON)
const MENU_CFG = {
  catRefKey: "ref",
  catNameKey: "name",
  productCatRefKey: "category_ref",
};

function transformMenu(api, cfg = MENU_CFG) {
  const cats = Array.isArray(api?.categories) ? api.categories : [];
  const products = Array.isArray(api?.products) ? api.products : [];
  try {
    console.log(
      "[menu][transform] input counts: categories=" +
        cats.length +
        " products=" +
        products.length,
    );
    console.log(
      "[menu][transform] keys: category.ref=" +
        cfg.catRefKey +
        " category.name=" +
        cfg.catNameKey +
        " product.categoryRef=" +
        cfg.productCatRefKey,
    );
  } catch {}

  const byCatRef = new Map();
  for (const c of cats) {
    const ref = c?.[cfg.catRefKey];
    const name = c?.[cfg.catNameKey] ?? ref ?? "Unnamed";
    if (!ref) continue;
    byCatRef.set(ref, { ref, name, items: [] });
  }

  for (const p of products) {
    const ref = p?.[cfg.productCatRefKey] ?? p?.categoryRef;
    if (!ref) continue;
    const bucket = byCatRef.get(ref);
    if (!bucket) continue;

    const hasSkus = Array.isArray(p?.skus) && p.skus.length > 0;
    let sizes =
      Array.isArray(p?.sizes) && p.sizes.length
        ? [...p.sizes]
        : hasSkus
          ? p.skus.map((s) => s?.size || s?.name).filter(Boolean)
          : null;

    const prices = {};
    if (hasSkus) {
      for (const sku of p.skus) {
        const keyRaw = sku?.size || sku?.name || "Default";
        const key =
          typeof keyRaw === "string" && keyRaw.trim() ? keyRaw.trim() : "Default";
        const cents = toCents(
          sku?.price_cents ?? sku?.price ?? sku?.amount ?? sku?.value,
        );
        if (Number.isFinite(cents)) prices[key] = cents;
      }
    } else {
      const cents = toCents(p?.price_cents ?? p?.price ?? p?.amount);
      if (Number.isFinite(cents)) prices.Default = cents;
    }

    const priceValues = Object.values(prices).filter((v) => Number.isFinite(v));
    const minPriceCents = priceValues.length ? Math.min(...priceValues) : 0;

    bucket.items.push({
      ...p,
      sizes,
      priceCents: prices,
      minPriceCents,
    });
  }

  const normalized = {
    categories: Array.from(byCatRef.values()),
    option_lists: Array.isArray(api?.option_lists) ? api.option_lists : [],
    globals: api?.globals || {},
    settings: api?.settings || {},
    raw: api,
  };

  try {
    console.log(
      "[menu][transform] output categories=" + normalized.categories.length,
    );
  } catch {}

  return normalized;
}

// Stable reference for HMR: keep the helper on window once it exists
if (typeof window !== "undefined") {
  const safeWindow = /** @type {Window} */ (window);
  if (!safeWindow.__pp_transformMenu) {
    safeWindow.__pp_transformMenu = transformMenu;
  }
}

const transformMenuStable = w.__pp_transformMenu || transformMenu;

// --- Safe, optional Google Maps loader (no crash if missing key) ---
function useGoogleMaps() {
  const [mapsLoaded, setMapsLoaded] = React.useState(
    () => !!(typeof window !== "undefined" && window.google?.maps),
  );

  React.useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }
    const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "";
    try {
      console.log("[maps] env key present?", !!key);
    } catch {}
    const scriptId = "pp-google-maps";
    const existing = document.getElementById(scriptId);

    const markLoaded = () => setMapsLoaded(true);

    if (!key) {
      console.warn("[maps] Missing VITE_GOOGLE_MAPS_API_KEY (maps will stay disabled).");
      return;
    }

    const desiredSrc = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      key,
    )}&libraries=places&loading=async`;

    if (existing) {
      const existingSrc = existing.getAttribute("src") || "";
      // If the script src changed (common during dev), reload it.
      if (existingSrc !== desiredSrc) {
        try {
          existing.parentNode?.removeChild(existing);
        } catch {}
      } else {
        if (window.google?.maps) {
          setMapsLoaded(true);
        } else {
          existing.addEventListener("load", markLoaded, { once: true });
        }
        return;
      }
    }

    const script = document.createElement("script");
    script.id = scriptId;
    script.async = true;
    script.defer = true;
    script.src = desiredSrc;
    script.onload = markLoaded;
    script.onerror = () => {
      console.warn("[maps] Failed to load Google Maps JS. Check referrer/API key restrictions.");
    };
    document.head.appendChild(script);
  }, []);

  return mapsLoaded;
}

// Global taps for silent errors that might interrupt the loader "finally"
if (typeof window !== "undefined") {
  if (!w.__PP_ONERROR_TAP) {
    w.__PP_ONERROR_TAP = true;
    window.addEventListener("error", (e) => {
      console.error("[PP][window.error]", e?.message, e?.error);
    });
    window.addEventListener("unhandledrejection", (e) => {
      console.error("[PP][unhandledrejection]", e?.reason);
    });
  }
}
// import DebugMenuFetch from './dev/DebugMenuFetch';
// TEMP: runtime guard in case Vite/HMR cache is stale and misses transformMenu.js
// import DebugMenuFetch from './dev/DebugMenuFetch';
// import useGoogleMaps from './hooks/useGoogleMaps';
// Using helper for avatar uploads and shared Firebase instances
// (Firebase app/auth/db/storage are centralized in src/firebase.js.)

/**
 * @typedef {Object} AuthContextType
 * @property {any} currentUser
 * @property {() => Promise<void>} loginWithGoogle
 * @property {() => Promise<void>} loginWithApple
 * @property {(phone: string, displayName?: string, token?: string | null, userOverride?: any) => any} loginLocal
 * @property {(args: { phone: string, displayName?: string, token?: string | null, user?: any }) => any} signupLocal
 * @property {() => Promise<void>} logout
 * @property {boolean} loading
 * @property {boolean} showLogin
 * @property {LoginTab} loginTab
 * @property {(tab?: LoginTab) => void} openLogin
 * @property {() => void} closeLogin
 * @property {import('react').Dispatch<import('react').SetStateAction<LoginTab>>} setLoginTab
 */

/** @typedef {'providers' | 'phone' | 'email'} LoginTab */

// Firebase config and singletons are centralized in src/firebase.js

// --- AUTH CONTEXT (Firebase + local session) ---
/** @type {import('react').Context<AuthContextType>} */
const AuthContext = createContext(
  /** @type {AuthContextType} */ ({
    currentUser: null,
    loginWithGoogle: async () => {},
    loginWithApple: async () => {},
    // Accept proper args in the default stubs so consumers see correct signatures:
    loginLocal: (_phone, _displayName, _token, _user) => null,
    signupLocal: (
      {
        phone: _p = "",
        displayName: _d = "",
        token: _t = null,
        user: _u = null,
      } = { phone: "", displayName: "" },
    ) => null,
    logout: async () => {},
    loading: true,
    showLogin: false,
    loginTab: /** @type {LoginTab} */ ("providers"),
    openLogin: () => {},
    closeLogin: () => {},
    setLoginTab:
      /** @type {import('react').Dispatch<import('react').SetStateAction<LoginTab>>} */ (
        (_tab) => {}
      ),
  }),
);
export function useAuth() {
  return useContext(AuthContext);
}

function AuthProvider({ children }) {
  const LOCAL_KEY = "pp_session_v1";

  // --- central login modal controls (works with or without Firebase) ---
  const [showLogin, setShowLogin] = React.useState(false);
  /** @type {[LoginTab, React.Dispatch<React.SetStateAction<LoginTab>>]} */
  const [loginTab, setLoginTab] = React.useState(
    /** @type {LoginTab} */ ("providers"),
  );

  /** @type {(tab: any) => LoginTab} */
  const toLoginTab = (tab) =>
    tab === "phone" || tab === "email" || tab === "providers"
      ? tab
      : "providers";

  /**
   * @param {LoginTab=} tab
   */
  const openLogin = React.useCallback(
    (tab = "providers") => {
      setLoginTab(toLoginTab(tab));
      setShowLogin(true);
    },
    [setLoginTab, setShowLogin],
  );
  const closeLogin = React.useCallback(
    () => setShowLogin(false),
    [setShowLogin],
  );

  const [firebaseUser, setFirebaseUser] = useState(null);
  const [localSession, setLocalSession] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null");
      if (!raw) return null;
      if (raw && typeof raw === "object" && raw.user) {
        return { token: raw.token || null, user: raw.user || null };
      }
      if (raw && typeof raw === "object") {
        return { token: null, user: raw };
      }
      return null;
    } catch {
      return null;
    }
  });
  const localUser = localSession?.user || null;
  const [loading, setLoading] = useState(true);
  const initDoneRef = useRef(false);
  const handledRedirectRef = useRef(false);
  const saveSession = (token, user) => {
    localStorage.setItem("pp_session_v1", JSON.stringify({ token, user }));
  };

  const ensurePersistence = React.useCallback(async () => {
    try {
      await setPersistence(firebaseAuth, browserLocalPersistence);
    } catch (err) {
      console.warn("[PP][AuthDBG] setPersistence error:", err?.message || err);
    }
  }, []);

  const signInWithProvider = React.useCallback(
    async (providerFactory) => {
      if (!FB_READY || !firebaseAuth) {
        console.warn("Firebase not configured; provider login disabled.");
        throw new Error("Sign-in unavailable");
      }

      await ensurePersistence();

      const provider = providerFactory();
      const providerId = provider?.providerId || "unknown";

      // Helpful: confirm WHICH Firebase project the running app is using
      try {
        const opts = firebaseAuth.app?.options || {};
        console.log("[PP][AuthDBG] firebase project:", {
          projectId: opts.projectId,
          authDomain: opts.authDomain,
          apiKeyTail: String(opts.apiKey || "").slice(-6),
          providerId,
        });
      } catch {}

      const isProbablyMobile = (() => {
        try {
          return (
            window.matchMedia?.("(max-width: 900px)")?.matches ||
            /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
          );
        } catch {
          return false;
        }
      })();

      // Apple: prefer redirect (especially on mobile / Safari)
      const preferPopup = providerId !== "apple.com" && !isProbablyMobile;

      console.log("[PP][AuthDBG] login start, providerId=", providerId, "preferPopup=", preferPopup);

      try {
        if (preferPopup) {
          try {
            const res = await signInWithPopup(firebaseAuth, provider);
            console.log("[PP][AuthDBG] popup user:", labelUser(res?.user));
            return;
          } catch (err) {
            const code = err?.code || "";
            const popupBad =
              code === "auth/popup-blocked" ||
              code === "auth/popup-closed-by-user" ||
              code === "auth/cancelled-popup-request" ||
              code === "auth/operation-not-supported-in-this-environment";
            if (!popupBad) throw err;
            console.warn("[PP][AuthDBG] popup failed -> redirect fallback:", code);
          }
        }

        await signInWithRedirect(firebaseAuth, provider);
      } catch (err) {
        const code = err?.code || "";
        console.warn("[PP][AuthDBG] login error:", code || err?.message || err);

        if (code === "auth/operation-not-allowed") {
          console.warn(
            "[PP][AuthDBG] Apple provider appears disabled for THIS Firebase project. " +
              "Double-check the Firebase projectId/authDomain logged above matches the console you edited."
          );
        }
      }
    },
    [ensurePersistence],
  );

  // Finish redirect (if any) before subscribing to auth changes
  useEffect(() => {
    if (!firebaseAuth) {
      setFirebaseUser(null);
      setLoading(false);
      return;
    }

    if (!initDoneRef.current) {
      initDoneRef.current = true;

      const nowLabel = (() => {
        try {
          return `${performance.now().toFixed(1)}ms`;
        } catch {
          return `${Date.now()}ms`;
        }
      })();
      console.log("[PP][AuthDBG] init @", nowLabel);
      logAuthConfig();
      dumpFirebaseLocalStorage("pre-getRedirectResult");
      try {
        localStorage.setItem("__pp_fb_test", "1");
        const ok = localStorage.getItem("__pp_fb_test") === "1";
        console.log("[PP][AuthDBG] localStorage write ok:", ok);
        localStorage.removeItem("__pp_fb_test");
      } catch (err) {
        console.warn(
          "[PP][AuthDBG] localStorage not available:",
          err?.message || err,
        );
      }

      (async () => {
        if (handledRedirectRef.current) return;
        handledRedirectRef.current = true;
        try {
          const res = await getRedirectResult(firebaseAuth);
          console.log(
            "[PP][AuthDBG] redirect result user:",
            labelUser(res?.user),
          );
        } catch (err) {
          console.warn(
            "[PP][AuthDBG] getRedirectResult error:",
            err?.message || err,
          );
        } finally {
          dumpFirebaseLocalStorage("post-getRedirectResult");
        }
      })();

      (async () => {
        try {
          if (typeof firebaseAuth.authStateReady === "function") {
            await firebaseAuth.authStateReady();
          }
        } catch (err) {
          console.warn(
            "[PP][AuthDBG] authStateReady error:",
            err?.message || err,
          );
        }
      })();
    }

    const unsubscribe = onIdTokenChanged(firebaseAuth, (user) => {
      if (user) {
        console.log("[PP][AuthDBG] listener user:", labelUser(user));
        setFirebaseUser(user);
      } else {
        console.log("[PP][AuthDBG] listener: user is null - dumping caches");
        dumpFirebaseLocalStorage("listener-null");
        setFirebaseUser(null);
      }
      setLoading(false);
    });

    return () => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }, [firebaseAuth]);

  useEffect(() => {
    const run = async () => {
      if (!FB_READY || !firebaseUser) return;

      // In dev, use same-origin + Vite proxy to avoid CORS for /auth/*
      const rawAuthBase = (import.meta.env.VITE_PP_AUTH_BASE_URL || MENU_BASE || "").replace(
        /\/+$/,
        "",
      );
      const url = `${rawAuthBase}/auth/firebase`;

      try {
        const idToken = await firebaseUser.getIdToken(true);
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
          console.warn("[auth] /auth/firebase failed:", data?.error || res.status);
          return;
        }
        saveSession(data.token, data.user);
      } catch (e) {
        console.warn("[auth] /auth/firebase exception:", e?.message || e);
      }
    };

    run();
  }, [firebaseUser]);

  // Dev-only: clear bad photoURL if using legacy firebasestorage.app links
  useEffect(() => {
    if (FB_READY && firebaseUser) {
      clearBadPhotoUrlIfNeeded(firebaseUser).catch(() => {});
    }
  }, [firebaseUser]);

  // Persist local session when it changes
  useEffect(() => {
    if (localSession && localSession.user) {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(localSession));
    } else {
      localStorage.removeItem(LOCAL_KEY);
    }
  }, [localSession]);

  // ---- public auth actions ----
  const loginWithGoogle = React.useCallback(async () => {
    await signInWithProvider(() => {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      return provider;
    });
  }, [signInWithProvider]);
  const loginWithApple = React.useCallback(async () => {
    if (!PP_ENABLE_APPLE_LOGIN) {
      console.warn("[auth] Apple login disabled (feature flag off).");
      return;
    }
    const factory = () => {
      const provider = new OAuthProvider("apple.com");
      provider.addScope("email");
      provider.addScope("name");
      return provider;
    };
    // hint: Apple prefers redirect on mobile
    factory.__forceRedirect = true;
    await signInWithProvider(factory);
  }, [signInWithProvider]);

  // Called by your password modal on success
  const loginLocal = React.useCallback(
    (phone, displayName = "", token = null, userOverride = null) => {
      try {
        if (FB_READY && firebaseAuth?.currentUser) {
          // Ensure local auth takes precedence over any lingering Firebase session.
          fbSignOut(firebaseAuth).catch(() => {});
        }
      } catch {}
      const baseUser =
        userOverride && typeof userOverride === "object"
          ? { ...userOverride }
          : {
              uid: `local:${phone}`,
              phoneNumber: phone,
              displayName: displayName || phone,
              providerId: "local",
            };

      const phoneValue =
        baseUser.phoneNumber || baseUser.phone || phone || "";
      if (!baseUser.providerId) baseUser.providerId = "local";
      if (!baseUser.uid) baseUser.uid = `local:${phoneValue || baseUser.id || ""}`;
      if (!baseUser.phoneNumber && phoneValue) baseUser.phoneNumber = phoneValue;
      if (!baseUser.phone && phoneValue) baseUser.phone = phoneValue;
      if (!baseUser.displayName)
        baseUser.displayName = displayName || phoneValue;

      setLocalSession({ token: token || null, user: baseUser });
      return baseUser;
    },
    [setLocalSession],
  );
  const signupLocal = React.useCallback(
    ({ phone, displayName, token = null, user = null } = {}) =>
      loginLocal(phone, displayName, token, user),
    [loginLocal],
  );

  const logoutLocal = React.useCallback(
    () => setLocalSession(null),
    [setLocalSession],
  );

  const logout = React.useCallback(async () => {
    try {
      if (FB_READY && firebaseAuth) {
        await fbSignOut(firebaseAuth);
      }
    } catch (err) {
      console.error("Logout failed:", err);
    } finally {
      localStorage.removeItem("pp_session_v1");
      logoutLocal();
    }
  }, [logoutLocal]);

  // prefer local user when local auth is active; otherwise fall back to Firebase user
  const preferLocal =
    !!localUser &&
    (localUser.providerId === "local" ||
      String(localUser.uid || "").startsWith("local:"));
  const currentUser = preferLocal ? localUser : firebaseUser || localUser;

  /** @type {AuthContextType} */
  const authValue = useMemo(
    () => ({
      currentUser,
      loginWithGoogle,
      loginWithApple,
      loginLocal,
      signupLocal,
      logout,
      loading,
      showLogin,
      loginTab,
      openLogin,
      closeLogin,
      setLoginTab,
    }),
    [
      currentUser,
      loginWithGoogle,
      loginWithApple,
      loginLocal,
      signupLocal,
      logout,
      loading,
      showLogin,
      loginTab,
      openLogin,
      closeLogin,
      setLoginTab,
    ],
  );

  const userKey =
    currentUser && typeof currentUser === "object"
      ? currentUser.uid ||
        currentUser.email ||
        currentUser.phoneNumber ||
        "user"
      : "anon";

  const Banner = () => (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        right: 0,
        padding: "4px 8px",
        fontSize: 11,
        background: "rgba(0,0,0,0.65)",
        color: "#fff",
        zIndex: 15,
        pointerEvents: "none",
        borderTopLeftRadius: 6,
        fontFamily: "var(--font-body, sans-serif)",
      }}
    >
      {loading
        ? "auth: loading-"
        : currentUser
          ? `auth: ${currentUser.email || currentUser.uid}`
          : "auth: signed out"}
    </div>
  );

  return (
    <AuthContext.Provider value={authValue}>
      <div key={userKey}>
        {children}
        <Banner />
      </div>
    </AuthContext.Provider>
  );
}

/*** -------------------------------------------------------------
 *  INLINE CONTEXTS + HELPERS + COMPONENTS (from /context, /components, /utils)
 *  - CartContext (CartProvider, useCart)
 *  - ThemeContext (ThemeProvider, useTheme)
 *  - Helpers: getProductImageUrl, formatId
 *  - ErrorBoundary, FirebaseBanner, QuickNav, Menu, ItemDetailPanel, OrderSummaryPanel, ThemeSwitcher
 *  Place above the rest so App can reference them without imports.
 *  ------------------------------------------------------------ */

// CartContext
// Default functions accept parameters so TS doesn't infer zero-arg signatures
const CartContext = createContext({
  cart: [],
  addToCart: (_items) => {},
  removeFromCart: (_index) => {},
  clearCart: () => {},
  totalPrice: 0,
});
function CartProvider({ children }) {
  const [cart, setCart] = useState([]);
  const addToCart = (itemsToAdd) => {
    setCart((prevCart) => {
      const newCart = [...prevCart];
      itemsToAdd.forEach((itemToAdd) => {
        const normalizedItem = {
          ...itemToAdd,
          size: makeSizeRecord(itemToAdd.size),
        };
        const idx = newCart.findIndex((cartItem, existingIdx) => {
          const existingSize = makeSizeRecord(cartItem.size);
          const matches =
            cartItem.name === normalizedItem.name &&
            existingSize.ref === normalizedItem.size.ref &&
            cartItem.isGlutenFree === normalizedItem.isGlutenFree &&
            JSON.stringify(cartItem.add_ons) ===
              JSON.stringify(normalizedItem.add_ons) &&
            JSON.stringify(cartItem.removedIngredients) ===
              JSON.stringify(normalizedItem.removedIngredients) &&
            JSON.stringify(cartItem.bundle_items || null) ===
              JSON.stringify(normalizedItem.bundle_items || null);
          if (matches && (typeof cartItem.size === "string" || !cartItem.size?.ref)) {
            newCart[existingIdx] = { ...cartItem, size: existingSize };
          }
          return matches;
        });
        if (idx > -1) newCart[idx].qty += normalizedItem.qty;
        else newCart.push(normalizedItem);
      });
      return newCart;
    });
  };
  const removeFromCart = (index) =>
    setCart((prev) => prev.filter((_, i) => i !== index));
  const clearCart = () => setCart([]);
  const totalPrice = useMemo(
    () => cart.reduce((sum, it) => sum + it.price * it.qty, 0),
    [cart],
  );
  return (
    <CartContext.Provider
      value={{ cart, addToCart, removeFromCart, clearCart, totalPrice }}
    >
      {children}
    </CartContext.Provider>
  );
}
function useCart() {
  return useContext(CartContext);
}

// ThemeContext
const ThemeContext = createContext({
  theme: "dark",
  setTheme: (_v) => {},
});
function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "dark";
    const stored = window.localStorage.getItem("pp_theme");
    return stored === "light" || stored === "dark" ? stored : "dark";
  });
  const themeTransitionTimer = React.useRef(null);
  useEffect(() => {
    try {
      document.body.setAttribute("data-theme", theme);
      document.documentElement.setAttribute("data-theme", theme);
      window.localStorage.setItem("pp_theme", theme);

      // smooth theme passage
      document.documentElement.setAttribute("data-theme-transition", "1");
      window.clearTimeout(themeTransitionTimer.current);
      themeTransitionTimer.current = window.setTimeout(() => {
        document.documentElement.removeAttribute("data-theme-transition");
      }, 380);
    } catch {
      // ignore
    }
    return () => window.clearTimeout(themeTransitionTimer.current);
  }, [theme]);
  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
function useTheme() {
  return useContext(ThemeContext);
}

// Helpers

const FALLBACK_IMAGE_URL = "/pizza-peppers-logo.jpg";

function cycleImgCandidates(imgEl, candidates) {
  if (!imgEl || !Array.isArray(candidates) || !candidates.length) {
    if (imgEl) imgEl.src = FALLBACK_IMAGE_URL;
    return;
  }
  const idx = Number(imgEl.dataset.ppImgTry || "0");
  const next = candidates[idx + 1];
  if (next) {
    imgEl.dataset.ppImgTry = String(idx + 1);
    imgEl.src = next;
  } else {
    imgEl.src = FALLBACK_IMAGE_URL;
  }
}

function formatId(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/ & /g, "-and-")
    .replace(/ /g, "-");
}

// ----------------- CARD HEADER SUPPRESSION (specific items) -----------------
const _ppNormName = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const _PP_HIDE_HEADERS_BY_NAME = new Set(
  [
    "Ham & Salami",
    "Seafood",
    "Tropical baked potato",
    "Bolognese Baked Potato",
    "Bacon Deluxe Baked Potato",
    "Our Signature Baked Potato",
    "Ribs",
    "Homemade Lasagna Bolognese",
  ].map(_ppNormName),
);

function shouldHideMenuCardHeader(item) {
  const nameKey = _ppNormName(item?.name);
  if (nameKey && _PP_HIDE_HEADERS_BY_NAME.has(nameKey)) return true;

  const catRef = String(item?.category_ref || item?.categoryRef || "").toUpperCase();
  if (catRef === "CALZONE") return true;

  // Safety: if "Calzone ..." but category ref is missing/mis-shaped
  if (String(item?.name || "").toLowerCase().startsWith("calzone")) return true;

  return false;
}

// --- Image lift list (EXCLUDES meal deals) ---
const _ppNorm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const _PP_IMG_LIFT_NAMES = new Set(
  [
    "Ham & Salami",
    "Seafood",
    "Tropical baked potato",
    "Bolognese Baked Potato",
    "Bacon Deluxe Baked Potato",
    "Our Signature Baked Potato",
    "Ribs",
    "Homemade Lasagna Bolognese",
  ].map(_ppNorm),
);

function shouldLiftCardImage(item, isMealDeal) {
  if (isMealDeal) return false; // never touch specials/meal deals

  const nameKey = _ppNorm(item?.name);
  if (nameKey && _PP_IMG_LIFT_NAMES.has(nameKey)) return true;

  // All Calzone pizzas (but not meal deals)
  const catRef = String(item?.category_ref || item?.categoryRef || "").toUpperCase();
  if (catRef === "CALZONE") return true;

  // Safety if category_ref missing
  if (String(item?.name || "").toLowerCase().startsWith("calzone")) return true;

  return false;
}

// ErrorBoundary
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("ErrorBoundary caught:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 16 }}>
          <h2>Something went wrong.</h2>
          <pre style={{ whiteSpace: "pre-wrap" }}>
            {String(this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// FirebaseBanner (uses FB_READY from firebase import already in this file)
function FirebaseBanner() {
  if (typeof FB_READY !== "undefined" && FB_READY) return null;
  if (typeof window !== "undefined") {
    try {
      if (window.localStorage.getItem("pp_hide_fb_banner") === "1") return null;
    } catch {}
  }
  return (
    <div
      style={{
        background: "#3b82f6",
        color: "white",
        padding: "8px 12px",
        fontSize: 13,
        position: "fixed",
        left: 8,
        bottom: 8,
        borderRadius: 8,
        zIndex: 15,
        pointerEvents: "none",
        display: "flex",
        gap: 10,
        alignItems: "center",
      }}
    >
      <span>
        Firebase not configured - sign-in & uploads are disabled in dev.
      </span>
      <button
        type="button"
        onClick={() => {
          try {
            if (typeof window !== "undefined") {
              window.localStorage.setItem("pp_hide_fb_banner", "1");
            }
          } catch {}
          if (typeof window !== "undefined") {
            window.location.reload();
          }
        }}
        style={{
          background: "rgba(255,255,255,0.2)",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          padding: "2px 8px",
          cursor: "pointer",
        }}
        aria-label="Dismiss"
      >
        Dismiss
      </button>
    </div>
  );
}

// QuickNav
function QuickNav({ menuData, activeCategory, usePortal }) {
  const shellRef = useRef(null);      // sticky container (NOT scrollable)
  const scrollerRef = useRef(null);   // inner horizontal scroller
  const chipRefs = useRef({});        // store <a> nodes (for focus + centering)
  const jumpLockRef = useRef(false);
  const jumpRafRef = useRef(null);
  const qnavSnapTimerRef = useRef(null);
  const qnavSnappingRef = useRef(false);
  const qnavProgrammaticTimerRef = useRef(null);
  const qnavProgrammaticUntilRef = useRef(0);
  const qnavSuppressFollowUntilRef = useRef(0);
  const qnavTouchingRef = useRef(false);
  const qnavTouchTimerRef = useRef(null);
  const qnavPendingActiveRef = useRef({ id: null, t: 0, timer: null });
  const qnavVertScrollUntilRef = useRef(0);
  const qnavVertScrollTimerRef = useRef(null);
  const [qnavVertSettleTick, setQnavVertSettleTick] = useState(0);
  const lastArrowStateRef = useRef({ l: false, r: false });
  const qnavInitialSnapRef = useRef(0);
  const qnavFollowTimerRef = useRef(null);
  const qnavFollowTargetRef = useRef(null);
  const qnavLastFollowedRef = useRef(null);
  const qnavLastActiveRef = useRef(null);
  const qnavFollowCooldownRef = useRef(0);
  const [liveActive, setLiveActive] = React.useState(() => {
    const first = (menuData?.categories || [])[0];
    return first ? formatId(first.name) : null;
  });
  const liveRafRef = React.useRef(null);
  const activeScrollerRef = React.useRef(null);
  const lastScrollTargetRef = React.useRef(null);
  const effectiveActive = liveActive || activeCategory || null;

  // Keep CSS in sync with the ACTUAL sticky header height (2-row layouts, zoom, etc.)
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    const root = document.documentElement;
    const headerEl = document.querySelector(".pp-topnav");
    if (!headerEl) return;

    const apply = () => {
      const h = Math.ceil(headerEl.getBoundingClientRect().height || 0);
      if (h > 0) root.style.setProperty("--pp-topnav-h", `${h}px`);
    };

    apply();

    let ro = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => apply());
      ro.observe(headerEl);
    }

    window.addEventListener("resize", apply);
    return () => {
      window.removeEventListener("resize", apply);
      try { ro?.disconnect?.(); } catch {}
    };
  }, []);

  const suppressActiveFollow = React.useCallback((ms = 900) => {
    qnavSuppressFollowUntilRef.current = Date.now() + ms;
  }, []);

  const scrollId = React.useId ? React.useId() : "pp-qnav-scroll";

  const [isMobileQnav, setIsMobileQnav] = React.useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(max-width: 900px)").matches;
  });
  const [canScrollLeft, setCanScrollLeft] = React.useState(false);
  const [canScrollRight, setCanScrollRight] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(max-width: 900px)");
    const onChange = (e) => setIsMobileQnav(!!e.matches);
    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else mql.addListener(onChange);
    setIsMobileQnav(!!mql.matches);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", onChange);
      else mql.removeListener(onChange);
    };
  }, []);

  const updateArrowState = React.useCallback(() => {
    if (isMobileQnav) return; // mobile = free scroll, no state churn
    const el = scrollerRef.current;
    if (!el) return;
    const max = Math.max(0, (el.scrollWidth || 0) - (el.clientWidth || 0));
    const left = el.scrollLeft || 0;
    const l = left > 2;
    const r = left < max - 2;
    const prev = lastArrowStateRef.current;
    if (prev.l !== l) setCanScrollLeft(l);
    if (prev.r !== r) setCanScrollRight(r);
    lastArrowStateRef.current = { l, r };
  }, [isMobileQnav]);

  // Lock the "follow active chip" behaviour while arrows are moving.
  // Keep this VERY simple to avoid timer churn + jitter during scroll.
  const lockProgrammaticNavScroll = React.useCallback(
    (ms = 420) => {
      const until = Date.now() + ms;
      qnavProgrammaticUntilRef.current = Math.max(
        qnavProgrammaticUntilRef.current || 0,
        until,
      );
      qnavSnappingRef.current = true;

      if (qnavProgrammaticTimerRef.current) {
        clearTimeout(qnavProgrammaticTimerRef.current);
      }

      // Safety unlock (real unlock happens in onScroll when movement ends)
      qnavProgrammaticTimerRef.current = setTimeout(() => {
        if (Date.now() >= (qnavProgrammaticUntilRef.current || 0)) {
          qnavSnappingRef.current = false;
          updateArrowState();
        }
      }, ms + 80);
    },
    [updateArrowState],
  );

  const animateNavScrollTo = React.useCallback(
    (targetLeft) => {
      const el = scrollerRef.current;
      if (!el) return;

      const max = Math.max(0, (el.scrollWidth || 0) - (el.clientWidth || 0));
      const clamped = Math.max(0, Math.min(max, targetLeft));

      // If we're basically already there, don't animate (prevents tiny jitter moves)
      if (Math.abs((el.scrollLeft || 0) - clamped) < 1) {
        updateArrowState();
        return;
      }

      const distance = Math.abs((el.scrollLeft || 0) - clamped);
      lockProgrammaticNavScroll(Math.max(600, Math.min(2000, 520 + distance * 0.9)));

      try {
        el.scrollTo({ left: clamped, behavior: "smooth" });
      } catch {
        el.scrollLeft = clamped;
      }

      // Arrow enable/disable state can lag on some browsers; force refresh.
      requestAnimationFrame(updateArrowState);
      setTimeout(updateArrowState, 220);
      setTimeout(updateArrowState, 520);
    },
    [lockProgrammaticNavScroll, updateArrowState],
  );

  const snapQuickNavToWholePills = React.useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (isMobileQnav) return; // keep mobile free scroll
    if (qnavSnappingRef.current) return;

    const cRect = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    const padL = (parseFloat(cs.paddingLeft) || 0) + 6;
    const padR = (parseFloat(cs.paddingRight) || 0) + 6;
    const leftEdge = cRect.left + padL;
    const rightEdge = cRect.right - padR;

    const links = Array.from(el.querySelectorAll('a[data-qnav-link="1"]'));
    if (!links.length) return;

    // Find first visible link and ensure its LEFT edge isn't cut
    let delta = 0;

    for (const a of links) {
      const r = a.getBoundingClientRect();
      if (r.right > leftEdge) {
        if (r.left < leftEdge) {
          delta = r.left - leftEdge; // negative => scroll left to reveal
        }
        break;
      }
    }

    // If no left fix needed, ensure last visible link isn't cut on the RIGHT
    if (Math.abs(delta) < 1) {
      for (let i = links.length - 1; i >= 0; i--) {
        const r = links[i].getBoundingClientRect();
        if (r.left < rightEdge) {
          if (r.right > rightEdge) {
            delta = r.right - rightEdge; // positive => scroll right to reveal
          }
          break;
        }
      }
    }

    if (Math.abs(delta) < 1) return;

    qnavSnappingRef.current = true;
    try {
      el.scrollBy({ left: delta, behavior: "smooth" });
    } catch {
      el.scrollLeft = (el.scrollLeft || 0) + delta;
    }

    setTimeout(() => {
      qnavSnappingRef.current = false;
      updateArrowState();
    }, 220);
  }, [isMobileQnav, updateArrowState]);

  // After refresh/layout settle, snap the rail and ensure the active chip is visible.
  React.useEffect(() => {
    if (isMobileQnav) return;
    const menuCount = menuData?.categories?.length || 0;
    if (!menuCount) return;
    if (qnavInitialSnapRef.current === menuCount) return;
    qnavInitialSnapRef.current = menuCount;

    const el = scrollerRef.current;
    if (!el) return;

    const activeId = effectiveActive;

    const run = () => {
      const rail = scrollerRef.current;
      if (!rail) return;

      // If the page loaded at top (or no hash), force rail to true start before snapping.
      try {
        const atTop = (document.scrollingElement?.scrollTop || 0) < 2;
        const hasHash = !!(window.location.hash && window.location.hash.length > 1);
        if (atTop && !hasHash) {
          rail.scrollLeft = 0;
        }
      } catch {}

      // Allow snap to run (it bails if "programmatic lock" is active)
      qnavSnappingRef.current = false;

      // 1) Snap the rail so no chip is half-cut
      try {
        snapQuickNavToWholePills();
      } catch {}

      // 2) If we already know an active chip, ensure it's comfortably visible
      try {
        if (activeId) {
          const chipEl = chipRefs.current[activeId];
          if (chipEl) {
            const cRect = rail.getBoundingClientRect();
            const chipRect = chipEl.getBoundingClientRect();

            // Treat the sticky arrow buttons as "unsafe areas"
            const leftBtn = shellRef.current?.querySelector(".quick-nav-arrow--left");
            const rightBtn = shellRef.current?.querySelector(".quick-nav-arrow--right");

            const leftEdge = leftBtn
              ? leftBtn.getBoundingClientRect().right + 10
              : cRect.left + 18;

            const rightEdge = rightBtn
              ? rightBtn.getBoundingClientRect().left - 10
              : cRect.right - 18;

            const leftOk = chipRect.left >= leftEdge;
            const rightOk = chipRect.right <= rightEdge;

            if (!leftOk || !rightOk) {
              const safeCenter = leftEdge + (rightEdge - leftEdge) / 2;
              const chipCenter = chipRect.left + chipRect.width / 2;
              const delta = chipCenter - safeCenter;

              const max = Math.max(0, (rail.scrollWidth || 0) - (rail.clientWidth || 0));
              const target = Math.max(0, Math.min(max, (rail.scrollLeft || 0) + delta));

              // instant correction (no animation on load)
              rail.scrollLeft = target;
            }
          }
        }
      } catch {}

      // 3) refresh arrow enabled/disabled state
      try {
        updateArrowState();
      } catch {}
    };

    const r1 = requestAnimationFrame(run);
    const r2 = requestAnimationFrame(() => requestAnimationFrame(run));
    const t1 = window.setTimeout(run, 80);
    const t2 = window.setTimeout(run, 220);

    return () => {
      try { cancelAnimationFrame(r1); } catch {}
      try { cancelAnimationFrame(r2); } catch {}
      try { window.clearTimeout(t1); } catch {}
      try { window.clearTimeout(t2); } catch {}
    };
  }, [isMobileQnav, menuData?.categories?.length, snapQuickNavToWholePills, updateArrowState]);

  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (isMobileQnav) return; // no scroll handler on mobile
    updateArrowState();
    const onScroll = () => {
      // Any nav-rail movement (user OR programmatic) should suppress follow briefly
      suppressActiveFollow(900);

      // Always update arrows on desktop
      updateArrowState();

      // If we're still in programmatic movement window, keep it locked.
      if (Date.now() < (qnavProgrammaticUntilRef.current || 0)) {
        qnavSnappingRef.current = true;

        // Extend lock slightly each tick so smooth scroll can't "fall out" mid-animation
        qnavProgrammaticUntilRef.current = Date.now() + 220;

        // Ensure we actually unlock after the last programmatic tick
        if (qnavProgrammaticTimerRef.current) {
          clearTimeout(qnavProgrammaticTimerRef.current);
        }
        const wait = Math.max(
          120,
          (qnavProgrammaticUntilRef.current || 0) - Date.now() + 80,
        );
        qnavProgrammaticTimerRef.current = setTimeout(() => {
          if (Date.now() >= (qnavProgrammaticUntilRef.current || 0)) {
            qnavSnappingRef.current = false;
            updateArrowState();
          }
        }, wait);

        // Never schedule settle-snap during programmatic movement
        if (qnavSnapTimerRef.current) clearTimeout(qnavSnapTimerRef.current);
        return;
      }

      // Programmatic movement is over
      qnavSnappingRef.current = false;

      // Desktop: do NOT "settle snap" (this is what causes the wiggle).
      // Only keep settle snap for touch/mobile-style interactions.
      if (!isMobileQnav && !qnavTouchingRef.current) return;

      if (qnavSnapTimerRef.current) clearTimeout(qnavSnapTimerRef.current);
      qnavSnapTimerRef.current = setTimeout(() => {
        snapQuickNavToWholePills();
      }, 120);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (qnavSnapTimerRef.current) clearTimeout(qnavSnapTimerRef.current);
      if (qnavProgrammaticTimerRef.current) clearTimeout(qnavProgrammaticTimerRef.current);
    };
  }, [isMobileQnav, lockProgrammaticNavScroll, suppressActiveFollow, updateArrowState, snapQuickNavToWholePills]);

  // Detect vertical scrolling in the *actual* scroll container and fire a "settled" tick.
  useEffect(() => {
    const onAnyScroll = () => {
      qnavVertScrollUntilRef.current = Date.now() + 320;

      if (qnavVertScrollTimerRef.current) {
        clearTimeout(qnavVertScrollTimerRef.current);
      }
      qnavVertScrollTimerRef.current = setTimeout(() => {
        setQnavVertSettleTick((v) => v + 1);
      }, 360);
    };

    const getDocScroller = () =>
      document.scrollingElement || document.documentElement;

    const getScrollParent = (el) => {
      let p = el?.parentElement;
      while (p) {
        const s = window.getComputedStyle(p);
        const oy = s.overflowY;
        if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight + 2) {
          return p;
        }
        p = p.parentElement;
      }
      return getDocScroller();
    };

    const menuRoot = pickMainMenuRoot();
    const parent = menuRoot ? getScrollParent(menuRoot) : getDocScroller();

    const isDocParent =
      parent === document.scrollingElement ||
      parent === document.documentElement ||
      parent === document.body;

    const target = isDocParent ? window : parent;
    target.addEventListener("scroll", onAnyScroll, { passive: true });
    window.addEventListener("resize", onAnyScroll);

    return () => {
      target.removeEventListener("scroll", onAnyScroll);
      window.removeEventListener("resize", onAnyScroll);
      if (qnavVertScrollTimerRef.current) clearTimeout(qnavVertScrollTimerRef.current);
    };
  }, [menuData?.categories?.length]);

  // Mobile: suppress "follow" while the user is actively dragging the nav rail.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const start = () => {
      qnavTouchingRef.current = true;
      suppressActiveFollow(1200);
      if (qnavTouchTimerRef.current) clearTimeout(qnavTouchTimerRef.current);
    };

    const end = () => {
      if (qnavTouchTimerRef.current) clearTimeout(qnavTouchTimerRef.current);
      qnavTouchTimerRef.current = setTimeout(() => {
        qnavTouchingRef.current = false;
      }, 220);
    };

    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", start, { passive: true });
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", end, { passive: true });

    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", start);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      if (qnavTouchTimerRef.current) clearTimeout(qnavTouchTimerRef.current);
    };
  }, [suppressActiveFollow]);

  // Re-check arrow state after layout/content changes (fonts, chip widths, etc.)
  React.useEffect(() => {
    if (isMobileQnav) return;
    const raf = requestAnimationFrame(() => updateArrowState());
    return () => cancelAnimationFrame(raf);
  }, [isMobileQnav, menuData?.categories?.length, updateArrowState]);

  const pickMainMenuRoot = () => {
    const candidates = Array.from(document.querySelectorAll(".menu-content"));
    if (!candidates.length) return null;

    const mainArea = document.querySelector(".main-content-area") || document.body;

    const scored = candidates
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 200 && rect.height > 200 && rect.bottom > 0;

        // prefer the one inside the real page content (not overlays)
        const inMain = mainArea.contains(el);

        // avoid modal/overlay menus
        const inOverlay = !!el.closest(
          ".pp-hh-mealPickBody, .pp-mealpick, .pp-halfhalf-modal, .pp-mealdeal-modal__panel, .pp-hh-editorModal, .modal-overlay, .pp-modal-backdrop",
        );

        const catCount = el.querySelectorAll(".menu-category[id]").length;

        const score =
          (inMain ? 1000 : 0) +
          (inOverlay ? -500 : 0) +
          (visible ? 100 : 0) +
          catCount * 10;
        return { el, score };
      })
      .sort((a, b) => b.score - a.score);

    return scored[0]?.el || null;
  };

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    let io = null;
    let raf = null;

    const build = () => {
      const menuRoot = pickMainMenuRoot();
      if (!menuRoot) return;

      const sections = Array.from(menuRoot.querySelectorAll(".menu-category[id]"))
        .filter((el) => (el.offsetHeight || 0) > 8);

      if (!sections.length) return;

      // Sticky "active line" (in viewport coords)
      const headerH =
        document.querySelector(".pp-topnav")?.getBoundingClientRect().height || 0;
      const navH = shellRef.current?.getBoundingClientRect().height || 0;
      const gap = 14;
      const lineY = headerH + navH + gap;

      const pickBest = () => {
        const EDGE = 12;

        const first = sections[0];
        const last = sections[sections.length - 1];

        const firstR = first.getBoundingClientRect();
        const lastR = last.getBoundingClientRect();

        // Sticky "active line" in viewport coords
        const viewH = window.innerHeight || 0;

        // Top lock: if we're near the top and the first section hasn't moved above the line much
        if (firstR.top >= lineY - EDGE) {
          setLiveActive(first.id);
          return;
        }

        // Bottom lock: if the last section is visible at the bottom of the viewport
        if (lastR.bottom <= viewH - EDGE) {
          setLiveActive(last.id);
          return;
        }

        // Main rule: pick the last section whose top is at/above the line (or not too far below)
        // Smaller window prevents switching to the next category too early.
        const BELOW_ALLOW = 160;

        let bestId = first.id;
        let bestTop = -Infinity;

        for (const el of sections) {
          const r = el.getBoundingClientRect();

          // ignore sections that are fully above viewport by a lot
          if (r.bottom < 30) continue;

          // candidate if top is not too far below the line
          if (r.top <= lineY + BELOW_ALLOW && r.top > bestTop) {
            bestTop = r.top;
            bestId = el.id;
          }
        }

        // Debounce active changes to prevent boundary flip-flop
        const now = performance.now();
        const pending = qnavPendingActiveRef.current;

        // If we’re already pending this id, let it settle
        if (pending.id === bestId) return;

        // New candidate: start a short settle timer
        pending.id = bestId;
        pending.t = now;

        if (pending.timer) clearTimeout(pending.timer);

        pending.timer = setTimeout(() => {
          qnavPendingActiveRef.current.id = null;
          qnavPendingActiveRef.current.timer = null;
          setLiveActive(bestId);
        }, 180);
      };

      // Root margin shifts the "viewport" down below sticky UI so edges behave.
      const topMargin = Math.round(lineY);
      const rootMargin = `-${topMargin}px 0px -10% 0px`;

      io = new IntersectionObserver(
        () => {
          // We don't need ratios; any intersection change is just a "tick" to recompute
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = null;
            pickBest();
          });
        },
        {
          root: null, // viewport
          rootMargin,
          threshold: [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 1],
        },
      );

      // Seed so first category is correct on initial render
      setLiveActive((prev) => prev || sections[0].id);

      for (const el of sections) io.observe(el);

      // Run once immediately
      pickBest();
    };

    const rebuild = () => {
      try {
        if (io) io.disconnect();
      } catch {}
      io = null;

      if (raf) {
        try {
          cancelAnimationFrame(raf);
        } catch {}
        raf = null;
      }
      build();
    };

    build();
    window.addEventListener("resize", rebuild);

      return () => {
        window.removeEventListener("resize", rebuild);
        try {
          if (io) io.disconnect();
        } catch {}
        if (raf) {
          try {
            cancelAnimationFrame(raf);
          } catch {}
        }
        try {
          const p = qnavPendingActiveRef.current;
          if (p?.timer) clearTimeout(p.timer);
        } catch {}
        qnavPendingActiveRef.current = { id: null, t: 0, timer: null };
      };
    }, [menuData]);

  const nudgeNav = React.useCallback((dir) => {
    const el = scrollerRef.current;
    if (!el) return;
    const amt = Math.round((el.clientWidth || 320) * 0.7);
    const dx = dir === "left" ? -amt : amt;
    try {
      el.scrollBy({ left: dx, behavior: "smooth" });
    } catch {
      el.scrollLeft = (el.scrollLeft || 0) + dx;
    }
    // Ensure arrow enable/disable state updates even if the browser batches scroll events
    requestAnimationFrame(() => updateArrowState());
    setTimeout(updateArrowState, 160);
    setTimeout(updateArrowState, 420);
    setTimeout(snapQuickNavToWholePills, 220);
  }, [updateArrowState, snapQuickNavToWholePills]);

  const jumpNavByChip = React.useCallback(
    (dir) => {
      const el = scrollerRef.current;
      if (!el) return;

      const max = Math.max(0, (el.scrollWidth || 0) - (el.clientWidth || 0));
      const cur = el.scrollLeft || 0;

      // Consistent "page" move so left/right feel identical
      const page = Math.round((el.clientWidth || 320) * 0.82);
      const desired = Math.max(0, Math.min(max, cur + (dir === "left" ? -page : page)));

      // Snap directionally so we NEVER rest mid-pill or "bounce back"
      const links = Array.from(el.querySelectorAll('a[data-qnav-link="1"]'));
      const pad = 12;

      let targetLeft = desired;

      if (links.length) {
        const wanted = desired + pad;
        let chosenLeft = null;

        if (dir === "right") {
          // first chip whose start is at/after the wanted position
          for (const a of links) {
            if (a.offsetLeft >= wanted) {
              chosenLeft = a.offsetLeft;
              break;
            }
          }
          // if none, clamp to last chip
          if (chosenLeft == null) chosenLeft = links[links.length - 1].offsetLeft;
        } else {
          // last chip whose start is at/before the wanted position
          for (let i = links.length - 1; i >= 0; i--) {
            if (links[i].offsetLeft <= wanted) {
              chosenLeft = links[i].offsetLeft;
              break;
            }
          }
          // if none, clamp to start
          if (chosenLeft == null) chosenLeft = 0;
        }

        targetLeft = Math.max(0, Math.min(max, chosenLeft - pad));
      }

      animateNavScrollTo(targetLeft);
    },
    [animateNavScrollTo],
  );

  const adjustNavForCategory = React.useCallback(
    (categoryId, behavior = "smooth") => {
      const container = scrollerRef.current;
      if (!container) return;

      const chipEl = chipRefs.current[categoryId];
      if (!chipEl) return;

      const ids = (menuData?.categories || [])
        .map((c) => formatId(c?.name || ""))
        .filter(Boolean);
      const firstId = ids[0];
      const lastId = ids[ids.length - 1];
      const isEdge = categoryId === firstId || categoryId === lastId;

      const max = Math.max(0, (container.scrollWidth || 0) - (container.clientWidth || 0));
      const cur = container.scrollLeft || 0;

      const cRect = container.getBoundingClientRect();
      const chipRect = chipEl.getBoundingClientRect();

      let targetLeft = cur;

      if (isMobileQnav && !isEdge) {
        // Mobile: center the active chip within the safe padded area.
        const cs = window.getComputedStyle(container);
        const padL = (parseFloat(cs.paddingLeft) || 0) + 6;
        const padR = (parseFloat(cs.paddingRight) || 0) + 6;
        const leftEdge = cRect.left + padL;
        const rightEdge = cRect.right - padR;
        const safeCenter = leftEdge + (rightEdge - leftEdge) / 2;
        const chipCenter = chipRect.left + chipRect.width / 2;
        const delta = chipCenter - safeCenter;
        targetLeft = Math.max(0, Math.min(max, cur + delta));
      } else {
        // Desktop (and mobile edges): ensure the chip is fully visible.
        const cs = window.getComputedStyle(container);
        const padL = (parseFloat(cs.paddingLeft) || 0) + 6;
        const padR = (parseFloat(cs.paddingRight) || 0) + 6;
        const leftOk = chipRect.left >= cRect.left + padL;
        const rightOk = chipRect.right <= cRect.right - padR;
        if (leftOk && rightOk) return;

        const chipCenter = chipRect.left + chipRect.width / 2;
        const containerCenter = cRect.left + cRect.width / 2;
        const delta = chipCenter - containerCenter;
        targetLeft = Math.max(0, Math.min(max, cur + delta));
      }

      const distance = Math.abs(targetLeft - cur);
      if (distance < 1) return;

      lockProgrammaticNavScroll(Math.max(500, Math.min(1400, 420 + distance * 0.9)));

      try {
        container.scrollTo({ left: targetLeft, behavior });
      } catch {
        container.scrollLeft = targetLeft;
      }

      requestAnimationFrame(updateArrowState);
    },
    [isMobileQnav, lockProgrammaticNavScroll, menuData?.categories, updateArrowState],
  );

  const focusChipByIndex = React.useCallback((index) => {
    const el = scrollerRef.current;
    if (!el) return;
    const links = Array.from(el.querySelectorAll('a[data-qnav-link="1"]'));
    if (!links.length) return;

    const clamped = Math.max(0, Math.min(index, links.length - 1));
    const target = links[clamped];
    target?.focus?.();

    // keep focused chip comfortably visible (desktop)
    if (!isMobileQnav && target) {
      const cRect = el.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      const pad = 16;
      if (r.left < cRect.left + pad || r.right > cRect.right - pad) {
        const delta = (r.left + r.width / 2) - (cRect.left + cRect.width / 2);
        try { el.scrollBy({ left: delta, behavior: "smooth" }); }
        catch { el.scrollLeft = (el.scrollLeft || 0) + delta; }
      }
    }
  }, [isMobileQnav]);

  const onQuickNavKeyDown = React.useCallback((e) => {
    const el = scrollerRef.current;
    if (!el) return;

    const links = Array.from(el.querySelectorAll('a[data-qnav-link="1"]'));
    if (!links.length) return;

    const activeEl = document.activeElement;
    const curIdx = links.findIndex((n) => n === activeEl);

    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusChipByIndex((curIdx === -1 ? 0 : curIdx + 1));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusChipByIndex((curIdx === -1 ? 0 : curIdx - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      focusChipByIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusChipByIndex(links.length - 1);
    }
  }, [focusChipByIndex]);

  const beginJumpLock = (scroller) => {
    if (!scroller) return;

    // lock the follow-scroll behaviour while we animate to target
    jumpLockRef.current = true;

    // cancel any previous watcher
    try {
      if (jumpRafRef.current) cancelAnimationFrame(jumpRafRef.current);
    } catch {}
    jumpRafRef.current = null;

    const settleMs = 140; // "no movement" window
    const maxMs = 1400; // safety unlock
    const start = performance.now();

    let lastTop = scroller.scrollTop || 0;
    let lastMoveAt = performance.now();

    const tick = () => {
      const now = performance.now();
      const curTop = scroller.scrollTop || 0;

      if (Math.abs(curTop - lastTop) > 0.5) {
        lastTop = curTop;
        lastMoveAt = now;
      }

      // unlock when scroll has settled (or we hit max time)
      if (now - lastMoveAt > settleMs || now - start > maxMs) {
        jumpLockRef.current = false;
        jumpRafRef.current = null;
        return;
      }

      jumpRafRef.current = requestAnimationFrame(tick);
    };

    jumpRafRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    return () => {
      try {
        if (jumpRafRef.current) cancelAnimationFrame(jumpRafRef.current);
      } catch {}
    };
  }, []);

  const getScrollContainer = (el) => {
    // Find the nearest scrollable parent; fallback to the page scroller.
    let p = el?.parentElement;
    while (p) {
      const s = window.getComputedStyle(p);
      const oy = s.overflowY;
      if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) {
        return p;
      }
      p = p.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };

  const scrollToCategory = (categoryId) => {
    const target = document.getElementById(categoryId);
    if (!target) return;

    const scroller = getScrollContainer(target);

    beginJumpLock(scroller);

    const headerH =
      document.querySelector(".pp-topnav")?.getBoundingClientRect().height || 0;
    const navH = shellRef.current?.getBoundingClientRect().height || 0;

    const gap = 6;

    const scrollerRectTop =
      scroller === document.scrollingElement ||
      scroller === document.documentElement ||
      scroller === document.body
        ? 0
        : scroller.getBoundingClientRect().top;

    const targetTop =
      target.getBoundingClientRect().top -
      scrollerRectTop +
      (scroller.scrollTop || 0);

    const top = Math.max(0, targetTop - headerH - navH - gap);

    try {
      scroller.scrollTo({ top, behavior: "smooth" });
    } catch {
      scroller.scrollTop = top;
    }
  };

  // Keep the active chip visible. During vertical scroll, follow with a light throttle.
  useEffect(() => {
    if (qnavFollowTimerRef.current) {
      clearTimeout(qnavFollowTimerRef.current);
      qnavFollowTimerRef.current = null;
    }

    if (jumpLockRef.current) return;
    if (qnavSnappingRef.current) return;
    if (qnavTouchingRef.current) return;
    if (Date.now() < qnavSuppressFollowUntilRef.current) return;

    const container = scrollerRef.current;
    if (!container) return;
    if (!effectiveActive) return;

    const now = Date.now();
    const scrollingVert = now < qnavVertScrollUntilRef.current;
    const activeChanged = qnavLastActiveRef.current !== effectiveActive;

    // During vertical scrolling, only follow on actual category changes
    // and throttle updates to prevent jitter.
    if (scrollingVert && !activeChanged) return;
    if (scrollingVert && now < qnavFollowCooldownRef.current) return;
    if (scrollingVert) qnavFollowCooldownRef.current = now + 220;

    const targetId = effectiveActive;
    qnavFollowTargetRef.current = targetId;
    qnavLastActiveRef.current = targetId;

    qnavFollowTimerRef.current = setTimeout(() => {
      if (qnavFollowTargetRef.current !== targetId) return;

      const chipEl = chipRefs.current[targetId];
      if (!chipEl) return;

      const cRect = container.getBoundingClientRect();
      const chipRect = chipEl.getBoundingClientRect();

      const ids = (menuData?.categories || [])
        .map((c) => formatId(c?.name || ""))
        .filter(Boolean);
      const firstId = ids[0];
      const lastId = ids[ids.length - 1];
      const isEdge = targetId === firstId || targetId === lastId;

      const max = Math.max(0, (container.scrollWidth || 0) - (container.clientWidth || 0));
      const cur = container.scrollLeft || 0;

      let targetLeft = null;

      if (isMobileQnav && !isEdge) {
        // Mobile: keep the active chip centered (except first/last).
        const cs = window.getComputedStyle(container);
        const padL = (parseFloat(cs.paddingLeft) || 0) + 6;
        const padR = (parseFloat(cs.paddingRight) || 0) + 6;
        const leftEdge = cRect.left + padL;
        const rightEdge = cRect.right - padR;
        const safeCenter = leftEdge + (rightEdge - leftEdge) / 2;
        const chipCenter = chipRect.left + chipRect.width / 2;
        const delta = chipCenter - safeCenter;
        targetLeft = Math.max(0, Math.min(max, cur + delta));
      } else {
        // Desktop (and mobile edges): just ensure the chip is fully visible.
        const cs = window.getComputedStyle(container);
        const padL = (parseFloat(cs.paddingLeft) || 0) + 6;
        const padR = (parseFloat(cs.paddingRight) || 0) + 6;
        const leftOk = chipRect.left >= cRect.left + padL;
        const rightOk = chipRect.right <= cRect.right - padR;

        if (leftOk && rightOk) {
          qnavLastFollowedRef.current = targetId;
          return;
        }

        const chipCenter = chipRect.left + chipRect.width / 2;
        const containerCenter = cRect.left + cRect.width / 2;
        const delta = chipCenter - containerCenter;
        targetLeft = Math.max(0, Math.min(max, cur + delta));
      }

      const distance = Math.abs((targetLeft ?? cur) - cur);
      if (distance < 18) return;
      const behavior = scrollingVert || distance < 28 ? "auto" : "smooth";
      try {
        container.scrollTo({ left: targetLeft, behavior });
      } catch {
        container.scrollLeft = targetLeft ?? cur;
      }

      qnavLastFollowedRef.current = targetId;
      requestAnimationFrame(updateArrowState);
    }, scrollingVert ? 80 : 200);

    return () => {
      if (qnavFollowTimerRef.current) {
        clearTimeout(qnavFollowTimerRef.current);
        qnavFollowTimerRef.current = null;
      }
    };
  }, [effectiveActive, qnavVertSettleTick, isMobileQnav, updateArrowState]);

  const nav = (
    <nav
      className={[
        "quick-nav-container",
        !isMobileQnav ? "quick-nav-container--arrows" : "",
        !isMobileQnav && !canScrollLeft && !canScrollRight
          ? "quick-nav--fits"
          : "",
      ].join(" ")}
      ref={shellRef}
      aria-label="Menu categories"
    >
      <div className="quick-nav-scroll">
        {!isMobileQnav ? (
          <button
            type="button"
            className="quick-nav-arrow quick-nav-arrow--left"
            aria-label="Scroll categories left"
            aria-disabled={!canScrollLeft}
            data-disabled={!canScrollLeft ? "1" : "0"}
            onClick={() => {
              const el = scrollerRef.current;
              if (!el || (el.scrollLeft || 0) <= 2) return;
              suppressActiveFollow(2600);
              jumpNavByChip("left");
            }}
          >
            {"\u2039"}
          </button>
        ) : null}

        <div
          id={scrollId}
          className="quick-nav-rail"
          ref={scrollerRef}
          onKeyDown={onQuickNavKeyDown}
        >
          <ul className="quick-nav-list" role="list">
            {(menuData?.categories || []).map((category) => {
              const categoryId = formatId(category.name);
              const isActive = effectiveActive === categoryId;

              return (
                <li key={category.name} className="quick-nav-item">
                  <a
                    data-qnav-link="1"
                    href={`#${categoryId}`}
                    className={isActive ? "active-nav-link" : ""}
                    aria-current={isActive ? "page" : undefined}
                    ref={(el) => {
                      if (el) chipRefs.current[categoryId] = el;
                    }}
                    onClick={(e) => {
                      e.preventDefault();
                      scrollToCategory(categoryId);
                      try {
                        requestAnimationFrame(() => {
                          adjustNavForCategory(categoryId);
                        });
                      } catch {}
                      try {
                        window.history.replaceState(null, "", `#${categoryId}`);
                      } catch {}
                    }}
                  >
                    {category.name}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>

        {!isMobileQnav ? (
          <button
            type="button"
            className="quick-nav-arrow quick-nav-arrow--right"
            aria-label="Scroll categories right"
            aria-disabled={!canScrollRight}
            data-disabled={!canScrollRight ? "1" : "0"}
            onClick={() => {
              if (!canScrollRight) return;
              suppressActiveFollow(2600);
              jumpNavByChip("right");
            }}
          >
            {"\u203A"}
          </button>
        ) : null}
      </div>
    </nav>
  );


  if (!usePortal || typeof document === "undefined") {
    return nav;
  }

  const portalTarget = document.querySelector(".pp-qnav-slot");
  return portalTarget ? createPortal(nav, portalTarget) : nav;
}

function HalfHalfPizzaThumbnail() {
  return (
    <img
      src={getProductImageUrl({ name: "Half & Half" }) || FALLBACK_IMAGE_URL}
      alt="Half & Half"
      className="card-image"
      onError={(e) => {
        try {
          const t = e.currentTarget;
          if (t.src.includes(FALLBACK_IMAGE_URL)) {
            t.style.display = "none";
            if (t.parentElement) {
              t.parentElement.style.backgroundColor = "#374151";
            }
          } else {
            t.src = FALLBACK_IMAGE_URL;
          }
        } catch {}
      }}
    />
  );
}

// Menu
function Menu({ menuData, onItemClick }) {
  return (
    <div className="menu-content">
      {(menuData?.categories || []).map((category) => (
        <div
          key={category.name}
          className="menu-category"
          id={formatId(category.name)}
        >
          <h2 className="category-title">{category.name}</h2>
          <div className="menu-grid">
            {(category.items || []).map((item) => {
              const isHalfHalf =
                item.isHalfHalf === true || item.id === "half_half";
              const displayImage = !isHalfHalf
                ? getProductImageUrl(item)
                : getProductImageUrl({ name: "Half & Half" });
              const imgSrc = displayImage || FALLBACK_IMAGE_URL;
              const isMealDeal =
                item?.bundle &&
                Array.isArray(item.bundle.slots) &&
                item.bundle.slots.length > 0;
              const isDessertComboMealDeal =
                String(item?.name || "").trim().toLowerCase() ===
                "dessert combo meal deal";
              const hideHeader = shouldHideMenuCardHeader(item);
              return (
                <div
                  key={item.id || item.name}
                  className={[
                    "menu-item-card",
                    isMealDeal ? "menu-item-card--mealdeal" : "",
                    isDessertComboMealDeal ? "pp-card--dessert-combo" : "",
                  ].join(" ")}
                  data-pp-noheader={hideHeader ? "1" : "0"}
                  data-pp-imglift={shouldLiftCardImage(item, isMealDeal) ? "1" : "0"}
                  onClick={() => onItemClick(item)}
                >
                  <div className="card-image-container">
                    {isHalfHalf ? (
                      <HalfHalfPizzaThumbnail />
                    ) : displayImage ? (
                      <img
                        key={imgSrc}
                        src={imgSrc}
                        alt={item.name}
                        className="card-image"
                        onError={(e) => {
                          try {
                            const t = e.currentTarget;
                            if (t.src.includes(FALLBACK_IMAGE_URL)) {
                              // Even the fallback failed: hide the img and keep the grey box.
                              t.style.display = "none";
                              if (t.parentElement) {
                                t.parentElement.style.backgroundColor = "#374151";
                              }
                            } else {
                              // First failure: swap to local fallback logo.
                              t.src = FALLBACK_IMAGE_URL;
                            }
                          } catch {}
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: "100%",
                          height: "100%",
                          backgroundColor: "#1f2937",
                        }}
                      />
                    )}
                    {/* NEW: overlay name + price on the image */}
                    <div className="pp-cardOverlay" aria-hidden="true">
                      {isMealDeal ? (
                        <div className="pp-mealdealOverlayMeta">
                          <div className="pp-mealdealPrice">
                            {currency(minPriceCents(item))}
                          </div>
                          {!hideHeader && (
                            <div className="pp-mealdealName">{item.name}</div>
                          )}
                        </div>
                      ) : (
                        <div className="pp-cardOverlay__row">
                          {!hideHeader && (
                            <div className="pp-cardOverlay__title">
                              {item.name}
                            </div>
                          )}
                          <div className="pp-cardOverlay__price">
                            {currency(minPriceCents(item))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Description lives under the image (optional) */}
                  {item.description ? (
                    <div className="card-text-container">
                      <p className="card-item-description">
                        {item.description}
                      </p>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function getAddOnsForProduct(product, menu) {
  if (!product || !menu) return [];

  // Use the raw menu products so we always see the real option_list_refs
  const apiRoot = menu.raw || menu;
  const products = Array.isArray(apiRoot?.products) ? apiRoot.products : [];

  let baseProduct = product;

  if (products.length) {
    const productId = product.id || product.product_id || product.ref;

    if (productId != null) {
      const byId = products.find((p) => p && p.id === productId);
      if (byId) {
        baseProduct = byId;
      }
    }

    if (baseProduct === product && product.name) {
      const byName = products.find((p) => p && p.name === product.name);
      if (byName) {
        baseProduct = byName;
      }
    }
  }

  const categoryRef = (
    baseProduct.category_ref ||
    baseProduct.categoryRef ||
    ""
  ).toString();
  const categoryLower = categoryRef.toLowerCase();

  // No extras for drinks
  if (/drink|beverage/.test(categoryLower)) return [];
  // No extras for meal deals (they have their own logic)
  if (__categoryGuards.isMealDeal(categoryRef)) return [];

  // Option lists catalog from the API (option_lists in menu.json)
  const optionLists = Array.isArray(apiRoot?.option_lists)
    ? apiRoot.option_lists
    : Array.isArray(menu?.option_lists)
      ? menu.option_lists
      : [];

  // Per-product allowed addon categories (EXTRAS_CHEESE, EXTRAS_MEAT, etc)
  const explicitRefs =
    baseProduct.option_list_refs ||
    baseProduct.optionListRefs ||
    baseProduct.optionLists ||
    [];

  const normalizeListRef = (val) => {
    const raw = (val ?? "").toString().trim().toUpperCase();
    return raw.replace(/^EXTRAS?_/, "");
  };

  let lists = [];
  if (Array.isArray(explicitRefs) && explicitRefs.length) {
    const refSet = new Set(explicitRefs.map((ref) => normalizeListRef(ref)));
    lists = optionLists.filter((ol) => {
      if (!ol) return false;
      const rawRef = ol.ref || ol.id || "";
      return refSet.has(normalizeListRef(rawRef));
    });
  } else {
    lists = getApplicableOptionGroups(baseProduct, menu);
  }

  // Shape them for the addons modal, respecting per-option `enabled`
  return (lists || [])
    .map((ol) => {
      const optionsRaw = ol.options || ol.items || [];

      const options = optionsRaw
        .filter(
          (opt) =>
            opt &&
            (opt.enabled === undefined || opt.enabled === true),
        )
        .map((opt) => {
          const ref = opt.ref || opt.id || opt.value || opt.name;
          if (!ref) return null;

          let priceCents = 0;
          if (Number.isFinite(opt.price_cents)) {
            priceCents = opt.price_cents;
          } else if (Number.isFinite(opt.price)) {
            priceCents = Math.round(opt.price * 100);
          } else if (Number.isFinite(opt.amount)) {
            priceCents = Math.round(opt.amount * 100);
          }

          return {
            ...opt,
            ref,
            name: opt.name || opt.label || opt.ref || "Add-on",
            price_cents: priceCents,
          };
        })
        .filter(Boolean);

      return {
        ref: ol.ref || ol.id || ol.name,
        name: ol.name || "Add-ons",
        options,
      };
    })
    .filter((list) => list.options.length > 0);
}

function getSizeSourceId(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  // IMPORTANT: for SKU-shaped size objects, `id` can be a skuId (not "large"/"regular").
  // Prefer readable size tokens first so GF/size rules work.
  return (
    entry.ref ||
    entry.name ||
    entry.label ||
    entry.size ||
    entry.id ||
    ""
  );
}

function makeSizeRecord(entry, fallback = "Regular") {
  const fallbackLabel = fallback || "Regular";
  if (!entry) {
    const ref = normalizeMenuSizeRef(fallbackLabel);
    return { id: fallbackLabel, name: fallbackLabel, ref };
  }
  if (typeof entry === "string") {
    const name = entry || fallbackLabel;
    return { id: name, name, ref: normalizeMenuSizeRef(name) };
  }
  const id = entry.id || entry.ref || entry.name || fallbackLabel;
  const name = entry.name || entry.label || id || fallbackLabel;
  return {
    id,
    name,
    ref: normalizeMenuSizeRef(id || name || fallbackLabel),
  };
}

function formatSizeSuffix(size, fallback = "Default") {
  const name = makeSizeRecord(size, fallback).name;
  if (!name) return "";
  return name !== fallback ? `(${name})` : "";
}

// ItemDetailPanel (simplified to match current props)
function ItemDetailPanel({
  item,
  menuData,
  onClose,
  editingIndex,
  editingItem,
  onSaveIngredients = null,
  primaryActionLabel = "Add to order",
  initialModal = null,
  suppressBasePanel = false,
  onModalsSettled = null,
  variant = "",
  lockSize = false,
  forcedPriceSizeRef = null,
  compactHalfMode = false,
  onApplyAddOns = null,
  lockQty = false,
}) {
  const isMealDealPick = variant === "mealdeal_pick";
  // Meal deal quick-pick: footer must always be visible on mobile sheets.
  const mdPickFooterPad = isMealDealPick
    ? "calc(150px + env(safe-area-inset-bottom))"
    : "calc(0.5rem + env(safe-area-inset-bottom))";
  const sizeOptions = useMemo(() => {
    if (Array.isArray(item?.rawSizes) && item.rawSizes.length) {
      return item.rawSizes;
    }
    if (Array.isArray(item?.sizes) && item.sizes.length) {
      return item.sizes.map((entry) =>
        typeof entry === "object"
          ? entry
          : {
              id: entry,
              name: entry,
              ref: normalizeMenuSizeRef(entry),
            },
      );
    }
    return [];
  }, [item]);
  const fallbackSizeName = sizeOptions[0]?.name || "Regular";
  const editingSizeToken = useMemo(() => {
    if (!editingItem?.size) return null;
    if (typeof editingItem.size === "string") return editingItem.size;
    return (
      editingItem.size.id ||
      editingItem.size.ref ||
      editingItem.size.name ||
      null
    );
  }, [editingItem]);
  const defaultSelectedSize = useMemo(() => {
    if (!sizeOptions.length) return null;
    if (editingSizeToken) {
      const target = normalizeProductSizeRef(editingSizeToken);
      const hit =
        sizeOptions.find(
          (opt) =>
            normalizeProductSizeRef(
              opt?.id || opt?.ref || opt?.name,
            ) === target,
        ) || null;
      if (hit) return hit;
    }
    return defaultSize({ sizes: sizeOptions }) || sizeOptions[0];
  }, [editingSizeToken, sizeOptions]);
  const [selectedSize, setSelectedSize] = useState(defaultSelectedSize);
  useEffect(() => {
    setSelectedSize(defaultSelectedSize);
  }, [defaultSelectedSize]);
  useEffect(() => {
    if (!lockSize || !forcedPriceSizeRef) return;
    const target = normalizeProductSizeRef(forcedPriceSizeRef);
    const match =
      sizeOptions.find(
        (size) =>
          normalizeProductSizeRef(getSizeSourceId(size) || size.name) === target,
      ) || null;
    if (match) setSelectedSize(match);
  }, [lockSize, forcedPriceSizeRef, sizeOptions]);
  const lockedSizeRef = lockSize && forcedPriceSizeRef ? forcedPriceSizeRef : null;
  const selectedSizeLabel =
    (selectedSize &&
      (selectedSize.name ||
        selectedSize.label ||
        selectedSize.ref ||
        selectedSize.id)) ||
    fallbackSizeName ||
    "regular";
  const priceSizeRef = normalizeAddonSizeRef(
    forcedPriceSizeRef || selectedSizeLabel,
  );
  const selectedSizeToken =
    getSizeSourceId(selectedSize) ||
    selectedSizeLabel ||
    fallbackSizeName ||
    "regular";
  const activeSizeRef = normalizeAddonSizeRef(selectedSizeToken);
  const [quantity, setQuantity] = useState(() => {
    if (lockQty) return 1;
    const q = Number(editingItem?.qty);
    return Number.isFinite(q) && q > 0 ? q : 1;
  });
  useEffect(() => {
    if (lockQty) {
      setQuantity(1);
      return;
    }
    const q = Number(editingItem?.qty);
    setQuantity(Number.isFinite(q) && q > 0 ? q : 1);
  }, [editingItem?.qty, item?.id, lockQty]);
  const [isGlutenFree, setIsGlutenFree] = useState(
    editingItem?.isGlutenFree || false,
  );
  const [selectedAddOns, setSelectedAddOns] = useState({});
  const [showExtrasModal, setShowExtrasModal] = useState(false);
  const addonCatalog = useMemo(
    () => (menuData && menuData.raw) || menuData || null,
    [menuData],
  );
  const [showIngredientsModal, setShowIngredientsModal] = useState(false);
  const hasOpenedModalRef = useRef(false);
  const [removedIngredientsLocal, setRemovedIngredientsLocal] = useState(
    editingItem?.removedIngredients || item?.removedIngredients || [],
  );

  useEffect(() => {
    setRemovedIngredientsLocal(
      editingItem?.removedIngredients || item?.removedIngredients || [],
    );
  }, [editingItem, item]);

  useEffect(() => {
    if (showExtrasModal || showIngredientsModal) {
      hasOpenedModalRef.current = true;
    }
  }, [showExtrasModal, showIngredientsModal]);
  useEffect(() => {
    if (initialModal === "addons") {
      setShowExtrasModal(true);
      setShowIngredientsModal(false);
    } else if (initialModal === "ingredients") {
      setShowIngredientsModal(true);
    }
  }, [initialModal]);

  useEffect(() => {
    if (
      suppressBasePanel &&
      hasOpenedModalRef.current &&
      !showExtrasModal &&
      !showIngredientsModal
    ) {
      hasOpenedModalRef.current = false;
      if (typeof onModalsSettled === "function") {
        onModalsSettled();
      }
    }
  }, [
    suppressBasePanel,
    showExtrasModal,
    showIngredientsModal,
    onModalsSettled,
  ]);

  const handleIngredientsSave = useCallback(
    (newRemoved) => {
      const next = newRemoved || [];
      setRemovedIngredientsLocal(next);
      if (typeof onSaveIngredients === "function") {
        onSaveIngredients(next);
      }
      setShowIngredientsModal(false);
    },
    [onSaveIngredients],
  );

  const isMealDealLine = __categoryGuards.isMealDeal(item?.category_ref);
  const addOnLists = useMemo(
    () => getAddOnsForProduct(item, addonCatalog),
    [item, addonCatalog],
  );
  const flatAddOns = useMemo(() => {
    const rows = [];
    addOnLists.forEach((list) => {
      (list?.options || []).forEach((opt) => {
        const base = opt || {};
        if (base.enabled === false) {
          return;
        }
        rows.push({
          ...base,
          ref:
            base.ref ||
            base.id ||
            base.value ||
            base.name ||
            base.label ||
            undefined,
          __listRef: list.ref,
          __listName: list.name,
          list_ref: list.ref,
          option_list_ref: list.ref,
        });
      });
    });
    return rows;
  }, [addOnLists]);
  const flatAddOnMap = useMemo(() => {
    const map = new Map();
    flatAddOns.forEach((opt) => {
      const key = getAddonKey(opt);
      if (key) map.set(key, opt);
    });
    return map;
  }, [flatAddOns]);
  const groupedAddOns = useMemo(
    () => groupAddonsForModal(flatAddOns),
    [flatAddOns],
  );
  useEffect(() => {
    if (editingItem?.add_ons && Array.isArray(editingItem.add_ons)) {
      const init = {};
      editingItem.add_ons.forEach((opt) => {
        const key = getAddonKey(opt);
        if (!key) return;
        const baseOption =
          flatAddOnMap.get(key) || opt.option || opt;
        const cents =
          resolveAddonPriceCents(baseOption, priceSizeRef, menuData) ||
          Number(opt?.price_cents || 0);
        init[key] = {
          ref: key,
          name: opt?.name || baseOption?.name || key,
          price_cents: cents,
          unitCents: cents,
          option: baseOption,
        };
      });
      setSelectedAddOns(init);
    } else {
      setSelectedAddOns({});
    }
  }, [editingItem, item, flatAddOnMap, priceSizeRef, menuData]);
  useEffect(() => {
    setSelectedAddOns((prev) => {
      let mutated = false;
      const next = {};
      Object.entries(prev).forEach(([key, entry]) => {
        const baseOption = entry.option || flatAddOnMap.get(key);
        const cents = resolveAddonPriceCents(
          baseOption,
          priceSizeRef,
          menuData,
        );
        const updated = {
          ...entry,
          option: baseOption,
          price_cents: cents,
          unitCents: cents,
        };
        next[key] = updated;
        if (
          baseOption !== entry.option ||
          cents !== entry.price_cents
        ) {
          mutated = true;
        }
      });
      return mutated ? next : prev;
    });
  }, [priceSizeRef, flatAddOnMap, menuData]);
  const handleOpenAddOns = useCallback(() => setShowExtrasModal(true), []);
  const toggleAddon = useCallback(
    (addon, checkedOverride) => {
      const key = getAddonKey(addon);
      if (!key) return;
      const baseOption = flatAddOnMap.get(key) || addon;
      const cents =
        resolveAddonPriceCents(baseOption, priceSizeRef, menuData) ||
        0;
      setSelectedAddOns((prev) => {
        const shouldCheck =
          typeof checkedOverride === "boolean" ? checkedOverride : !prev[key];
        const next = { ...prev };
        if (shouldCheck) {
          next[key] = {
            ref: key,
            name: baseOption?.name || key,
            price_cents: cents,
            unitCents: cents,
            option: baseOption,
          };
        } else {
          delete next[key];
        }
        return next;
      });
    },
    [flatAddOnMap, priceSizeRef, menuData],
  );
  const selectedAddOnDetails = useMemo(() => {
    return Object.values(selectedAddOns).map((entry) => {
      const resolved = resolveAddonPriceCents(
        entry.option,
        priceSizeRef,
        menuData,
      );
      return {
        ref: entry.ref,
        name: entry.name,
        price_cents: resolved,
        unitCents: resolved,
        listRef: entry.option?.__listRef,
        listName: entry.option?.__listName,
        option: entry.option,
      };
    });
  }, [selectedAddOns, priceSizeRef, menuData]);
  const addOnsTotalCents = useMemo(
    () =>
      calcExtrasCentsForSize(selectedAddOnDetails, priceSizeRef, menuData),
    [selectedAddOnDetails, priceSizeRef, menuData],
  );
  const addOnsCount = selectedAddOnDetails.length;
  const listFmt = (arr, max = 3) => {
    const a = Array.isArray(arr) ? arr.filter(Boolean) : [];
    if (!a.length) return "";
    if (a.length <= max) return a.join(", ");
    return `${a.slice(0, max).join(", ")} +${a.length - max}`;
  };
  const addOnNames = selectedAddOnDetails
    .map((o) => o?.name || o?.ref || "")
    .filter(Boolean);
  const removedNames = Array.isArray(removedIngredientsLocal)
    ? removedIngredientsLocal.filter(Boolean)
    : [];
  const addOnsCents = Number.isFinite(addOnsTotalCents) ? addOnsTotalCents : 0;
  const applyAddOns = useCallback(() => {
    if (typeof onApplyAddOns === "function") {
      onApplyAddOns(selectedAddOnDetails);
    }
  }, [onApplyAddOns, selectedAddOnDetails]);
  const canEditIngredients = productSupportsIngredientEdit(item);
  const ingredientGroups = useMemo(
    () => (item ? groupIngredientsForProduct(item) : []),
    [item],
  );

  const ingredientSummary = useMemo(() => {
    if (!ingredientGroups || !ingredientGroups.length) return [];
    const seen = new Set();
    const result = [];

    ingredientGroups.forEach((group) => {
      (group.items || []).forEach((ing) => {
        if (!ing) return;
        let label;
        if (typeof ing === "string") {
          label = ing;
        } else {
          label =
            ing.name ||
            ing.label ||
            ing.value ||
            ing.ref ||
            ing.id;
        }
        if (!label) return;
        const key = String(label);
        if (seen.has(key)) return;
        seen.add(key);
        result.push(key);
      });
    });

    return result;
  }, [ingredientGroups]);

  const categoryRefUpper = String(
    item?.category_ref || item?.categoryRef || "",
  ).toUpperCase();
  const isPizzaItem =
    categoryRefUpper.endsWith("_PIZZAS") ||
    item?.category === "Pizza" ||
    item?.__categoryType === "pizza";

  // ---------- GF (Large-only) unified logic ----------
  const settings = menuData?.data?.settings || menuData?.settings || {};
  const gfEnabledGlobal =
    settings.gf_enabled === true || settings.gfEnabled === true;

  // menu.json can specify allowed sizes globally (your data uses ["large"])
  const gfAllowedSizes = Array.isArray(settings.gf_allowed_sizes)
    ? settings.gf_allowed_sizes
    : null;

  const gfFlag = item?.allow_gf === true || item?.allowGF === true;
  const gfRule = item?.gf_size_rule || item?.gfSizeRule || item?.gfRule || null;

  // Pizza-only: show GF if explicitly allowed OR globally enabled (and not explicitly disallowed)
  const gfEligible =
    isPizzaItem &&
    (gfFlag ||
      (gfEnabledGlobal &&
        item?.allow_gf !== false &&
        item?.allowGF !== false));

  // surcharge: per-product overrides global
  const gfSurchargeCents = toCents(
    item?.gluten_free_surcharge ??
      item?.glutenFreeSurcharge ??
      settings.gf_surcharge ??
      settings.gfSurcharge ??
      0,
  );
  const gfSurchargeLabel = currency(gfSurchargeCents);
  const gfFeeText = gfSurchargeCents > 0 ? ` (+${gfSurchargeLabel})` : "";

  const gfSizeKey = (sizeLike) => {
    const raw =
      typeof sizeLike === "string"
        ? sizeLike
        : getSizeSourceId(sizeLike) || sizeLike?.name || sizeLike?.id || "";
    return normalizeProductSizeRef(raw);
  };

  const gfAllowedSet = gfAllowedSizes
    ? new Set(gfAllowedSizes.map((s) => normalizeProductSizeRef(String(s))))
    : null;

  // Allowed size check (locks to LARGE via menu settings / rule)
  const gfAllowedFor = (sizeLike) => {
    const k = gfSizeKey(sizeLike);

    // Belt + braces: if the product says large_only, enforce it
    if (String(gfRule).toLowerCase() === "large_only") return k === "LARGE";

    // If menu has a global allowed size list, use it
    if (gfAllowedSet) return gfAllowedSet.has(k);

    // Fallback to existing util behaviour
    return isGfAllowedForSize(k);
  };

  const gfPossible =
    gfEligible &&
    Array.isArray(sizeOptions) &&
    sizeOptions.length > 0 &&
    sizeOptions.some((sz) => gfAllowedFor(sz));

  const gfIsLargeNow =
    normalizeProductSizeRef(lockedSizeRef || selectedSizeToken) === "LARGE";

  // If size is locked and not LARGE, user cannot enable GF
  const gfDisabled = !!lockSize && !gfIsLargeNow;

  // When GF is on, it must be LARGE (enforced)
  useEffect(() => {
    if (!isGlutenFree) return;
    if (gfIsLargeNow) return;

    const forced = sizeOptions?.find((sz) => gfAllowedFor(sz)) || null;
    if (forced && !lockSize) {
      setSelectedSize(forced);
    } else {
      setIsGlutenFree(false);
    }
  }, [isGlutenFree, gfIsLargeNow, sizeOptions, gfAllowedFor, lockSize]);

  const supportsGF = gfPossible;
  useEffect(() => {
    if (isMealDealPick) return;
    if (!supportsGF && isGlutenFree) setIsGlutenFree(false);
  }, [supportsGF, isGlutenFree, isMealDealPick]);
  useEffect(() => {
    if (!supportsGF) return;
    if (!isGlutenFree) return;
    const enforced = enforceGfSize(item, selectedSizeToken);
    const targetRef = normalizeProductSizeRef(enforced.sizeRef || "LARGE");
    const matchingLabel =
      sizeOptions.find(
        (size) =>
          normalizeProductSizeRef(getSizeSourceId(size)) === targetRef,
      ) ||
      null;
    if (
      matchingLabel &&
      normalizeProductSizeRef(getSizeSourceId(selectedSize)) !== targetRef
    ) {
      setSelectedSize(matchingLabel);
    }
  }, [
    supportsGF,
    isGlutenFree,
    item,
    selectedSize,
    selectedSizeToken,
    sizeOptions,
  ]);
  useEffect(() => {
    if (initialModal === "addons" || initialModal === "ingredients") return;
    setShowExtrasModal(false);
    setShowIngredientsModal(false);
  }, [item?.id, item?.name, initialModal]);
  const hasAddOns = !isMealDealLine && addOnLists.length > 0;
  const handleQuantityChange = (amount) => {
    if (lockQty) return;
    setQuantity((prev) => Math.max(1, (prev || 1) + amount));
  };
  const handleSelectSize = useCallback(
    (size) => {
      if (isGlutenFree) {
        if (!gfAllowedFor(size)) return;
      }
      setSelectedSize(size);
    },
    [isGlutenFree, gfAllowedFor],
  );
  const handleGlutenFreeToggle = useCallback(() => {
    if (!gfPossible) return;
    if (gfDisabled) return;

    setIsGlutenFree((prev) => {
      const next = !prev;
      if (next && !gfIsLargeNow && !lockSize) {
        const forced = sizeOptions?.find((sz) => gfAllowedFor(sz)) || null;
        if (forced) setSelectedSize(forced);
      }
      return next;
    });
  }, [gfPossible, gfDisabled, gfIsLargeNow, lockSize, sizeOptions, gfAllowedFor]);
  const getPriceCents = (sizeKey) => {
    const key = sizeKey || "Default";
    if (item?.priceCents && Number.isFinite(item.priceCents[key]))
      return item.priceCents[key];
    if (Number.isFinite(item?.priceCents?.Default))
      return item.priceCents.Default;
    if (Number.isFinite(item?.minPriceCents)) return item.minPriceCents;
    return 0;
  };
  const heroImage = getProductImageUrl(item);
  const HERO_RADIUS = "1rem";
  const quantityTotal = quantity || 0;
  const secondaryActionLabel = lockQty ? "Back" : "Cancel";
  const rootClassName = variant
    ? `detail-panel detail-panel--${variant}`
    : "detail-panel";
  const basePanel = (
    <div
      className={rootClassName}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        position: "relative",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => onClose()}
        className="quantity-btn"
        style={{
          position: "absolute",
          top: "1.5rem",
          right: "1.5rem",
          zIndex: 10,
        }}
        title="Close"
      >
        &times;
      </button>
      <div className="pp-idp-top">
        <div
          className="detail-image-wrapper pp-idp-hero"
          style={{
            width: "100%",
            flex: "0 0 auto",
            height: "clamp(170px, 30vh, 280px)",
            borderRadius: HERO_RADIUS,
            overflow: "hidden",
            marginBottom: "0.75rem",
            background: "var(--idp-hero-bg, transparent)",
            border: "none",
            boxShadow: "none",
          }}
        >
          {heroImage && (() => {
            const heroCandidates = [
              getProductImageUrl(item),
              FALLBACK_IMAGE_URL,
            ].filter(Boolean);
            const heroSrc = heroCandidates[0] || FALLBACK_IMAGE_URL;
            return (
              <img
                src={heroSrc}
                alt={item.name}
                className="detail-image"
                data-pp-img-try="0"
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  display: "block",
                  borderRadius: HERO_RADIUS,
                  background: "transparent",
                  transform: "translateZ(0)",
                  backfaceVisibility: "hidden",
                }}
                onError={(e) => cycleImgCandidates(e.currentTarget, heroCandidates)}
              />
            );
          })()}
        </div>

        <div className="pp-idp-meta">
          {isMealDealPick ? (
            <div className="pp-mdp-headCard">
              <div className="pp-mdp-headTitle">{item?.name || ""}</div>
              {item?.description ? (
                <div className="pp-mdp-headDesc">{item.description}</div>
              ) : null}

              {ingredientSummary.length > 0 ? (
                <div className="pp-mdp-headChips">
                  {ingredientSummary.slice(0, 10).map((name) => (
                    <span key={name} className="pp-mdp-chipMini">{name}</span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <h3 className="panel-title pp-idp-title">{item.name}</h3>

              {(() => {
                const descText = String(item?.description || "").trim();
                const descLower = descText.toLowerCase();

                // If the description looks like an ingredient list AND we already show ingredient chips,
                // hide the description to prevent duplicates.
                const matchCount = (ingredientSummary || []).reduce((n, ing) => {
                  const k = String(ing || "").trim().toLowerCase();
                  if (!k) return n;
                  return descLower.includes(k) ? n + 1 : n;
                }, 0);

                const looksLikeIngredientList =
                  !!descText &&
                  descText.includes(",") &&
                  matchCount >= Math.min(2, Math.max(1, (ingredientSummary || []).length));

                const hideDescBecauseIngredients =
                  !isMealDealPick && !compactHalfMode && (ingredientSummary || []).length > 0 && looksLikeIngredientList;

                if (!descText || hideDescBecauseIngredients) return null;

                return <p className="pp-idp-desc">{descText}</p>;
              })()}

            </>
          )}
        </div>
      </div>

      <div
        className="detail-panel-body"
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          overflowY: "auto",
          paddingRight: "0.25rem",
          overscrollBehavior: "contain",
          paddingBottom: mdPickFooterPad,
        }}
      >
        {/* Ingredients summary moved into the scroll area for more breathing room */}
        {!isMealDealPick && !compactHalfMode && ingredientSummary.length > 0 && (
          <div
            className="pp-ingredients-summary"
            style={{
              marginTop: "0.25rem",
              marginBottom: "0.85rem",
              padding: "0.75rem 0.75rem 0.25rem",
              borderRadius: "0.75rem",
              background: "var(--pp-surface-soft, rgba(0,0,0,0.035))",
            }}
          >
            <div className="pp-ingredients-summary__title">Ingredients</div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
              {ingredientSummary.map((name) => (
                <span
                  key={name}
                  className="pp-chip"
                  style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
                >
                  {name}
                </span>
              ))}
            </div>
          </div>
        )}

        {!compactHalfMode && (
          <>
            {lockedSizeRef ? (
              <div className="pp-md-sizeLock">
                🔒 Size: <b>{String(lockedSizeRef).replace(/_/g, " ")}</b>
                {isMealDealPick ? (
                  <span style={{ marginLeft: 10, opacity: 0.9 }}>
                    {gfPossible && gfIsLargeNow
                      ? (isGlutenFree ? "GF ON" : "GF OFF")
                      : null}
                  </span>
                ) : null}
              </div>
            ) : sizeOptions.length ? (
              <>
                <div
                  role="radiogroup"
                  aria-label="Choose size"
                  className="pp-size-row"
                >
                  {sizeOptions.map((size) => {
                    const id = getSizeSourceId(size) || size.name;
                    const optionRef = normalizeAddonSizeRef(id || size.name);
                    const checked = optionRef === activeSizeRef;
                    const gfLocked = isGlutenFree && !gfAllowedFor(id);
                    return (
                      <label
                        key={id || size.name}
                        className={`pp-size-chip${
                          checked ? " pp-size-chip--active" : ""
                        }${gfLocked ? " pp-size-chip--disabled" : ""}`}
                      >
                        <input
                          type="radio"
                          name={`size-${item.id}`}
                          value={id}
                          checked={checked}
                          onChange={() => handleSelectSize(size)}
                          disabled={gfLocked}
                        />
                        <span className="pp-size-label">{size.name}</span>
                        <span className="pp-size-price">
                          {currency(getPriceCents(size.name))}
                        </span>
                      </label>
                    );
                  })}
                </div>
                <SizePriceDisclaimer />
              </>
            ) : null}
            {!isMealDealPick && (
              <>
                <div className="size-quantity-row">
                  <div>
                    <span style={{ fontWeight: 500 }}>Price</span>
                    <span
                      style={{ color: "var(--text-medium)", marginLeft: "0.5rem" }}
                    >
                      {currency(
                        getPriceCents(
                          sizeOptions.length ? selectedSize?.name : "Default",
                        ),
                      )}
                    </span>
                  </div>
                  <div className="quantity-controls">
                    <button
                      className="quantity-btn"
                      onClick={() => handleQuantityChange(-1)}
                      disabled={lockQty || quantityTotal <= 1}
                    >
                      -
                    </button>
                    <span>{quantityTotal}</span>
                    <button
                      className="quantity-btn"
                      onClick={() => handleQuantityChange(1)}
                      disabled={lockQty}
                    >
                      +
                    </button>
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {isMealDealPick ? null : isMealDealLine ? (
          <div
            className="muted-note"
            style={{ marginTop: "0.5rem", opacity: 0.8 }}
          >
            Meal deal toppings are chosen when you pick each included pizza.
          </div>
        ) : hasAddOns ? (
          <div style={{ marginTop: "0.5rem" }}>
            <h4 className="h4" style={{ marginBottom: "0.35rem" }}>
              Add-ons
            </h4>
            <p className="muted-note" style={{ fontSize: "0.85rem" }}>
              {addOnsCount > 0
                ? `${addOnsCount} selected - ${currency(addOnsTotalCents)} extra`
                : "Customize this item with extra toppings, sauces, and more."}
            </p>
          </div>
        ) : (
          <div
            className="muted-note"
            style={{ marginTop: "0.5rem", opacity: 0.8 }}
          >
            No add-ons available for this item.
          </div>
        )}
        {/* Removed: old sticky actions row (we use the footer toolbar buttons instead) */}
      </div>
      <div
        className="cart-total-section"
        style={{
          flex: "0 0 auto",
          marginTop: "auto",
          position: isMealDealPick ? "absolute" : "sticky",
          left: isMealDealPick ? 0 : undefined,
          right: isMealDealPick ? 0 : undefined,
          bottom: 0,
          zIndex: 20,
          background: "var(--pp-surface, var(--panel))",
          borderTop: "1px solid var(--line, var(--border-color))",
          paddingTop: "0.75rem",
          paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))",
        }}
      >
        {(hasAddOns || canEditIngredients || gfPossible) && (
          <div
            className={`pp-mdp-footerTools ${gfPossible ? "pp-mdp-footerTools--3" : ""}`}
          >
            {hasAddOns && (
              <button
                type="button"
                onClick={handleOpenAddOns}
                className="pp-mdp-toolBtn"
                aria-haspopup="dialog"
                aria-controls="addons-modal"
              >
                <span className="pp-mdp-toolText">{"\uD83E\uDDC0"} Add-ons</span>
              </button>
            )}
            {canEditIngredients && (
              <button
                type="button"
                onClick={() => setShowIngredientsModal(true)}
                className="pp-mdp-toolBtn"
                aria-haspopup="dialog"
                aria-controls="ingredients-modal"
              >
                <span className="pp-mdp-toolText">{"\uD83E\uDDC5"} Ingredients</span>
              </button>
            )}
            {gfPossible && (
              <button
                type="button"
                onClick={handleGlutenFreeToggle}
                disabled={gfDisabled}
                className={`pp-mdp-toolBtn pp-mdp-toolBtn--gf ${isGlutenFree ? "is-on" : ""} ${gfDisabled ? "is-disabled" : ""}`}
                aria-pressed={isGlutenFree}
                title={
                  gfDisabled
                    ? "Gluten-free is available on LARGE pizzas only"
                    : `Gluten-free base (Large only)${
                        gfSurchargeCents > 0 ? ` +${gfSurchargeLabel}` : ""
                      }`
                }
              >
                <span className="pp-mdp-toolText">
                  {"\uD83C\uDF3E"}{" "}
                  {gfIsLargeNow
                    ? `GF ${isGlutenFree ? `ON${gfFeeText}` : "OFF"}`
                    : "GF (Large only)"}
                </span>
              </button>
            )}
          </div>
        )}
        {isMealDealPick && (
          <div className="pp-mdp-summary">
            <div className="pp-mdp-chip pp-mdp-chip--addons">
              ✅ Add-ons: {addOnNames.length ? listFmt(addOnNames) : "None"}
              {addOnsCents > 0 ? ` (+${currency(addOnsCents)})` : ""}
            </div>

            <div className="pp-mdp-chip pp-mdp-chip--removed">
              🚫 Removed: {removedNames.length ? listFmt(removedNames) : "None"}
            </div>
          </div>
        )}
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            type="button"
            onClick={() => onClose()}
            className="simple-button"
            style={{ flex: "0 0 120px" }}
          >
            {secondaryActionLabel}
          </button>

          <button
            type="button"
            onClick={() => {
              const itemsToAdd = [];
              if (quantityTotal > 0) {
                const payloadSize =
                  selectedSize || sizeOptions[0] || { id: "Default", name: "Default" };
                itemsToAdd.push({
                  size: payloadSize,
                  qty: quantityTotal,
                });
              }
              onClose(itemsToAdd, isGlutenFree, selectedAddOnDetails);
            }}
            className="place-order-button"
            disabled={!lockQty && quantityTotal <= 0}
            style={{
              flex: "1 1 auto",
              minHeight: 48,
              opacity: !lockQty && quantityTotal <= 0 ? 0.65 : 1,
              background: "var(--brand-neon-green, #bef264)",
              color: "var(--cta-text, #0b1220)",
              border: "1px solid rgba(0,0,0,0.12)",
              borderRadius: "14px",
              fontWeight: 900,
            }}
          >
            {primaryActionLabel
              ? primaryActionLabel
              : editingIndex != null
              ? "Update Item"
              : `Add ${quantityTotal} to Order`}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {!suppressBasePanel && basePanel}
      {showExtrasModal && (
        <div
          className="pp-modal-backdrop"
          role="dialog"
          aria-modal="true"
          id="addons-modal"
          onClick={() => setShowExtrasModal(false)}
        >
          <div className="pp-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pp-modal-header">
              <div className="pp-modal-title">Add-ons & Extras</div>
              <button
                type="button"
                className="pp-btn pp-btn-subtle"
                onClick={() => setShowExtrasModal(false)}
                aria-label="Close"
              >
                {"\u00d7"}
              </button>
            </div>
            <div className="pp-modal-body">
              <div style={{ marginBottom: ".75rem" }}>
                <span className="pp-chip">
                  Only items available for this product are shown
                </span>
              </div>
              {groupedAddOns.length ? (
                <div className="pp-addon-groups">
                  {groupedAddOns.map((group) => (
                    <section key={group.label} className="pp-addon-group">
                      <h4 className="pp-addon-title capitalize">
                        {group.label}
                      </h4>
                      <div className="pp-options-grid pp-grid-addons pp-addon-grid">
                        {group.options.map((addon) => {
                          const addonKey = getAddonKey(addon);
                          if (!addonKey) return null;
                          const baseOption = addon.option || addon;
                          const baseCents =
                            resolveAddonPriceCents(
                              baseOption,
                              priceSizeRef,
                              menuData,
                            ) || 0;
                          const displayPrice =
                            baseCents > 0 ? `+${currency(baseCents)}` : currency(0);
                          const checked = !!selectedAddOns[addonKey];
                          return (
                            <label key={addonKey} className="pp-option">
                              <div
                                style={{
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: ".25rem",
                                }}
                              >
                                <span className="pp-option-name">
                                  <span>{addon.name || addonKey}</span>
                                  <span className="pp-option-price">
                                    {displayPrice}
                                  </span>
                                </span>
                                {addon.desc ? (
                                  <div className="pp-option-desc">
                                    {addon.desc}
                                  </div>
                                ) : null}
                              </div>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleAddon(addon)}
                                aria-label={`Toggle ${addon.name || addonKey}`}
                              />
                            </label>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <p style={{ color: "var(--pp-text-dim)" }}>
                  No add-ons available for this item.
                </p>
              )}
            </div>
            <div
              className="pp-modal-footer"
              style={{ flexDirection: "column", alignItems: "stretch" }}
            >
              <div
                style={{
                  display: "flex",
                  gap: ".6rem",
                  justifyContent: "flex-end",
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  className="pp-btn pp-btn-subtle"
                  onClick={() => {
                    setSelectedAddOns({});
                    if (typeof onApplyAddOns === "function") {
                      onApplyAddOns([]);
                    }
                    setShowExtrasModal(false);
                  }}
                >
                  Clear all
                </button>
                <button
                  type="button"
                  className="pp-btn pp-btn-primary"
                  onClick={() => {
                    applyAddOns();
                    setShowExtrasModal(false);
                  }}
                >
                  Apply Add-ons
                </button>
              </div>
              <div className="pp-disclaimer" style={{ textAlign: "right" }}>
                Prices for add-ons vary by pizza size.
              </div>
            </div>
          </div>
        </div>
      )}
      {showIngredientsModal && editingItem && (
        <EditIngredientsModal
          item={editingItem}
          initialRemoved={removedIngredientsLocal || []}
          onSave={handleIngredientsSave}
          onCancel={() => setShowIngredientsModal(false)}
        />
      )}
    </>
  );
}

function getFormattedAddressFromPlace(place) {
  if (!place) return "";

  const fa = place.formattedAddress ?? place.formatted_address ?? null;

  if (typeof fa === "string") return fa.trim();

  if (fa && typeof fa === "object") {
    const t =
      fa.text ||
      fa.value ||
      (fa.displayName && fa.displayName.text) ||
      "";
    if (typeof t === "string") return t.trim();
  }

  const dn = place.displayName?.text;
  if (typeof dn === "string") return dn.trim();

  return "";
}

function getAddressComponentsFromPlace(place) {
  if (!place) return [];
  return (
    place.addressComponents || // Places API (new)
    place.address_components || // legacy
    []
  );
}

function getLongNameFromComponent(comp) {
  if (!comp) return "";
  return (
    comp.long_name || // legacy
    comp.longText || // new
    comp.name || // fallback
    comp.short_name ||
    comp.shortText ||
    ""
  );
}

function getShortNameFromComponent(comp) {
  if (!comp) return "";
  return (
    comp.short_name ||
    comp.shortText ||
    comp.abbreviatedName ||
    comp.long_name ||
    comp.longText ||
    ""
  );
}

// Single-mode dropdown: enter a voucher code manually
function VoucherDropdown({ value, onChange, title = "Voucher", compact = false }) {
  const [open, setOpen] = React.useState(false);
  const [msg, setMsg] = React.useState("");
  const wrapRef = React.useRef(null);
  const innerRef = React.useRef(null);
  const inputRef = React.useRef(null);
  const [maxH, setMaxH] = React.useState(0);

  const applied = (value || "").trim();

  const measure = React.useCallback(() => {
    const el = innerRef.current;
    if (!el) return;
    setMaxH(el.scrollHeight || 0);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(measure);
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => {
      try {
        cancelAnimationFrame(raf);
      } catch {}
      window.removeEventListener("resize", onResize);
    };
  }, [open, value, msg, measure]);

  React.useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus?.());
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      const root = wrapRef.current;
      if (!root) return;
      if (!root.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const applyManual = () => {
    const code = (value || "").trim();
    if (!code) {
      setMsg("Enter a voucher code.");
      return;
    }
    setMsg(`Voucher saved (stub): ${code}`);
  };

  return (
    <div ref={wrapRef} style={{ marginBottom: "0.75rem" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={[
          "pp-voucherBtn",
          open ? "is-open" : "",
          compact ? "is-compact" : "",
        ].filter(Boolean).join(" ")}
      >
        <div className="pp-voucherText">
          <div className="pp-voucherTitle">{title}</div>
          <div className="pp-voucherSub">
            {applied ? `Applied: ${applied}` : "Enter a voucher code"}
          </div>
        </div>

        <span aria-hidden="true" className="pp-voucherCaret">
          v
        </span>
      </button>

      <div
        style={{
          overflow: "hidden",
          maxHeight: open ? `${maxH}px` : "0px",
          opacity: open ? 1 : 0,
          transform: open ? "translateY(0px)" : "translateY(-6px)",
          transition:
            "max-height 340ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 180ms ease, transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)",
          willChange: "max-height, opacity, transform",
        }}
      >
        <div ref={innerRef} style={{ paddingTop: "0.65rem", paddingBottom: "0.15rem" }}>
          <div
            style={{
              display: "flex",
              gap: "0.45rem",
              alignItems: "center",
              padding: "0.65rem",
              borderRadius: "0.85rem",
              border: "1px solid rgba(255,255,255,0.22)",
              boxShadow: "var(--shadow-card)",
              background: "var(--panel)",
            }}
          >
            <input
              ref={inputRef}
              type="text"
              placeholder="Enter voucher code"
              value={value || ""}
              onChange={(e) => onChange?.(e.target.value)}
              style={{
                flex: "1 1 auto",
                minWidth: 0,
                height: 34,
                minHeight: 34,
                padding: "0 12px",
                lineHeight: "34px",
                borderRadius: "0.65rem",
                border: "1px solid rgba(255,255,255,0.26)",
                background: "var(--surface)",
                color: "var(--text-light)",
                fontSize: "13px",
                fontWeight: 800,
                letterSpacing: "0.2px",
                boxSizing: "border-box",
              }}
            />
            <button
              type="button"
              className="simple-button"
              onClick={applyManual}
              style={{ padding: "0.65rem 1rem", whiteSpace: "nowrap" }}
            >
              Apply
            </button>
          </div>

          {msg ? (
            <div style={{ marginTop: "0.55rem", fontSize: "0.85rem", color: "var(--text-medium)" }}>
              {msg}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Review screen: big store map (embed, no API key required)
function StoreMapEmbed({ height = "320px" }) {
  const lat = ABOUT_STORE_LOCATION?.lat;
  const lng = ABOUT_STORE_LOCATION?.lng;
  const src =
    typeof lat === "number" && typeof lng === "number"
      ? `https://www.google.com/maps?q=${lat},${lng}&z=18&output=embed`
      : `https://www.google.com/maps?q=${encodeURIComponent(
          ABOUT_LOCATION_TEXT || "Pizza Peppers",
        )}&z=18&output=embed`;

  return (
    <div
      style={{
        borderRadius: "0.75rem",
        overflow: "hidden",
        border: "1px solid var(--border-color)",
        background: "var(--surface)",
      }}
    >
      <iframe
        title="Pizza Peppers map"
        src={src}
        width="100%"
        height={height}
        style={{ border: 0, display: "block" }}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
      />
    </div>
  );
}

// ReviewOrderPanel
function ReviewOrderPanel({
  onBack,
  onEditItem,
  onOpenProfile,
  orderType,
  orderAddress,
  orderDeliveryFee,
  orderAddressError,
  estimatedTime,
  storeOpenNow,
  preorderPickupLabel,
  pickupWhen,
  pickupScheduledUtcIso,
  deliveryWhen,
  deliveryScheduledUtcIso,
}) {
  const { cart, totalPrice, clearCart } = useCart();
  const { currentUser } = useAuth();
  const localProfile = useLocalProfile(currentUser);
  const profileName = pickProfileName(localProfile, currentUser);
  const profilePhone = pickProfilePhone(localProfile, currentUser);
  const profileAddress = pickProfileAddress(localProfile);
  const [voucherCode, setVoucherCode] = React.useState("");
  const finalTotal = totalPrice + (orderDeliveryFee || 0);
  const fmtAdelLabel = (utcIso) => {
    if (!utcIso) return "";
    const d = new Date(utcIso);
    if (!Number.isFinite(d.getTime())) return "";
    return new Intl.DateTimeFormat("en-AU", {
      timeZone: ADEL_TZ,
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
  };

  const pickupIsPreorder = pickupWhen === "SCHEDULE" || !storeOpenNow;
  const deliveryIsPreorder = deliveryWhen === "SCHEDULE" || !storeOpenNow;
  const isPreorder =
    (orderType === "Pickup" && pickupIsPreorder) ||
    (orderType === "Delivery" && deliveryIsPreorder);
  const [placing, setPlacing] = React.useState(false);
  const [placeErr, setPlaceErr] = React.useState("");
  const [placeOk, setPlaceOk] = React.useState("");
  const fulfilment = orderType === "Delivery" ? "delivery" : "pickup";
  const orderAddressText = normalizeAddressText(orderAddress);
  const profileAddressText = normalizeAddressText(profileAddress);
  const deliveryAddress =
    fulfilment === "delivery" ? (orderAddressText || profileAddressText) : "";
  const needsLogin = !currentUser;
  const needsName = !!currentUser && !profileName;
  const needsPhone = !!currentUser && !profilePhone;
  const needsLocation = fulfilment === "delivery" && deliveryAddress.length < 6;
  const canPlaceStrict =
    cart.length > 0 &&
    !needsLogin &&
    !needsName &&
    !needsPhone &&
    !needsLocation &&
    !(orderType === "Delivery" && (!deliveryAddress || !!orderAddressError));
  const pickupScheduledLabel =
    fmtAdelLabel(pickupScheduledUtcIso) ||
    preorderPickupLabel ||
    "15 min after opening";
  const pickupTimeLabel = pickupIsPreorder
    ? `Pre-order (Ready ${pickupScheduledLabel})`
    : `ASAP (Approx. ${estimatedTime} mins)`;
  const deliveryScheduledLabel =
    fmtAdelLabel(deliveryScheduledUtcIso) || "after opening";
  const deliveryTimeLabel = deliveryIsPreorder
    ? `Pre-order (Deliver ${deliveryScheduledLabel})`
    : `ASAP (Approx. ${estimatedTime} mins)`;

  const buildOrderPayload = React.useCallback(() => {
    const dollarsToCents = (n) => {
      const x = Number(n || 0);
      return Math.round(x * 100);
    };

    const toExtraString = (x) => {
      if (typeof x === "string") return x;
      if (x && typeof x === "object") {
        return x.name || x.label || x.title || x.id || JSON.stringify(x);
      }
      return String(x);
    };

    const inferCategory = (it) => {
      const raw = it?.category || it?.cat || it?.menuCategory || it?.group || "";
      const s = String(raw).toLowerCase();

      if (s.includes("pizza")) return "Pizza";
      if (s.includes("side")) return "Sides";
      if (s.includes("drink")) return "Drinks";
      if (s.includes("dessert")) return "Dessert";

      if (it?.size || it?.halfA || it?.halfB) return "Pizza";
      return "Other";
    };

    const cartItemToPosItem = (it) => {
      const extras = [];
      if (Array.isArray(it?.add_ons)) extras.push(...it.add_ons.map(toExtraString));
      if (Array.isArray(it?.extras)) extras.push(...it.extras.map(toExtraString));
      if (it?.isGlutenFree) extras.push("Gluten Free");

      if (it?.size) extras.push(`Size: ${toExtraString(it.size)}`);

      if (it?.halfA?.name || it?.halfB?.name) {
        extras.push(
          `Half/Half: ${it?.halfA?.name || "?"} | ${it?.halfB?.name || "?"}`,
        );
      }

      const item = {
        name: it?.name || "Item",
        qty: Number(it?.qty || 1),
        price: Number(it?.price || 0),
        category: inferCategory(it),
      };

      if (extras.length) item.extras = extras;
      return item;
    };

    const websiteOrderId = `web_${Date.now()}_${Math.random()
      .toString(16)
      .slice(2)}`;

    const payload = {
      source: "website",
      fulfilment,
      payment_method: "card",
      payment_total_cents: dollarsToCents(finalTotal),
      customer: {
        name: profileName,
        phone: profilePhone,
        uid: currentUser?.uid || null,
        email: currentUser?.email || localProfile?.email || null,
      },
      items: (cart || []).map(cartItemToPosItem),
      website_order_id: websiteOrderId,
      created_at: new Date().toISOString(),
      location:
        fulfilment === "delivery"
          ? {
              type: "delivery",
              address: deliveryAddress,
              address_line1: localProfile?.addressLine1 || "",
              suburb: localProfile?.suburb || "",
              state: localProfile?.state || "",
              postcode: localProfile?.postcode || "",
            }
          : { type: "pickup", store: "Pizza Peppers" },
      profile_snapshot: {
        displayName: localProfile?.displayName || "",
        phoneNumber: localProfile?.phoneNumber || "",
        addressLine1: localProfile?.addressLine1 || "",
        suburb: localProfile?.suburb || "",
        state: localProfile?.state || "",
        postcode: localProfile?.postcode || "",
      },
    };

    if (fulfilment === "pickup") {
      payload.pickup = {
        when: pickupIsPreorder ? "scheduled" : "asap",
        requested_ready_at_utc: pickupIsPreorder ? (pickupScheduledUtcIso || null) : null,
        requested_ready_label: pickupIsPreorder ? pickupScheduledLabel : null,
      };
    }

    return payload;
  }, [
    cart,
    orderType,
    finalTotal,
    fulfilment,
    deliveryAddress,
    profileName,
    profilePhone,
    currentUser?.uid,
    currentUser?.email,
    localProfile?.email,
    localProfile?.addressLine1,
    localProfile?.suburb,
    localProfile?.state,
    localProfile?.postcode,
    localProfile?.displayName,
    localProfile?.phoneNumber,
    pickupIsPreorder,
    pickupScheduledUtcIso,
    pickupScheduledLabel,
  ]);

  const handlePlaceOrder = React.useCallback(async () => {
    if (placing) return;
    if (!canPlaceStrict) {
      onOpenProfile?.();
      return;
    }

    setPlaceErr("");
    setPlaceOk("");
    setPlacing(true);

    const payload = buildOrderPayload();

    try {
      const result = await sendWebsiteOrderToPos(payload);
      console.log("[PP][Order] sent", { result });

      setPlaceOk("Order sent to POS.");
      try {
        clearCart?.();
      } catch {}

      // If we were in a modal flow, go back to menu after a beat
      setTimeout(() => {
        try {
          onBack?.();
        } catch {}
      }, 600);
    } catch (e) {
      const msg = e?.message || String(e);

      // If online send fails, queue it so it can retry on next load.
      const queued = enqueueOrder(payload);
      console.warn("[PP][Order] send failed (queued)", { msg, queued });

      setPlaceErr(
        `Could not reach the POS right now - saved locally and will retry. (${msg})`,
      );

      // Best-effort immediate flush (sometimes the POS endpoint comes back)
      try {
        await flushOrderOutboxOnce();
      } catch {}
    } finally {
      setPlacing(false);
    }
  }, [canPlaceStrict, placing, buildOrderPayload, clearCart, onBack, onOpenProfile]);

  return (
    <>
      <h2 className="panel-title">Review Order</h2>

      {needsLogin || needsName || needsPhone || needsLocation ? (
        <div className="pp-warning">
          <div style={{ fontWeight: 800, marginBottom: 6 }}>
            Finish details to place an order
          </div>
          {needsLogin ? <div>• Sign in first</div> : null}
          {needsName ? <div>• Add your name in Profile</div> : null}
          {needsPhone ? <div>• Add your phone number in Profile</div> : null}
          {needsLocation ? <div>• Add a delivery address</div> : null}
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <button
              type="button"
              className="simple-button"
              onClick={() => onOpenProfile?.()}
            >
              {needsLogin ? "Sign in / Profile" : "Open Profile"}
            </button>
            {needsLocation ? (
              <button type="button" className="simple-button" onClick={onBack}>
                Fix address
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div style={{ marginBottom: "1rem" }}>
        <StoreMapEmbed height="320px" />
        <div style={{ marginTop: "0.5rem", color: "var(--text-medium)" }}>
          <strong>Pizza Peppers</strong>
          <div style={{ fontSize: "0.9rem" }}>{ABOUT_LOCATION_TEXT}</div>
        </div>
      </div>

      <div className="info-box">
        {orderType === "Pickup" ? (
          <>
            <p>
              Pickup from: <strong>Pizza Peppers Store</strong>
            </p>
            <p>
              Pickup time: <strong>{pickupTimeLabel}</strong>
            </p>
            {!storeOpenNow ? (
              <p
                style={{
                  marginTop: "0.35rem",
                  color: "var(--text-medium)",
                  fontSize: "0.85rem",
                }}
              >
                Store is closed — pickup is scheduled as a pre-order.
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p>
              Delivery address:{" "}
              <strong>{normalizeAddressText(deliveryAddress) || "-"}</strong>
            </p>
            <p>
              Delivery time: <strong>{deliveryTimeLabel}</strong>
            </p>
          </>
        )}
      </div>

      <div className="cart-items-list">
        {cart.length > 0 ? (
          cart.map((it, idx) => (
            <div
              key={idx}
              className="cart-item"
              onClick={() => onEditItem?.(it, idx)}
            >
              <div>
                <span>
                  {it.qty} x {it.name} {formatSizeSuffix(it.size)}
                </span>
                {it.isGlutenFree && (
                  <span
                    style={{
                      color: "#facc15",
                      marginLeft: "0.5rem",
                      fontSize: "0.75rem",
                    }}
                  >
                    GF
                  </span>
                )}
                {(() => {
                  const extrasSummary = Array.isArray(it.add_ons)
                    ? it.add_ons
                        .map((opt) => opt?.name || opt?.ref)
                        .filter(Boolean)
                        .join(", ")
                    : "";
                  return extrasSummary ? (
                    <div className="cart-item-details">{extrasSummary}</div>
                  ) : null;
                })()}
                <div className="cart-item-details" style={{ color: "#fca5a5" }}>
                  {it.removedIngredients?.length > 0
                    ? `No ${it.removedIngredients.join(", ")}`
                    : ""}
                </div>
                {Array.isArray(it.bundle_items) && it.bundle_items.length > 0 ? (
                  <div className="cart-item-details" style={{ marginTop: "0.35rem", opacity: 0.9 }}>
                    {it.bundle_items.map((bi, j) => {
                      const extras = Array.isArray(bi.add_ons)
                        ? bi.add_ons.map((o) => o?.name || o?.ref).filter(Boolean).join(", ")
                        : "";
                      const removed =
                        Array.isArray(bi.removedIngredients) && bi.removedIngredients.length
                          ? `No ${bi.removedIngredients.join(", ")}`
                          : "";
                      return (
                        <div key={j} style={{ marginTop: "0.15rem" }}>
                          <div>
                            <strong
                              style={{
                                textTransform: "uppercase",
                                fontSize: "0.75rem",
                                opacity: 0.75,
                              }}
                            >
                              {bi.bundle_slot || "item"}:
                            </strong>{" "}
                            {bi.name} {formatSizeSuffix(bi.size)}
                            {bi.isGlutenFree ? (
                              <span style={{ color: "#facc15", marginLeft: "0.5rem", fontSize: "0.75rem" }}>
                                GF
                              </span>
                            ) : null}
                          </div>
                          {extras ? <div className="cart-item-details">{extras}</div> : null}
                          {removed ? (
                            <div className="cart-item-details" style={{ color: "#fca5a5" }}>
                              {removed}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
              <span>${(it.price * it.qty).toFixed(2)}</span>
            </div>
          ))
        ) : (
          <div className="pp-emptyCart">
            <div className="pp-emptyCartTitle">Your cart is empty</div>
            <div className="pp-emptyCartSub">Pick something from the menu 👈</div>
          </div>
        )}
      </div>

      <div className="cart-total-section">
        <VoucherDropdown value={voucherCode} onChange={setVoucherCode} />

        {orderType === "Delivery" && orderDeliveryFee > 0 && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: "0.5rem",
              color: "var(--text-medium)",
            }}
          >
            <span>Delivery Fee</span>
            <span>${orderDeliveryFee.toFixed(2)}</span>
          </div>
        )}

        <div className="total-price-display">
          <span>Total:</span>
          <span>${finalTotal.toFixed(2)}</span>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
          <button type="button" className="simple-button" onClick={onBack}>
            Back
          </button>

          <button
            type="button"
            className="place-order-button"
            disabled={!canPlaceStrict || placing}
            onClick={handlePlaceOrder}
          >
            {placing ? "Sending..." : isPreorder ? "Place pre-order" : "Place order"}
          </button>
        </div>

        {import.meta.env.DEV ? (
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.65 }}>
            Order endpoint: {String(import.meta.env.VITE_PP_ORDER_INGEST_URL || "(not set)")}
          </div>
        ) : null}

        <div
          style={{
            marginTop: "0.5rem",
            fontSize: "0.8rem",
            color: "var(--text-medium)",
          }}
        >
          {placeErr ? placeErr : placeOk ? placeOk : "Orders send to POS when you place."}
        </div>
      </div>
    </>
  );
}

// OrderInfoPanel
function OrderInfoPanel({
  onEditItem,
  isMapsLoaded,
  orderType,
  setOrderType,
  orderAddress,
  setOrderAddress,
  orderDeliveryFee,
  setOrderDeliveryFee,
  orderAddressError,
  setOrderAddressError,
  estimatedTime,
  storeOpenNow,
  preorderPickupLabel,
  pickupWhen,
  setPickupWhen,
  pickupScheduledUtcIso,
  setPickupScheduledUtcIso,
  deliveryWhen,
  setDeliveryWhen,
  deliveryScheduledUtcIso,
  setDeliveryScheduledUtcIso,
  pickupTimeLocked,
  setPickupTimeLocked,
  deliveryTimeLocked,
  setDeliveryTimeLocked,
  onProceed,
}) {
  const { cart, totalPrice } = useCart();
  const { currentUser } = useAuth();
  const localProfile = useLocalProfile(currentUser);
  const profileAddress = pickProfileAddress(localProfile);
  const orderAddressText = normalizeAddressText(orderAddress);
  const [voucherCode, setVoucherCode] = React.useState("");
  const addressInputRef = useRef(null);
  const deliveryPlacesElRef = React.useRef(null);
  const [addressAutoErr, setAddressAutoErr] = React.useState("");
  const [scheduleModalOpen, setScheduleModalOpen] = React.useState(false);
  const [scheduleModalFor, setScheduleModalFor] = React.useState("Delivery"); // "Pickup" | "Delivery"
  const finalTotal = totalPrice + (orderDeliveryFee || 0);
  const canUsePlacesWidget =
    isMapsLoaded &&
    typeof window !== "undefined" &&
    typeof window.google?.maps?.importLibrary === "function";
  const pickupLeadMins = 15;
  const deliveryLeadMins = 45;

  const fmtAdelLabel = (utcIso) => {
    if (!utcIso) return "";
    const d = new Date(utcIso);
    if (!Number.isFinite(d.getTime())) return "";
    return new Intl.DateTimeFormat("en-AU", {
      timeZone: ADEL_TZ,
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
  };

  const pickupTimeLabel =
    pickupWhen === "SCHEDULE" || !storeOpenNow
      ? `Pre-order (Ready ${pickupScheduledUtcIso ? fmtAdelLabel(pickupScheduledUtcIso) : (preorderPickupLabel || "15 min after opening")})`
      : `ASAP (Approx. ${estimatedTime} mins)`;
  const deliveryTimeLabel =
    deliveryWhen === "SCHEDULE" || !storeOpenNow
      ? `Pre-order (Deliver ${deliveryScheduledUtcIso ? fmtAdelLabel(deliveryScheduledUtcIso) : "after opening"})`
      : `ASAP (Approx. ${estimatedTime} mins)`;

  const pad2 = (n) => String(n).padStart(2, "0");

  const ymdFromUtcIsoAdel = (utcIso) => {
    const d = utcIso ? new Date(utcIso) : new Date();
    const z = _zonedParts(d, ADEL_TZ);
    return `${z.year}-${pad2(z.month)}-${pad2(z.day)}`;
  };

  const openDayOptions = React.useMemo(() => {
    const out = [];
    const now = new Date();
    const nowZ = _zonedParts(now, ADEL_TZ);

    // Adelaide "midnight" in UTC for today
    const baseUtc = _zonedTimeToUtc(
      { year: nowZ.year, month: nowZ.month, day: nowZ.day, hour: 0, minute: 0, second: 0 },
      ADEL_TZ,
    );

    for (let i = 0; i < 10; i++) {
      const dayUtc = new Date(baseUtc.getTime() + i * 86400000);
      const z = _zonedParts(dayUtc, ADEL_TZ);
      const win = OPEN_WINDOWS_ADEL[z.weekday];
      if (!win) continue;

      const key = `${z.year}-${pad2(z.month)}-${pad2(z.day)}`;
      const WEEKDAYS_LONG = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
      const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

      const slotIndex = out.length; // 0..6

      let label = "";
      if (slotIndex === 0) label = "Today";
      else if (slotIndex === 1) label = "Tomorrow";
      else if (slotIndex === 6) label = `${MONTHS_SHORT[z.month - 1]} ${pad2(z.day)}`; // ✅ last item is date
      else label = WEEKDAYS_LONG[z.weekday]; // indices 2..5 are weekday names

      out.push({ key, label });
      if (out.length >= 7) break;
    }
    return out;
  }, []);

  const activeScheduledUtcIso =
    orderType === "Delivery" ? deliveryScheduledUtcIso : pickupScheduledUtcIso;
  const [schedDayKey, setSchedDayKey] = React.useState(() =>
    ymdFromUtcIsoAdel(activeScheduledUtcIso),
  );
  React.useEffect(() => {
    // keep local day selector synced when scheduled iso changes externally
    setSchedDayKey(ymdFromUtcIsoAdel(activeScheduledUtcIso));
  }, [activeScheduledUtcIso, orderType]);

  const timeOptionsForDay = React.useCallback((dayKey, leadMins, kind) => {
    if (!dayKey) return [];
    const [yy, mm, dd] = dayKey.split("-").map((x) => Number(x));
    if (![yy, mm, dd].every(Number.isFinite)) return [];

    const dayUtc = _zonedTimeToUtc(
      { year: yy, month: mm, day: dd, hour: 0, minute: 0, second: 0 },
      ADEL_TZ,
    );
    const z = _zonedParts(dayUtc, ADEL_TZ);
    const win = OPEN_WINDOWS_ADEL[z.weekday];
    if (!win) return [];

    const [openStart, openEnd] = win;

    const isPickup = kind === "Pickup";

    // Pickup: 5:15 → 8:45
    // Delivery: 5:45 → 8:30
    const windowStart = isPickup ? PICKUP_SLOT_START_MINS : DELIVERY_SLOT_START_MINS;
    const windowEnd = isPickup ? PICKUP_SLOT_END_MINS : DELIVERY_SLOT_END_MINS;

    // Scheduling window, still respecting store hours
    let startMin = Math.max(openStart, windowStart);
    const endMins = Math.min(openEnd, windowEnd);
    if (startMin > endMins) return [];

    // If scheduling for "today", prevent choosing past slots:
    const todayKey = ymdFromUtcIsoAdel(""); // uses "now" by default
    if (dayKey === todayKey) {
      const now = new Date();
      const nowZ = _zonedParts(now, ADEL_TZ);
      const nowMin = nowZ.hour * 60 + nowZ.minute;
      const earliest = nowMin + (Number.isFinite(leadMins) ? leadMins : 0);

      // round up to next 15-min boundary
      const rounded = Math.ceil(earliest / 15) * 15;

      startMin = Math.max(startMin, rounded);
    }

    // round up to 15-min
    startMin = Math.ceil(startMin / 15) * 15;

    const opts = [];
    const minsToLabel = (mins) => {
      let h24 = Math.floor(mins / 60);
      const m = mins % 60;
      const ampm = h24 < 12 ? "AM" : "PM";
      let h12 = h24 % 12;
      if (h12 === 0) h12 = 12;
      return `${h12}:${pad2(m)} ${ampm}`;
    };

    for (let m = startMin; m <= endMins; m += 15) {
      const h = Math.floor(m / 60);
      const mi = m % 60;
      const utc = _zonedTimeToUtc(
        { year: yy, month: mm, day: dd, hour: h, minute: mi, second: 0 },
        ADEL_TZ,
      );
      const iso = utc.toISOString();
      const label = minsToLabel(m);

      opts.push({ iso, label });
    }
    return opts;
  }, []);

  const firstSchedOption = React.useCallback(
    (leadMins, kind) => {
      for (const day of openDayOptions) {
        const opts = timeOptionsForDay(day.key, leadMins, kind);
        if (opts.length) return { dayKey: day.key, iso: opts[0].iso };
      }
      return { dayKey: openDayOptions[0]?.key || "", iso: "" };
    },
    [openDayOptions, timeOptionsForDay],
  );

  const getSoonestSlotLabel = React.useCallback(
    (leadMins, kind) => {
      for (const day of openDayOptions) {
        const opts = timeOptionsForDay(day.key, leadMins, kind);
        if (opts.length) return opts[0].label || "";
      }
      return "";
    },
    [openDayOptions, timeOptionsForDay],
  );

  const soonestPickupSlotLabel = React.useMemo(
    () => getSoonestSlotLabel(pickupLeadMins, "Pickup"),
    [getSoonestSlotLabel, pickupLeadMins],
  );

  const soonestDeliverySlotLabel = React.useMemo(
    () => getSoonestSlotLabel(deliveryLeadMins, "Delivery"),
    [getSoonestSlotLabel, deliveryLeadMins],
  );

  const openScheduleModal = (mode) => {
    setScheduleModalFor(mode);
    setScheduleModalOpen(true);
  };

  function ScheduleModal({ open, mode, onClose }) {
    if (!open) return null;

    const isDelivery = mode === "Delivery";
    const leadMins = isDelivery ? 45 : 15;

    const forcedSchedule = !storeOpenNow; // closed => schedule required
    const currentWhen = isDelivery ? deliveryWhen : pickupWhen;
    const currentIso = isDelivery ? deliveryScheduledUtcIso : pickupScheduledUtcIso;

    const effectiveWhen = forcedSchedule ? "SCHEDULE" : (currentWhen || "ASAP");

    const [draftWhen, setDraftWhen] = React.useState(effectiveWhen);
    const [draftDayKey, setDraftDayKey] = React.useState(() => ymdFromUtcIsoAdel(currentIso || ""));
    const [draftIso, setDraftIso] = React.useState(currentIso || "");

    const dayOptions = React.useMemo(() => {
      return (openDayOptions || []).filter(
        (d) => timeOptionsForDay(d.key, leadMins, mode).length > 0,
      );
    }, [openDayOptions, timeOptionsForDay, leadMins, mode]);

    // When opened / mode changes: seed day + iso if scheduling is active or required
    React.useEffect(() => {
      if (!open) return;

      const nextWhen = forcedSchedule ? "SCHEDULE" : (currentWhen || "ASAP");
      setDraftWhen(nextWhen);

      // pick day
      let nextDay = ymdFromUtcIsoAdel(currentIso || "");
      if (!dayOptions.some((d) => d.key === nextDay)) {
        const first = firstSchedOption(leadMins, mode);
        nextDay = first.dayKey || dayOptions[0]?.key || "";
      }
      if (!nextDay) nextDay = dayOptions[0]?.key || "";

      // seed iso (only when scheduling)
      let nextIso = currentIso || "";
      if (nextWhen === "SCHEDULE") {
        const opts = timeOptionsForDay(nextDay, leadMins, mode);
        if (!opts.some((o) => o.iso === nextIso)) nextIso = opts[0]?.iso || "";
      }

      setDraftDayKey(nextDay);
      setDraftIso(nextIso);
    }, [open, mode]); // keep minimal to avoid loops

    const scheduleVisible = forcedSchedule || draftWhen === "SCHEDULE";
    const timeOptions = draftDayKey ? timeOptionsForDay(draftDayKey, leadMins, mode) : [];

    const ensureScheduleMode = React.useCallback(() => {
      if (forcedSchedule) return;

      if (draftWhen !== "SCHEDULE") {
        setDraftWhen("SCHEDULE");
      }

      // Ensure we have a valid day/time in the filtered list
      const first = firstSchedOption(leadMins, mode);
      const safeDay = dayOptions.some((d) => d.key === draftDayKey) ? draftDayKey : (first.dayKey || dayOptions[0]?.key || "");
      const opts = safeDay ? timeOptionsForDay(safeDay, leadMins, mode) : [];
      const safeIso = opts.some((o) => o.iso === draftIso) ? draftIso : (first.iso || opts[0]?.iso || "");

      if (safeDay && safeDay !== draftDayKey) setDraftDayKey(safeDay);
      if (safeIso && safeIso !== draftIso) setDraftIso(safeIso);
    }, [forcedSchedule, draftWhen, draftDayKey, draftIso, dayOptions, leadMins, mode, firstSchedOption, timeOptionsForDay]);

    const onPickSchedule = () => {
      ensureScheduleMode();
    };

    const onDayChange = (nextDay) => {
      setDraftDayKey(nextDay);

      const opts = timeOptionsForDay(nextDay, leadMins, mode);
      setDraftIso(opts[0]?.iso || "");
    };

    const save = () => {
      const finalWhen = forcedSchedule ? "SCHEDULE" : draftWhen;

      if (finalWhen === "ASAP") {
        if (isDelivery) {
          setDeliveryWhen("ASAP");
          setDeliveryTimeLocked(true);
        } else {
          setPickupWhen("ASAP");
          setPickupTimeLocked(true);
        }
        onClose?.();
        return;
      }

      // Schedule must have a valid slot
      let day = draftDayKey;
      if (!day || !dayOptions.some((d) => d.key === day)) day = dayOptions[0]?.key || "";

      const opts = timeOptionsForDay(day, leadMins, mode);
      let iso = draftIso;
      if (!iso || !opts.some((o) => o.iso === iso)) iso = opts[0]?.iso || "";

      // If still nothing, don?t save
      if (!day || !iso) return;

      setSchedDayKey(day);

      if (isDelivery) {
        setDeliveryWhen("SCHEDULE");
        setDeliveryScheduledUtcIso(iso);
        setDeliveryTimeLocked(true);
      } else {
        setPickupWhen("SCHEDULE");
        setPickupScheduledUtcIso(iso);
        setPickupTimeLocked(true);
      }

      onClose?.();
    };

    return createPortal(
      <div className="pp-modal-backdrop" id="schedule-modal" onClick={onClose}>
        <div className="pp-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <div className="pp-modal-header">
            <div className="pp-modal-title">{mode} time</div>
            <button type="button" className="pp-modal-close" aria-label="Close" title="Close" onClick={onClose} />
          </div>

          <div className="pp-modal-body">
            <div className="pp-scheduleSummary">
              <div className="pp-scheduleSummaryLabel">Selected</div>
              <div className="pp-scheduleSummaryValue">
                {mode}: {draftDayKey ? (dayOptions.find((d) => d.key === draftDayKey)?.label || draftDayKey) : "—"}{" "}
                {draftIso ? `@ ${fmtAdelLabel(draftIso)}` : ""}
              </div>
            </div>

            {forcedSchedule ? (
              <div className="pp-disclaimer" style={{ marginTop: 0 }}>
                We’re closed right now — pick a time for when we’re back open 🙂
              </div>
            ) : (
              <div className="pp-pickupWhenSwitch" style={{ marginTop: 0 }}>
                <button
                  type="button"
                  className={["pp-pickupWhenBtn", draftWhen === "ASAP" ? "is-active" : ""].join(" ")}
                  onClick={() => setDraftWhen("ASAP")}
                >
                  ASAP
                </button>
                <button
                  type="button"
                  className={["pp-pickupWhenBtn", draftWhen === "SCHEDULE" ? "is-active" : ""].join(" ")}
                  onClick={onPickSchedule}
                >
                  Schedule
                </button>
              </div>
            )}

            <div
              className="pp-pickupScheduleGrid"
              style={{
                marginTop: 12,
                opacity: scheduleVisible ? 1 : 0.75,
              }}
            >
              {!scheduleVisible ? (
                <div className="pp-disclaimer" style={{ marginTop: 0, marginBottom: 10 }}>
                  Select <strong>Schedule</strong> to choose a day and time.
                </div>
              ) : null}

              {dayOptions.length === 0 ? (
                <div className="pp-disclaimer" style={{ marginTop: 0 }}>
                  No available days found.
                </div>
              ) : (
                <>
                  <div className="pp-pickupScheduleRow">
                    <label>Day</label>
                    <select
                      className="pp-pickupScheduleSelect"
                      value={draftDayKey || ""}
                      onMouseDown={ensureScheduleMode}
                      onFocus={() => { if (!forcedSchedule) setDraftWhen("SCHEDULE"); }}
                      onChange={(e) => {
                        if (!forcedSchedule) setDraftWhen("SCHEDULE");
                        const nextDay = e.target.value;
                        setDraftDayKey(nextDay);
                        const opts = timeOptionsForDay(nextDay, leadMins, mode);
                        setDraftIso(opts[0]?.iso || "");
                      }}
                    >
                      {dayOptions.map((d) => (
                        <option key={d.key} value={d.key}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="pp-pickupScheduleRow">
                    <label>Time</label>
                    {timeOptions.length === 0 ? (
                      <div className="pp-disclaimer" style={{ marginTop: 0 }}>
                        No time slots available for this day.
                      </div>
                    ) : (
                      <select
                        className="pp-pickupScheduleSelect"
                        value={draftIso || ""}
                        onMouseDown={ensureScheduleMode}
                        onFocus={() => { if (!forcedSchedule) setDraftWhen("SCHEDULE"); }}
                        onChange={(e) => {
                          if (!forcedSchedule) setDraftWhen("SCHEDULE");
                          setDraftIso(e.target.value);
                        }}
                      >
                        {timeOptions.map((t) => (
                          <option key={t.iso} value={t.iso}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                </>
              )}
            </div>

            <div className="pp-scheduleSpacer" />
          </div>

          <div className="pp-modal-footer">
            <button type="button" className="pp-btn pp-btn-secondary" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="pp-btn pp-btn-primary"
              onClick={save}
              disabled={scheduleVisible && (!draftDayKey || !draftIso)}
            >
              Save
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }



  const isPreorder =
    (orderType === "Pickup" && (pickupWhen === "SCHEDULE" || !storeOpenNow)) ||
    (orderType === "Delivery" && (deliveryWhen === "SCHEDULE" || !storeOpenNow));

  React.useEffect(() => {
    if (orderType !== "Pickup") return;
    if (!(pickupWhen === "SCHEDULE" || !storeOpenNow)) return;

    const opts = timeOptionsForDay(schedDayKey, pickupLeadMins, "Pickup");
    if (!opts.length) {
      const next = firstSchedOption(pickupLeadMins, "Pickup");
      if (next.dayKey && next.dayKey !== schedDayKey) setSchedDayKey(next.dayKey);
      if (next.iso) setPickupScheduledUtcIso(next.iso);
      return;
    }

    if (!opts.some((o) => o.iso === pickupScheduledUtcIso)) {
      setPickupScheduledUtcIso(opts[0].iso);
    }
  }, [
    orderType,
    pickupWhen,
    storeOpenNow,
    schedDayKey,
    pickupScheduledUtcIso,
    timeOptionsForDay,
    firstSchedOption,
    setPickupScheduledUtcIso,
  ]);

  React.useEffect(() => {
    if (orderType !== "Delivery") return;
    if (!(deliveryWhen === "SCHEDULE" || !storeOpenNow)) return;

    const opts = timeOptionsForDay(schedDayKey, deliveryLeadMins, "Delivery");
    if (!opts.length) {
      const next = firstSchedOption(deliveryLeadMins, "Delivery");
      if (next.dayKey && next.dayKey !== schedDayKey) setSchedDayKey(next.dayKey);
      if (next.iso) setDeliveryScheduledUtcIso(next.iso);
      return;
    }

    if (!opts.some((o) => o.iso === deliveryScheduledUtcIso)) {
      setDeliveryScheduledUtcIso(opts[0].iso);
    }
  }, [
    orderType,
    deliveryWhen,
    storeOpenNow,
    schedDayKey,
    deliveryScheduledUtcIso,
    timeOptionsForDay,
    firstSchedOption,
    setDeliveryScheduledUtcIso,
  ]);

  React.useEffect(() => {
    if (orderType !== "Delivery") return;
    if (normalizeAddressText(orderAddress)) return;
    if (!profileAddress) return;

    setOrderAddress(normalizeAddressText(profileAddress));
    setOrderAddressError?.("");
  }, [orderType, orderAddress, profileAddress, setOrderAddress, setOrderAddressError]);

  React.useEffect(() => {
    const cleaned = normalizeAddressText(orderAddress);

    if (typeof orderAddress !== "string") {
      setOrderAddress(cleaned);
      return;
    }

    if (cleaned === "" && orderAddress) {
      setOrderAddress("");
    }
  }, [orderAddress, setOrderAddress]);

  useEffect(() => {
    if (
      orderType !== "Delivery" ||
      !canUsePlacesWidget ||
      !addressInputRef.current
    ) {
      return;
    }

    setAddressAutoErr("");

    let disposed = false;
    let widget = null;
    let themeObs = null;

    (async () => {
      try {
        const { PlaceAutocompleteElement } =
          await window.google.maps.importLibrary("places");

        if (disposed || !addressInputRef.current) return;

        const boundsLiteral = {
          south: -35.15,
          north: -35.0,
          west: 138.45,
          east: 138.65,
        };

        const el = new PlaceAutocompleteElement({
          componentRestrictions: { country: "AU" },
          types: ["address"],
          locationRestriction: boundsLiteral,
        });

        el.style.display = "block";
        el.style.width = "100%";

        const applyPlacesTheme = () => {
          const theme =
            document.documentElement.getAttribute("data-theme") || "dark";
          const isLight = theme === "light";

          // These are supported styling hooks on the element itself
          el.style.colorScheme = isLight ? "light" : "dark";
          el.style.backgroundColor = isLight ? "#ffffff" : "rgba(15, 23, 42, 0.35)";
          el.style.border = isLight
            ? "1px solid rgba(15, 23, 42, 0.12)"
            : "1px solid rgba(148, 163, 184, 0.22)";
          el.style.borderRadius = "14px";
        };

        applyPlacesTheme();

        // Keep it in sync when you toggle LIGHT/DARK
        if (typeof MutationObserver !== "undefined") {
          themeObs = new MutationObserver(applyPlacesTheme);
          themeObs.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["data-theme"],
          });
        }

        const container = addressInputRef.current;
        container.innerHTML = "";
        container.appendChild(el);
        deliveryPlacesElRef.current = el;
        widget = el;

        // Seed widget with whatever we already have (orderAddress or profileAddress)
        try {
          const desired =
            normalizeAddressText(orderAddress) || normalizeAddressText(profileAddress);
          if (desired) {
            // only seed if the widget looks empty, so we don't fight typing
            let current = "";
            try {
              current = normalizeAddressText(el.value || "");
            } catch {}
            if (!current) {
              try {
                el.value = desired;
              } catch {}
              try {
                el.setAttribute("value", desired);
              } catch {}
            }
          }
        } catch {}

        el.addEventListener("gmp-requesterror", (e) => {
          console.warn("[maps][places] request error", e);
          setAddressAutoErr(
            "Address suggestions are unavailable (API key / referrer restriction). You can still type the address manually.",
          );
        });

        el.addEventListener("gmp-select", async (event) => {
          const prediction = event?.placePrediction;
          if (!prediction) return;

          const place = prediction.toPlace ? prediction.toPlace() : null;
          if (!place) return;

          await place.fetchFields?.({
            fields: ["formattedAddress", "addressComponents"],
          });

          const formatted = getFormattedAddressFromPlace(place);
          const components = getAddressComponentsFromPlace(place);

          if (!components || !components.length) {
            setOrderAddressError("Please select a valid address from the suggestions.");
            setOrderDeliveryFee(0);
            return;
          }

          const suburbComponent = components.find((c) =>
            (c.types || []).includes("locality"),
          );

          if (suburbComponent) {
            const zones = {
              "sheidow park": 8.4,
              woodcroft: 8.4,
              "christie downs": 12.6,
              "trott park": 8.4,
              "happy valley": 8.4,
              "o'halloran hill": 8.4,
              "hallett cove": 12.6,
              "hackham west": 12.6,
              "huntfield heights": 12.6,
              "morphett vale": 8.4,
              lonsdale: 12.6,
              "old reynella": 8.4,
              hackham: 12.6,
              reynella: 8.4,
              "onkaparinga hills": 12.6,
              "reynella east": 8.4,
              "aberfoyle park": 12.6,
            };

            const suburbName =
              getLongNameFromComponent(suburbComponent).toLowerCase();

            setOrderAddress(formatted);

            if (zones[suburbName]) {
              setOrderDeliveryFee(zones[suburbName]);
              setOrderAddressError("");
            } else {
              setOrderDeliveryFee(0);
              setOrderAddressError("Sorry, we do not deliver to this suburb.");
            }
          } else {
            setOrderAddressError(
              "Could not determine suburb. Please try a different address.",
            );
            setOrderDeliveryFee(0);
          }
        });
      } catch (err) {
        console.warn("[maps][places] autocomplete init failed:", err);
        setAddressAutoErr(
          "Address suggestions are unavailable (API key / referrer restriction). You can still type the address manually.",
        );
      }
    })();

    return () => {
      disposed = true;
      try {
        if (widget && widget.parentNode) {
          widget.parentNode.removeChild(widget);
        }
      } catch (_) {}
      try {
        themeObs?.disconnect?.();
      } catch {}
    };
  }, [
    isMapsLoaded,
    orderType,
    setOrderAddress,
    setOrderAddressError,
    setOrderDeliveryFee,
    canUsePlacesWidget,
    setAddressAutoErr,
  ]);

  React.useEffect(() => {
    if (orderType !== "Delivery") return;
    if (!canUsePlacesWidget) return;

    const el = deliveryPlacesElRef.current;
    if (!el) return;

    const desired =
      normalizeAddressText(orderAddress) || normalizeAddressText(profileAddress);
    if (!desired) return;

    // Only update when widget is empty (or garbage), so user can still type/select
    let current = "";
    try {
      current = normalizeAddressText(el.value || "");
    } catch {}

    if (!current || current.toLowerCase() === "[object object]") {
      try {
        el.value = desired;
      } catch {}
      try {
        el.setAttribute("value", desired);
      } catch {}
    }
  }, [orderType, canUsePlacesWidget, orderAddress, profileAddress]);

  return (
    <>
      <h2 className="panel-title">Your Order</h2>

      <div className="pp-orderTypeSwitch">
        <button
          type="button"
          className={[
            "pp-orderTypeBtn",
            orderType === "Pickup" ? "is-active" : "",
          ].join(" ")}
          onClick={() => {
            setOrderType("Pickup");
            setOrderAddress("");
            setOrderDeliveryFee(0);
            setOrderAddressError("");
          }}
        >
          Pickup
        </button>

        <button
          type="button"
          className={[
            "pp-orderTypeBtn",
            orderType === "Delivery" ? "is-active" : "",
          ].join(" ")}
          onClick={() => setOrderType("Delivery")}
        >
          Delivery
        </button>
      </div>

      <div className="info-box" style={{ marginTop: "0.85rem" }}>
        <div className="pp-infoRow">
          {orderType === "Pickup" ? (
            <>
              <div className="pp-infoTop">
                <div className="pp-infoTopLabel">Pickup from:</div>
                <div className="pp-infoTopValue">Pizza Peppers Store</div>
              </div>

              <div className="pp-infoBottom">
                <div className="pp-infoBottomLabel">Pickup time</div>

                <div
                  className="pp-infoBottomValue pp-stack2"
                  title={`Today ${soonestPickupSlotLabel}`}
                >
                  <div className="pp-stack2Title">Pick-up time</div>
                  <div className="pp-stack2Sub">
                    Today {soonestPickupSlotLabel}
                  </div>
                </div>

                <button
                  type="button"
                  className="pp-changeBtn"
                  onClick={() => openScheduleModal("Pickup")}
                >
                  Change
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="pp-defRow pp-defRow--address">
                <div className="pp-defLabel">Delivery to</div>

                <div className="pp-defRight pp-defRight--address">
                  <div className="pp-deliveryAddressRow pp-deliveryAddressRow--inline">
                    <div className="pp-deliveryAddressField">
                      {canUsePlacesWidget && !addressAutoErr ? (
                        <div
                          id="address"
                          ref={addressInputRef}
                          className="pp-delivery-autocomplete"
                        />
                      ) : (
                        <input
                          type="text"
                          id="address"
                          onChange={(e) => {
                            setOrderAddress(normalizeAddressText(e.target.value));
                            setOrderDeliveryFee(0);
                            setOrderAddressError("");
                          }}
                          value={orderAddress}
                          placeholder="Start typing your address…"
                        />
                      )}
                    </div>

                    <div
                      className={[
                        "pp-deliveryFeePill",
                        (orderAddress || "").trim().length > 0 ? "is-visible" : "is-hidden",
                      ].join(" ")}
                      title="Delivery fee"
                      aria-hidden={(orderAddress || "").trim().length === 0}
                    >
                      {orderDeliveryFee > 0 ? `$${orderDeliveryFee.toFixed(2)}` : "—"}
                    </div>
                  </div>
                </div>
              </div>

              <div className="pp-infoBottom">
                <div className="pp-infoBottomLabel">Delivery time</div>

                <div
                  className="pp-infoBottomValue pp-stack2"
                  title={`Today ${soonestDeliverySlotLabel}`}
                >
                  <div className="pp-stack2Title">Delivery time</div>
                  <div className="pp-stack2Sub">
                    Today {soonestDeliverySlotLabel}
                  </div>
                </div>

                <button
                  type="button"
                  className="pp-changeBtn"
                  onClick={() => openScheduleModal("Delivery")}
                >
                  Change
                </button>
              </div>

              {profileAddress ? (
                <div className="pp-orderNote">
                  Using profile address by default. You can edit it for this order.
                </div>
              ) : null}

              {addressAutoErr ? (
                <div className="pp-orderError">{addressAutoErr}</div>
              ) : null}

              {orderAddressError ? (
                <div className="pp-orderError">{orderAddressError}</div>
              ) : null}
            </>
          )}
        </div>
      </div>\1

          {orderType === "Delivery" && addressAutoErr ? (
            <div style={{ marginTop: "0.5rem", fontSize: "0.9rem", color: "#fca5a5" }}>
              {addressAutoErr}
            </div>
          ) : null}

          {orderAddressError && (
            <p
              style={{
                color: "#fca5a5",
                marginTop: "0.5rem",
                fontSize: "0.875rem",
              }}
            >
              {orderAddressError}
            </p>
          )}
        </div>
      ) : null}

      <div className="cart-items-list">
        {cart.length > 0 ? (
          cart.map((it, idx) => (
            <div
              key={idx}
              className="cart-item"
              onClick={() => onEditItem(it, idx)}
            >
              <div>
                <span>
                  {it.qty} x {it.name} {formatSizeSuffix(it.size)}
                </span>
                {it.isGlutenFree && (
                  <span
                    style={{
                      color: "#facc15",
                      marginLeft: "0.5rem",
                      fontSize: "0.75rem",
                    }}
                  >
                    GF
                  </span>
                )}
                {(() => {
                  const extrasSummary = Array.isArray(it.add_ons)
                    ? it.add_ons
                        .map((opt) => opt?.name || opt?.ref)
                        .filter(Boolean)
                        .join(", ")
                    : "";
                  return extrasSummary ? (
                    <div className="cart-item-details">{extrasSummary}</div>
                  ) : null;
                })()}
                <div className="cart-item-details" style={{ color: "#fca5a5" }}>
                  {it.removedIngredients?.length > 0
                    ? `No ${it.removedIngredients.join(", ")}`
                    : ""}
                </div>
                {Array.isArray(it.bundle_items) && it.bundle_items.length > 0 ? (
                  <div className="cart-item-details" style={{ marginTop: "0.35rem", opacity: 0.9 }}>
                    {it.bundle_items.map((bi, j) => {
                      const extras = Array.isArray(bi.add_ons)
                        ? bi.add_ons.map((o) => o?.name || o?.ref).filter(Boolean).join(", ")
                        : "";
                      const removed =
                        Array.isArray(bi.removedIngredients) && bi.removedIngredients.length
                          ? `No ${bi.removedIngredients.join(", ")}`
                          : "";
                      return (
                        <div key={j} style={{ marginTop: "0.15rem" }}>
                          <div>
                            <strong
                              style={{
                                textTransform: "uppercase",
                                fontSize: "0.75rem",
                                opacity: 0.75,
                              }}
                            >
                              {bi.bundle_slot || "item"}:
                            </strong>{" "}
                            {bi.name} {formatSizeSuffix(bi.size)}
                            {bi.isGlutenFree ? (
                              <span style={{ color: "#facc15", marginLeft: "0.5rem", fontSize: "0.75rem" }}>
                                GF
                              </span>
                            ) : null}
                          </div>
                          {extras ? <div className="cart-item-details">{extras}</div> : null}
                          {removed ? (
                            <div className="cart-item-details" style={{ color: "#fca5a5" }}>
                              {removed}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
              <span>${(it.price * it.qty).toFixed(2)}</span>
            </div>
          ))
        ) : (
          <div className="pp-emptyCart">
            <div className="pp-emptyCartTitle">Your cart is empty</div>
            <div className="pp-emptyCartSub">Pick something from the menu 👈</div>
          </div>
        )}
      </div>

      <div className="cart-total-section">
        <VoucherDropdown value={voucherCode} onChange={setVoucherCode} compact />

        {orderDeliveryFee > 0 && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: "0.5rem",
              color: "var(--text-medium)",
            }}
          >
            <span>Delivery Fee</span>
            <span>${orderDeliveryFee.toFixed(2)}</span>
          </div>
        )}

        <div className="total-price-display">
          <span>Total:</span>
          <span>${finalTotal.toFixed(2)}</span>
        </div>

        <button
          type="button"
          className="place-order-button"
          disabled={
            cart.length === 0 ||
            (orderType === "Delivery" && (!orderAddressText || !!orderAddressError))
          }
          onClick={() => onProceed?.()}
        >
          {isPreorder ? "Place pre-order" : "Continue"}
        </button>
      </div>
    </>
  );
}

// ThemeSwitcher (single toggle)
function ThemeSwitcher({ compact = false }) {
  const { theme, setTheme } = useTheme();

  const isDark = theme === "dark";
  const nextTheme = isDark ? "light" : "dark";

  return (
    <button
      type="button"
      className={`pp-theme-toggle ${compact ? "pp-theme-toggle--compact" : ""}`}
      onClick={() => setTheme(nextTheme)}
      aria-label={`Switch to ${nextTheme} mode`}
      title={`Switch to ${nextTheme} mode`}
    >
      <span className="pp-theme-toggle__emoji" aria-hidden="true">
        {isDark ? "\uD83C\uDF19" : "\uD83C\uDF1E"}
      </span>

      {!compact && (
        <span className="pp-theme-toggle__label">
          {isDark ? "Dark" : "Light"}
        </span>
      )}
    </button>
  );
}

// --- Icons (place ABOVE LoginModal) ---
const GoogleIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="24"
    height="24"
    style={{ marginRight: "1rem" }}
  >
    <path
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      fill="#4285F4"
    />
    <path
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      fill="#34A853"
    />
    <path
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      fill="#FBBC05"
    />
    <path
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      fill="#EA4335"
    />
  </svg>
);

const AppleIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="24"
    height="24"
    style={{ marginRight: "1rem" }}
  >
    <path
      d="M19.05 17.55C18.8 18.09 18.45 18.75 18 19.35C17.5 19.95 17.05 20.55 16.5 21C16 21.5 15.45 21.8 14.85 22.05C14.25 22.3 13.65 22.5 13 22.5C12.3 22.5 11.7 22.3 11.1 22.05C10.5 21.8 10 21.5 9.45 21C8.95 20.5 8.45 19.95 7.95 19.35C7.5 18.75 7.15 18.1 6.9 17.55C6.3 16.5 6 15.35 6 14.1C6 12.8 6.3 11.65 6.9 10.65C7.2 10.05 7.6 9.45 8.1 8.85C8.6 8.25 9.15 7.7 9.75 7.2C10.35 6.7 11 6.4 11.65 6.15C12.3 5.9 13 5.8 13.75 5.8C14.45 5.8 15.15 6 15.8 6.3C15.15 6.75 14.65 7.35 14.3 8.1C14 8.85 13.85 9.6 13.85 10.35C13.85 11.25 14.05 12.1 14.45 12.9C14.85 13.7 15.4 14.35 16.1 14.85C16.8 15.35 17.6 15.6 18.5 15.6C18.8 15.6 19.05 15.55 19.25 15.5C19.5 15.45 19.7 15.4 19.9 15.35C20.9 14.85 21.7 14.15 22.35 13.25C21.9 12.95 21.45 12.7 21 12.5C20.5 12.3 20 12.15 19.45 12.05C18.75 11.85 18.05 11.75 17.3 11.75C16.45 11.75 15.65 11.9 14.9 12.2C14.15 12.5 13.5 12.95 12.95 13.55C12.4 14.15 11.95 14.8 11.6 15.5C11.25 16.2 11.05 16.95 11.05 17.75C11.05 18.05 11.1 18.3 11.2 18.5C11.3 18.7 11.45 18.85 11.65 18.95C12.2 19.25 12.8 19.4 13.45 19.4C14.1 19.4 14.7 19.2 15.25 18.8C15.8 18.4 16.25 17.9 16.6 17.3C16.95 16.7 17.2 16.05 17.35 15.35C16.45 15.1 15.7 14.65 15.1 13.95C14.5 13.25 14.2 12.45 14.2 11.55C14.2 10.7 14.4 9.9 14.8 9.15C15.2 8.4 15.8 7.8 16.6 7.35C16.9 7.15 17.2 7.05 17.5 7.05C17.8 7.05 18.05 7.1 18.25 7.2C18.5 7.3 18.7 7.45 18.85 7.65C17.95 8.1 17.2 8.7 16.6 9.45C16 10.2 15.7 11.05 15.7 12C15.7 12.8 15.9 13.5 16.3 14.1C16.7 14.7 17.2 15.15 17.85 15.45C18.1 15.55 18.3 15.6 18.45 15.6C18.5 15.6 18.5 15.6 18.5 15.6C18.5 15.6 18.5 15.6 18.5 15.6C19.4 15.6 20.2 15.35 20.9 14.85C20.65 16.1 20 17 19.05 17.55Z"
      fill="currentColor"
    />
  </svg>
);

const PhoneIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="24"
    height="24"
    style={{ marginRight: "1rem" }}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);

// --- Login modal (inline) ---
// --- Login modal (inline, password-first with optional OTP verify) ---
/**
 * @param {{ isOpen: boolean, tab?: LoginTab, onClose: () => void }} props
 */
function LoginModal({ isOpen, tab = "providers", onClose }) {
  const {
    loginLocal,
    loginWithGoogle,
    loginWithApple,
    setLoginTab: setLoginTabCtx,
    currentUser,
    loading: authLoading,
  } = useAuth();
  const firebaseDisabled = !FB_READY || !firebaseAuth;

  const initialTab = /** @type {LoginTab} */ (
    tab === "phone" ? "phone" : "providers"
  );
  /** @type {[LoginTab, React.Dispatch<React.SetStateAction<LoginTab>>]} */
  const [activeTab, setActiveTab] = React.useState(initialTab);
  const [mode, setMode] = React.useState("login"); // "login" | "signup"

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

  React.useEffect(() => {
    if (tab === "phone") {
      setActiveTab("phone");
    } else {
      setActiveTab("providers");
    }
  }, [tab]);

  React.useEffect(() => {
    setLoginTabCtx(activeTab);
  }, [activeTab, setLoginTabCtx]);

  React.useEffect(() => {
    if (!authLoading && currentUser && isOpen) {
      onClose?.();
    }
  }, [authLoading, currentUser, isOpen, onClose]);

  React.useEffect(() => {
    if (!isOpen) {
      setPhone("");
      setPhone2("");
      setPassword("");
      setPassword2("");
      setOtp("");
      setCodeSent(false);
      setOtpOpen(false);
      setErr("");
      setOk("");
      setLoading(false);
      return;
    }
  }, [isOpen]);

  React.useEffect(() => {
    setErr("");
    setOk("");
    setOtp("");
    setOtpOpen(false);
    setCodeSent(false);
    if (activeTab !== "phone") {
      setMode("login");
    }
  }, [activeTab]);

  const handleClose = React.useCallback(() => {
    onClose?.();
  }, [onClose]);

  // ---- phone normalization ----
  const normalizePhone = (s) => {
    if (!s) return "";
    let x = String(s).trim();

    // remove spaces/dashes/brackets etc, keep digits and leading +
    x = x.replace(/[^\d+]/g, "");

    // 00.. -> +..
    if (x.startsWith("00")) x = "+" + x.slice(2);

    // AU mobile: 04xxxxxxxx -> +614xxxxxxxx
    if (/^04\d{8}$/.test(x)) x = "+61" + x.slice(1);

    // AU mobile: 4xxxxxxxx -> +614xxxxxxxx (sometimes people omit leading 0)
    if (/^4\d{8}$/.test(x)) x = "+61" + x;

    // 61xxxxxxxxx -> +61xxxxxxxxx
    if (/^61\d+$/.test(x)) x = "+" + x;

    // raw digits -> +digits
    if (!x.startsWith("+") && /^\d+$/.test(x)) x = "+" + x;

    return x;
  };

  // ---- optional: OTP via Firebase phone (not required to log in) ----
  React.useEffect(() => {
    return () => {
      if (w.__ppRecaptcha && w.__ppRecaptcha.clear) {
        try {
          w.__ppRecaptcha.clear();
        } catch {}
      }
      w.__ppRecaptcha = null;
      w.__ppConfirmation = null;
    };
  }, []);

  const ensureRecaptcha = async () => {
    if (firebaseDisabled)
      throw new Error("Phone verification is unavailable right now.");
    if (recaptchaMounted.current) return;
    const sdkEnsure = await getFirebase();
    if (!sdkEnsure.auth)
      throw new Error("Phone verification is unavailable right now.");
    w.__ppRecaptcha = new sdkEnsure.RecaptchaVerifier(
      sdkEnsure.auth,
      "recaptcha-container-modal",
      {
        size: "normal",
        theme: "dark",
      },
    );
    recaptchaMounted.current = true;
  };

  const sendCode = async () => {
    setErr("");
    setOk("");
    if (firebaseDisabled) {
      setErr("SMS verification is unavailable in this environment.");
      return;
    }
    try {
      setLoading(true);
      await ensureRecaptcha();
      const ph = normalizePhone(phone);
      if (!ph.startsWith("+") || ph.length < 8)
        throw new Error("Enter a valid phone (with country code).");
      const sdk2 = await getFirebase();
      if (!sdk2.auth)
        throw new Error("Phone verification is unavailable right now.");
      const confirmation = await sdk2.signInWithPhoneNumber(
        sdk2.auth,
        ph,
        w.__ppRecaptcha,
      );
      w.__ppConfirmation = confirmation;
      setCodeSent(true);
      setOk("Code sent. Check your SMS.");
    } catch (error) {
      setErr(error?.message || "Failed to send code");
    } finally {
      setLoading(false);
    }
  };

  const verifyCode = async () => {
    setErr("");
    setOk("");
    if (firebaseDisabled) return;
    try {
      setLoading(true);
      if (!w.__ppConfirmation) throw new Error("Please send the code first.");
      const res = await w.__ppConfirmation?.confirm(otp);
      if (res?.user) setOk("Number verified (optional).");
    } catch (error) {
      setErr(error?.message || "Invalid code");
    } finally {
      setLoading(false);
    }
  };

  const handleProvider = async (fn) => {
    if (typeof fn !== "function") return;
    try {
      setLoading(true);
      setErr("");
      setOk("");
      const mode = await fn();
      if (mode === "popup") handleClose();
    } catch (error) {
      const msg =
        error?.code === "auth/popup-closed-by-user"
          ? "Popup closed. Please try again or use the redirect option."
          : error?.message || "Sign-in failed. Please try again.";
      setErr(msg);
    } finally {
      setLoading(false);
    }
  };

  const MENU_BASE = (import.meta.env.VITE_PP_MENU_BASE_URL || "").replace(/\/+$/, "");
  const RAW_AUTH_BASE = (import.meta.env.VITE_PP_AUTH_BASE_URL || MENU_BASE || "").replace(/\/+$/, "");
  const AUTH_BASE = RAW_AUTH_BASE;

  console.log("[auth] AUTH_BASE =", AUTH_BASE || "(same-origin)");

  const saveSession = (token, user) => {
    localStorage.setItem("pp_session_v1", JSON.stringify({ token, user }));
  };

  const normalizeSessionUser = (user, fallbackPhone) => {
    const phoneValue = String(user?.phone || user?.phoneNumber || fallbackPhone || "").trim();
    const idValue = user?.id ?? user?.uid ?? phoneValue;
    return {
      id: user?.id ?? null,
      uid: user?.uid ? String(user.uid) : `local:${idValue}`,
      phone: phoneValue,
      phoneNumber: phoneValue,
      displayName: user?.displayName || user?.display_name || phoneValue,
      role: user?.role || "customer",
      providerId: user?.providerId || "local",
    };
  };

  const readJsonSafe = async (res) => {
    const txt = await res.text();
    try {
      return JSON.parse(txt);
    } catch {
      return { ok: false, error: txt ? txt.slice(0, 180) : `HTTP ${res.status}` };
    }
  };

  // ---- auth submit (password-first, OTP optional) ----
  const submitLogin = async (e) => {
    e.preventDefault();
    setErr("");
    setOk("");
    const ph = normalizePhone(phone);
    if (!ph) return setErr("Please enter your phone.");
    if (!password) return setErr("Please enter your password.");
    try {
      setLoading(true);
      const res = await fetch(`${AUTH_BASE}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: ph, password }),
      });
      const data = await readJsonSafe(res);
      const token = data?.token || data?.accessToken || data?.access_token || "";
      if (!res.ok || !(data?.ok === true || !!token)) {
        throw new Error(data?.error || `Login failed (HTTP ${res.status})`);
      }

      const sessionUser = normalizeSessionUser(data?.user || data?.profile || {}, ph);
      saveSession(token, sessionUser);
      loginLocal(sessionUser.phoneNumber || ph, sessionUser.displayName || "", token, sessionUser);
      setOk("Welcome back!");
      setTimeout(handleClose, 300);
    } catch (error) {
      setErr(error?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  const submitSignup = async (e) => {
    e.preventDefault();
    setErr("");
    setOk("");

    const ph1 = normalizePhone(phone);
    const ph2 = normalizePhone(phone2);
    if (!ph1 || !ph2) return setErr("Please enter and confirm your phone.");
    if (ph1 !== ph2) return setErr("Phone numbers do not match.");
    if (!password || !password2)
      return setErr("Please enter and confirm your password.");
    if (password !== password2) return setErr("Passwords do not match.");
    if (password.length < 6)
      return setErr("Password must be at least 6 characters.");

    try {
      setLoading(true);
      const res = await fetch(`${AUTH_BASE}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: ph1, password, displayName: "" }),
      });
      const data = await readJsonSafe(res);
      const token = data?.token || data?.accessToken || data?.access_token || "";
      if (!res.ok || !(data?.ok === true || !!token)) {
        throw new Error(data?.error || `Sign up failed (HTTP ${res.status})`);
      }

      const sessionUser = normalizeSessionUser(data?.user || data?.profile || {}, ph1);
      saveSession(token, sessionUser);
      loginLocal(sessionUser.phoneNumber || ph1, sessionUser.displayName || "", token, sessionUser);
      setOk("Account created - you're all set.");
      setTimeout(handleClose, 400);
    } catch (error) {
      setErr(error?.message || "Sign up failed");
    } finally {
      setLoading(false);
    }
  };

  // ---- visuals ----
  const buttonStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    padding: "0.9rem",
    marginBottom: "1rem",
    borderRadius: "0.75rem",
    border: "1px solid var(--border-color)",
    backgroundColor: "var(--background-dark)",
    color: "var(--text-light)",
    fontSize: "1rem",
    fontFamily: "var(--font-heading)",
    cursor: "pointer",
    transition: "background-color 0.2s",
  };

  const fieldStyle = {
    width: "100%",
    padding: "0.85rem",
    borderRadius: "0.6rem",
    border: "1px solid var(--border-color)",
    backgroundColor: "var(--border-color)",
    color: "var(--text-light)",
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay pp-login-overlay" onClick={handleClose}>
      <div
        className="modal-content pp-login-modal pp-login-solid"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: "560px",
          width: "95%",
          padding: "1.25rem 1.5rem",
          overflow: "hidden",
        }}
      >
        <div
          className="modal-header"
          style={{ borderBottom: "none", paddingBottom: 0 }}
        >
          <div className="pp-login-brand">
            <img
              className="pp-login-brand__logo"
              src="/pizza-peppers-logo.jpg"
              alt="Pizza Peppers"
            />
            <div className="pp-login-brand__text">
              <div className="pp-login-title">Sign in</div>
              <div className="pp-login-subtitle">Quick checkout & saved details</div>
            </div>
          </div>
          <button
            type="button"
            className="pp-modal-close"
            aria-label="Close login modal"
            title="Close"
            onClick={handleClose}
          >
            {"\u00d7"}
          </button>
        </div>

        <div
          className="modal-body"
          style={{ overflowX: "hidden", paddingTop: "0.75rem" }}
        >
          {activeTab !== "phone" && err && (
            <p style={{ color: "tomato", margin: "0 0 1rem 0" }}>{err}</p>
          )}
          {activeTab === "providers" && (
            <>
              <div
                style={{ display: "grid", gap: "0.75rem", marginTop: "0.5rem" }}
              >
                <button
                  type="button"
                  className="pp-login-providerBtn"
                  style={buttonStyle}
                  onClick={async () => {
                    try {
                      await handleProvider(loginWithGoogle);
                    } catch (e) {
                      console.error("[auth] provider failed", e);
                    }
                  }}
                  disabled={firebaseDisabled || loading}
                  title={firebaseDisabled ? "Temporarily unavailable" : ""}
                >
                  <GoogleIcon />
                  Continue with Google
                </button>
                <button
                  type="button"
                  className="pp-login-providerBtn"
                  style={buttonStyle}
                  onClick={() => setActiveTab("phone")}
                  title={
                    firebaseDisabled
                      ? "Opens local phone/password login (Firebase disabled)"
                      : ""
                  }
                >
                  <PhoneIcon />
                  Continue with Phone
                </button>
              </div>
              <p style={{ margin: "0.8rem 0 0.25rem", color: "var(--text-medium)", textAlign: "center" }}>
                By continuing, you agree to our Terms and Conditions.
              </p>
            </>
          )}

          {activeTab === "phone" && (
            <div style={{ marginTop: "0.5rem" }}>
              <button
                type="button"
                className="pp-login-back"
                onClick={() => setActiveTab("providers")}
              >
                {"\u2190"} Back
              </button>
              {/* Tabs */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "0.5rem",
                  marginBottom: "1rem",
                }}
              >
                <button
                  onClick={() => {
                    setMode("login");
                    setErr("");
                    setOk("");
                  }}
                  style={{
                    ...buttonStyle,
                    marginBottom: 0,
                    backgroundColor:
                      mode === "login"
                        ? "var(--background-dark)"
                        : "transparent",
                    border:
                      mode === "login"
                        ? "1px solid var(--brand-neon-green)"
                        : "1px solid var(--border-color)",
                  }}
                >
                  Log in
                </button>
                <button
                  onClick={() => {
                    setMode("signup");
                    setErr("");
                    setOk("");
                  }}
                  style={{
                    ...buttonStyle,
                    marginBottom: 0,
                    backgroundColor:
                      mode === "signup"
                        ? "var(--background-dark)"
                        : "transparent",
                    border:
                      mode === "signup"
                        ? "1px solid var(--brand-neon-green)"
                        : "1px solid var(--border-color)",
                  }}
                >
                  Sign up
                </button>
              </div>

              {/* Forms */}
              {mode === "login" ? (
                <form
                  onSubmit={submitLogin}
                  style={{ display: "grid", gap: "0.85rem" }}
                >
                  <label
                    htmlFor="phone-login"
                    style={{ color: "var(--text-medium)", fontSize: "0.95rem" }}
                  >
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
                  <label
                    htmlFor="pw-login"
                    style={{ color: "var(--text-medium)", fontSize: "0.95rem" }}
                  >
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

                  {err && <p style={{ color: "tomato", margin: 0 }}>{err}</p>}
                  {ok && (
                    <p style={{ color: "var(--brand-neon-green)", margin: 0 }}>
                      {ok}
                    </p>
                  )}

                  <button
                    type="submit"
                    className="place-order-button"
                    disabled={loading}
                    style={{ opacity: loading ? 0.6 : 1 }}
                  >
                    {loading ? "Please wait..." : "Log in"}
                  </button>

                  {/* Optional OTP verify (non-blocking) */}
                  <details
                    id="pp-otp-details-login"
                    open={otpOpen}
                    onToggle={() => {
                      const el = document.getElementById(
                        "pp-otp-details-login",
                      );
                      // @ts-ignore - HTMLDetailsElement type in JS
                      setOtpOpen(!!el && el.open);
                    }}
                    style={{ marginTop: "0.25rem" }}
                  >
                    <summary
                      style={{ cursor: "pointer", color: "var(--text-medium)" }}
                    >
                      Verify number (optional)
                    </summary>
                    <div
                      style={{
                        display: "grid",
                        gap: "0.6rem",
                        marginTop: "0.5rem",
                      }}
                    >
                      {!codeSent ? (
                        <>
                          <div id="recaptcha-container-modal" />
                          <button
                            onClick={sendCode}
                            type="button"
                            className="simple-button"
                            disabled={loading}
                            style={{ opacity: loading ? 0.6 : 1 }}
                          >
                            Send verification code
                          </button>
                        </>
                      ) : (
                        <>
                          <label
                            htmlFor="otp-login"
                            style={{
                              color: "var(--text-medium)",
                              fontSize: "0.9rem",
                            }}
                          >
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
                          <button
                            onClick={verifyCode}
                            type="button"
                            className="simple-button"
                            disabled={loading}
                            style={{ opacity: loading ? 0.6 : 1 }}
                          >
                            Verify code
                          </button>
                        </>
                      )}
                    </div>
                  </details>
                </form>
              ) : (
                <form
                  onSubmit={submitSignup}
                  style={{ display: "grid", gap: "0.85rem" }}
                >
                  <label
                    htmlFor="phone1"
                    style={{ color: "var(--text-medium)", fontSize: "0.95rem" }}
                  >
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

                  <label
                    htmlFor="phone2"
                    style={{ color: "var(--text-medium)", fontSize: "0.95rem" }}
                  >
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

                  <label
                    htmlFor="pw1"
                    style={{ color: "var(--text-medium)", fontSize: "0.95rem" }}
                  >
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

                  <label
                    htmlFor="pw2"
                    style={{ color: "var(--text-medium)", fontSize: "0.95rem" }}
                  >
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

                  {err && <p style={{ color: "tomato", margin: 0 }}>{err}</p>}
                  {ok && (
                    <p style={{ color: "var(--brand-neon-green)", margin: 0 }}>
                      {ok}
                    </p>
                  )}

                  <button
                    type="submit"
                    className="place-order-button"
                    disabled={loading}
                    style={{ opacity: loading ? 0.6 : 1 }}
                  >
                    {loading ? "Please wait..." : "Create account"}
                  </button>

                  {/* Optional OTP verify (non-blocking) */}
                  <details
                    id="pp-otp-details-signup"
                    open={otpOpen}
                    onToggle={() => {
                      const el = document.getElementById(
                        "pp-otp-details-signup",
                      );
                      // @ts-ignore - HTMLDetailsElement type in JS
                      setOtpOpen(!!el && el.open);
                    }}
                    style={{ marginTop: "0.25rem" }}
                  >
                    <summary
                      style={{ cursor: "pointer", color: "var(--text-medium)" }}
                    >
                      Verify number (optional)
                    </summary>
                    <div
                      style={{
                        display: "grid",
                        gap: "0.6rem",
                        marginTop: "0.5rem",
                      }}
                    >
                      {!codeSent ? (
                        <>
                          <div id="recaptcha-container-modal" />
                          <button
                            onClick={sendCode}
                            type="button"
                            className="simple-button"
                            disabled={loading}
                            style={{ opacity: loading ? 0.6 : 1 }}
                          >
                            Send verification code
                          </button>
                        </>
                      ) : (
                        <>
                          <label
                            htmlFor="otp-signup"
                            style={{
                              color: "var(--text-medium)",
                              fontSize: "0.9rem",
                            }}
                          >
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
                          <button
                            onClick={verifyCode}
                            type="button"
                            className="simple-button"
                            disabled={loading}
                            style={{ opacity: loading ? 0.6 : 1 }}
                          >
                            Verify code
                          </button>
                        </>
                      )}
                    </div>
                  </details>
                </form>
              )}

              <button
                type="button"
                onClick={() => {
                  setActiveTab("providers");
                  setErr("");
                  setOk("");
                }}
                className="simple-button"
                style={{
                  marginTop: "1rem",
                  background: "transparent",
                  border: "1px solid var(--border-color)",
                }}
              >
                All sign-in options
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LoginPage() {
  const {
    currentUser,
    loading: authLoading,
    loginWithGoogle,
    openLogin,
    closeLogin,
  } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const fromState = location.state?.from?.pathname || "/";
  const params = React.useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  );
  const nextParam = params.get("next");
  const destination = nextParam || fromState || "/";

  console.debug("[PP][Login] render", {
    loading: authLoading,
    hasUser: !!currentUser,
    destination,
  });

  React.useEffect(() => {
    if (!authLoading && currentUser) {
      console.info("[PP][Login] user present, navigating to", destination);
      navigate(destination, { replace: true });
    }
  }, [authLoading, currentUser, destination, navigate]);

  React.useEffect(() => {
    openLogin("providers");
    return () => closeLogin();
  }, [openLogin, closeLogin]);

  return (
    <div
      className="login-page"
      style={{ padding: "2rem", textAlign: "center" }}
    >
      <h2 style={{ marginBottom: "1rem" }}>Sign in to continue</h2>
      {authLoading ? (
        <p style={{ marginBottom: "1.5rem", opacity: 0.75 }}>
          Checking your session...
        </p>
      ) : (
        <>
          <p style={{ marginBottom: "1.5rem", opacity: 0.75 }}>
            Use Google or phone login to access your account.
          </p>
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              gap: "1rem",
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              className="pp-btn pp-primary"
              onClick={() => loginWithGoogle()}
            >
              Continue with Google
            </button>
            <button
              type="button"
              className="pp-btn"
              onClick={() => openLogin("phone")}
            >
              Use phone login
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ProfileModal({ onClose, isMapsLoaded }) {
  const { currentUser, loading: authLoading, loginLocal } = useAuth();
  const [profileLoading, setProfileLoading] = React.useState(true);
  const [profile, setProfile] = React.useState(null);
  const [error, setError] = React.useState(null);
  const makeEmptyForm = React.useCallback(
    () => ({
      displayName: "",
      phoneNumber: "",
      photoURL: "",
      email: "",
      addressLine1: "",
      addressLine2: "",
      suburb: "",
      state: "",
      postcode: "",
      paymentLabel: "",
      paymentBrand: "",
      paymentLast4: "",
      paymentExp: "",
    }),
    [],
  );
  // ---- safety flags (Firebase may be disabled locally) ----
  const authSafe = firebaseAuth || null;
  const firebaseDisabled = !FB_READY || !authSafe;
  // Uploads are allowed if the user exists. If Firebase is off, we fall back to localStorage.
  const canUseAvatarUpload = !!currentUser;
  const [saving, setSaving] = React.useState(false);
  const defaultAvatar = "/pizza-peppers-logo.jpg";
  const [uploading, setUploading] = React.useState(false);
  const [uploadPct, setUploadPct] = React.useState(0);
  const [okMsg, setOkMsg] = React.useState("");
  const [errMsg, setErrMsg] = React.useState("");
  const fileInputRef = React.useRef(null);
  const profileAddressRef = React.useRef(null);
  const profilePlacesElRef = React.useRef(null);
  const [profileAutocompleteReady, setProfileAutocompleteReady] =
    React.useState(false);
  const [form, setForm] = React.useState(makeEmptyForm);
  const avatarSrc = form.photoURL?.trim() ? form.photoURL : defaultAvatar;
  const avatarInitial = (form.displayName || form.email || "U")
    .slice(0, 1)
    .toUpperCase();
  const canUseProfilePlaces =
    isMapsLoaded && !!w.google?.maps?.importLibrary;
  const showProfileAutocomplete = canUseProfilePlaces && profileAutocompleteReady;
  const AUTH_BASE = (import.meta.env.VITE_PP_AUTH_BASE_URL || import.meta.env.VITE_PP_MENU_BASE_URL || "").replace(
    /\/+$/,
    "",
  );

  const readSessionToken = React.useCallback(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("pp_session_v1") || "null");
      return raw?.token || null;
    } catch {
      return null;
    }
  }, []);

  const readJsonSafeLocal = React.useCallback(async (res) => {
    const txt = await res.text();
    try {
      return JSON.parse(txt);
    } catch {
      return { ok: false, error: txt ? txt.slice(0, 180) : `HTTP ${res.status}` };
    }
  }, []);

  const readAddressFromWidget = React.useCallback(() => {
    try {
      const container = profileAddressRef.current;
      if (!container) return "";
      const el = profilePlacesElRef.current || container.firstElementChild;
      if (!el) return "";

      // 1) Try direct value (some versions support it)
      const direct = normalizeAddressText(el.value || "");
      if (direct) return direct;

      // 2) Try attribute (some versions reflect it)
      const attr = normalizeAddressText(el.getAttribute?.("value") || "");
      if (attr) return attr;

      // 3) Last resort: look for a real input inside (shadow DOM if open)
      try {
        const shadowInput =
          el.shadowRoot?.querySelector?.("input") ||
          container.querySelector?.("input");
        const v = normalizeAddressText(shadowInput?.value || "");
        if (v) return v;
      } catch {}

      return "";
    } catch {
      return "";
    }
  }, []);

  React.useEffect(() => {
    if (!showProfileAutocomplete) return;

    const el = profilePlacesElRef.current;
    if (!el) return;

    const desired = normalizeAddressText(form.addressLine1 || "");
    if (!desired) return;

    // Only set if it's empty or garbage so we don't fight the user while typing
    let current = "";
    try {
      current = normalizeAddressText(el.value || "");
    } catch {}

    if (!current || current.toLowerCase() === "[object object]") {
      try {
        el.value = desired;
      } catch {}
      try {
        el.setAttribute("value", desired);
      } catch {}
    }
  }, [showProfileAutocomplete, form.addressLine1]);

  // Attach Google Places PlaceAutocompleteElement to the profile address field
  React.useEffect(() => {
    setProfileAutocompleteReady(false);
    // Important: profileLoading gates the form rendering, so wait until it finishes.
    if (!isMapsLoaded || profileLoading || !profileAddressRef.current) return;

    const w = typeof window !== "undefined" ? window : null;
    const hasMaps = !!w?.google?.maps;
    const canImportPlaces =
      hasMaps && typeof w.google.maps.importLibrary === "function";
    const container = profileAddressRef.current;

    if (!canImportPlaces || !container) return;

    let cancelled = false;
    let widget = null;
    let onSelect = null;

    (async () => {
      try {
        const { PlaceAutocompleteElement } =
          await w.google.maps.importLibrary("places");

        if (cancelled || !profileAddressRef.current) return;

        const boundsLiteral = {
          south: -35.15,
          north: -35.0,
          west: 138.45,
          east: 138.65,
        };

        const el = new PlaceAutocompleteElement({
          componentRestrictions: { country: "AU" },
          types: ["address"],
          locationRestriction: boundsLiteral,
        });

        el.style.display = "block";
        el.style.width = "100%";
        el.style.padding = "0.75rem 1rem";
        el.style.border = "none";
        el.style.outline = "none";
        el.style.background = "transparent";

        container.innerHTML = "";
        container.appendChild(el);
        profilePlacesElRef.current = el;
        widget = el;
        setProfileAutocompleteReady(true);

        // Seed the widget display with what we already have saved
        try {
          const existing = normalizeAddressText(form.addressLine1 || "");
          if (existing) {
            // Some builds support .value; some only respond to attribute
            try {
              el.value = existing;
            } catch {}
            try {
              el.setAttribute("value", existing);
            } catch {}
          }
        } catch {}

        onSelect = async (event) => {
          try {
            const prediction = event?.placePrediction;
            if (!prediction) return;

            const place = prediction.toPlace ? prediction.toPlace() : null;
            if (!place) return;

            await place.fetchFields?.({
              fields: ["formattedAddress", "addressComponents"],
            });

            const formatted = getFormattedAddressFromPlace(place) || "";
            const comps = getAddressComponentsFromPlace(place) || [];

            if (!comps.length) {
              setErrMsg("Please select a valid address from the suggestions.");
              return;
            }

            const byType = (t) =>
              comps.find(
                (c) => Array.isArray(c.types) && c.types.includes(t),
              );

            const suburb =
              getLongNameFromComponent(byType("locality")) ||
              getLongNameFromComponent(byType("postal_town")) ||
              getLongNameFromComponent(byType("sublocality_level_1")) ||
              "";

            const postcode = getLongNameFromComponent(byType("postal_code")) || "";

            const state =
              getShortNameFromComponent(byType("administrative_area_level_1")) ||
              "SA";

            setForm((prev) => ({
              ...prev,
              addressLine1: normalizeAddressText(formatted),
              suburb,
              postcode,
              state,
            }));

            if (suburb) {
              const allowed = new Set(
                Object.keys(deliveryZones || {}).map((name) =>
                  String(name).trim().toLowerCase(),
                ),
              );
              if (!allowed.has(suburb.trim().toLowerCase())) {
                setErrMsg(
                  "That suburb is outside our delivery area. Please use one of our delivery suburbs.",
                );
              } else {
                setErrMsg("");
              }
            } else {
              setErrMsg("");
            }
          } catch (err) {
            console.warn("[profile][places] select error", err);
          }
        };

        el.addEventListener("gmp-select", onSelect);
      } catch (err) {
        console.warn("[profile][places] init error", err);
      }
    })();

    return () => {
      cancelled = true;
      setProfileAutocompleteReady(false);
      try {
        if (widget && onSelect) widget.removeEventListener("gmp-select", onSelect);
        if (profileAddressRef.current) profileAddressRef.current.innerHTML = "";
      } catch {}
    };
  }, [
    isMapsLoaded,
    profileLoading,
    deliveryZones,
    setForm,
    setErrMsg,
    setProfileAutocompleteReady,
  ]);

  const handlePickAvatar = React.useCallback(() => {
    if (!canUseAvatarUpload || uploading) return;
    fileInputRef.current?.click();
  }, [canUseAvatarUpload, uploading]);
  const handleCancel = React.useCallback(() => {
    onClose?.();
  }, [onClose]);

  console.log("[PP][Profile] render", {
    authLoading,
    hasUser: !!currentUser,
    profileLoading,
    profile,
  });

  const okTimerRef = React.useRef(null);

  const showOk = React.useCallback(
    (msg, autoClear = true) => {
      if (okTimerRef.current) {
        clearTimeout(okTimerRef.current);
        okTimerRef.current = null;
      }
      setOkMsg(msg);
      if (autoClear && msg) {
        okTimerRef.current = setTimeout(() => {
          setOkMsg("");
          okTimerRef.current = null;
        }, 1500);
      }
    },
    [setOkMsg],
  );

  React.useEffect(() => {
    return () => {
      if (okTimerRef.current) {
        clearTimeout(okTimerRef.current);
      }
    };
  }, []);

  // Load existing profile (or seed from auth)
  React.useEffect(() => {
    setErrMsg("");
    if (authLoading) return;
    let cancelled = false;
    setError(null);

    if (!currentUser) {
      setProfile(null);
      setForm(makeEmptyForm());
      setProfileLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setProfileLoading(true);

    const seed = {
      displayName: currentUser.displayName || "",
      phoneNumber: currentUser.phoneNumber || currentUser.phone || "",
      photoURL: currentUser.photoURL || "",
      email: currentUser.email || "",
    };

    let localData = {};
    try {
      localData = readLocalProfile(currentUser) || {};
    } catch (e) {
      console.warn(
        "[PP][Profile] local profile parse failed:",
        e?.message || e,
      );
    }

    const commitProfile = (data = {}, maybeError = null) => {
      if (cancelled) return;
      if (maybeError) {
        setError(maybeError);
      } else {
        setError(null);
      }
      const merged = { ...makeEmptyForm(), ...seed, ...localData, ...data };
      setProfile({
        name: merged.displayName || "",
        email: merged.email || "",
        photoURL: merged.photoURL || "",
        phone: merged.phoneNumber || "",
        address: merged.addressLine1 || "",
      });
      setForm(merged);
      setProfileLoading(false);
    };

    const hydrateFromServer = async () => {
      if (!AUTH_BASE) return;
      const token = readSessionToken();
      if (!token) return;
      try {
        const res = await fetch(`${AUTH_BASE}/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await readJsonSafeLocal(res);
        if (!res.ok || !data?.ok) return;
        const serverProfile =
          data?.profile && typeof data.profile === "object" ? data.profile : {};
        const serverDisplayName = data?.user?.displayName || "";
        const merged = { ...serverProfile };
        if (serverDisplayName && !merged.displayName) {
          merged.displayName = serverDisplayName;
        }
        if (Object.keys(merged).length) {
          writeLocalProfile(currentUser, merged);
          commitProfile(merged);
        }
      } catch (e) {
        console.warn("[PP][Profile] /me fetch failed:", e?.message || e);
      }
    };

    const finishWithLocal = () => {
      commitProfile();
      hydrateFromServer();
    };

    const isLocalUser =
      currentUser?.providerId === "local" ||
      (currentUser?.uid &&
        (currentUser.uid.startsWith("local:") ||
          currentUser.uid.startsWith("local_")));

    if (isLocalUser) {
      finishWithLocal();
      return () => {
        cancelled = true;
      };
    }

    if (firebaseDisabled) {
      finishWithLocal();
      return () => {
        cancelled = true;
      };
    }

    let hasFirestore = false;
    try {
      const scope = Function(
        "return typeof window !== 'undefined' ? window : globalThis;",
      )();
      hasFirestore =
        !!scope?.firebase?.firestore || !!scope?.__PP_FIRESTORE_READY__;
    } catch {
      hasFirestore = false;
    }

    if (!hasFirestore) {
      finishWithLocal();
      return () => {
        cancelled = true;
      };
    }

    const hasFirebaseAuthedUser = !!firebaseAuth?.currentUser;
    if (!hasFirebaseAuthedUser) {
      finishWithLocal();
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        const { getFirestore, doc, getDoc } = await import(
          "firebase/firestore"
        );
        const db = getFirestore();
        const ref = doc(db, "users", currentUser.uid);
        const snap = await getDoc(ref);
        const data = snap.exists() ? snap.data() : {};
        commitProfile(data);
      } catch (e) {
        console.warn("[PP][Profile] Firestore fetch failed:", e?.message || e);
        commitProfile({}, e?.message || String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authLoading, currentUser, firebaseDisabled, makeEmptyForm]);

  const onChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") {
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onAvatarSelect = async (e) => {
    const file = e.target?.files?.[0];
    if (!file || !currentUser) return;
    setErrMsg("");
    showOk("");
    setUploading(true);
    setUploadPct(0);
    try {
      const liveUser = currentUser;
      if (
        !firebaseDisabled &&
        typeof storage !== "undefined" &&
        storage &&
        liveUser
      ) {
        // Hook up Firebase Storage upload here if needed; local fallback keeps UI consistent.
      }

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        setForm((prev) => ({ ...prev, photoURL: String(dataUrl || "") }));
        if (currentUser) {
          try {
            const prevSaved = readLocalProfile(currentUser) || {};
            writeLocalProfile(currentUser, {
              ...prevSaved,
              photoURL: String(dataUrl || ""),
            });
          } catch {}
        }
        setUploadPct(100);
        showOk(
          firebaseDisabled ? "Photo saved to this device." : "Photo updated.",
        );
        setUploading(false);
      };
      reader.onprogress = (pe) => {
        if (pe.lengthComputable && pe.total > 0) {
          setUploadPct(Math.round((pe.loaded / pe.total) * 100));
        }
      };
      reader.onerror = () => {
        setErrMsg("Failed to read selected file.");
        showOk("");
        setUploadPct(0);
        setUploading(false);
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error(err);
      setErrMsg("Upload failed.");
      showOk("");
      setUploadPct(0);
      setUploading(false);
    } finally {
      try {
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        } else if (e?.target) {
          e.target.value = "";
        }
      } catch {}
    }
  };

  const onSaveProfile = async (e) => {
    e?.preventDefault?.();
    if (!currentUser) return;
    setSaving(true);
    setErrMsg("");
    showOk("");
    try {
      if (!form.displayName?.trim()) throw new Error("Please enter your name.");
      const cfg = /** @type {PpDeliveryConfig | null} */ (
        typeof window !== "undefined" ? window.__PP_DELIVERY_CONFIG : null
      );
      const hasAnyAddress =
        (form.addressLine1 && form.addressLine1.trim()) ||
        (form.suburb && form.suburb.trim()) ||
        (form.postcode && String(form.postcode).trim());

      if (hasAnyAddress && cfg?.isPlaceInDeliveryArea) {
        const extractPostcodeFn = cfg.getExtractPostcode?.() || null;
        const allowedPostcodes = cfg.getAllowedPostcodes?.() || new Set();
        const allowedSuburbs = cfg.getAllowedSuburbs?.() || new Set();

        const suburbUpper = form.suburb
          ? String(form.suburb).trim().toUpperCase()
          : "";
        const postcodeStr = form.postcode ? String(form.postcode).trim() : "";

        // Build a set from the Pizza Peppers deliveryZones map
        const deliveryZoneSuburbs = new Set(
          Object.keys(deliveryZones || {}).map((name) =>
            String(name).trim().toUpperCase(),
          ),
        );

        // 1) anything allowed by the global config
        const matchesConfig =
          (postcodeStr && allowedPostcodes.has(postcodeStr)) ||
          (suburbUpper && allowedSuburbs.has(suburbUpper));

        // 2) OR any suburb explicitly listed in deliveryZones
        const matchesDeliveryZones =
          suburbUpper && deliveryZoneSuburbs.has(suburbUpper);

        const addressOk = matchesConfig || matchesDeliveryZones;
        if (!addressOk) {
          setErrMsg(
            "Saved, but this address looks outside our delivery area.",
          );
        }
      }
      const addressLine1 = normalizeAddressText(
        form.addressLine1 || readAddressFromWidget() || "",
      );
      if (addressLine1 !== normalizeAddressText(form.addressLine1 || "")) {
        setForm((prev) => ({ ...prev, addressLine1 }));
      }
      const payload = {
        ...form,
        addressLine1,
        address: {
          line: addressLine1 || "",
          suburb: form.suburb || "",
          postcode: form.postcode || "",
          state: form.state || "",
        },
      };
      const sdk = await getFirebase();
      const isLocalUser =
        currentUser?.providerId === "local" ||
        (currentUser?.uid &&
          (currentUser.uid.startsWith("local:") ||
            currentUser.uid.startsWith("local_")));

      const hasFirebaseAuthedUser = !!firebaseAuth?.currentUser;

      const persistLocalCache = () => {
        try {
          writeLocalProfile(currentUser, payload);
        } catch {}
      };

      if (isLocalUser || firebaseDisabled || !hasFirebaseAuthedUser) {
        persistLocalCache();
        try {
          const phoneValue =
            form.phoneNumber ||
            currentUser.phoneNumber ||
            currentUser.phone ||
            "";
          if (loginLocal) {
            const token = readSessionToken();
            const updatedUser = {
              ...currentUser,
              displayName: form.displayName,
              phoneNumber: phoneValue,
              phone: phoneValue,
            };
            loginLocal(phoneValue, form.displayName, token, updatedUser);
          }
        } catch {}
        try {
          const token = readSessionToken();
          if (AUTH_BASE && token) {
            await fetch(`${AUTH_BASE}/me`, {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({ displayName: form.displayName, profile: payload }),
            });
          }
        } catch {}
        showOk("Profile saved to this device.");
      } else if (sdk?.db) {
        const ref = sdk.doc(sdk.db, "users", currentUser.uid);
        await sdk.setDoc(ref, payload, { merge: true });

        persistLocalCache();

        try {
          const profileTarget = currentUser;
          if (profileTarget && sdk.updateProfile) {
            await sdk.updateProfile(profileTarget, {
              displayName: form.displayName,
              photoURL: form.photoURL || profileTarget.photoURL || undefined,
            });
          }
        } catch {}

        showOk("Profile saved.");
      } else {
        persistLocalCache();
        showOk("Profile saved to this device.");
      }
    } catch (err) {
      console.error(err);
      const message = err?.message || "Failed to save profile.";
      setErrMsg(message);
    } finally {
      setSaving(false);
    }
  };

  const saveLabel = React.useMemo(() => {
    if (saving) return "Saving...";
    if (okMsg && okMsg.toLowerCase().includes("profile saved")) return "Saved!";
    return "Save changes";
  }, [okMsg, saving]);

  return (
    <div className="modal-overlay pp-profileOverlay" onClick={() => onClose?.()}>
      <div className="pp-modal pp-profileModal" onClick={(e) => e.stopPropagation()}>
        <div className="pp-modal-header">
          <div className="pp-modal-title">Your Profile</div>
          <button
            className="pp-modal-close"
            aria-label="Close profile"
            title="Close"
            onClick={() => onClose?.()}
          >
            {"\u00d7"}
          </button>
        </div>

        <div className="pp-modal-body">
          {authLoading ? (
            <p style={{ color: "var(--text-medium)" }}>Loading account...</p>
          ) : !currentUser ? (
            <div>
              <p style={{ color: "var(--text-medium)" }}>
                You&apos;re not signed in.
              </p>
              <p style={{ color: "var(--text-medium)" }}>
                Please login to manage your profile.
              </p>
            </div>
          ) : profileLoading ? (
            <p style={{ color: "var(--text-medium)" }}>Loading profile...</p>
          ) : (
            <>
              {error ? (
                <div className="pp-error" style={{ marginBottom: "0.75rem" }}>
                  {error}
                </div>
              ) : null}
              <form onSubmit={onSaveProfile} className="profile-modal">
                <div className="profile-card">
                  <div className="avatar-row">
                    <div className="avatar-shell">
                      {form.photoURL?.trim() ? (
                        <img src={avatarSrc} alt="Avatar" />
                      ) : (
                        <span className="avatar-initial">{avatarInitial}</span>
                      )}
                    </div>
                    <div className="avatar-actions">
                      <button
                        type="button"
                        className="pp-input"
                        onClick={handlePickAvatar}
                        disabled={!canUseAvatarUpload || uploading}
                        style={{
                          cursor:
                            !canUseAvatarUpload || uploading
                              ? "not-allowed"
                              : "pointer",
                        }}
                        title={
                          firebaseDisabled
                            ? "Saves to this device (local only)"
                            : "Upload to your account"
                        }
                      >
                        {uploading
                          ? `Uploading... ${uploadPct ?? 0}%`
                          : firebaseDisabled
                            ? "Upload photo (local)"
                            : "Upload photo"}
                      </button>
                      <small>
                        JPG/PNG up to ~1MB{" "}
                        {firebaseDisabled ? "(stored locally)" : ""}
                      </small>
                    </div>
                  </div>
                </div>

                <div className="profile-grid">
                  <div className="profile-card">
                    <h3>Account</h3>
                    <div className="pp-field">
                      <label className="pp-label" htmlFor="pf_name">
                        Name
                      </label>
                      <input
                        id="pf_name"
                        name="displayName"
                        className="pp-input"
                        type="text"
                        placeholder="Your name"
                        value={form.displayName ?? ""}
                        onChange={onChange}
                        required
                      />
                    </div>
                    <div className="pp-field" style={{ marginTop: 12 }}>
                      <label className="pp-label" htmlFor="pf_email">
                        Email
                      </label>
                      <input
                        id="pf_email"
                        name="email"
                        className="pp-input"
                        type="email"
                        placeholder="sam@example.com"
                        value={form.email ?? ""}
                        onChange={onChange}
                      />
                    </div>
                  </div>

                  <div className="profile-card">
                    <h3>Contact</h3>
                    <div className="pp-field">
                      <label className="pp-label" htmlFor="pf_phone">
                        Phone
                      </label>
                      <input
                        id="pf_phone"
                        name="phoneNumber"
                        className="pp-input"
                        type="tel"
                        placeholder="+61 412 345 678"
                        value={form.phoneNumber ?? ""}
                        onChange={onChange}
                      />
                    </div>
                  </div>
                </div>

                <div className="profile-card">
                  <h3>Delivery</h3>
                  <div className="pp-form-row">
                    <div className="pp-form-field" style={{ flex: 1 }}>
                      <label>
                        Delivery Address
                        <div style={{ position: "relative" }}>
                          <div
                            id="pf_address1"
                            ref={profileAddressRef}
                            className="pp-input"
                            style={{
                              padding: 0,
                              minHeight: "44px",
                              display: showProfileAutocomplete ? "flex" : "none",
                              alignItems: "center",
                            }}
                          />
                          {!showProfileAutocomplete && (
                            <input
                              id="pf_address1"
                              className="pp-input"
                              name="addressLine1"
                              type="text"
                              value={form.addressLine1 || ""}
                              onChange={(e) => {
                                setErrMsg("");
                                setForm((prev) => ({
                                  ...prev,
                                  addressLine1: e.target.value,
                                }));
                              }}
                              placeholder="Start typing your address..."
                              autoComplete="street-address"
                            />
                          )}
                        </div>
                      </label>
                    </div>
                  </div>
                </div>

                <div className="profile-footer">
                  <div style={{ marginRight: "auto", minHeight: "1.25rem" }}>
                    {okMsg ? <span className="pp-success">{okMsg}</span> : null}
                    {errMsg ? <span className="pp-error">{errMsg}</span> : null}
                  </div>
                  <button
                    className="pp-input"
                    type="button"
                    onClick={handleCancel}
                    style={{ cursor: "pointer" }}
                  >
                    Cancel
                  </button>
                  <button
                    className="pp-input"
                    type="submit"
                    disabled={saving}
                    style={{
                      cursor: saving ? "not-allowed" : "pointer",
                      background: "var(--brand-neon-green)",
                      color: "#0a0a0a",
                      fontWeight: 700,
                    }}
                  >
                    {saveLabel}
                  </button>
                </div>
              </form>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={onAvatarSelect}
                style={{ display: "none" }}
                disabled={!canUseAvatarUpload || uploading}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// === Pizza Peppers delivery suburbs (display list) ===
// Values are dollars (UI shows $x.xx). Source provided by owner.
const deliveryZones = {
  "Sheidow Park": 8.4,
  Woodcroft: 8.4,
  "Christie Downs": 12.6,
  "Trott Park": 8.4,
  "Happy Valley": 8.4,
  "O'Halloran Hill": 8.4,
  "Hallett Cove": 12.6,
  "Hackham West": 12.6,
  "Huntfield Heights": 12.6,
  "Morphett Vale": 8.4,
  Lonsdale: 12.6,
  "Old Reynella": 8.4,
  Hackham: 12.6,
  Reynella: 8.4,
  "Onkaparinga Hills": 12.6,
  "Reynella East": 8.4,
  "Aberfoyle Park": 12.6,
};

// --- MODAL COMPONENTS ---

function EditIngredientsModal({ item, onSave, onCancel, initialRemoved = [] }) {
  const [removedIngredients, setRemovedIngredients] = useState(
    new Set(initialRemoved),
  );
  useEffect(() => {
    setRemovedIngredients(new Set(initialRemoved));
  }, [initialRemoved]);
  const ingredientGroups = useMemo(
    () => groupIngredientsForProduct(item),
    [item],
  );
  const getKey = useCallback((ing) => {
    if (!ing) return null;
    if (typeof ing === "string") return ing;
    return (
      ing.ref ||
      ing.id ||
      ing.value ||
      ing.name ||
      ing.label ||
      null
    );
  }, []);
  const isRemoved = useCallback(
    (ing) => {
      const key = getKey(ing);
      if (!key) return false;
      return removedIngredients.has(key);
    },
    [getKey, removedIngredients],
  );
  const toggleIngredient = useCallback(
    (ing) => {
      if (ing?.removable === false) return;
      const key = getKey(ing);
      if (!key) return;
      setRemovedIngredients((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [getKey],
  );
  const handleSave = useCallback(() => {
    onSave(Array.from(removedIngredients));
  }, [onSave, removedIngredients]);
  const handleReset = useCallback(() => {
    setRemovedIngredients(new Set());
  }, []);
  if (!item) return null;
  return (
    <div
      className="pp-modal-backdrop"
      role="dialog"
      aria-modal="true"
      id="ingredients-modal"
      onClick={onCancel}
    >
      <div className="pp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pp-modal-header">
          <div className="pp-modal-title">Edit Ingredients</div>
          <button
            type="button"
            className="pp-btn pp-btn-subtle"
            onClick={onCancel}
            aria-label="Close"
          >
            {"\u00d7"}
          </button>
        </div>
        <div className="pp-modal-body">
          {ingredientGroups.length ? (
            <div className="pp-addon-groups">
              {ingredientGroups.map((group) => (
                <section key={group.label} className="pp-addon-group">
                  <h4 className="pp-addon-group__title">{group.label}</h4>
                  <div className="pp-options-grid pp-grid-addons">
                    {group.items.map((ing) => {
                      const key = getKey(ing);
                      if (!key) return null;
                      const locked = ing?.removable === false;
                      const checked = !isRemoved(ing);
                      return (
                        <label key={key} className="pp-option-row">
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: ".2rem",
                            }}
                          >
                            <span style={{ fontWeight: 700 }}>
                              {(ing?.name || key || "").toString()}
                            </span>
                            {ing?.note ? (
                              <span
                                style={{
                                  fontSize: ".8rem",
                                  color: "var(--pp-text-dim)",
                                }}
                              >
                                {ing.note}
                              </span>
                            ) : null}
                          </div>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: ".65rem",
                            }}
                          >
                            {locked && (
                              <span
                                className="pp-chip"
                                style={{ fontSize: ".75rem" }}
                              >
                                Locked
                              </span>
                            )}
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={locked}
                              onChange={() => toggleIngredient(ing)}
                              aria-label={`Toggle ingredient ${ing?.name || key}`}
                            />
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <p style={{ color: "var(--pp-text-dim)" }}>
              No configurable ingredients for this product.
            </p>
          )}
        </div>
        <div
          className="pp-modal-footer"
          style={{ flexDirection: "column", alignItems: "stretch" }}
        >
          <div
            style={{
              display: "flex",
              gap: ".6rem",
              justifyContent: "flex-end",
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              className="pp-btn"
              onClick={handleReset}
            >
              Reset to Default
            </button>
            <button
              type="button"
              className="pp-btn pp-btn-primary"
              onClick={handleSave}
            >
              Save Changes
            </button>
          </div>
          <div
            className="pp-disclaimer"
            style={{ textAlign: "right" }}
          >
            Removing ingredients will not change the price, but helps the
            kitchen prepare your order correctly.
          </div>
        </div>
      </div>
    </div>
  );
}

function OpeningHoursView({ onBack }) {
  const [openNow, setOpenNow] = React.useState(isOpenNowAdelaide());
  React.useEffect(() => {
    const t = setInterval(() => setOpenNow(isOpenNowAdelaide()), 60 * 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="sub-panel-view">
      <div className="sub-panel-header">
        <button onClick={onBack} className="sub-panel-back-button">
          &#8592; Back
        </button>
        <h3 className="panel-title">Opening Hours</h3>
      </div>
      <div style={{ padding: "0.5rem 1rem" }}>
        <span
          style={{
            display: "inline-block",
            padding: "0.25rem 0.6rem",
            borderRadius: "9999px",
            fontSize: "0.85rem",
            fontWeight: 600,
            background: openNow
              ? "rgba(34,197,94,0.15)"
              : "rgba(239,68,68,0.15)",
            color: openNow ? "#22c55e" : "#ef4444",
            border: `1px solid ${openNow ? "#22c55e33" : "#ef444433"}`,
          }}
        >
          {openNow ? "Open now" : "Closed now"}
        </span>
      </div>
      <div className="sub-panel-content" style={{ lineHeight: "1.8" }}>
        {HOURS_DISPLAY.map(({ d, h }) => (
          <p key={d}>
            <strong>{d}:</strong> {h}
          </p>
        ))}
      </div>
    </div>
  );
}

// ADD THIS NEW COMPONENT
function DeliveryAreasView({ onBack }) {
  return (
    <div className="sub-panel-view">
      <div className="sub-panel-header">
        <button onClick={onBack} className="sub-panel-back-button">
          &#8592; Back
        </button>
        <h3 className="panel-title">Delivery Areas</h3>
      </div>
      <div className="sub-panel-content">
        {Object.entries(deliveryZones).map(([suburb, price]) => (
          <div
            key={suburb}
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "0.5rem 0",
              textTransform: "capitalize",
              borderBottom: "1px solid var(--border-color)",
            }}
          >
            <p style={{ margin: 0 }}>{suburb}</p>
            <p style={{ margin: 0 }}>${price.toFixed(2)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// REPLACE your old AboutPanel with this new version
function TermsPage() {
  const headingStyle = {
    fontFamily: "var(--font-heading)",
    color: "var(--brand-neon-green)",
    marginTop: "2.5rem",
    borderBottom: "1px solid var(--border-color)",
    paddingBottom: "0.5rem",
    scrollMarginTop: "6rem",
  };
  const subHeadingStyle = {
    fontFamily: "var(--font-heading)",
    color: "var(--brand-neon-green)",
    marginTop: "1.5rem",
  };
  const pStyle = { lineHeight: "1.7", color: "var(--text-medium)" };
  const listStyle = { ...pStyle, paddingLeft: "1.5rem" };
  const tocLinkStyle = {
    color: "var(--brand-pink)",
    textDecoration: "none",
    fontWeight: "500",
  };

  const tocItems = [
    "Registration",
    "Collection Notice",
    "Accuracy, completeness and timeliness of information",
    "Promotions and competitions",
    "Orders and processing",
    "Price and Payment",
    "Customer Reviews & Ratings",
    "Linked sites",
    "Intellectual property rights",
    "Warranties and disclaimers",
    "Liability",
    "Jurisdiction and governing law",
    "Privacy Policy",
  ];

  const generateId = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  return (
    <div
      style={{
        padding: "1.5rem",
        maxWidth: "800px",
        margin: "0 auto",
        fontFamily: "var(--font-body)",
      }}
    >
      <h1
        style={{ ...headingStyle, borderBottom: "none", textAlign: "center" }}
      >
        Terms & Conditions
      </h1>

      {/* --- TABLE OF CONTENTS --- */}
      <div
        className="info-box"
        style={{ marginBottom: "3rem", padding: "1.5rem" }}
      >
        <h4
          style={{
            fontFamily: "var(--font-heading)",
            color: "var(--brand-neon-green)",
            marginTop: 0,
            marginBottom: "1rem",
            textAlign: "center",
          }}
        >
          Table of Contents
        </h4>
        <ul
          style={{
            paddingLeft: "1.5rem",
            margin: 0,
            columns: 2,
            listStyleType: "none",
          }}
        >
          {tocItems.map((item, index) => (
            <li key={item} style={{ marginBottom: "0.75rem" }}>
              <a href={`#${generateId(item)}`} style={tocLinkStyle}>
                {index < 12 ? `${index + 1}. ` : ""}
                {item}
              </a>
            </li>
          ))}
        </ul>
      </div>

      <p style={pStyle}>
        Thank you for visiting our website. This website is owned and operated
        by Next Order Pty Ltd. (ACN 627 375 535). By accessing and/or using this
        website and related services, you agree to these Terms and Conditions,
        which include our Privacy Policy (Terms). You should review our Privacy
        Policy and these Terms carefully and immediately cease using our website
        if you do not agree to these Terms.
      </p>
      <p style={pStyle}>
        In these Terms, 'us', 'we' and 'our' means Next Order Pty Ltd.
      </p>

      <h3 id={generateId(tocItems[0])} style={headingStyle}>
        1. Registration
      </h3>
      <p style={pStyle}>
        You must be a registered member to make orders, reservations and access
        certain features of our website. When you register and activate your
        account, you will provide us with personal information such as your
        name, mobile number and address. You must ensure that this information
        is accurate and current. We will handle all personal information we
        collect in accordance with our Privacy Policy.
      </p>
      <p style={pStyle}>To create an account, you must be:</p>
      <ul style={listStyle}>
        <li>(a) at least 18 years of age;</li>
        <li>
          (b) possess the legal right and ability to enter into a legally
          binding agreement with us; and
        </li>
        <li>
          (c) agree and warrant to use the website in accordance with these
          Terms.
        </li>
      </ul>

      <h3 id={generateId(tocItems[1])} style={headingStyle}>
        2. Collection Notice
      </h3>
      <p style={pStyle}>
        We collect personal information about you in order to process your
        orders, reservations and for purposes otherwise set out in our Privacy
        Policy. We may disclose that information to third parties that help us
        deliver our services (including information technology suppliers,
        communication suppliers and our Restaurants) or as required by law. If
        you do not provide this information, we may not be able to provide all
        of our services to you.
      </p>
      <p style={pStyle}>Our Privacy Policy explains:</p>
      <ul style={listStyle}>
        <li>
          (i) how we store and use, and how you may access and correct your
          personal information;
        </li>
        <li>
          (ii) how you can lodge a complaint regarding the handling of your
          personal information; and
        </li>
        <li>(iii) how we will handle any complaint.</li>
      </ul>
      <p style={pStyle}>
        By providing your personal information to us, you consent to the
        collection, use, storage and disclosure of that information as described
        in the Privacy Policy and these Terms.
      </p>

      <h3 id={generateId(tocItems[2])} style={headingStyle}>
        3. Accuracy, completeness and timeliness of information
      </h3>
      <p style={pStyle}>
        The information on our website is not comprehensive and is intended to
        provide a summary of the subject matter covered. While we use all
        reasonable attempts to ensure the accuracy and completeness of the
        information on our website, live waiting times displayed for delivery
        and pickup are estimates only as set out in our Delivery Policy. We may,
        from time to time and without notice, change or add to the website
        (including the Terms) or the information, products or services described
        in it. However, we do not undertake to keep the website updated. We are
        not liable to you or anyone else if errors occur in the information on
        the website or if that information is not up-to-date.
      </p>

      <h3 id={generateId(tocItems[3])} style={headingStyle}>
        4. Promotions and competitions
      </h3>
      <p style={pStyle}>
        For certain campaigns, promotions or contests, additional terms and
        conditions may apply. If you want to participate in such a campaign,
        promotion or contest, you need to agree to the relevant terms and
        conditions applicable to that campaign, promotion or contest. In case of
        any inconsistency between such terms and conditions and these Terms,
        those terms and conditions will prevail.
      </p>

      <h3 id={generateId(tocItems[4])} style={headingStyle}>
        5. Orders and processing
      </h3>
      <h4 style={subHeadingStyle}>5.1 Placing your Order</h4>
      <p style={pStyle}>
        Once you select the Products you wish to order from the menu and provide
        other required information, you will be given the opportunity to submit
        your Order by clicking or selecting the "Order", "Proceed to Payment",
        "Confirm and Pay" or similar button. It is important that you check all
        the information that you enter and correct any errors before clicking or
        selecting this button; once you do so we will process your Order and
        errors cannot be corrected.
      </p>
      <h4 style={subHeadingStyle}>5.2 Minimum Order Amount</h4>
      <p style={pStyle}>
        If a minimum order amount is in place, you may not place an order until
        the value of your Order equals or exceeds that amount. The minimum order
        amount must be met after applying any discounts or specials that reduce
        the total Order amount.
      </p>
      <h4 style={subHeadingStyle}>5.3 Amending or cancelling your Order</h4>
      <p style={pStyle}>
        Once you submit your Order and your payment has been authorised, you
        will not be entitled to change or cancel your Order online. If you wish
        to change or cancel your Order, you may contact the Restaurant directly.
        However, there is no guarantee that the Restaurant will agree to your
        requests as they may have already started to process your Order.
      </p>
      <h4 style={subHeadingStyle}>5.4 Payment authorisation</h4>
      <p style={pStyle}>
        Where any payment you make is not authorised, your Order will not be
        processed by or communicated to the Restaurant.
      </p>
      <h4 style={subHeadingStyle}>
        5.5 Processing your Order and Restaurant rejections
      </h4>
      <p style={pStyle}>
        On receipt of your Order, we will begin processing it by sending it to
        the Restaurant and may notify you by SMS that your Order has been
        received and is being processed. The restaurant has the discretion to
        reject Orders at any time because they are too busy, due to weather
        conditions or for any other reason.
      </p>
      <h4 style={subHeadingStyle}>5.6 Delivery of your Order</h4>
      <p style={pStyle}>
        Delivery will be provided by the Restaurant. Estimated times for
        deliveries and collections are provided by the Restaurant and are only
        estimates. While the Restaurant will try their best to meet these
        estimates, we make no guarantee that Orders will be delivered or will be
        available for collection within the estimated times.
      </p>

      <h3 id={generateId(tocItems[5])} style={headingStyle}>
        6. Price and Payment
      </h3>
      <h4 style={subHeadingStyle}>6.1 Taxes and delivery costs</h4>
      <p style={pStyle}>
        Prices for individual menu items will be as quoted on the Website in
        Australian dollars. These prices include any applicable taxes but may
        exclude delivery costs and any online payment administration charge.
      </p>
      <h4 style={subHeadingStyle}>6.2 Payment methods</h4>
      <p style={pStyle}>
        Payment for Orders must be made by an accepted credit or debit card
        through the Website or in cash to the Restaurant at the point of
        collection or delivery to you.
      </p>
      <h4 style={subHeadingStyle}>6.3 Card payments</h4>
      <p style={pStyle}>
        If you pay by credit or debit card, you may be required to show the card
        to the Restaurant at the time of delivery as proof of identification.
        Delays with the processing of card payments may result in delays in sums
        being deducted from your bank account or charged to your credit or debit
        card.
      </p>
      <h4 style={subHeadingStyle}>6.4 Credit and discount vouchers</h4>
      <p style={pStyle}>
        A credit or discount may apply to your Order if you use a promotional
        voucher or code recognised by the Website and endorsed by the
        Restaurant.
      </p>
      <h4 style={subHeadingStyle}>6.5 Rejected Orders</h4>
      <p style={pStyle}>
        Once you have submitted an Order that you are paying for by credit or
        debit card and your payment has been authorised, you will be charged the
        full amount of your Order. If your Order is subsequently rejected by the
        Restaurant, your bank or card issuer will refund the relevant amount.
        This may take between 3 to 5 working days (or longer, depending on your
        bank or card issuer).
      </p>

      <h3 id={generateId(tocItems[6])} style={headingStyle}>
        7. Customer Reviews & Ratings
      </h3>
      <p style={pStyle}>
        You are responsible for review content and ratings. By submitting a
        review you agree that content provided is true and accurate.
      </p>

      <h3 id={generateId(tocItems[7])} style={headingStyle}>
        8. Linked sites
      </h3>
      <p style={pStyle}>
        Our website may contain links to websites operated by third parties.
        Those links are provided for convenience and may not remain current or
        be maintained. We do not endorse and are not responsible for the content
        on those linked websites.
      </p>

      <h3 id={generateId(tocItems[8])} style={headingStyle}>
        9. Intellectual property rights
      </h3>
      <p style={pStyle}>
        (a) Unless otherwise indicated, we own or license all rights, title and
        interest (including copyright, designs, patents, trademarks and other
        intellectual property rights) in this website and in all of the material
        made available on this website.
      </p>
      <p style={pStyle}>
        (b) Your use of this website does not grant or transfer any rights,
        title or interest to you in relation to this website or its Content. Any
        reproduction or redistribution of this website or the Content is
        prohibited and may result in civil and criminal penalties.
      </p>

      <h3 id={generateId(tocItems[9])} style={headingStyle}>
        10. Warranties and disclaimers
      </h3>
      <p style={pStyle}>
        To the maximum extent permitted by law, including the Australian
        Consumer Law, we make no warranties or representations about this
        website or the Content, including but not limited to warranties or
        representations that they will be complete, accurate or up-to-date, that
        access will be uninterrupted or error-free or free from viruses, or that
        this website will be secure.
      </p>

      <h3 id={generateId(tocItems[10])} style={headingStyle}>
        11. Liability
      </h3>
      <p style={pStyle}>
        To the maximum extent permitted by law, including the Australian
        Consumer Law, in no event shall we be liable for any direct and indirect
        loss, damage or expense which may be suffered due to your use of our
        website and/or the information or materials contained on it.
      </p>

      <h3 id={generateId(tocItems[11])} style={headingStyle}>
        12. Jurisdiction and governing law
      </h3>
      <p style={pStyle}>
        Your use of the website and these Terms are governed by the law of
        Victoria and you submit to the non-exclusive jurisdiction of the courts
        exercising jurisdiction in Victoria.
      </p>

      <h2
        id={generateId(tocItems[12])}
        style={{ ...headingStyle, marginTop: "4rem" }}
      >
        Privacy Policy
      </h2>
      <p style={pStyle}>
        In this Privacy Policy, 'us' 'we' or 'our' means Next Order Pty Ltd (ACN
        627 375 535) and our related bodies corporate. We are committed to
        respecting your privacy. Our Privacy Policy sets out how we collect,
        use, store and disclose your personal information.
      </p>

      <h4 style={subHeadingStyle}>What personal information do we collect?</h4>
      <p style={pStyle}>
        We may collect personal information such as your name, street address,
        telephone number, credit card information, device ID, and other details
        you provide to us through our website or app.
      </p>

      <h4 style={subHeadingStyle}>
        Why do we collect, use and disclose personal information?
      </h4>
      <p style={pStyle}>
        We may collect, hold, use and disclose your personal information to
        enable you to access and use our website, to operate and improve our
        services, to send you service and marketing messages, and to comply with
        our legal obligations.
      </p>

      <h4 style={subHeadingStyle}>
        Do we use your personal information for direct marketing?
      </h4>
      <p style={pStyle}>
        We may send you direct marketing communications. You may opt-out of
        receiving marketing materials from us by contacting us at
        privacy@nextorder.com.au.
      </p>

      <h4 style={subHeadingStyle}>
        To whom do we disclose your personal information?
      </h4>
      <p style={pStyle}>
        We may disclose personal information to our employees, third party
        suppliers, service providers, and as required by law. We may disclose
        personal information outside of Australia to cloud providers located in
        India and the United States of America.
      </p>

      <h4 style={subHeadingStyle}>Using our website and cookies</h4>
      <p style={pStyle}>
        We may collect personal information about you when you use and access
        our website. We may also use 'cookies' or other similar tracking
        technologies on our website that help us track your website usage and
        remember your preferences.
      </p>

      <h4 style={subHeadingStyle}>Security</h4>
      <p style={pStyle}>
        We take reasonable steps to protect your personal information from
        misuse, interference and loss, as well as unauthorised access,
        modification or disclosure.
      </p>

      <h4 style={subHeadingStyle}>Making a complaint</h4>
      <p style={pStyle}>
        If you think we have breached the Privacy Act, you can contact us at
        privacy@Ashmore.com.au. We will acknowledge your complaint and respond
        to you within a reasonable period of time.
      </p>

      <Link
        to="/"
        style={{
          color: "var(--brand-pink)",
          marginTop: "3rem",
          display: "inline-block",
          fontWeight: "bold",
          textDecoration: "none",
          fontSize: "1.1rem",
        }}
      >
        &#8592; Back to Menu
      </Link>
    </div>
  );
}

// --- NAVBAR COMPONENT ---
function Navbar({
  onAboutClick,
  onMenuClick,
  onCartClick,
  onLoginClick,
  onProfileClick,
  onLoyaltyClick,
  loyaltyEnabled = true,
  loyaltyJoined = false,
  searchName,
  searchTopping,
  onSearchNameChange,
  onSearchToppingChange,
}) {
  const { cart } = useCart();
  const { currentUser, logout, loading: authLoading } = useAuth();
  const totalItems = useMemo(
    () => cart.reduce((sum, item) => sum + item.qty, 0),
    [cart],
  );

  const firstName =
    (currentUser?.displayName && currentUser.displayName.split(" ")[0]) ||
    (currentUser?.phoneNumber ? currentUser.phoneNumber : "there");

  const { theme, setTheme } = useTheme();
  const handleToggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [setTheme, theme]);

  const [acctOpen, setAcctOpen] = useState(false);
  const acctRef = useRef(null);
  const [isNameFocused, setIsNameFocused] = useState(false);
  const [isToppingFocused, setIsToppingFocused] = useState(false);
  // Desktop search pill "hug" widths (measured from placeholder + real padding)
  const desktopNameInputRef = useRef(null);
  const desktopToppingInputRef = useRef(null);
  const [collapsedNameW, setCollapsedNameW] = useState(124);
  const [collapsedToppingW, setCollapsedToppingW] = useState(124);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const measureOne = (el) => {
      if (!el) return null;
      const cs = window.getComputedStyle(el);

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      // Match the input's rendered font as closely as possible
      ctx.font = `${cs.fontStyle} ${cs.fontVariant} ${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`;

      const text = el.getAttribute("placeholder") || "";
      const textW = ctx.measureText(text).width;

      const padL = parseFloat(cs.paddingLeft || "0") || 0;
      const padR = parseFloat(cs.paddingRight || "0") || 0;
      const borderL = parseFloat(cs.borderLeftWidth || "0") || 0;
      const borderR = parseFloat(cs.borderRightWidth || "0") || 0;

      // Tiny safety buffer so it never clips, but still hugs
      const extra = 8; // bigger safety buffer at larger header scale

      const w = Math.ceil(textW + padL + padR + borderL + borderR + extra);
      // clamp so it never gets silly
      return Math.max(110, Math.min(w, 260));
    };

    const measure = () => {
      const w1 = measureOne(desktopNameInputRef.current);
      const w2 = measureOne(desktopToppingInputRef.current);
      const maxW = Math.max(
        typeof w1 === "number" ? w1 : 0,
        typeof w2 === "number" ? w2 : 0,
      );
      if (maxW > 0) {
        setCollapsedNameW(maxW);
        setCollapsedToppingW(maxW);
      }
    };

    measure();
    const t = window.setTimeout(measure, 60);
    window.addEventListener("resize", measure);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    if (!acctOpen || typeof window === "undefined") return;

    const onKeyDown = (e) => {
      if (e.key === "Escape") setAcctOpen(false);
    };

    const onMouseDown = (e) => {
      const el = acctRef.current;
      if (!el) return;
      if (!el.contains(e.target)) setAcctOpen(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onMouseDown, true);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onMouseDown, true);
    };
  }, [acctOpen]);

  // Mobile navbar: keep the top bar tight, open search in a dropdown drawer.
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(max-width: 1023.98px)").matches;
  });
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const navRef = useRef(null);
  const mobileSearchOpenedAtRef = useRef(0);
  const mobileNameInputRef = useRef(null);
  const [mobileNavHeight, setMobileNavHeight] = useState(0);

  const closeMobileSearch = useCallback(() => setMobileSearchOpen(false), []);
  const toggleMobileSearch = useCallback(() => {
    setMobileSearchOpen((prev) => {
      const next = !prev;
      if (next) mobileSearchOpenedAtRef.current = Date.now();
      return next;
    });
  }, []);

  // Keep a reliable nav height so the (portal) drawer can sit directly beneath it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const measure = () => {
      const h = navRef.current?.getBoundingClientRect?.().height || 0;
      setMobileNavHeight(h);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // When the drawer opens: measure again + focus the first input.
  useEffect(() => {
    if (!isMobile || !mobileSearchOpen) return;

    const h = navRef.current?.getBoundingClientRect?.().height || 0;
    if (h) setMobileNavHeight(h);

    const t = window.setTimeout(() => {
      try {
        mobileNameInputRef.current?.focus?.();
      } catch {}
    }, 30);

    const onKeyDown = (e) => {
      if (e.key === "Escape") closeMobileSearch();
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isMobile, mobileSearchOpen, closeMobileSearch]);

  const mobileDrawerTop = mobileNavHeight ? mobileNavHeight + 6 : 72;

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(max-width: 1023.98px)");
    const onChange = (e) => setIsMobile(!!e.matches);
    try {
      mql.addEventListener("change", onChange);
    } catch {
      // Safari fallback
      mql.addListener(onChange);
    }
    setIsMobile(mql.matches);
    return () => {
      try {
        mql.removeEventListener("change", onChange);
      } catch {
        mql.removeListener(onChange);
      }
    };
  }, []);

  // If we leave mobile sizing, ensure drawer is closed.
  useEffect(() => {
    if (!isMobile) setMobileSearchOpen(false);
  }, [isMobile]);

  return (
    <nav ref={navRef} className="pp-topnav">
      <div className={`pp-topnav__row${isMobile ? " pp-topnav__row--mobileMinimal" : ""}`}>
        {isMobile ? (
          <>
            <button
              type="button"
              className="pp-topnav__mIconBtn"
              onClick={handleToggleTheme}
              aria-label="Toggle theme"
              title="Toggle theme"
            >
              <span className="pp-topnav__mIcon" aria-hidden="true">
                {theme === "dark" ? "\uD83C\uDF19" : "\uD83C\uDF1E"}
              </span>
            </button>

            <Link
              to="/"
              onClick={onMenuClick}
              className="pp-topnav__mLogo"
              aria-label="Pizza Peppers"
              title="Pizza Peppers"
            >
              <img
                className="pp-topnav__logoImg pp-topnav__logoImg--banner"
                src={ppBanner}
                alt="Pizza Peppers"
                draggable="false"
              />
            </Link>

            <button
              type="button"
              className="pp-topnav__mIconBtn"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleMobileSearch();
              }}
              aria-label="Search"
              aria-expanded={mobileSearchOpen}
              aria-controls="pp-mobile-search-drawer"
              title="Search"
            >
              <span className="pp-topnav__mIcon" aria-hidden="true">
                {"\uD83D\uDD0D"}
              </span>
            </button>
          </>
        ) : (
          <>
            <div className="pp-topnav__left">
              <ThemeSwitcher compact />

              {/* Desktop: keep the inline searches */}
              <div className="pp-topnav__searchWrap">
                <div
                  style={{
                    position: "relative",
                    width: "100%",
                    maxWidth: "100%",
                  }}
                >
                  <input
                    type="text"
                    placeholder="Search pizzas"
                    value={searchName || ""}
                    onChange={(e) =>
                      onSearchNameChange && onSearchNameChange(e.target.value)
                    }
                    onFocus={() => setIsNameFocused(true)}
                    onBlur={() => setIsNameFocused(false)}
                    className="pp-topnav__searchInput"
                    ref={desktopNameInputRef}
                  />
                </div>

                <div
                  style={{
                    position: "relative",
                    width: "100%",
                    maxWidth: "100%",
                  }}
                >
                  <input
                    type="text"
                    placeholder="Search toppings"
                    value={searchTopping || ""}
                    onChange={(e) =>
                      onSearchToppingChange &&
                      onSearchToppingChange(e.target.value)
                    }
                    onFocus={() => setIsToppingFocused(true)}
                    onBlur={() => setIsToppingFocused(false)}
                    className="pp-topnav__searchInput"
                    ref={desktopToppingInputRef}
                  />
                </div>
              </div>
            </div>

            <Link
              to="/"
              onClick={onMenuClick}
              className="pp-topnav__logo pp-topnav__brandCard"
              aria-label="Go to menu"
              title="Menu"
            >
              <img
                className="pp-topnav__logoImg pp-topnav__logoImg--banner"
                src={ppBanner}
                alt="Pizza Peppers"
                draggable="false"
              />
            </Link>

            <div className="pp-topnav__right">
              {acctOpen && (
                <div
                  className="pp-topnav__acctScrim"
                  onClick={() => setAcctOpen(false)}
                  aria-hidden="true"
                />
              )}
              <div className="pp-topnav__rightStack">
              <div
                className={[
                  "pp-topnav__rightActions",
                  loyaltyEnabled ? "has-loyalty" : "no-loyalty",
                ].join(" ")}
              >
                <button
                  type="button"
                  onClick={onAboutClick}
                  className="pp-topnav__linkBtn"
                >
                  About
                </button>

                {loyaltyEnabled ? (
                  <button
                    type="button"
                    onClick={onLoyaltyClick}
                    className="pp-topnav__linkBtn pp-topnav__linkBtn--loyalty"
                    title="Loyalty"
                  >
                    {`${EM.CROWN} Loyalty`}
                  </button>
                ) : null}

                  <button
                    type="button"
                    onClick={onCartClick}
                    className="pp-topnav__linkBtn"
                  >
                    Cart ({totalItems})
                  </button>
                </div>

                {authLoading ? null : currentUser ? (
                  <details
                    className="pp-topnav__acct"
                    ref={acctRef}
                    open={acctOpen}
                    onToggle={(e) => setAcctOpen(e.currentTarget.open)}
                  >
                    <summary className="pp-topnav__acctBtn">
                      <span className="pp-topnav__acctDot" />
                      <span className="pp-topnav__acctText">Hi, {firstName}</span>
                      <span className="pp-topnav__acctCaret">▾</span>
                    </summary>

                    <div className="pp-topnav__acctMenu">
                      <button
                        type="button"
                        onClick={() => {
                          setAcctOpen(false);
                          onProfileClick();
                        }}
                        className="pp-topnav__acctItem"
                      >
                        Profile
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAcctOpen(false);
                          logout?.();
                        }}
                        className="pp-topnav__acctItem pp-topnav__acctItem--danger"
                      >
                        Logout
                      </button>
                    </div>
                  </details>
                ) : (
                  <div className="pp-topnav__acct">
                    <button
                      type="button"
                      onClick={onLoginClick}
                      className="pp-topnav__acctBtn"
                    >
                      Login
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Mobile search drawer (PORTAL) — fixes cases where the drawer is clipped/hidden */}
      {isMobile && mobileSearchOpen && typeof document !== "undefined" && document.body
        ? createPortal(
            <>
              {/* Backdrop starts BELOW the header so the search button stays clickable */}
              <div
                className="pp-topnav__searchBackdrop"
                style={{
                  position: "fixed",
                  left: 0,
                  right: 0,
                  top: `${mobileDrawerTop}px`,
                  bottom: 0,
                  zIndex: 20040,
                }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  // Prevent the "finger release" from instantly closing the drawer
                  if (Date.now() - mobileSearchOpenedAtRef.current < 250) return;
                  closeMobileSearch();
                }}
              />

              <div
                id="pp-mobile-search-drawer"
                className="pp-topnav__searchDrawer is-open"
                style={{
                  position: "fixed",
                  left: 0,
                  right: 0,
                  top: `${mobileDrawerTop}px`,
                  zIndex: 20050,
                  marginTop: 0,
                }}
                role="region"
                aria-label="Search"
              >
                <div className="pp-topnav__searchDrawerInner">
                  <div className="pp-topnav__searchField">
                    <div className="pp-topnav__searchLabel">Pizzas</div>
                    <input
                      ref={mobileNameInputRef}
                      type="text"
                      placeholder="Search pizzas"
                      value={searchName || ""}
                      onChange={(e) =>
                        onSearchNameChange && onSearchNameChange(e.target.value)
                      }
                      className="pp-topnav__searchInput"
                    />
                  </div>

                  <div className="pp-topnav__searchField">
                    <div className="pp-topnav__searchLabel">Toppings</div>
                    <input
                      type="text"
                      placeholder="Search toppings"
                      value={searchTopping || ""}
                      onChange={(e) =>
                        onSearchToppingChange &&
                        onSearchToppingChange(e.target.value)
                      }
                      className="pp-topnav__searchInput"
                    />
                  </div>
                </div>
              </div>
            </>,
            document.body,
          )
        : null}
    </nav>
  );
}

function LoyaltyModal({ isOpen, onClose }) {
  const { currentUser, openLogin } = useAuth();
  const user = currentUser;

  const localProfile = useLocalProfile(user);
  const joined = !!(localProfile?.loyalty?.joined || localProfile?.loyaltyJoined);

  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState("");
  const [ok, setOk] = React.useState("");

  const AUTH_BASE = (import.meta.env.VITE_PP_AUTH_BASE_URL || import.meta.env.VITE_PP_MENU_BASE_URL || "").replace(
    /\/+$/,
    "",
  );

  const readSessionToken = React.useCallback(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("pp_session_v1") || "null");
      return raw?.token || null;
    } catch {
      return null;
    }
  }, []);

  const saveProfileEverywhere = React.useCallback(
    async (nextProfile) => {
      if (!user) return;

      // 1) local cache (instant UI)
      try {
        writeLocalProfile(user, nextProfile);
      } catch {}

      // 2) your Flask DB via /me (if token exists)
      try {
        const token = readSessionToken();
        if (AUTH_BASE && token) {
          await fetch(`${AUTH_BASE}/me`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ profile: nextProfile }),
          });
        }
      } catch {}
    },
    [user, AUTH_BASE, readSessionToken],
  );

  const handlePrimary = React.useCallback(async () => {
    setErr("");
    setOk("");

    // ✅ If not logged in: go straight to login
    if (!user) {
      try {
        onClose?.();
      } catch {}
      openLogin?.("providers");
      return;
    }

    // If already joined, nothing to do yet (placeholder program)
    if (joined) return;

    // Join + persist (profile_json)
    setSaving(true);
    try {
      const nowIso = new Date().toISOString();

      const prev = (localProfile && typeof localProfile === "object") ? localProfile : {};
      const prevL = (prev.loyalty && typeof prev.loyalty === "object") ? prev.loyalty : {};

      const nextProfile = {
        ...prev,
        loyaltyJoined: true,
        loyalty: {
          ...prevL,
          joined: true,
          joinedAt: prevL.joinedAt || nowIso,
          points: Number(prevL.points ?? prev.loyaltyPoints ?? 0) || 0,
        },
      };

      await saveProfileEverywhere(nextProfile);
      setOk("Welcome! Loyalty is now active (features coming soon).");
    } catch (e) {
      setErr(e?.message || "Couldn’t join right now.");
    } finally {
      setSaving(false);
    }
  }, [user, joined, localProfile, saveProfileEverywhere, onClose, openLogin]);

  const handleClose = React.useCallback(() => onClose?.(), [onClose]);

  if (!isOpen) return null;

  const points = Number(localProfile?.loyalty?.points ?? localProfile?.loyaltyPoints ?? 0) || 0;
  const tierLabel = joined ? "Member" : "Not joined";
  const primaryLabel = !user
    ? `Login to join ${EM.CROWN}`
    : joined
      ? `${EM.CROWN} Loyalty`
      : `Join loyalty ${EM.CROWN}`;

  const content = (
    <div className="pp-modal-backdrop" id="loyalty-modal" onClick={handleClose}>
      <div className="pp-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="pp-modal-header">
          <div className="pp-modal-title pp-loyaltyTitle">
            <span className="pp-loyaltyTitleIcon" aria-hidden="true">{EM.CROWN}</span>
            <span>Loyalty</span>
          </div>

          <button
            type="button"
            className="pp-modal-close"
            aria-label="Close"
            title="Close"
            onClick={handleClose}
          />
        </div>

        <div className="pp-modal-body">
          {(err || ok) ? (
            <div className="pp-warning" style={{ marginTop: 0 }}>
              {err || ok}
            </div>
          ) : null}

          <div className="pp-section" style={{ marginTop: 0 }}>
            <h4 style={{ marginTop: 0 }}>Status</h4>

            <div className="pp-row">
              <label>Membership</label>
              <div style={{ fontWeight: 800 }}>
                {joined ? "Joined" : "Not joined"}
              </div>
            </div>

            <div className="pp-row">
              <label>Points</label>
              <div style={{ fontWeight: 800 }}>
                {points}
              </div>
            </div>
          </div>

          <div className="pp-section">
            <h4 style={{ marginTop: 0 }}>Perks & rewards</h4>
            <div style={{ color: "var(--text-medium)", fontWeight: 650, lineHeight: 1.35 }}>
              Perks and rewards coming soon {EM.CROWN}
            </div>
          </div>
        </div>

        <div className="pp-modal-footer">
          <button
            type="button"
            className="pp-btn pp-btn-primary"
            onClick={handlePrimary}
            disabled={saving || joined}
            title={joined ? "Already joined" : undefined}
          >
            {saving ? "Saving..." : primaryLabel}
          </button>

          <button
            type="button"
            className="pp-btn pp-btn-secondary"
            onClick={handleClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" && document.body
    ? createPortal(content, document.body)
    : content;
}

// Mobile bottom nav (Menu / About / Profile)
function MobileBottomNav({
  activeKey = "menu",
  authed = false,
  onMenu,
  onAbout,
  onProfile,
  onLogin,
  loyaltyEnabled = true,
  loyaltyJoined = false,
  onLoyalty,
  elevated = false,
}) {
  const item = (key, icon, label, onClick, extraClass) => (
    <button
      type="button"
      className={[
        "pp-bottomnav__item",
        activeKey === key ? "is-active" : "",
        extraClass || "",
      ].join(" ")}
      aria-current={activeKey === key ? "page" : undefined}
      onClick={onClick}
    >
      <span className="pp-bottomnav__icon" aria-hidden="true">{icon}</span>
      <span className="pp-bottomnav__label">{label}</span>
    </button>
  );

  return (
    <nav
      className={[
        "pp-bottomnav",
        !loyaltyEnabled ? "pp-bottomnav--3" : "",
        elevated ? "pp-bottomnav--elevated" : "",
      ].join(" ")}
      aria-label="Primary"
    >
      {item("menu", "\uD83C\uDF55", "Menu", () => onMenu?.())}
      {item("about", "\uD83C\uDFEA", "About", () => onAbout?.())}
      {loyaltyEnabled
        ? item(
            "loyalty",
            EM.CROWN,
            "Loyalty",
            () => onLoyalty?.(),
            "pp-bottomnav__item--loyalty",
          )
        : null}
      {item("profile", "\uD83D\uDC64", "Profile", () => (authed ? onProfile?.() : onLogin?.()))}
    </nav>
  );
}

// ADD THIS ENTIRE BLOCK AFTER YOUR Navbar COMPONENT
function Footer() {
  return (
    <footer className="site-footer">
      <div className="ashmore-lockup" aria-label="Forged by Ashmore Co">
        <img
          className="ashmore-lockup__mark"
          src="/ashmore-co.png"
          alt=""
          aria-hidden="true"
        />
        <div className="ashmore-lockup__words">
          <div className="ashmore-lockup__kicker">FORGED BY</div>
          <div className="ashmore-lockup__brand">
            ASHMORE <span className="ashmore-lockup__co">CO</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

// --- PAGE COMPONENT ---
function Home({
  menuData,
  handleItemClick,
  hhMobilePicking,
  hhMobileDraft,
  setHhMobileDraft,
  mealDealDraft,
  onResumeMealDeal,
}) {
  // --- Meal deal "resume" banner dismiss (does NOT delete the draft) ---
  const mealDealDraftKey = React.useMemo(() => {
    if (!mealDealDraft) return "";
    return String(
      mealDealDraft.draftId ||
        mealDealDraft.id ||
        mealDealDraft.item?.id ||
        mealDealDraft.name ||
        "draft",
    );
  }, [mealDealDraft]);

  const [hideMealDealResumeBanner, setHideMealDealResumeBanner] = React.useState(false);

  React.useEffect(() => {
    if (!mealDealDraft) {
      setHideMealDealResumeBanner(false);
      return;
    }
    try {
      const k = `pp_hide_mealdeal_resume_${mealDealDraftKey}`;
      setHideMealDealResumeBanner(window.localStorage.getItem(k) === "1");
    } catch {
      setHideMealDealResumeBanner(false);
    }
  }, [mealDealDraft, mealDealDraftKey]);

  const dismissMealDealResumeBanner = React.useCallback(() => {
    setHideMealDealResumeBanner(true);
    try {
      const k = `pp_hide_mealdeal_resume_${mealDealDraftKey}`;
      window.localStorage.setItem(k, "1");
    } catch {}
  }, [mealDealDraftKey]);

  const [activeCategory, setActiveCategory] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sections =
      (menuData?.categories || []).map((category) => ({
        id: formatId(category.name),
        element: document.getElementById(formatId(category.name)),
      })) || [];

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveCategory(entry.target.id);
          }
        });
      },
      { rootMargin: "-40% 0px -55% 0px", threshold: 0 },
    );

    sections.forEach(({ element }) => {
      if (element) observer.observe(element);
    });

    return () => observer.disconnect();
  }, [menuData]);

  return (
    <>
      {mealDealDraft && !hideMealDealResumeBanner && (
        <div
          style={{
            marginBottom: "0.85rem",
            padding: "0.85rem 1rem",
            borderRadius: "16px",
            border: "1px solid rgba(148,163,184,0.28)",
            background: "var(--panel)",
            boxShadow: "var(--shadow-card)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "0.75rem",
          }}
        >
          <div>
            <div style={{ fontWeight: 900 }}>Meal deal in progress</div>
            <div style={{ color: "var(--text-medium)", fontWeight: 700 }}>
              Tap to resume building
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.55rem" }}>
            <button
              type="button"
              className="place-order-button"
              style={{ width: "auto", paddingInline: "1rem" }}
              onClick={onResumeMealDeal}
            >
              Resume
            </button>

            {/* Dismiss banner (keeps draft saved) */}
            <button
              type="button"
              className="pp-btn pp-btn-subtle"
              aria-label="Close"
              title="Dismiss"
              onClick={(e) => {
                e.stopPropagation();
                dismissMealDealResumeBanner();
              }}
            />
          </div>
        </div>
      )}
      <QuickNav menuData={menuData} activeCategory={activeCategory} usePortal />
      {hhMobilePicking && (
        <div className="pp-hh-pickNotice" role="status" aria-live="polite">
          <div className="pp-hh-pickNotice__top">
            <div>
              <div className="pp-hh-pickNotice__kicker">
                {"\uD83C\uDF55"} Half & Half {"\u2014"} Selection Mode
              </div>
              <div className="pp-hh-pickNotice__title">
                Pick <b>two</b> pizzas to build your Half & Half
              </div>
            </div>

            <button
              type="button"
              className="pp-hh-pickNotice__exit"
              onClick={() => setHhMobileDraft(null)}
              aria-label="Exit Half and Half selection"
              title="Exit"
            >
              {"\u2715"} Exit
            </button>
          </div>

          <div className="pp-hh-pickNotice__stepRow">
            <div className="pp-hh-pickNotice__stepPill">
              Step {hhMobileDraft?.side === "A" ? "1" : "2"} / 2
            </div>

            <div className="pp-hh-pickNotice__nextPill">
              Next:{" "}
              <b>
                {hhMobileDraft?.side === "A"
                  ? `Pizza 1 (Left) ${"\uD83D\uDC48"}`
                  : `Pizza 2 (Right) ${"\uD83D\uDC49"}`}
              </b>
            </div>
          </div>

          <div className="pp-hh-pickNotice__progress" aria-hidden="true">
            <div
              className={[
                "pp-hh-pickNotice__seg",
                hhMobileDraft?.halfA ? "is-done" : "is-active",
              ].join(" ")}
            />
            <div
              className={[
                "pp-hh-pickNotice__seg",
                hhMobileDraft?.halfB
                  ? "is-done"
                  : hhMobileDraft?.side === "B"
                  ? "is-active"
                  : "",
              ].join(" ")}
            />
          </div>

          <div className="pp-hh-pickNotice__cards">
            <div
              className={[
                "pp-hh-pickNotice__card",
                hhMobileDraft?.halfA ? "is-filled" : "",
              ].join(" ")}
            >
              <div className="pp-hh-pickNotice__cardTag">LEFT</div>
              <div className="pp-hh-pickNotice__cardName">
                {hhMobileDraft?.halfA?.name || "Pizza 1 not selected"}
              </div>
            </div>

            <div
              className={[
                "pp-hh-pickNotice__card",
                hhMobileDraft?.halfB ? "is-filled" : "",
              ].join(" ")}
            >
              <div className="pp-hh-pickNotice__cardTag">RIGHT</div>
              <div className="pp-hh-pickNotice__cardName">
                {hhMobileDraft?.halfB?.name || "Pizza 2 not selected"}
              </div>
            </div>
          </div>

          <div className="pp-hh-pickNotice__hint">
            {EM.CHECK} Tap a pizza card below to fill the{" "}
            <b>{hhMobileDraft?.side === "A" ? "LEFT" : "RIGHT"}</b> half. You can
            change it later.
          </div>
        </div>
      )}
      <Menu menuData={menuData} onItemClick={handleItemClick} />
    </>
  );
}

function LoadingScreen({
  title = "Loading\u2026",
  subtitle = "Please wait",
}) {
  return (
    <div className="pp-loading-screen" role="status" aria-live="polite">
      <div className="pp-loading-card">
        <div className="pp-loading-brand">Pizza Peppers</div>
        <div className="pp-loading-spinner" aria-hidden="true" />
        <div className="pp-loading-title">{title}</div>
        <div className="pp-loading-subtitle">{subtitle}</div>

        <div className="pp-loading-bars" aria-hidden="true">
          <div className="pp-loading-bar" />
          <div className="pp-loading-bar" />
          <div className="pp-loading-bar" />
        </div>
      </div>
    </div>
  );
}

// --- LAYOUT COMPONENT ---
function AppLayout({ isMapsLoaded }) {
  // --- DIAG BLOCK (prove this is the file actually rendering) ---
  if (!w.__PP_DIAG_MARK) {
    w.__PP_DIAG_MARK = Math.random().toString(36).slice(2, 8);
    console.log("[PP][diag] AppLayout mount mark =", w.__PP_DIAG_MARK);
  }

  const location = useLocation();
  const isAdminRoute = location.pathname.startsWith("/admin");
  React.useEffect(() => {
    // Best-effort retry of queued orders
    flushOrderOutboxOnce().then((r) => {
      if (r?.sent) console.log("[PP][OrderOutbox] flushed", r);
    }).catch(() => {});
  }, []);

  const authCtx = useAuth();
  const authUser = authCtx.currentUser;
  const authLoadingFlag = authCtx.loading;
  const localProfile = useLocalProfile(authUser);
  const loyaltyJoined = !!(localProfile?.loyalty?.joined || localProfile?.loyaltyJoined);

  // Debug-only: quick sanity renderer to verify pipeline via ?menuDebug=1
  const menuDebug =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("menuDebug");

  const { cart, totalPrice, addToCart, removeFromCart } = useCart();
  const cartItemCount = React.useMemo(() => {
    return (cart || []).reduce((sum, it) => sum + (Number(it?.qty) || 1), 0);
  }, [cart]);
  // Mobile cart FAB: item count + subtle "added" animation
  const [cartFabBump, setCartFabBump] = React.useState(false);
  const cartFabPrevCountRef = React.useRef(null);
  const cartFabTimerRef = React.useRef(null);

  React.useEffect(() => {
    // first render: just set baseline
    if (cartFabPrevCountRef.current == null) {
      cartFabPrevCountRef.current = cartItemCount;
      return;
    }

    const prev = Number(cartFabPrevCountRef.current || 0);
    const next = Number(cartItemCount || 0);
    cartFabPrevCountRef.current = next;

    // Only bump when count increases
    if (next > prev) {
      setCartFabBump(true);
      if (cartFabTimerRef.current) window.clearTimeout(cartFabTimerRef.current);
      cartFabTimerRef.current = window.setTimeout(() => {
        setCartFabBump(false);
      }, 520);
    }
  }, [cartItemCount]);

  React.useEffect(() => {
    return () => {
      if (cartFabTimerRef.current) window.clearTimeout(cartFabTimerRef.current);
    };
  }, []);
  const [menuData, setMenuData] = React.useState({
    categories: [],
    option_lists: [],
    optionListsMap: {},
  });
  const [isLoading, setIsLoading] = React.useState(true);
  const [menuReady, setMenuReady] = React.useState(false);
  const [menuError, setMenuError] = useState(null);
  // Global header search state
  const [searchName, setSearchName] = useState("");
  const [searchTopping, setSearchTopping] = useState("");
  const [mealDealMenuFilter, setMealDealMenuFilter] = useState(null);
  const [mealDealDraft, setMealDealDraft] = useState(null);

  const [selectedItem, setSelectedItem] = useState(null);
  const [editingIndex, setEditingIndex] = useState(null);
  const [customizingItem, setCustomizingItem] = useState(null);
  const [rightPanelView, setRightPanelView] = useState("order");
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isLoyaltyOpen, setIsLoyaltyOpen] = useState(false);
  const [loyaltyEnabled, setLoyaltyEnabled] = React.useState(() => {
    if (typeof window === "undefined") return true;
    return readLoyaltyFeatureEnabled();
  });

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    const sync = () => setLoyaltyEnabled(readLoyaltyFeatureEnabled());

    const onStorage = (e) => {
      if (e?.key === FEATURE_LOYALTY_ENABLED_KEY) sync();
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(FEATURE_FLAGS_UPDATED_EVENT, sync);

    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(FEATURE_FLAGS_UPDATED_EVENT, sync);
    };
  }, []);

    
  React.useEffect(() => {
    if (!loyaltyEnabled && isLoyaltyOpen) setIsLoyaltyOpen(false);
  }, [loyaltyEnabled, isLoyaltyOpen]);
  // Mobile detection (keeps it in sync when resizing devtools)
  const [isMobileScreen, setIsMobileScreen] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 1023.98px)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 1023.98px)");
    const onChange = () => setIsMobileScreen(mq.matches);
    onChange();
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  const [isMobile, setIsMobile] = React.useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 1023.98px)").matches;
  });
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(max-width: 1023.98px)");
    const onChange = (e) => setIsMobile(e.matches);
    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else mql.addListener(onChange);
    setIsMobile(mql.matches);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", onChange);
      else mql.removeListener(onChange);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const update = () => {
      const topnav = document.querySelector(".pp-topnav");
      if (!topnav) return;

      const h = Math.ceil(topnav.getBoundingClientRect().height || 0);
      const gap = 10; // breathing room between header + quick-nav

      document.documentElement.style.setProperty("--pp-qnav-top", `${h + gap}px`);
    };

    const rafUpdate = () => requestAnimationFrame(update);

    rafUpdate();
    window.addEventListener("resize", rafUpdate);
    window.addEventListener("orientationchange", rafUpdate);

    return () => {
      window.removeEventListener("resize", rafUpdate);
      window.removeEventListener("orientationchange", rafUpdate);
    };
  }, []);

  const [cartModalOpen, setCartModalOpen] = React.useState(false);

  React.useEffect(() => {
    if (!authCtx.showLogin) return;
    ppLockBodyScroll();
    return () => ppUnlockBodyScroll();
  }, [authCtx.showLogin]);

  React.useEffect(() => {
    if (!isProfileOpen) return;
    ppLockBodyScroll();
    return () => ppUnlockBodyScroll();
  }, [isProfileOpen]);

  React.useEffect(() => {
    if (!isLoyaltyOpen) return;
    ppLockBodyScroll();
    return () => ppUnlockBodyScroll();
  }, [isLoyaltyOpen]);

  const anyOverlayOpen =
    authCtx.showLogin ||
    cartModalOpen ||
    isProfileOpen ||
    isLoyaltyOpen ||
    (isMobile && !!selectedItem);

  React.useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (anyOverlayOpen) return;

    try {
      window.__ppScrollLockCount = 0;
      document.body.classList.remove("pp-scroll-locked");
    } catch {}
  }, [anyOverlayOpen]);

  const showViewOrderFab =
    isMobile &&
    !authCtx.showLogin &&
    !cartModalOpen &&
    !isProfileOpen &&
    !isLoyaltyOpen &&
    !selectedItem; // hides during item detail + meal deal editor + half&half, etc.

  const openLoyalty = React.useCallback(() => {
    if (!loyaltyEnabled) return;
    setCartModalOpen(false);
    setIsProfileOpen(false);
    setIsLoyaltyOpen(true);
  }, [loyaltyEnabled]);

  const prevIsHalfHalfOpenRef = React.useRef(false);

  const hardScrollToTopAndClearHash = React.useCallback(() => {
    if (typeof window === "undefined") return;

    // 1) Clear hash so the browser stops anchoring to #classic-pizzas etc.
    try {
      if (window.location.hash) {
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search
        );
      }
    } catch {}

    // 2) Temporarily disable smooth scrolling (CSS has html { scroll-behavior:smooth; })
    const html = document.documentElement;
    const prevScrollBehavior = html.style.scrollBehavior;
    try {
      html.style.scrollBehavior = "auto";
    } catch {}

    const hardTop = () => {
      try { window.scrollTo(0, 0); } catch {}

      // Hit common scrollers (covers future layout changes)
      const scrollers = [
        document.scrollingElement,
        document.documentElement,
        document.body,
        document.querySelector(".left-pane"),
        document.querySelector(".main-content-area"),
        document.querySelector(".menu-content"),
      ].filter(Boolean);

      for (const el of scrollers) {
        try {
          el.scrollTop = 0;
          el.scrollTo?.({ top: 0, left: 0, behavior: "auto" });
        } catch {}
      }
    };

    // Run a few times to beat layout / sticky elements / reflow
    try {
      hardTop();
      requestAnimationFrame(hardTop);
      setTimeout(hardTop, 50);
      setTimeout(hardTop, 120);
    } finally {
      // Restore previous behavior
      try {
        setTimeout(() => {
          html.style.scrollBehavior = prevScrollBehavior || "";
        }, 150);
      } catch {}
    }
  }, []);
  // Ensure Half & Half always opens at the top on mobile
  const prevHalfHalfOpenRef = React.useRef(false);
  const navigate = useNavigate();

  const goToMenu = React.useCallback(() => {
    // Hard reset: close any overlays and return to the menu screen.
    setIsProfileOpen(false);
    setCartModalOpen(false);

    setSelectedItem(null);
    setCustomizingItem(null);
    setEditingIndex(null);

    setRightPanelView("order");

    // If user is on /login or /terms, bring them back home too.
    try {
      navigate("/", { replace: false });
    } catch {}
  }, [
    navigate,
    setIsProfileOpen,
    setCartModalOpen,
    setSelectedItem,
    setCustomizingItem,
    setEditingIndex,
    setRightPanelView,
  ]);

  // Safety: if you resize back to desktop, close the modal
  React.useEffect(() => {
    if (!isMobile) setCartModalOpen(false);
  }, [isMobile]);

  React.useEffect(() => {
    const isHH =
      !!selectedItem && (selectedItem.isHalfHalf === true || String(selectedItem.id) === "half_half");

    if (isMobileScreen && isHH && !prevIsHalfHalfOpenRef.current) {
      hardScrollToTopAndClearHash();
    }

    prevIsHalfHalfOpenRef.current = isHH;
  }, [isMobileScreen, selectedItem, hardScrollToTopAndClearHash]);

  React.useEffect(() => {
    const isHH = !!selectedItem?.isHalfHalf;
    if (!isMobileScreen) {
      prevHalfHalfOpenRef.current = isHH;
      return;
    }

    // Only on transition: closed -> open
    if (isHH && !prevHalfHalfOpenRef.current) {
      try {
        requestAnimationFrame(() => {
          // Reset any page scroll
          window.scrollTo({ top: 0, left: 0, behavior: "auto" });

          // Reset the Half & Half modal scroll container
          const panel = document.querySelector(".pp-halfhalf-modal__panel");
          if (panel && panel.scrollTo) {
            panel.scrollTo({ top: 0, left: 0, behavior: "auto" });
          }
        });
      } catch {}
    }

    prevHalfHalfOpenRef.current = isHH;
  }, [isMobileScreen, selectedItem]);

  React.useEffect(() => {
    if (!isMobile) return;
    if (!cartModalOpen) return;
    ppLockBodyScroll();
    return () => ppUnlockBodyScroll();
  }, [isMobile, cartModalOpen]);

  // Mobile Half & Half flow draft: pick pizzas in menu first, then open editor modal
  const [hhMobileDraft, setHhMobileDraft] = useState(null);
  /**
   * hhMobileDraft shape:
   * {
   *   step: "pick" | "edit",
   *   side: "A" | "B",
   *   halfA: object|null,
   *   halfB: object|null,
   *   sizeRef: "LARGE"|"FAMILY"|"PARTY"|"REGULAR" // optional
   * }
   */
  const hhMobilePicking = isMobileScreen && hhMobileDraft?.step === "pick";

  // --- Order draft state (shared between order + review panels) ---
  const [orderType, setOrderType] = useState("Pickup");
  const [orderAddress, setOrderAddress] = useState("");
  const [orderDeliveryFee, setOrderDeliveryFee] = useState(0);
  const [orderAddressError, setOrderAddressError] = useState("");
  const [estimatedTime, setEstimatedTime] = useState(0);
  const [storeOpenNow, setStoreOpenNow] = useState(() => isOpenNowAdelaide());
  // Scheduling (works even when store is open)
  const [pickupWhen, setPickupWhen] = useState("ASAP"); // "ASAP" | "SCHEDULE"
  const [pickupScheduledUtcIso, setPickupScheduledUtcIso] = useState(""); // ISO UTC
  const [deliveryWhen, setDeliveryWhen] = useState("ASAP"); // "ASAP" | "SCHEDULE"
  const [deliveryScheduledUtcIso, setDeliveryScheduledUtcIso] = useState(""); // ISO UTC
  const [pickupTimeLocked, setPickupTimeLocked] = useState(false);
  const [deliveryTimeLocked, setDeliveryTimeLocked] = useState(false);

  useEffect(() => {
    const base = 20;
    const itemsCount = cart.reduce((sum, it) => sum + (it?.qty || 0), 0);
    const extra = itemsCount > 1 ? (itemsCount - 1) * 2 : 0;
    const cookTime = base + extra;
    if (orderType === "Pickup") setEstimatedTime(cookTime);
    else
      setEstimatedTime(
        orderAddress ? cookTime + Math.floor(Math.random() * 21) + 15 : 0,
      );
  }, [orderType, orderAddress, cart]);

  useEffect(() => {
    const t = setInterval(() => setStoreOpenNow(isOpenNowAdelaide()), 60 * 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!storeOpenNow) return;

    const computeNext = (leadMins) => {
      const now = new Date();
      const earliestUtc = now.getTime() + leadMins * 60 * 1000;
      const rounded =
        Math.ceil(earliestUtc / (15 * 60 * 1000)) * (15 * 60 * 1000);
      return new Date(rounded).toISOString();
    };

    const tick = () => {
      if (!pickupTimeLocked) {
        setPickupScheduledUtcIso(computeNext(15));
        setPickupWhen("ASAP");
      }
      if (!deliveryTimeLocked) {
        setDeliveryScheduledUtcIso(computeNext(45));
        setDeliveryWhen("ASAP");
      }
    };

    tick();
    const t = setInterval(tick, 60 * 1000);
    return () => clearInterval(t);
  }, [storeOpenNow, pickupTimeLocked, deliveryTimeLocked]);

  useEffect(() => {
    if (storeOpenNow) return;

    // Store closed -> both fulfilments must be scheduled
    setPickupWhen("SCHEDULE");
    setDeliveryWhen("SCHEDULE");

    if (!pickupTimeLocked || !pickupScheduledUtcIso) {
      const openUtc = getNextOpeningUtcAdelaide(new Date());
      if (openUtc) {
        const readyUtc = new Date(openUtc.getTime() + 15 * 60 * 1000);
        setPickupScheduledUtcIso(readyUtc.toISOString());
      }
    }
    if (!deliveryTimeLocked || !deliveryScheduledUtcIso) {
      const openUtc = getNextOpeningUtcAdelaide(new Date());
      if (openUtc) {
        const readyUtc = new Date(openUtc.getTime() + 45 * 60 * 1000);
        setDeliveryScheduledUtcIso(readyUtc.toISOString());
      }
    }
  }, [
    storeOpenNow,
    pickupScheduledUtcIso,
    deliveryScheduledUtcIso,
    pickupTimeLocked,
    deliveryTimeLocked,
  ]);

  useEffect(() => {
    if (orderType === "Delivery" && storeOpenNow) {
      setPickupWhen("ASAP");
    }
  }, [orderType, storeOpenNow]);

  const preorderPickupLabel = useMemo(() => {
    if (orderType !== "Pickup") return null;
    if (storeOpenNow) return null;
    const openUtc = getNextOpeningUtcAdelaide(new Date());
    if (!openUtc) return null;
    const readyUtc = new Date(openUtc.getTime() + 15 * 60 * 1000); // 15 min after opening
    return new Intl.DateTimeFormat("en-AU", {
      timeZone: ADEL_TZ,
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(readyUtc);
  }, [orderType, storeOpenNow]);

  useEffect(() => {
    if (rightPanelView === "review" && cart.length === 0) {
      setRightPanelView("order");
    }
  }, [rightPanelView, cart.length]);

  const halfAndHalfApplyPizzaRef = useRef(null);
  const mealDealApplyItemRef = useRef(null);

  const registerExternalPizzaApply = useCallback((fnOrNull) => {
    // Store the callback so handleItemClick can route menu clicks into
    // the Half & Half selector. Passing null clears it.
    halfAndHalfApplyPizzaRef.current = fnOrNull || null;
  }, []);

  const registerExternalMealItemApply = useCallback((fnOrNull) => {
    mealDealApplyItemRef.current = fnOrNull || null;
  }, []);

  // Filter menuData based on pizza name + toppings
  const filteredMenuData = React.useMemo(() => {
    if (!menuData || !Array.isArray(menuData.categories)) return menuData;

    const nameQ = searchName.trim().toLowerCase();
    const toppingQ = searchTopping.trim().toLowerCase();
    const hasName = nameQ.length > 0;
    const hasTopping = toppingQ.length > 0;

    if (!hasName && !hasTopping) return menuData;

    const filteredCategories = (menuData.categories || [])
      .map((cat) => {
        const items = (cat.items || []).filter((item) => {
          if (!item) return false;

          const matchesName = !hasName
            ? true
            : String(item.name || "").toLowerCase().includes(nameQ);

          if (!hasTopping) return matchesName;

          const rawIngredients = Array.isArray(item.ingredients)
            ? item.ingredients
            : [];

          const flatIngredients = rawIngredients
            .map((ing) => {
              if (!ing) return "";
              if (typeof ing === "string") return ing;
              return (
                ing.name ||
                ing.label ||
                ing.value ||
                ing.ref ||
                ing.id ||
                ""
              );
            })
            .join(" ")
            .toLowerCase();

          const matchesTopping = flatIngredients.includes(toppingQ);
          return matchesName && matchesTopping;
        });

        if (!items.length) return null;
        return { ...cat, items };
      })
      .filter(Boolean);

    return { ...(menuData || {}), categories: filteredCategories };
  }, [menuData, searchName, searchTopping]);

  const menuDataForHome = useMemo(() => {
    const base = filteredMenuData || menuData;

    const builderOpen =
      selectedItem?.bundle &&
      Array.isArray(selectedItem.bundle.slots) &&
      selectedItem.bundle.slots.length;

    let out = base;

    if (mealDealMenuFilter?.halfHalfMode) {
      out = _filterMenuDataForHalfHalf(base);
    } else if (builderOpen && mealDealMenuFilter?.step) {
      // Meal deal builder: restrict to the current step/category/search
      out = _filterMenuDataForMealStep(base, mealDealMenuFilter.step, {
        activeCategoryRef: mealDealMenuFilter.activeCategoryRef,
        search: mealDealMenuFilter.search,
        hideHalfHalf: mealDealMenuFilter.hideHalfHalf,
      });
    }

    // Half & Half builder: ONLY show eligible pizzas in the left menu
    if (selectedItem?.isHalfHalf || hhMobilePicking) {
      out = _filterMenuDataForHalfHalf(out);
    }

    return out;
  }, [filteredMenuData, menuData, selectedItem, mealDealMenuFilter, hhMobilePicking]);

  const menuItems = React.useMemo(() => {
    const sourceMenu = menuDataForHome || menuData;
    const categories = Array.isArray(sourceMenu?.categories)
      ? sourceMenu.categories
      : [];
    const rows = [];
    categories.forEach((cat) => {
      const catAllowHalf = cat?.allowHalf ?? cat?.allow_half ?? undefined;
      (cat?.items || []).forEach((item) => {
        const baseCents = getBasePriceCents(item) || 0;
        const cents = Number.isFinite(item?.price_cents)
          ? item.price_cents
          : baseCents;
        rows.push({
          ...item,
          category: item.category || (cat?.type === "pizza" ? "Pizza" : item.category),
          __categoryType: cat?.type,
          __categoryRef: cat?.ref,
          // propagate allowHalf flag from product or category level
          allowHalf:
            item?.allowHalf ??
            item?.allow_half ??
            catAllowHalf,
          price: cents,
          price_cents: cents,
        });
      });
    });
    return rows;
  }, [menuData, menuDataForHome]);
  const handleProfileOpen = React.useCallback(() => {
    console.log(
      "[PP][Profile] open clicked. user=",
      authUser?.email || authUser?.uid || null,
      "authLoading=",
      authLoadingFlag,
    );
    setIsProfileOpen(true);
  }, [authLoadingFlag, authUser]);

  const forceMenuReady = React.useCallback(() => {
    setIsLoading(false);
    setMenuReady(true);
    console.warn("[menu][dev] forced ready");
  }, [setIsLoading, setMenuReady]);

  const prepareItemForPanel = useCallback((item) => {
    if (!item) return null;
    const fallbackCents = Number.isFinite(item?.priceCents?.Default)
      ? item.priceCents.Default
      : Number.isFinite(item?.minPriceCents)
        ? item.minPriceCents
        : Number.isFinite(item?.basePrice_cents)
          ? item.basePrice_cents
          : 0;
    const rawEntries =
      Array.isArray(item?.skus) && item.skus.length
        ? item.skus
        : Array.isArray(item?.sizes) && item.sizes.length
          ? item.sizes
          : null;
    const sizeEntries = rawEntries
      ? rawEntries.map((entry, idx) => {
          if (entry && typeof entry === "object") {
            const labelRaw = entry.name || entry.size || entry.label;
            const label =
              typeof labelRaw === "string" && labelRaw.trim()
                ? labelRaw.trim()
                : `Option ${idx + 1}`;
            const centsFromMap = Number.isFinite(item?.priceCents?.[label])
              ? item.priceCents[label]
              : null;
            const centsEntry = toCents(
              entry.price_cents ?? entry.price ?? entry.amount ?? entry.value,
            );
            const cents = Number.isFinite(centsFromMap)
              ? centsFromMap
              : Number.isFinite(centsEntry)
                ? centsEntry
                : fallbackCents;
            return {
              ...entry,
              id: entry.id || entry.skuId || `${item.id || "product"}-${idx}`,
              name: label,
              price_cents: Number.isFinite(cents) ? cents : fallbackCents,
            };
          }
          const label =
            typeof entry === "string" && entry.trim()
              ? entry.trim()
              : `Option ${idx + 1}`;
          const cents = Number.isFinite(item?.priceCents?.[label])
            ? item.priceCents[label]
            : fallbackCents;
          return {
            id: `${item.id || "product"}-${idx}`,
            name: label,
            price_cents: Number.isFinite(cents) ? cents : fallbackCents,
          };
        })
      : [
          {
            id: item.id || "default",
            name: "Regular",
            price_cents: fallbackCents,
          },
        ];
    const sizeNames = sizeEntries.map((s) => s.name || "Regular");
    const priceMap = {};
    const priceCentsMap = {};
    for (const entry of sizeEntries) {
      const label = entry.name || "Regular";
      const centsFromMap = Number.isFinite(item?.priceCents?.[label])
        ? item.priceCents[label]
        : null;
      const cents = Number.isFinite(centsFromMap)
        ? centsFromMap
        : Number.isFinite(entry.price_cents)
          ? entry.price_cents
          : fallbackCents;
      priceCentsMap[label] = Number.isFinite(cents) ? cents : fallbackCents;
      priceMap[label] = priceCentsMap[label] / 100;
    }
    return {
      ...item,
      image: getProductImageUrl(item),
      rawSizes: sizeEntries,
      sizes: sizeNames,
      prices: priceMap,
      priceCents: priceCentsMap,
      basePrice:
        (Number.isFinite(item?.minPriceCents)
          ? item.minPriceCents
          : fallbackCents) / 100,
    };
  }, []);

  // Shared click metadata so mobile + desktop routing stays in sync.
  const _getMenuClickMeta = useCallback(
    (menuItem, prepared) => {
      // Look up the flat menu row so we can inspect category info
      const flat = Array.isArray(menuItems)
        ? menuItems.find((row) => row.id === menuItem.id) ||
          menuItems.find((row) => row.name === menuItem.name)
        : null;

      // Only allow proper pizzas (non-mini) that explicitly allow Half & Half
      const categoryRefRaw = flat?.__categoryRef || flat?.category_ref;
      const categoryRef =
        typeof categoryRefRaw === "string" ? categoryRefRaw.toUpperCase() : "";
      const allowedHalfSizes = _halfHalfAllowedSizeSet(menuData);

      const isPizzaForHalfHalf =
        !!flat &&
        categoryRef.endsWith("_PIZZAS") &&
        categoryRef !== "MINI_PIZZAS" &&
        flat.allowHalf !== false &&
        _productHasAnyAllowedHalfHalfSize(flat, allowedHalfSizes);

      const clickedIsMealBundle =
        prepared?.bundle &&
        Array.isArray(prepared.bundle.slots) &&
        prepared.bundle.slots.length;

      return { isPizzaForHalfHalf, clickedIsMealBundle };
    },
    [menuItems, menuData],
  );

  const handleItemClickMobile = useCallback(
    (menuItem) => {
      const prepared = prepareItemForPanel(menuItem);
      if (!prepared) return;

      const { isPizzaForHalfHalf, clickedIsMealBundle } = _getMenuClickMeta(
        menuItem,
        prepared,
      );

      // MOBILE Half & Half picking: menu click selects Pizza 1 then Pizza 2
      if (hhMobilePicking && prepared.id !== "half_half") {
        // Only accept eligible pizzas
        if (!isPizzaForHalfHalf) return;

        const base = {
          ...prepared,
          qty: 1,
          add_ons: [],
          removedIngredients: [],
          size: hhMobileDraft?.sizeRef || "LARGE",
        };

        const selectionSide = hhMobileDraft?.side || "A";
        const otherPicked =
          selectionSide === "A"
            ? Boolean(hhMobileDraft?.halfB)
            : Boolean(hhMobileDraft?.halfA);

        setHhMobileDraft((prev) => {
          const side = prev?.side || "A";
          const next = { ...(prev || {}), step: otherPicked ? "edit" : "pick" };

          if (side === "A") {
            next.halfA = base;
            next.side = "B";
            return next;
          }

          next.halfB = base;
          next.side = "A";
          return next;
        });

        // If the other half already exists, open the modal editor.
        if (otherPicked) {
          setSelectedItem(HALF_HALF_FORCED_ITEM);
        }

        return;
      }

      // If the Half & Half editor is open and this item is eligible,
      // route the click into the selector instead of opening the panel
      if (
        selectedItem?.isHalfHalf &&
        halfAndHalfApplyPizzaRef?.current &&
        prepared.id !== "half_half" &&
        isPizzaForHalfHalf
      ) {
        halfAndHalfApplyPizzaRef.current(prepared);
        return;
      }

      const builderOpen =
        selectedItem?.bundle &&
        Array.isArray(selectedItem.bundle.slots) &&
        selectedItem.bundle.slots.length;

      if (builderOpen && mealDealApplyItemRef?.current && !clickedIsMealBundle) {
        mealDealApplyItemRef.current(menuItem);
        return;
      }

      if (clickedIsMealBundle) {
        setMealDealDraft(prepared);
        setSelectedItem(prepared);
        setCustomizingItem(null);
        setEditingIndex(null);
        setRightPanelView("order");
        return;
      }

      // Half & Half entry (mobile flow = go to pick mode)
      if (
        prepared?.id === "half_half" ||
        menuItem?.id === "half_half" ||
        menuItem?.isHalfHalf
      ) {
        hardScrollToTopAndClearHash();
        setSelectedItem(null);
        setCustomizingItem(null);
        setEditingIndex(null);
        setRightPanelView("order");
        setHhMobileDraft({
          step: "pick",
          side: "A",
          halfA: null,
          halfB: null,
          sizeRef: "LARGE",
        });
        return;
      }

      // Normal behaviour: open this item in the detail/customiser panel
      setSelectedItem(prepared);
      setCustomizingItem({
        ...prepared,
        add_ons: [],
        removedIngredients: [],
      });
      setEditingIndex(null);
      setRightPanelView("order");
    },
    [
      prepareItemForPanel,
      _getMenuClickMeta,
      selectedItem,
      hhMobilePicking,
      hhMobileDraft,
      setHhMobileDraft,
      setMealDealDraft,
      setSelectedItem,
      setCustomizingItem,
      setEditingIndex,
      setRightPanelView,
      mealDealApplyItemRef,
      hardScrollToTopAndClearHash,
    ],
  );

  const handleItemClickDesktop = useCallback(
    (menuItem) => {
      const prepared = prepareItemForPanel(menuItem);
      if (!prepared) return;

      const { isPizzaForHalfHalf, clickedIsMealBundle } = _getMenuClickMeta(
        menuItem,
        prepared,
      );

      // If the Half & Half editor is open and this item is eligible,
      // route the click into the selector instead of opening the panel
      if (
        selectedItem?.isHalfHalf &&
        halfAndHalfApplyPizzaRef?.current &&
        prepared.id !== "half_half" &&
        isPizzaForHalfHalf
      ) {
        halfAndHalfApplyPizzaRef.current(prepared);
        return;
      }

      // DESKTOP meal-deal selection mode: ALWAYS route clicks back into the meal-deal builder.
      // This prevents the normal item detail panel from opening over the meal-deal navigator.
      const mealDealSelectingDesktop =
        !!mealDealMenuFilter?.step && typeof mealDealApplyItemRef?.current === "function";

      if (mealDealSelectingDesktop && !clickedIsMealBundle) {
        // If something accidentally stole selectedItem away from the bundle on desktop,
        // snap back to the meal deal so the right panel stays clean.
        const selectedIsMealBundle =
          selectedItem?.bundle &&
          Array.isArray(selectedItem.bundle.slots) &&
          selectedItem.bundle.slots.length;

        if (!selectedIsMealBundle && mealDealDraft?.bundle?.slots?.length) {
          setSelectedItem(mealDealDraft);
          setCustomizingItem(null);
          setEditingIndex(null);
          setRightPanelView("order");
        }

        mealDealApplyItemRef.current(menuItem);
        return;
      }

      const builderOpen =
        selectedItem?.bundle &&
        Array.isArray(selectedItem.bundle.slots) &&
        selectedItem.bundle.slots.length;

      if (builderOpen && mealDealApplyItemRef?.current && !clickedIsMealBundle) {
        mealDealApplyItemRef.current(menuItem);
        return;
      }

      if (clickedIsMealBundle) {
        setMealDealDraft(prepared);
        setSelectedItem(prepared);
        setCustomizingItem(null);
        setEditingIndex(null);
        setRightPanelView("order");
        return;
      }

      // Half & Half entry (desktop = open editor)
      if (
        prepared?.id === "half_half" ||
        menuItem?.id === "half_half" ||
        menuItem?.isHalfHalf
      ) {
        hardScrollToTopAndClearHash();
        setSelectedItem(HALF_HALF_FORCED_ITEM);
        setCustomizingItem(null);
        setEditingIndex(null);
        setRightPanelView("order");
        return;
      }

      // Normal behaviour: open this item in the detail/customiser panel
      setSelectedItem(prepared);
      setCustomizingItem({
        ...prepared,
        add_ons: [],
        removedIngredients: [],
      });
      setEditingIndex(null);
      setRightPanelView("order");
    },
    [
      prepareItemForPanel,
      _getMenuClickMeta,
      selectedItem,
      mealDealMenuFilter,
      mealDealDraft,
      setMealDealDraft,
      setSelectedItem,
      setCustomizingItem,
      setEditingIndex,
      setRightPanelView,
      mealDealApplyItemRef,
      hardScrollToTopAndClearHash,
    ],
  );

  const handleItemClick = useCallback(
    (menuItem) =>
      isMobileScreen
        ? handleItemClickMobile(menuItem)
        : handleItemClickDesktop(menuItem),
    [isMobileScreen, handleItemClickMobile, handleItemClickDesktop],
  );

  const handleResumeMealDeal = useCallback(() => {
    if (!mealDealDraft) return;
    setSelectedItem(mealDealDraft);
    setCustomizingItem(null);
    setEditingIndex(null);
    setRightPanelView("order");
  }, [mealDealDraft, setSelectedItem, setCustomizingItem, setEditingIndex, setRightPanelView]);

  const handleEditItem = (item, index) => {
    const prepared = item?.prices ? { ...item } : prepareItemForPanel(item);
    if (!prepared) return;

    const isMealBundle =
      prepared?.bundle && Array.isArray(prepared.bundle.slots) && prepared.bundle.slots.length;
    if (isMealBundle) {
      setSelectedItem(prepared);
      setCustomizingItem(null);
      setEditingIndex(index);
      setRightPanelView("order");
      return;
    }

    setSelectedItem(prepared);
    setCustomizingItem({
      ...prepared,
      add_ons: Array.isArray(item.add_ons) ? item.add_ons : [],
      removedIngredients: Array.isArray(item.removedIngredients)
        ? item.removedIngredients
        : [],
    });
    setEditingIndex(index);
  };

  const handleClosePanel = (itemsToAdd, isGlutenFree, addOnSelections = []) => {
    if (itemsToAdd && itemsToAdd.length > 0) {
      const finalItems = itemsToAdd.map(({ size, qty }) => {
        const sizeInfo = makeSizeRecord(size);
        const sizeLabel = sizeInfo.name || "Default";
        const basePriceCents = getBasePriceCents(selectedItem, sizeLabel);
        const basePrice =
          Number.isFinite(basePriceCents) && basePriceCents > 0
            ? basePriceCents / 100
            : (selectedItem.prices?.[sizeLabel] ?? selectedItem.basePrice ?? 0);
        const normalizedSizeRef = normalizeAddonSizeRef(sizeInfo.id || sizeLabel);
        const addOnUnit =
          calcExtrasCentsForSize(
            addOnSelections,
            normalizedSizeRef,
            menuData,
          ) / 100;
        const isLarge = normalizeProductSizeRef(normalizedSizeRef) === "LARGE";
        const gfUpcharge =
          isGlutenFree && isLarge
            ? (getGfSurchargeCentsForProduct(selectedItem, menuData) || 0) / 100
            : 0;
        return {
          ...selectedItem,
          size: sizeInfo,
          qty,
          price: basePrice + gfUpcharge + addOnUnit,
          isGlutenFree: isGlutenFree && isLarge,
          add_ons: addOnSelections.map((opt) => ({ ...opt })),
          removedIngredients: customizingItem?.removedIngredients || [],
        };
      });
      if (editingIndex !== null) removeFromCart(editingIndex);
      addToCart(finalItems);
    }
    setSelectedItem(null);
    setEditingIndex(null);
    setCustomizingItem(null);
  };

  const handleAddHalfHalfToOrder = (item) => {
    if (!item) return;
    const priceCents = Number(item.price) || Number(item.price_cents) || 0;
    const payload = {
      ...item,
      qty: item.qty ?? 1,
      size: item.size || { id: "half-half", name: "Half & Half" },
      add_ons: Array.isArray(item.add_ons) ? item.add_ons : [],
      removedIngredients: Array.isArray(item.removedIngredients)
        ? item.removedIngredients
        : [],
      price: priceCents / 100,
      price_cents: priceCents,
    };
    addToCart([payload]);
    setSelectedItem(null);
    setCustomizingItem(null);
    setEditingIndex(null);
  };

  const handleSaveIngredients = (newRemoved) => {
    setCustomizingItem((prev) =>
      prev ? { ...prev, removedIngredients: newRemoved || [] } : prev,
    );
  };

  const handleApplyAddOns = (newAddOns) => {
    setCustomizingItem((prev) =>
      prev ? { ...prev, add_ons: newAddOns || [] } : prev,
    );
  };

  const showOrderPanel = () => {
    goToMenu();
  };

  const showCartPanel = () => {
    // Cart on mobile should open as a full-screen modal.
    setSelectedItem(null);
    setRightPanelView("order");
    if (isMobile) setCartModalOpen(true);
  };

  const showAboutPanel = () => {
    // About on mobile should open as a full-screen modal.
    setIsProfileOpen(false);
    setSelectedItem(null);
    setRightPanelView("about");
    if (isMobile) setCartModalOpen(true);
  };

  React.useEffect(() => {
    let alive = true;
    setIsLoading(true);
    setMenuReady(false);
    console.log("[menu][effect] start");
    (async () => {
      try {
        const api = await fetchMenu(MENU_URL);
        const normalized = transformMenuStable(api);
        const optionListsMap = Object.fromEntries(
          (normalized?.option_lists || []).map((ol) => [
            ol?.ref || ol?.id || ol?.name,
            ol,
          ]),
        );
        if (!alive) return;
        const categories = Array.isArray(normalized?.categories)
          ? normalized.categories.map((cat) => ({
              ...cat,
              items: Array.isArray(cat?.items) ? [...cat.items] : [],
            }))
          : [];
        const hasHalfHalfAlready = categories.some((cat) =>
          (cat?.items || []).some((item) => item?.id === HALF_HALF_FORCED_ITEM.id),
        );
        if (!hasHalfHalfAlready) {
          const targetIndex = categories.findIndex((cat) => {
            if (!cat) return false;
            if (typeof cat.type === "string" && cat.type.toLowerCase().includes("pizza"))
              return true;
            return /pizza/i.test(cat?.name || "");
          });
          const injectedItem = {
            ...HALF_HALF_FORCED_ITEM,
            category_ref: targetIndex >= 0 ? categories[targetIndex]?.ref : "CUSTOM_HALF_HALF",
          };
          if (targetIndex >= 0) {
            const targetCat = categories[targetIndex] || {};
            categories[targetIndex] = {
              ...targetCat,
              items: [injectedItem, ...(targetCat.items || [])],
            };
          } else {
            categories.unshift({
              name: "Custom Creations",
              ref: "CUSTOM_HALF_HALF",
              type: "pizza",
              items: [injectedItem],
            });
          }
        }
        setMenuData({ ...normalized, categories, optionListsMap });
        setMenuError(null);
      } catch (err) {
        console.warn("[menu][effect] error", err);
        if (!alive) return;
        setMenuData({ categories: [], option_lists: [], optionListsMap: {} });
        setMenuError(err);
      } finally {
        if (!alive) return;
        setIsLoading(false);
        setMenuReady(true);
        console.log("[menu][effect] finally -> ready");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.__FORCE_MENU_READY === true) {
      forceMenuReady();
    }
    window.__FORCE_MENU_READY = forceMenuReady;
    return () => {
      if (window.__FORCE_MENU_READY === forceMenuReady)
        delete window.__FORCE_MENU_READY;
    };
  }, [forceMenuReady]);

  if (typeof window !== "undefined") {
    const devWindow = window;
    devWindow.__APP_RENDER_TAP = "ready";
    devWindow.__FORCE_MENU_READY = forceMenuReady;
  }

  const cats = menuData?.categories ?? [];
  const hasMenu = cats.length > 0;
  try {
    console.log(
      "[menu][render] menuLoading=",
      isLoading,
      " categories=",
      cats.length,
    );
  } catch {}

  if (isLoading) {
    return (
      <LoadingScreen
        title="Loading menu"
        subtitle="Fetching the latest items\u2026"
      />
    );
  }

  if (!hasMenu) {
    return (
      <div className="p-8 text-center text-gray-400">
        No items to show yet (0 categories). Check /pp-proxy/public/menu.
      </div>
    );
  }

  const isHalfHalfPanel = Boolean(selectedItem?.isHalfHalf);
  const isMealDealSelected = Boolean(
    selectedItem?.bundle &&
      Array.isArray(selectedItem.bundle.slots) &&
      selectedItem.bundle.slots.length,
  );
  const isItemDetailPanel = Boolean(
    selectedItem && !isHalfHalfPanel && !isMealDealSelected,
  );
  const rightSidebarClassName = isHalfHalfPanel
    ? "right-sidebar right-sidebar--halfhalf"
    : "right-sidebar";
  const orderPanelClassName = [
    "order-panel-container",
    isHalfHalfPanel ? "order-panel-container--halfhalf" : "",
    isItemDetailPanel ? "order-panel-container--detail" : "",
    isMealDealSelected ? "order-panel-container--mealdeal" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const mobileOrderPanelClassName = [
    "order-panel-container",
    "order-panel-container--mobileCart",
    isHalfHalfPanel ? "order-panel-container--halfhalf" : "",
    isItemDetailPanel ? "order-panel-container--detail" : "",
    isMealDealSelected ? "order-panel-container--mealdeal" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const rightPanelBody = (
    <>
      {selectedItem && (
        isHalfHalfPanel ? (
          <div className="pp-halfhalf-modal">
            <div
              className="pp-halfhalf-modal__backdrop"
              onClick={() => {
                setSelectedItem(null);
                setHhMobileDraft(null);
              }}
            />
            <div className="pp-halfhalf-modal__panel">
              <HalfAndHalfSelector
                menuItems={menuItems}
                menuData={menuData}
                onAddItemToOrder={(hh) => {
                  handleAddHalfHalfToOrder(hh);
                  setHhMobileDraft(null);
                }} // uses the existing add-to-cart bridge
                selectedItem={selectedItem}
                setSelectedItem={(v) => {
                  setSelectedItem(v);
                  if (v == null) setHhMobileDraft(null);
                }}
                registerExternalPizzaApply={registerExternalPizzaApply}
                useExternalMenuSelection={!isMobileScreen}
                hidePizzaPicker={!isMobileScreen}
                initialHalfA={isMobileScreen ? hhMobileDraft?.halfA : null}
                initialHalfB={isMobileScreen ? hhMobileDraft?.halfB : null}
                initialSizeRef={
                  isMobileScreen ? (hhMobileDraft?.sizeRef || "LARGE") : "LARGE"
                }
                onRequestChangeHalf={
                  isMobileScreen
                    ? (side) => {
                        setSelectedItem(null);
                        setHhMobileDraft((prev) => ({
                          ...(prev || {}),
                          step: "pick",
                          side: side === "B" ? "B" : "A",
                          halfA: side === "A" ? null : prev?.halfA || null,
                          halfB: side === "B" ? null : prev?.halfB || null,
                          sizeRef: prev?.sizeRef || "LARGE",
                        }));
                        try {
                          requestAnimationFrame(() => {
                            window.scrollTo({ top: 0, behavior: "smooth" });
                          });
                        } catch {}
                      }
                    : null
                }
              />
            </div>
          </div>
        ) : isMealDealSelected ? (
          isMobile ? null : (
            <MealDealBuilderPanel
              item={selectedItem}
              menuData={menuData}
              prepareItemForPanel={prepareItemForPanel}
              editingIndex={editingIndex}
              isMobile={isMobileScreen}
              onCancel={() => {
                setMealDealMenuFilter(null);
                setSelectedItem(null);
                setEditingIndex(null);
                setCustomizingItem(null);
              }}
              onCommit={(payload) => {
                if (editingIndex !== null) removeFromCart(editingIndex);
                addToCart([payload]);
                setMealDealMenuFilter(null);
                setMealDealDraft(null);
                setSelectedItem(null);
                setEditingIndex(null);
                setCustomizingItem(null);
              }}
              registerExternalMealItemApply={registerExternalMealItemApply}
              onMenuFilterChange={setMealDealMenuFilter}
            />
          )
        ) : (
          <div className="pp-itemdetail-modal">
            <div
              className="pp-itemdetail-modal__backdrop"
              onClick={handleClosePanel}
            />
            <div className="pp-itemdetail-modal__panel">
              <ItemDetailPanel
                item={selectedItem}
                menuData={menuData}
                onClose={handleClosePanel}
                editingIndex={editingIndex}
                editingItem={customizingItem}
                onSaveIngredients={handleSaveIngredients}
                onApplyAddOns={handleApplyAddOns}
                primaryActionLabel={undefined}
                initialModal={undefined}
                onModalsSettled={() => {}}
              />
            </div>
          </div>
        )
      )}
      {!selectedItem &&
        (rightPanelView === "about" ? (
          <AboutPanel isMapsLoaded={isMapsLoaded} />
        ) : rightPanelView === "review" ? (
          <ReviewOrderPanel
            onBack={() => setRightPanelView("order")}
            onEditItem={handleEditItem}
            onOpenProfile={handleProfileOpen}
            orderType={orderType}
            orderAddress={orderAddress}
            orderDeliveryFee={orderDeliveryFee}
            orderAddressError={orderAddressError}
            estimatedTime={estimatedTime}
            storeOpenNow={storeOpenNow}
            preorderPickupLabel={preorderPickupLabel}
            pickupWhen={pickupWhen}
            pickupScheduledUtcIso={pickupScheduledUtcIso}
            deliveryWhen={deliveryWhen}
            deliveryScheduledUtcIso={deliveryScheduledUtcIso}
          />
        ) : (
          <OrderInfoPanel
            onEditItem={handleEditItem}
            isMapsLoaded={isMapsLoaded}
            orderType={orderType}
            setOrderType={setOrderType}
            orderAddress={orderAddress}
            setOrderAddress={setOrderAddress}
            orderDeliveryFee={orderDeliveryFee}
            setOrderDeliveryFee={setOrderDeliveryFee}
            orderAddressError={orderAddressError}
            setOrderAddressError={setOrderAddressError}
            estimatedTime={estimatedTime}
            storeOpenNow={storeOpenNow}
            preorderPickupLabel={preorderPickupLabel}
            pickupWhen={pickupWhen}
            setPickupWhen={setPickupWhen}
            pickupScheduledUtcIso={pickupScheduledUtcIso}
            setPickupScheduledUtcIso={setPickupScheduledUtcIso}
            deliveryWhen={deliveryWhen}
            setDeliveryWhen={setDeliveryWhen}
            deliveryScheduledUtcIso={deliveryScheduledUtcIso}
            setDeliveryScheduledUtcIso={setDeliveryScheduledUtcIso}
            pickupTimeLocked={pickupTimeLocked}
            setPickupTimeLocked={setPickupTimeLocked}
            deliveryTimeLocked={deliveryTimeLocked}
            setDeliveryTimeLocked={setDeliveryTimeLocked}
            onProceed={() => {
              setRightPanelView("review");
              if (isMobile) setCartModalOpen(true);
            }}
          />
        ))}
    </>
  );
  const mealDealPanel = isMealDealSelected ? (
    <div
      className="order-panel-container order-panel-container--mealdeal"
      style={{ flex: "1 1 auto", minHeight: 0, height: "100%" }}
    >
      <MealDealBuilderPanel
        item={selectedItem}
        menuData={menuData}
        prepareItemForPanel={prepareItemForPanel}
        editingIndex={editingIndex}
        isMobile={isMobile}
        onCancel={() => {
          setMealDealMenuFilter(null);
          setSelectedItem(null);
          setEditingIndex(null);
          setCustomizingItem(null);
        }}
        onCommit={(payload) => {
          if (editingIndex !== null) removeFromCart(editingIndex);
          addToCart([payload]);
          setMealDealMenuFilter(null);
          setMealDealDraft(null);
          setSelectedItem(null);
          setEditingIndex(null);
          setCustomizingItem(null);
        }}
        onCommitAndReview={(payload) => {
          if (editingIndex !== null) removeFromCart(editingIndex);
          addToCart([payload]);
          setMealDealMenuFilter(null);
          setMealDealDraft(null);
          setSelectedItem(null);
          setEditingIndex(null);
          setCustomizingItem(null);
          setRightPanelView("review");
        }}
        registerExternalMealItemApply={() => {}}
        onMenuFilterChange={() => {}}
      />
    </div>
  ) : null;

  return (
    <>
      <LoginModal
        isOpen={authCtx.showLogin}
        tab={authCtx.loginTab}
        onClose={authCtx.closeLogin}
      />
      {isProfileOpen && (
        <ProfileModal
          isMapsLoaded={isMapsLoaded}
          onClose={() => setIsProfileOpen(false)}
        />
      )}
      <LoyaltyModal
        isOpen={!!isLoyaltyOpen && !!loyaltyEnabled}
        onClose={() => setIsLoyaltyOpen(false)}
      />

      <div className="app-grid-layout">
        <div className="left-pane">
          {!isAdminRoute ? (
            <>
              <Navbar
                onAboutClick={showAboutPanel}
                onMenuClick={showOrderPanel}
                onCartClick={showCartPanel}
                onLoginClick={(tab) => authCtx.openLogin(tab)}
                onProfileClick={handleProfileOpen}
                onLoyaltyClick={openLoyalty}
                loyaltyEnabled={loyaltyEnabled}
                loyaltyJoined={loyaltyJoined}
                searchName={searchName}
                searchTopping={searchTopping}
                onSearchNameChange={setSearchName}
                onSearchToppingChange={setSearchTopping}
              />
              <div className="pp-qnav-slot" />
            </>
          ) : null}

          <main className="main-content-area">
            {/* <DebugMenuFetch /> */} {/* TEMP widget hidden */}
            {!isAdminRoute && menuError ? (
              <div className="mb-4 text-center text-xs text-red-300 opacity-80">
                Menu error: {String(menuError?.message || menuError)}
              </div>
            ) : null}
            <Routes>
              <Route
                path="/"
                element={
                  <Home
                    menuData={menuDataForHome}
                    handleItemClick={handleItemClick}
                    hhMobilePicking={hhMobilePicking}
                    hhMobileDraft={hhMobileDraft}
                    setHhMobileDraft={setHhMobileDraft}
                    mealDealDraft={mealDealDraft}
                    onResumeMealDeal={handleResumeMealDeal}
                  />
                }
              />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/terms" element={<TermsPage />} />
              <Route
                path="*"
                element={<div style={{ padding: 16 }}>Route fallback OK</div>}
              />
            </Routes>
            {!isAdminRoute ? <Footer /> : null}
          </main>
        </div>
        {/* Desktop only: keep the right sidebar */}
        {!isAdminRoute && !isMobileScreen && (
          <div className={rightSidebarClassName}>
            <div className={orderPanelClassName}>{rightPanelBody}</div>
          </div>
        )}
        {!isAdminRoute && showViewOrderFab && (
          <div className="pp-mobileViewOrderBar">
            <button
              type="button"
              className={["pp-cart-fab", cartFabBump ? "is-bump" : ""].join(" ")}
              onClick={() => setCartModalOpen(true)}
              aria-label={
                cartItemCount > 0
                  ? `View order (${cartItemCount} item${cartItemCount === 1 ? "" : "s"})`
                  : "View order"
              }
            >
              <span className="pp-cart-fab__icon" aria-hidden="true">
                {EM.CART}
              </span>
              <span className="pp-cart-fab__label">View order</span>

              {cartItemCount > 0 && (
                <span className="pp-cart-fab__count" aria-hidden="true">
                  {cartItemCount}
                </span>
              )}
            </button>
          </div>
        )}
        {!isAdminRoute && isMobile && cartModalOpen && (
          <div className="pp-cart-modal" role="dialog" aria-modal="true">
            <div
              className="pp-cart-modal__backdrop"
              onClick={() => setCartModalOpen(false)}
            />
            <div className="pp-cart-modal__panel">
              <button
                type="button"
                className="quantity-btn"
                title="Close"
                onClick={() => setCartModalOpen(false)}
                style={{ position: "absolute", top: "1rem", right: "1rem", zIndex: 5 }}
              >
                &times;
              </button>

              <div className={mobileOrderPanelClassName}>{rightPanelBody}</div>
            </div>
          </div>
        )}
        {!isAdminRoute && isMobile && (
          <MobileBottomNav
            elevated={!!cartModalOpen || !!isProfileOpen || !!isLoyaltyOpen}
            activeKey={
              isLoyaltyOpen && loyaltyEnabled
                ? "loyalty"
                : isProfileOpen
                ? "profile"
                : cartModalOpen && rightPanelView === "about"
                ? "about"
                : "menu"
            }
            authed={!authLoadingFlag && !!authUser}
            loyaltyEnabled={loyaltyEnabled}
            onMenu={() => goToMenu()}
            onAbout={() => showAboutPanel()}
            onProfile={() => {
              setCartModalOpen(false);
              handleProfileOpen();
            }}
            loyaltyJoined={loyaltyJoined}
            onLoyalty={openLoyalty}
            onLogin={() => authCtx.openLogin?.("providers")}
          />
        )}
      </div>
      {/* Mobile: render selected item modals outside the grid (so they can't be hidden) */}
      {!isAdminRoute && isMobileScreen && !!selectedItem ? rightPanelBody : null}
      {!isAdminRoute && isMobile && isMealDealSelected && (
        <div className="pp-mealdeal-modal" role="dialog" aria-modal="true">
          <div
            className="pp-mealdeal-modal__backdrop"
            onClick={() => setSelectedItem(null)}
          />
          <div className="pp-mealdeal-modal__panel">
            {mealDealPanel}
          </div>
        </div>
      )}
    </>
  );
}


function App() {
  React.useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.log(
      "[PP][env] VITE_PP_ORDER_INGEST_URL =",
      import.meta.env.VITE_PP_ORDER_INGEST_URL,
    );
  }, []);

  console.log("[env] VITE_PP_MENU_BASE_URL =", import.meta.env.VITE_PP_MENU_BASE_URL);
  console.log("[env] VITE_PP_IMAGES_BASE_URL =", import.meta.env.VITE_PP_IMAGES_BASE_URL);
  console.log("[img][debug] IMG_BASE =", IMG_BASE);
  console.log(
    "[img][debug] sample =",
    getProductImageUrl({ name: "Italian", image: "italian.jpg" }),
  );
  const isMapsLoaded = useGoogleMaps();
  const location = useLocation();
  const isAdminRoute = location.pathname.startsWith("/admin");

  const wrapProviders = (children) => (
    <AppProvider>
      <AuthProvider>
        <ThemeProvider>{children}</ThemeProvider>
      </AuthProvider>
    </AppProvider>
  );

  if (isAdminRoute) {
    // Admin must NOT render inside the POS grid layout
    return wrapProviders(
      <div className="pp-admin-standalone">
        <Routes>
          <Route path="/admin/*" element={<AdminPanelPage />} />
        </Routes>
      </div>,
    );
  }

  return wrapProviders(
    <CartProvider>
      <FirebaseBanner />
      <ErrorBoundary>
        <AppLayout isMapsLoaded={isMapsLoaded} />
      </ErrorBoundary>
      <div
        id="recaptcha-container-root"
        style={{ position: "fixed", bottom: 0, right: 0, zIndex: 1 }}
      />
    </CartProvider>,
  );
}

function AboutPanel({ isMapsLoaded }) {
  const [currentView, setCurrentView] = useState("main"); // 'main', 'hours', or 'delivery'
  const [pcValue, setPcValue] = useState("");
  const [pcResult, setPcResult] = useState(null);
  const mapRef = useRef(null);
  const [openNowMain, setOpenNowMain] = React.useState(isOpenNowAdelaide());
  React.useEffect(() => {
    const t = setInterval(() => setOpenNowMain(isOpenNowAdelaide()), 60 * 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!isMapsLoaded || currentView !== "main") return;

    const el = mapRef.current;
    if (!(el instanceof HTMLElement) || !el.isConnected) return;

    const maps = w.google?.maps;
    if (!maps) return;

    const map = new maps.Map(el, {
      center: ABOUT_STORE_LOCATION,
      zoom: 15,
      disableDefaultUI: true,
      styles: [
        {
          featureType: "all",
          elementType: "geometry",
          stylers: [{ color: "#242f3e" }],
        },
        {
          featureType: "all",
          elementType: "labels.text.stroke",
          stylers: [{ lightness: -80 }],
        },
        {
          featureType: "administrative",
          elementType: "labels.text.fill",
          stylers: [{ color: "#746855" }],
        },
        {
          featureType: "administrative.locality",
          elementType: "labels.text.fill",
          stylers: [{ color: "#d59563" }],
        },
        {
          featureType: "poi",
          elementType: "labels.text.fill",
          stylers: [{ color: "#d59563" }],
        },
        {
          featureType: "poi.park",
          elementType: "geometry",
          stylers: [{ color: "#263c3f" }],
        },
        {
          featureType: "poi.park",
          elementType: "labels.text.fill",
          stylers: [{ color: "#6b9a76" }],
        },
        {
          featureType: "road",
          elementType: "geometry.fill",
          stylers: [{ color: "#2b3544" }],
        },
        {
          featureType: "road",
          elementType: "labels.text.fill",
          stylers: [{ color: "#9ca5b3" }],
        },
        {
          featureType: "road.arterial",
          elementType: "geometry",
          stylers: [{ color: "#374151" }],
        },
        {
          featureType: "road.highway",
          elementType: "geometry",
          stylers: [{ color: "#746855" }],
        },
        {
          featureType: "road.highway",
          elementType: "labels.text.fill",
          stylers: [{ color: "#f3d19c" }],
        },
        {
          featureType: "road.local",
          elementType: "geometry",
          stylers: [{ color: "#374151" }],
        },
        {
          featureType: "transit",
          elementType: "geometry",
          stylers: [{ color: "#2f3948" }],
        },
        {
          featureType: "transit.station",
          elementType: "labels.text.fill",
          stylers: [{ color: "#d59563" }],
        },
        {
          featureType: "water",
          elementType: "geometry",
          stylers: [{ color: "#17263c" }],
        },
        {
          featureType: "water",
          elementType: "labels.text.fill",
          stylers: [{ color: "#515c6d" }],
        },
        {
          featureType: "water",
          elementType: "labels.text.stroke",
          stylers: [{ lightness: -20 }],
        },
      ],
    });
    const marker = new maps.Marker({
      position: ABOUT_STORE_LOCATION,
      map,
      title: "Pizza Peppers",
    });

    return () => {
      try {
        marker.setMap(null);
      } catch {}
      try {
        maps.event.clearInstanceListeners(map);
      } catch {}
    };
  }, [isMapsLoaded, currentView]);

  const onPcChange = (e) => {
    const onlyDigits = e.target.value.replace(/\D+/g, "").slice(0, 4);
    setPcValue(onlyDigits);
    setPcResult(null);
  };

  const onPcCheck = (e) => {
    e?.preventDefault?.();
    const pc = pcValue.trim();
    if (pc.length !== 4) {
      setPcResult({ kind: "error", text: "Enter a 4-digit postcode." });
      return;
    }
    const override = OVERRIDE_POSTCODES[pc];
    if (override) {
      const dollars = (override.fee_cents ?? 0) / 100;
      const eta = override.eta_min ? ` (ETA ~${override.eta_min} min)` : "";
      setPcResult({
        kind: "ok",
        text: `We deliver to ${pc}. Delivery fee ~$${dollars.toFixed(2)}${eta}${override.note ? ` - ${override.note}` : ""}.`,
      });
      return;
    }
    try {
      const q =
        typeof quoteForPostcodeSafe === "function"
          ? quoteForPostcodeSafe(pc)
          : null;
      if (q && typeof q === "object" && (q.ok || q.covered)) {
        const feeCents = typeof q.fee_cents === "number" ? q.fee_cents : 0;
        const dollars = feeCents / 100;
        const eta = q.eta_min ? ` (ETA ~${q.eta_min} min)` : "";
        setPcResult({
          kind: "ok",
          text: `We deliver to ${pc}. Delivery fee ~$${dollars.toFixed(2)}${eta}.`,
        });
      } else {
        setPcResult({
          kind: "no",
          text: `Postcode ${pc} is currently outside our delivery area.`,
        });
      }
    } catch (err) {
      console.warn("[about][postcode] quote error", err);
      setPcResult({
        kind: "error",
        text: "Couldn't check right now. Please call the store.",
      });
    }
  };

  if (currentView === "hours")
    return <OpeningHoursView onBack={() => setCurrentView("main")} />;
  if (currentView === "delivery")
    return <DeliveryAreasView onBack={() => setCurrentView("main")} />;

  return (
    <>
      <h2 className="panel-title">About Pizza Peppers</h2>
      <div className="about-panel-list-item">
        <h4>Our Location</h4>
        <p>{ABOUT_LOCATION_TEXT}</p>
        <div
          ref={mapRef}
          style={{
            height: "200px",
            width: "100%",
            borderRadius: "0.5rem",
            marginTop: "1rem",
            background: "var(--surface)",
            border: "1px solid var(--border-color)",
          }}
        />
      </div>
      <div className="about-panel-list-item">
        <a href={`tel:${ABOUT_PHONE_LINK}`}>
          <h4>Call Us</h4>
          <p>{ABOUT_PHONE_DISPLAY}</p>
        </a>
      </div>
      <div
        className="about-panel-list-item"
        onClick={() => setCurrentView("hours")}
        style={{ cursor: "pointer" }}
      >
        <div
          className="about-row"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
          }}
        >
          <div>
            <h4>Opening Hours</h4>
            <p>View our weekly trading hours</p>
          </div>
          <span
            aria-label="open-status"
            style={{
              flexShrink: 0,
              display: "inline-block",
              padding: "0.25rem 0.6rem",
              borderRadius: "9999px",
              fontSize: "0.85rem",
              fontWeight: 600,
              background: openNowMain
                ? "rgba(34,197,94,0.15)"
                : "rgba(239,68,68,0.15)",
              color: openNowMain ? "#22c55e" : "#ef4444",
              border: `1px solid ${openNowMain ? "#22c55e33" : "#ef444433"}`,
            }}
          >
            {openNowMain ? "Open now" : "Closed now"}
          </span>
        </div>
      </div>
      <div className="about-panel-list-item">
        <button onClick={() => setCurrentView("delivery")}>
          <h4>Delivery Areas</h4>
          <p>
            See suburbs and delivery fees. Some suburbs are manually included -
            use the checker below for live status.
          </p>
        </button>
      </div>
      <div className="about-panel-list-item">
        <h4>Check your postcode</h4>
        <form
          onSubmit={onPcCheck}
          style={{
            display: "flex",
            gap: "0.5rem",
            flexWrap: "wrap",
            marginTop: "0.5rem",
          }}
        >
          <input
            value={pcValue}
            onChange={onPcChange}
            placeholder="e.g. 5159"
            className="w-full border rounded px-2 py-2"
            style={{ flex: "1 1 160px", minWidth: "140px" }}
          />
          <button
            type="submit"
            className="pp-btn"
            style={{ minWidth: "110px" }}
          >
            Check
          </button>
        </form>
        {pcResult ? (
          <div
            className="w-full rounded border px-3 py-2"
            style={{
              marginTop: "0.75rem",
              background: "var(--surface)",
              borderColor: "var(--line)",
              color: "var(--text-primary)",
            }}
            role="status"
            aria-live="polite"
          >
            <strong style={{ display: "block", marginBottom: 4 }}>
              {pcResult.kind === "ok" ? "Delivery available" : "Not in range"}
            </strong>
            <span>{pcResult.text}</span>
          </div>
        ) : null}
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

export default App;


















