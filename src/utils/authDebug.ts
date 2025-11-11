import type { Auth, User } from "firebase/auth";
import { auth } from "../firebase";

const now = () => `${(performance?.now?.() ?? Date.now()).toFixed(1)}ms`;

export function enableAuthDebug(auth: Auth) {
  const hdr = "[PP][AuthDBG]";
  const info = {
    host: location.hostname,
    origin: location.origin,
    referrer: document.referrer,
    ua: navigator.userAgent,
  };

  if (typeof window !== "undefined") {
    (window as any).__PP_AUTH_DUMP__ = async () => {
      const u = auth.currentUser;
      console.groupCollapsed(`${hdr} DUMP @ ${now()}`);
      console.log("env:", info);
      console.log("auth.app.name:", auth.app?.name);
      console.log("auth.config:", {
        apiKey: (auth as any)?.config?.apiKey,
        authDomain: (auth as any)?.config?.authDomain,
      });
      console.log(
        "currentUser:",
        u
          ? {
              uid: u.uid,
              email: u.email,
              providerData: u.providerData?.map((p) => p?.providerId),
            }
          : null
      );
      console.log(
        "localStorage keys:",
        Object.keys(localStorage).filter((k) => k.startsWith("firebase:"))
      );
      try {
        const cacheKeys = Object.keys(localStorage).filter((k) =>
          k.includes("firebase:authUser")
        );
        console.log("authUser caches:", cacheKeys);
        for (const key of cacheKeys) {
          console.log(key, JSON.parse(localStorage.getItem(key) || "null"));
        }
      } catch {
        // noop
      }
      console.groupEnd();
    };
  }

  console.group(`${hdr} init @ ${now()}`);
  console.log("env:", info);
  console.log("auth.app.name:", auth.app?.name);
  console.groupEnd();

  (auth as any).__ppDebug = {
    logPopupStart(providerId: string) {
      console.info(`${hdr} popup:start`, providerId, "@", now(), info);
    },
    logPopupOk(user: User | null) {
      console.info(
        `${hdr} popup:ok`,
        user ? user.email || user.uid : null,
        "@",
        now()
      );
    },
    logPopupErr(err: unknown) {
      const code = (err as any)?.code;
      const msg = (err as any)?.message;
      console.warn(`${hdr} popup:err`, code, msg, "@", now());
    },
    logRedirectStart(providerId: string) {
      console.info(`${hdr} redirect:start`, providerId, "@", now(), info);
    },
    logRedirectResult(user: User | null) {
      console.info(
        `${hdr} redirect:result`,
        user ? user.email || user.uid : null,
        "@",
        now()
      );
    },
    logRedirectErr(err: unknown) {
      const code = (err as any)?.code;
      const msg = (err as any)?.message;
      console.warn(`${hdr} redirect:err`, code, msg, "@", now());
    },
    logListener(user: User | null) {
      console.info(
        `${hdr} listener`,
        user ? user.email || user.uid : null,
        "@",
        now()
      );
    },
  };
}

export function dumpFirebaseAuthCaches(prefix = "[PP][AuthDBG]") {
  try {
    const lsKeys = Object.keys(localStorage).filter((k) => k.includes("firebase:"));
    console.groupCollapsed(`${prefix} localStorage firebase:*`);
    for (const key of lsKeys) {
      let value: unknown = null;
      try {
        value = JSON.parse(localStorage.getItem(key) || "null");
      } catch {
        value = localStorage.getItem(key);
      }
      console.log(key, value);
    }
    const ssKeys = Object.keys(sessionStorage).filter((k) => k.includes("firebase:"));
    console.groupCollapsed(`${prefix} sessionStorage firebase:*`);
    for (const key of ssKeys) {
      let value: unknown = null;
      try {
        value = JSON.parse(sessionStorage.getItem(key) || "null");
      } catch {
        value = sessionStorage.getItem(key);
      }
      console.log(key, value);
    }
    console.groupEnd();
    console.groupEnd();
  } catch (e) {
    const msg = (e as any)?.message || e;
    console.warn(prefix, "dump caches error:", msg);
  }
}

export function dumpFirebaseLocalStorage(tag: string) {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("firebase"));
    console.log(`[PP][AuthDBG][${tag}] localStorage firebase:*`, keys);
  } catch (err) {
    console.warn("[PP][AuthDBG] dumpFirebaseLocalStorage error:", (err as any)?.message || err);
  }
}

export function logAuthConfig() {
  try {
    console.log("[PP][AuthDBG] auth config:", {
      apiKey: auth.app.options.apiKey,
      authDomain: auth.app.options.authDomain,
      appName: auth.app.name,
    });
  } catch (err) {
    console.warn("[PP][AuthDBG] logAuthConfig error:", (err as any)?.message || err);
  }
}

export function labelUser(user: any) {
  return user ? user.email || user.phoneNumber || user.uid : null;
}
