import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';

function AboutPanel({ onOpenHours, onOpenDelivery, isMapsLoaded }) {
    const mapRef = useRef(null);
    const storeLocation = { lat: -35.077, lng: 138.515 }; // Approximate location for Reynella

    // This useEffect hook initializes the Google Map
    useEffect(() => {
        // It waits until the Google script is loaded and the map div is ready
        if (isMapsLoaded && mapRef.current) {
            const map = new window.google.maps.Map(mapRef.current, {
                center: storeLocation,
                zoom: 15,
                disableDefaultUI: true, // Hides the default map controls
                // This is a dark theme for the map to match your site
                styles: [ { "featureType": "all", "elementType": "geometry", "stylers": [ { "color": "#242f3e" } ] }, { "featureType": "all", "elementType": "labels.text.stroke", "stylers": [ { "lightness": -80 } ] }, { "featureType": "administrative", "elementType": "labels.text.fill", "stylers": [ { "color": "#746855" } ] }, { "featureType": "administrative.locality", "elementType": "labels.text.fill", "stylers": [ { "color": "#d59563" } ] }, { "featureType": "poi", "elementType": "labels.text.fill", "stylers": [ { "color": "#d59563" } ] }, { "featureType": "poi.park", "elementType": "geometry", "stylers": [ { "color": "#263c3f" } ] }, { "featureType": "poi.park", "elementType": "labels.text.fill", "stylers": [ { "color": "#6b9a76" } ] }, { "featureType": "road", "elementType": "geometry.fill", "stylers": [ { "color": "#2b3544" } ] }, { "featureType": "road", "elementType": "labels.text.fill", "stylers": [ { "color": "#9ca5b3" } ] }, { "featureType": "road.arterial", "elementType": "geometry", "stylers": [ { "color": "#374151" } ] }, { "featureType": "road.highway", "elementType": "geometry", "stylers": [ { "color": "#746855" } ] }, { "featureType": "road.highway", "elementType": "labels.text.fill", "stylers": [ { "color": "#f3d19c" } ] }, { "featureType": "road.local", "elementType": "geometry", "stylers": [ { "color": "#374151" } ] }, { "featureType": "transit", "elementType": "geometry", "stylers": [ { "color": "#2f3948" } ] }, { "featureType": "transit.station", "elementType": "labels.text.fill", "stylers": [ { "color": "#d59563" } ] }, { "featureType": "water", "elementType": "geometry", "stylers": [ { "color": "#17263c" } ] }, { "featureType": "water", "elementType": "labels.text.fill", "stylers": [ { "color": "#515c6d" } ] }, { "featureType": "water", "elementType": "labels.text.stroke", "stylers": [ { "lightness": -20 } ] } ]
            });
            // This creates the pin on the map
            new window.google.maps.Marker({ position: storeLocation, map: map, title: 'Pizza Peppers' });
        }
    }, [isMapsLoaded]); // This effect depends on the map script being loaded

    return (
        <>
            <h2 className="panel-title">About Pizza Peppers</h2>
            <div className="about-panel-list-item">
                <h4>Our Location</h4>
                <p>123 Pizza Lane, Reynella SA 5161</p>
                <div ref={mapRef} style={{ height: '200px', width: '100%', borderRadius: '0.5rem', marginTop: '1rem', background: 'var(--border-color)' }}></div>
            </div>
            <div className="about-panel-list-item">
                <a href="tel:0883877700">
                    <h4>Call Us</h4>
                    <p>(08) 8387 7700</p>
                </a>
            </div>
            <div className="about-panel-list-item">
                <button onClick={onOpenHours}>
                    <h4>Opening Hours</h4>
                    <p>View our weekly trading hours</p>
                </button>
            </div>
            <div className="about-panel-list-item">
                <button onClick={onOpenDelivery}>
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

export default AboutPanel;