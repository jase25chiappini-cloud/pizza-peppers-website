import React, { useState, useEffect, useRef } from 'react';
import { useCart } from '../context/CartContext';
import AddressAutocomplete from './AddressAutocomplete';

// --- DYNAMIC TIME & DELIVERY LOGIC ---
const deliveryZones = {
  'sheidow park': 8.40, 'woodcroft': 8.40, 'christie downs': 12.60, 'trott park': 8.40,
  'happy valley': 8.40, "o'halloran hill": 8.40, 'hallett cove': 12.60, 'hackham west': 12.60,
  'huntfield heights': 12.60, 'morphett vale': 8.40, 'lonsdale': 12.60, 'old reynella': 8.40,
  'hackham': 12.60, 'reynella': 8.40, 'onkaparinga hills': 12.60, 'reynella east': 8.40,
  'aberfoyle park': 12.60
};
const calculateCookTime = (cart) => {
    const baseTime = 20; const itemsCount = cart.reduce((sum, item) => sum + item.qty, 0);
    const extraTime = itemsCount > 1 ? (itemsCount - 1) * 2 : 0; return baseTime + extraTime;
};
const getSimulatedDriveTime = (address) => {
    if (!address) return 0; return Math.floor(Math.random() * (35 - 15 + 1)) + 15;
};

function OrderSummaryPanel({ onEditItem, isMapsLoaded }) {
    const { cart, totalPrice } = useCart();
    const [orderType, setOrderType] = useState('Pickup'); 
    const [address, setAddress] = useState('');
    const [estimatedTime, setEstimatedTime] = useState(0);
    const [deliveryFee, setDeliveryFee] = useState(0);
    const [addressError, setAddressError] = useState('');
    const addressInputRef = useRef(null);
    const finalTotal = totalPrice + deliveryFee;

    useEffect(() => {
        const cookTime = calculateCookTime(cart);
        if (orderType === 'Pickup') {
            setEstimatedTime(cookTime);
        } else {
            const driveTime = getSimulatedDriveTime(address);
            if (driveTime > 0) { setEstimatedTime(cookTime + driveTime); } else { setEstimatedTime(0); }
        }
    }, [orderType, address, cart]);

    useEffect(() => {
        if (orderType !== 'Delivery' || !isMapsLoaded || !addressInputRef.current) return;
        const adelaideBounds = new window.google.maps.LatLngBounds( new window.google.maps.LatLng(-35.15, 138.45), new window.google.maps.LatLng(-35.00, 138.65) );
        const autocomplete = new window.google.maps.places.Autocomplete(addressInputRef.current, { componentRestrictions: { country: 'AU' }, types: ['address'], fields: ['formatted_address', 'address_components'], bounds: adelaideBounds, strictBounds: true });
        const onPlaceChanged = () => {
            const place = autocomplete.getPlace();
            if (!place || !place.address_components) { setAddressError('Please select a valid address from the suggestions.'); setDeliveryFee(0); return; }
            const suburbComponent = place.address_components.find(component => component.types.includes('locality'));
            if (suburbComponent) {
                const suburb = suburbComponent.long_name.toLowerCase();
                if (deliveryZones[suburb]) {
                    setAddress(place.formatted_address); setDeliveryFee(deliveryZones[suburb]); setAddressError('');
                } else {
                    setAddress(place.formatted_address); setDeliveryFee(0); setAddressError('Sorry, we do not deliver to this suburb.');
                }
            } else { setAddressError('Could not determine suburb. Please try a different address.'); setDeliveryFee(0); }
        };
        autocomplete.addListener('place_changed', onPlaceChanged);
        return () => { if (autocomplete && window.google) { window.google.maps.event.clearInstanceListeners(autocomplete); } };
    }, [isMapsLoaded, orderType]);

    const activeButtonStyle = { backgroundColor: 'var(--brand-neon-green)', color: 'var(--background-dark)', border: 'none', padding: '0.75rem 1rem', borderRadius: '0.5rem', fontWeight: '700', cursor: 'pointer', width: '50%' };
    const inactiveButtonStyle = { ...activeButtonStyle, backgroundColor: 'var(--border-color)', color: 'var(--text-light)' };

    return (
        <>
            <h2 className="panel-title">Your Order</h2>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
                <button style={orderType === 'Pickup' ? activeButtonStyle : inactiveButtonStyle} onClick={() => { setOrderType('Pickup'); setAddress(''); setDeliveryFee(0); setAddressError(''); }}>Pickup</button>
                <button style={orderType === 'Delivery' ? activeButtonStyle : inactiveButtonStyle} onClick={() => setOrderType('Delivery')}>Delivery</button>
            </div>

            <div className="info-box">
                {orderType === 'Pickup' ? (
                    <>
                        <p>Pickup from: <strong>Pizza Peppers Store</strong></p>
                        <p>Pickup time: <strong>ASAP (Approx. {estimatedTime} mins)</strong></p>
                    </>
                ) : (
                    <>
                        <label htmlFor="address" style={{ fontWeight: 500, marginBottom: '0.5rem', display: 'block' }}>Delivery Address</label>
                        <input
                            ref={addressInputRef}
                            type="text"
                            id="address"
                            onChange={(e) => {
                                setAddress(e.target.value);
                                setDeliveryFee(0);
                                setAddressError('');
                            }}
                            value={address}
                            placeholder={isMapsLoaded ? 'Start typing your address…' : 'Loading address helper…'}
                            disabled={!isMapsLoaded}
                            style={{ width: 'calc(100% - 1.5rem)'}}
                        />
                        {addressError && <p style={{ color: '#fca5a5', marginTop: '0.5rem', fontSize: '0.875rem' }}>{addressError}</p>}
                        {estimatedTime > 0 && deliveryFee > 0 && <p style={{ marginTop: '1rem' }}>Estimated delivery time: <strong>ASAP (Approx. {estimatedTime} mins)</strong></p>}
                    </>
                )}
            </div>
            
            <div className="cart-items-list">{cart.length > 0 ? cart.map((item, index) => (<div key={index} className="cart-item" onClick={() => onEditItem(item, index)}><div><span>{item.qty} x {item.name} {item.size !== 'Default' ? `(${item.size})` : ''}</span>{item.isGlutenFree && <span style={{color: '#facc15', marginLeft: '0.5rem', fontSize: '0.75rem'}}>GF</span>}<div className="cart-item-details">{Object.values(item.extras || {}).map(extra => `${extra.qty}x ${extra.name}`).join(', ')}</div><div className="cart-item-details" style={{color: '#fca5a5'}}>{item.removedIngredients?.length > 0 ? `No ${item.removedIngredients.join(', ')}` : ''}</div></div><span>${(item.price * item.qty).toFixed(2)}</span></div>)) : <p style={{ color: 'var(--text-medium)', textAlign: 'center', marginTop: '2rem' }}>Your cart is empty.</p>}</div>
            
            <div className="cart-total-section">
                <div style={{marginBottom: '1rem'}}>
                    <input type="text" placeholder="Add voucher code" style={{width: 'calc(100% - 1.5rem)'}} />
                </div>
                {deliveryFee > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem', color: 'var(--text-medium)' }}>
                        <span>Delivery Fee</span>
                        <span>${deliveryFee.toFixed(2)}</span>
                    </div>
                )}
                <div className="total-price-display">
                    <span>Total:</span>
                    <span>${finalTotal.toFixed(2)}</span>
                </div>
                <button className="place-order-button" disabled={orderType === 'Delivery' && (!address || addressError)}>Continue</button>
            </div>
        </>
    );
}

export default OrderSummaryPanel;