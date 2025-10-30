import React from "react";
import { FB_READY } from "../firebase";

export default function FirebaseBanner() {
  if (FB_READY) return null;
  return (
    <div style={{
      background: "#3b82f6", color: "white", padding: "8px 12px",
      fontSize: 13, position: "fixed", left: 8, bottom: 8, borderRadius: 8, zIndex: 9999
    }}>
      Firebase not configured — sign-in & uploads disabled in dev.
    </div>
  );
}

