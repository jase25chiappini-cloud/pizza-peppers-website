import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * AddressHelper
 * - Uses Google Places Autocomplete if available (window.google.maps.places)
 * - Falls back to manual text inputs if Maps not configured
 *
 * Props:
 *   value: { line: "", suburb: "", postcode: "", state: "" }
 *   onChange: (addr) => void
 *   disabled?: boolean
 *   labelPrefix?: string  // e.g. "Delivery " to render "Delivery Address"
 */
export default function AddressHelper({
  value,
  onChange,
  onPlaceSelect = () => {},
  onInvalidSelection = () => {},
  disabled = false,
  labelPrefix = "",
}) {
  const [addr, setAddr] = useState(() => ({
    line: value?.line || "",
    suburb: value?.suburb || "",
    postcode: value?.postcode || "",
    state: value?.state || "",
  }));

  const autocompleteRef = useRef(null);
  const inputRef = useRef(null);

  const mapsReady = useMemo(() => {
    const g = globalThis.google;
    return !!(g && g.maps && g.maps.places);
  }, []);

  // Keep internal state in sync if the parent updates externally
  useEffect(() => {
    setAddr((prev) => {
      const next = {
        line: value?.line || "",
        suburb: value?.suburb || "",
        postcode: value?.postcode || "",
        state: value?.state || "",
      };
      if (
        prev.line === next.line &&
        prev.suburb === next.suburb &&
        prev.postcode === next.postcode &&
        prev.state === next.state
      ) {
        return prev;
      }
      return next;
    });
  }, [value?.line, value?.suburb, value?.postcode, value?.state]);

  useEffect(() => {
    if (!mapsReady || !inputRef.current) return;

    const { google } = window;
    const deliveryConfig =
      typeof window !== "undefined" ? window.__PP_DELIVERY_CONFIG : undefined;
    let boundsInstance = null;
    try {
      const boundsData = deliveryConfig?.getBounds?.();
      if (
        boundsData?.sw &&
        boundsData?.ne &&
        google?.maps?.LatLng &&
        google?.maps?.LatLngBounds
      ) {
        boundsInstance = new google.maps.LatLngBounds(
          new google.maps.LatLng(boundsData.sw.lat, boundsData.sw.lng),
          new google.maps.LatLng(boundsData.ne.lat, boundsData.ne.lng)
        );
      }
    } catch (err) {
      console.warn("[delivery] failed to create bounds", err);
    }

    autocompleteRef.current = new google.maps.places.Autocomplete(
      inputRef.current,
      {
        componentRestrictions: { country: ["au"] },
        fields: ["address_components", "formatted_address"],
        types: ["address"],
        bounds: boundsInstance || undefined,
        strictBounds: !!boundsInstance,
      }
    );

    const onPlaceChanged = async () => {
      const place = autocompleteRef.current.getPlace();
      if (!place || !place.address_components) return;

      let extractPostcodeFn =
        (typeof window !== "undefined"
          ? window.__PP_DELIVERY_CONFIG?.getExtractPostcode?.()
          : null) || null;
      if (!extractPostcodeFn) {
        try {
          const module = await import("../config/delivery.js");
          if (typeof module?.extractPostcode === "function") {
            extractPostcodeFn = module.extractPostcode;
          }
        } catch {}
      }

      let isAllowed = true;
      if (deliveryConfig?.isPlaceInDeliveryArea) {
        try {
          isAllowed = deliveryConfig.isPlaceInDeliveryArea(
            place,
            extractPostcodeFn
          );
        } catch (err) {
          console.warn("[delivery] validation failed", err);
        }
      }

      if (!isAllowed) {
        onInvalidSelection?.();
        inputRef.current?.focus();
        return;
      }

      const parts = parseAddressComponents(place.address_components);
      const next = {
        line: parts.line || inputRef.current.value || "",
        suburb: parts.locality || parts.sublocality || "",
        postcode: parts.postal_code || "",
        state: parts.administrative_area_level_1 || "",
      };
      setAddr(next);
      onChange?.(next, { place });
      onPlaceSelect?.(place);
    };

    const listener = autocompleteRef.current.addListener(
      "place_changed",
      onPlaceChanged
    );

    return () => {
      if (listener && listener.remove) listener.remove();
    };
  }, [mapsReady, onChange, onPlaceSelect, onInvalidSelection]);

  const handleChange = (field) => (e) => {
    const next = { ...addr, [field]: e.target.value };
    setAddr(next);
    onChange?.(next, { place: null });
  };

  return (
    <div className="space-y-3">
      <label className="block text-sm font-medium">
        {labelPrefix}Address
        <input
          ref={inputRef}
          type="text"
          placeholder="Street address"
          className="mt-1 w-full rounded-xl border border-gray-600 bg-transparent p-3 outline-none focus:ring-2 focus:ring-gray-400"
          value={addr.line}
          onChange={handleChange("line")}
          disabled={disabled}
        />
      </label>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="block text-sm font-medium">
          Suburb
          <input
            type="text"
            placeholder="Suburb"
            className="mt-1 w-full rounded-xl border border-gray-600 bg-transparent p-3 outline-none focus:ring-2 focus:ring-gray-400"
            value={addr.suburb}
            onChange={handleChange("suburb")}
            disabled={disabled}
          />
        </label>

        <label className="block text-sm font-medium">
          State
          <input
            type="text"
            placeholder="SA / VIC / NSW ..."
            className="mt-1 w-full rounded-xl border border-gray-600 bg-transparent p-3 outline-none focus:ring-2 focus:ring-gray-400"
            value={addr.state}
            onChange={handleChange("state")}
            disabled={disabled}
          />
        </label>

        <label className="block text-sm font-medium">
          Postcode
          <input
            type="text"
            inputMode="numeric"
            placeholder="e.g. 5000"
            className="mt-1 w-full rounded-xl border border-gray-600 bg-transparent p-3 outline-none focus:ring-2 focus:ring-gray-400"
            value={addr.postcode}
            onChange={handleChange("postcode")}
            disabled={disabled}
            maxLength={6}
          />
        </label>
      </div>

      {!mapsReady && (
        <p className="text-xs opacity-70">
          Tip: Enable Google Maps Places (set <code>VITE_GOOGLE_MAPS_API_KEY</code>) for address autocomplete.
        </p>
      )}
    </div>
  );
}

/** Helpers */
function parseAddressComponents(components) {
  const get = (type) =>
    components.find((c) => c.types && c.types.includes(type))?.long_name || "";
  const streetNumber =
    components.find((c) => c.types?.includes("street_number"))?.long_name || "";
  const route =
    components.find((c) => c.types?.includes("route"))?.long_name || "";
  const line = [streetNumber, route].filter(Boolean).join(" ");

  return {
    line,
    locality: get("locality"),
    sublocality: get("sublocality") || get("sublocality_level_1"),
    postal_code: get("postal_code"),
    administrative_area_level_1: get("administrative_area_level_1"),
  };
}
