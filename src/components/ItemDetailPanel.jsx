import React, { useState } from 'react';
import { getImagePath } from '../utils/helpers';

function ItemDetailPanel({ item, onClose, editingIndex, editingItem, onOpenExtras, onOpenIngredients }) {
    const [quantities, setQuantities] = useState(() => {
        const q = {};
        if (item.sizes) {
            item.sizes.forEach(size => q[size] = 0);
        } else {
            q.Default = 0;
        }
        if (editingItem) {
            q[editingItem.size] = editingItem.qty;
        }
        return q;
    });

    const [isGlutenFree, setIsGlutenFree] = useState(editingItem?.isGlutenFree || false);
    
    const handleQuantityChange = (size, amount) => {
        setQuantities(prev => ({ ...prev, [size]: Math.max(0, prev[size] + amount) }));
    };

    const handleGlutenFreeToggle = () => {
        setIsGlutenFree(prev => {
            const newState = !prev;
            if (newState) {
                setQuantities(currentQs => ({
                    ...Object.fromEntries(Object.keys(currentQs).map(s => [s, s === 'Large' ? currentQs[s] : 0]))
                }));
            }
            return newState;
        });
    };
    
    const handleAddToCart = () => {
        const itemsToAdd = [];
        for (const size in quantities) {
            if (quantities[size] > 0) {
                itemsToAdd.push({ size, qty: quantities[size] });
            }
        }
        onClose(itemsToAdd, isGlutenFree);
    };

    const totalItems = Object.values(quantities).reduce((sum, qty) => sum + qty, 0);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
            <button 
                onClick={() => onClose()} 
                className="quantity-btn"
                style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', zIndex: '10' }}
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
                            if (size === 'Large') {
                                rowClassName += " glowing-border";
                            } else {
                                rowClassName += " disabled-option";
                            }
                        }

                        return (
                            <div key={size} className={rowClassName}>
                                <div>
                                    <span style={{fontWeight: 500}}>{size}</span>
                                    <span style={{color: 'var(--text-medium)', marginLeft: '0.5rem'}}>${(item.prices[size] + (isGlutenFree && size === 'Large' ? 4 : 0)).toFixed(2)}</span>
                                </div>
                                <div className="quantity-controls">
                                    <button className="quantity-btn" onClick={() => handleQuantityChange(size, -1)} disabled={(isGlutenFree && size !== 'Large') || quantities[size] === 0}>-</button>
                                    <span>{quantities[size]}</span>
                                    <button className="quantity-btn" onClick={() => handleQuantityChange(size, 1)} disabled={isGlutenFree && size !== 'Large'}>+</button>
                                </div>
                            </div>
                        );
                    })
                ) : (
                    <div className="size-quantity-row">
                        <div><span>Default</span></div>
                        <div className="quantity-controls">
                            <button className="quantity-btn" onClick={() => handleQuantityChange('Default', -1)} disabled={quantities.Default === 0}>-</button>
                            <span>{quantities.Default}</span>
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
                <button className="simple-button" onClick={onOpenExtras}>Add Extras ({Object.keys(editingItem?.extras || {}).length})</button>
                {item.ingredients && <button className="simple-button" onClick={onOpenIngredients}>Edit Ingredients</button>}
            </div>
            <div className="cart-total-section">
                <button onClick={handleAddToCart} className="place-order-button" style={{ backgroundColor: 'var(--brand-neon-green)', color: 'black' }}>
                    {editingIndex !== null ? 'Update Item' : `Add ${totalItems} to Order`}
                </button>
                <button onClick={() => onClose()} className="simple-button" style={{ marginTop: '0.5rem' }}>Cancel</button>
            </div>
        </div>
    );
}

export default ItemDetailPanel;