import React, { useRef, useEffect } from 'react';

// It now accepts an `isLoaded` prop
function AddressAutocomplete({ onAddressSelect, isLoaded }) { 
    const autocompleteInput = useRef(null);

    useEffect(() => {
        // This logic will now ONLY run if `isLoaded` is true and `window.google` exists
        if (isLoaded && window.google) {

            // --- Define the Adelaide location and search radius ---
            const adelaideLocation = new window.google.maps.LatLng(-34.9285, 138.6007);
            const radiusInMeters = 50000; // 50 kilometers

            const autocomplete = new window.google.maps.places.Autocomplete(autocompleteInput.current, {
                componentRestrictions: { country: "au" },
                fields: ["formatted_address"],
                types: ["address"],
                // --- Add location biasing options ---
                location: adelaideLocation,
                radius: radiusInMeters,
                // --- THIS IS THE FIX: Changed from false to true ---
                strictBounds: true, // This now ONLY shows Adelaide addresses
            });
            // ---------------------------------------------

            autocomplete.addListener("place_changed", () => {
                const place = autocomplete.getPlace();
                if (place && place.formatted_address) {
                    onAddressSelect(place.formatted_address);
                }
            });
        }
    }, [isLoaded, onAddressSelect]); // Re-run this effect if `isLoaded` changes

    return (
        <input
            ref={autocompleteInput}
            type="text"
            id="address"
            placeholder={isLoaded ? "Start typing your address..." : "Loading address helper..."}
            // The input will be disabled until the script is loaded
            disabled={!isLoaded} 
            style={{ width: 'calc(100% - 1rem)', padding: '0.5rem', borderRadius: '0.25rem', border: '1px solid #4b5563', backgroundColor: '#374151', color: 'white' }}
        />
    );
}

export default AddressAutocomplete;