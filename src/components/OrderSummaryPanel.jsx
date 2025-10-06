import React from 'react';
import { useCart } from '../context/CartContext';

function OrderSummaryPanel({ onEditItem }) {
    const { cart, totalPrice } = useCart();
    
    return (
        <>
            <h2 className="panel-title">Your Order</h2>
            <div style={{ marginBottom: '1rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
                <p>Pickup from: **Pizza Peppers Store**</p>
                <p>Pickup time: **ASAP**</p>
            </div>
            <div className="cart-items-list">
                {cart.length > 0 ? (
                    cart.map((item, index) => (
                        <div key={index} className="cart-item" onClick={() => onEditItem(item, index)}>
                            <div>
                                <span>{item.qty} x {item.name} {item.size !== 'Default' ? `(${item.size})` : ''}</span>
                                {item.isGlutenFree && <span style={{color: '#facc15', marginLeft: '0.5rem', fontSize: '0.75rem'}}>GF</span>}
                                <div className="cart-item-details">
                                    {Object.values(item.extras || {}).map(extra => `${extra.qty}x ${extra.name}`).join(', ')}
                                </div>
                                <div className="cart-item-details" style={{color: '#fca5a5'}}>
                                    {item.removedIngredients?.length > 0 ? `No ${item.removedIngredients.join(', ')}` : ''}
                                </div>
                            </div>
                            <span>${(item.price * item.qty).toFixed(2)}</span>
                        </div>
                    ))
                ) : (
                    <p style={{ color: 'var(--text-medium)' }}>Click on an item to add it to your order.</p>
                )}
            </div>
            <div style={{margin: '1rem 0'}}>
                <input type="text" placeholder="Add voucher code" style={{width: 'calc(100% - 1rem)', padding: '0.5rem', borderRadius: '0.25rem', border: '1px solid #4b5563', backgroundColor: '#374151', color: 'white'}} />
            </div>
            <div className="cart-total-section">
                <div className="total-price-display">
                    <span>Total:</span>
                    <span>${totalPrice.toFixed(2)}</span>
                </div>
                <button className="place-order-button">Continue</button>
            </div>
        </>
    );
}

export default OrderSummaryPanel;