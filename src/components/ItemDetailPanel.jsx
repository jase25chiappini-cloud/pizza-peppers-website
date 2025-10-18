import React, { useState } from 'react';

// NOTE: We assume getImagePath is imported from a utils file in your actual project.
const getImagePath = (name) => `https://placehold.co/400x200/374151/ADF000?text=${name.replace(/ /g, '+')}`;

// This is the new, more robust version of the component
function ItemDetailPanel({ item, onClose, editingIndex, editingItem, onOpenExtras, onOpenIngredients }) {
    
    const [quantities, setQuantities] = useState(() => {
        const q = {};
        if (item.sizes) {
            item.sizes.forEach(size => q[size] = 0);
        } else {
            q.Default = 0;
        }
        if (editingItem) {
            const sizeKey = editingItem.size || 'Default';
            q[sizeKey] = editingItem.qty;
        }
        return q;
    });

    const [isGlutenFree, setIsGlutenFree] = useState(editingItem?.isGlutenFree || false);
    
    const handleQuantityChange = (size, amount) => {
        setQuantities(prev => ({
            ...prev,
            [size]: Math.max(0, (prev[size] || 0) + amount) 
        }));
    };

    const handleGlutenFreeToggle = () => {
        setIsGlutenFree(prev => {
            const newState = !prev;
            if (newState) {
                setQuantities(currentQs => ({ ...Object.fromEntries(Object.keys(currentQs).map(s => [s, s === 'Large' ? currentQs[s] : 0])) }));
            }
            return newState;
        });
    };
    
    const handleAddToCart = () => {
        const itemsToAdd = [];
        for (const size in quantities) {
            if (quantities[size] > 0) {
                itemsToAdd.push({ size: item.sizes ? size : 'Default', qty: quantities[size] });
            }
        }
        onClose(itemsToAdd, isGlutenFree);
    };

    const totalItems = Object.values(quantities).reduce((sum, qty) => sum + (qty || 0), 0);

    // --- THIS IS THE CORRECTED FUNCTION ---
    // It now correctly handles raw price strings from the API.
    const getPrice = (size) => {
        const rawPrice = item.prices[size];

        // If the price doesn't exist, return 0
        if (rawPrice === undefined || rawPrice === null) {
            return 0;
        }
        // If it's already a number, return it
        if (typeof rawPrice === 'number') {
            return rawPrice;
        }
        // If it's a string, try to parse it into a number
        if (typeof rawPrice === 'string') {
            // This will find the first number in a string like "$14.50 AUD" and convert it
            const parsedPrice = parseFloat(rawPrice.replace(/[^0-9.]/g, ''));
            return isNaN(parsedPrice) ? 0 : parsedPrice;
        }
        // As a final fallback, return 0
        return 0;
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
            <button 
                onClick={() => onClose()} 
                className="quantity-btn"
                style={{ position: 'absolute', top: '1.5rem', right: '1.5rem', zIndex: '10' }}
                title="Close"
            >
                &times;
            </button>
            <img src={getImagePath(item.name)} alt={item.name} className="detail-image" />
            <h3 className="panel-title" style={{ marginTop: '1rem' }}>{item.name}</h3>
            <p style={{ color: 'var(--text-medium)', fontSize: '0.875rem', marginTop: 0 }}>{item.description}</p>
            
            <div className="detail-panel-body">
                {item.sizes ? (
                    item.sizes.map(size => {
                        let rowClassName = "size-quantity-row";
                        if (isGlutenFree) {
                            if (size === 'Large') { rowClassName += " glowing-border"; } else { rowClassName += " disabled-option"; }
                        }
                        return (
                            <div key={size} className={rowClassName}>
                                <div>
                                    <span style={{fontWeight: 500}}>{size}</span>
                                    <span style={{color: 'var(--text-medium)', marginLeft: '0.5rem'}}>${(getPrice(size) + (isGlutenFree && size === 'Large' ? 4 : 0)).toFixed(2)}</span>
                                </div>
                                <div className="quantity-controls">
                                    <button className="quantity-btn" onClick={() => handleQuantityChange(size, -1)} disabled={(isGlutenFree && size !== 'Large') || (quantities[size] || 0) === 0}>-</button>
                                    <span>{quantities[size] || 0}</span>
                                    <button className="quantity-btn" onClick={() => handleQuantityChange(size, 1)} disabled={isGlutenFree && size !== 'Large'}>+</button>
                                </div>
                            </div>
                        );
                    })
                ) : (
                    <div className="size-quantity-row">
                        <div>
                            <span style={{fontWeight: 500}}>Price</span>
                            <span style={{color: 'var(--text-medium)', marginLeft: '0.5rem'}}>${(getPrice('Default')).toFixed(2)}</span>
                        </div>
                        <div className="quantity-controls">
                            <button className="quantity-btn" onClick={() => handleQuantityChange('Default', -1)} disabled={(quantities.Default || 0) === 0}>-</button>
                            <span>{quantities.Default || 0}</span>
                            <button className="quantity-btn" onClick={() => handleQuantityChange('Default', 1)}>+</button>
                        </div>
                    </div>
                )}
                
                {item.sizes && (
                    <div className="gluten-free-toggle">
                        <label htmlFor="gf-checkbox">Gluten Free (Large Only) +$4.00</label>
                        <input type="checkbox" id="gf-checkbox" checked={isGlutenFree} onChange={handleGlutenFreeToggle} />
                    </div>
                )}
                
                {item.sizes && <button className="simple-button" onClick={onOpenExtras}>Add Extras</button>}
                {item.ingredients && <button className="simple-button" onClick={onOpenIngredients}>Edit Ingredients</button>}
            </div>

            <div className="cart-total-section">
                <button onClick={handleAddToCart} className="place-order-button">
                    {editingIndex !== null ? 'Update Item' : `Add ${totalItems} to Order`}
                </button>
                <button onClick={() => onClose()} className="simple-button" style={{ marginTop: '0.5rem' }}>Cancel</button>
            </div>
        </div>
    );
}

export default ItemDetailPanel;

