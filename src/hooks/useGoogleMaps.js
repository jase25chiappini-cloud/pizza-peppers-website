import { useState, useEffect } from 'react';

const useGoogleMaps = (apiKey) => {
    const [isLoaded, setIsLoaded] = useState(false);

    useEffect(() => {
        // This is a more reliable check. If the 'google' object already exists on the window,
        // it means the script has been loaded by a previous render, so we don't need to do anything.
        if (window.google && window.google.maps) {
            setIsLoaded(true);
            return;
        }

        const scriptId = 'google-maps-script';
        const existingScript = document.getElementById(scriptId);

        if (existingScript) {
            // If the script tag exists but window.google isn't ready,
            // we set up a listener on the existing script.
            const handleLoad = () => setIsLoaded(true);
            existingScript.addEventListener('load', handleLoad);
            // Cleanup the event listener on unmount
            return () => existingScript.removeEventListener('load', handleLoad);
        }

        if (!apiKey) {
            console.error("Google Maps API key is missing for the loader hook.");
            return;
        }

        const script = document.createElement('script');
        script.id = scriptId;
        script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
        script.async = true;
        script.defer = true;
        
        script.onload = () => {
            setIsLoaded(true);
        };

        script.onerror = () => {
            console.error("Google Maps script failed to load.");
        };

        document.head.appendChild(script);

    }, [apiKey]);

    return { isLoaded };
};

export default useGoogleMaps;