import React, { useState, createContext, useContext, useMemo } from 'react';

const CartContext = createContext();

// Make sure the "export" keyword is here
export function CartProvider({ children }) {
    const [cart, setCart] = useState([]);

    const addToCart = (itemsToAdd) => {
        setCart(prevCart => {
            const newCart = [...prevCart];
            itemsToAdd.forEach(itemToAdd => {
                const existingItemIndex = newCart.findIndex(cartItem => 
                    cartItem.name === itemToAdd.name && 
                    cartItem.size === itemToAdd.size && 
                    cartItem.isGlutenFree === itemToAdd.isGlutenFree && 
                    JSON.stringify(cartItem.extras) === JSON.stringify(itemToAdd.extras) && 
                    JSON.stringify(cartItem.removedIngredients) === JSON.stringify(itemToAdd.removedIngredients)
                );
                
                if (existingItemIndex > -1) { 
                    newCart[existingItemIndex].qty += itemToAdd.qty; 
                } else { 
                    newCart.push(itemToAdd); 
                }
            });
            return newCart;
        });
    };

    const removeFromCart = (index) => setCart(prev => prev.filter((_, i) => i !== index));
    const totalPrice = useMemo(() => cart.reduce((sum, item) => sum + (item.price * item.qty), 0), [cart]);

    return (
        <CartContext.Provider value={{ cart, addToCart, removeFromCart, totalPrice }}>
            {children}
        </CartContext.Provider>
    );
}

// And make sure the "export" keyword is here too
export function useCart() { 
    return useContext(CartContext); 
}