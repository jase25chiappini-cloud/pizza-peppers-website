import React, { useState, createContext, useContext, useMemo, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import { formatId, getImagePath } from './utils/helpers';
import { menuData, extrasData } from './data/menuData';
import Menu from './components/Menu';
import { CartProvider, useCart } from './context/CartContext';
import QuickNav from './components/QuickNav';
import { ThemeProvider } from './context/ThemeContext';
import ThemeSwitcher from './components/ThemeSwitcher';
import ItemDetailPanel from './components/ItemDetailPanel';
import OrderSummaryPanel from './components/OrderSummaryPanel';

// --- CSS STYLES ---
function AppStyles() {
  const styles = `
    /* --- THEME & BASE STYLES (No changes here) --- */
    :root {
      --brand-pink: #D92682; --brand-green-cta: #00A756; --brand-neon-green: #ADF000;
      --background-dark: #111827; --background-light: #1f2937; --border-color: #374151;
      --text-light: #f3f4f6; --text-medium: #9ca3af;
    }
    [data-theme='light'] {
      --brand-neon-green: #008a45; --background-dark: #f9fafb; --background-light: #ffffff;
      --border-color: #e5e7eb; --text-light: #111827; --text-medium: #6b7280;
    }
    [data-theme='dark'] {
      --background-dark: #000000; --background-light: #111111;
      --border-color: #2b2b2b; --text-medium: #888888;
    }
    html { scroll-behavior: smooth; }
    body {
      background-color: var(--background-dark); color: var(--text-light);
      font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
      margin: 0;
    }

/* --- FINAL APP-WIDE LAYOUT --- */
.app-grid-layout {
    display: grid;
    grid-template-columns: 1fr; /* Single column on mobile */
}

@media (min-width: 1024px) {
    .app-grid-layout {
        /* Left column is flexible, right column is exactly 35% of the viewport width */
        grid-template-columns: minmax(0, 1fr) 35%;
    }
}

.main-content-area {
    padding: 1.5rem;
}

.right-sidebar {
    display: none; /* Hidden on mobile */
}

@media (min-width: 1024px) {
    .right-sidebar {
        display: block;
        position: sticky; /* This makes the entire sidebar stick to the viewport */
        top: 0;            /* Aligns it to the very top */
        height: 100vh;     /* Ensures it's always the full height of the screen */
    }
}
    
.order-panel-container {
  background-color: var(--background-light);
  padding: 1.5rem;
  height: 100%; /* This makes it fill its sticky parent */
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  box-sizing: border-box; /* This is crucial for correct height calculation */
  border-radius: 0; 
}

    /* --- OTHER COMPONENT STYLES (No changes) --- */
    .menu-category { margin-bottom: 3rem; }
    .category-title { font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem; color: var(--brand-neon-green); scroll-margin-top: 1rem; }
    /* ... The rest of your styles for cards, buttons, etc., remain unchanged ... */
    .menu-grid { display: grid; grid-template-columns: repeat(1, 1fr); gap: 1rem; }
    @media (min-width: 640px) { .menu-grid { grid-template-columns: repeat(2, 1fr); } }
    @media (min-width: 1280px) { .menu-grid { grid-template-columns: repeat(3, 1fr); } }
    .menu-item-card { background-color: var(--background-light); border-radius: 0.75rem; border: 1px solid var(--border-color); cursor: pointer; transition: border-color 0.2s, background-color 0.2s; display: flex; flex-direction: column; overflow: hidden; }
    .menu-item-card:hover { border-color: var(--brand-neon-green); }
    .card-image-container { height: 8rem; width: 100%; background-color: var(--border-color); }
    .card-image { width: 100%; height: 100%; object-fit: cover; }
    .card-text-container { padding: 0.75rem; flex-grow: 1; }
    .card-item-name { font-size: 1rem; font-weight: 700; color: var(--brand-neon-green); }
    .card-item-description { font-size: 0.75rem; color: var(--text-medium); margin-top: 0.25rem; }
    .panel-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 1rem; color: var(--brand-neon-green); }
    .cart-items-list, .detail-panel-body { flex-grow: 1; overflow-y: auto; padding-right: 0.5rem; }
    .cart-item { display: flex; justify-content: space-between; align-items: center; font-size: 0.875rem; border-bottom: 1px solid var(--border-color); padding: 0.75rem 0.25rem; cursor: pointer; }
    .cart-item:hover { background-color: var(--border-color); }
    .cart-item-details { font-size: 0.75rem; color: var(--text-medium); padding-left: 1rem; margin-top: 0.25rem; }
    .cart-total-section { margin-top: auto; padding-top: 1rem; border-top: 1px solid var(--border-color); }
    .total-price-display { display: flex; justify-content: space-between; align-items: center; font-size: 1.125rem; font-weight: 700; margin-bottom: 1rem; }
    .place-order-button, .simple-button, .quantity-btn { cursor: pointer; border: none; border-radius: 0.5rem; }
    .place-order-button { width: 100%; background-color: var(--brand-green-cta); color: white; padding: 0.75rem 1rem; font-weight: 700; }
    .place-order-button:hover { opacity: 0.9; }
    .detail-image { width: 100%; height: 12rem; object-fit: cover; border-radius: 0.5rem; background-color: var(--border-color); }
    .size-quantity-row { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem; border: 1px solid var(--border-color); border-radius: 0.5rem; margin-bottom: 0.5rem; transition: all 0.3s ease-in-out; }
    .size-quantity-row.glowing-border { border-color: var(--brand-neon-green); box-shadow: 0 0 10px 2px var(--brand-neon-green); }
    .disabled-option { opacity: 0.35; pointer-events: none; background-color: rgba(0,0,0,0.1); }
    .gluten-free-toggle {  display: flex; justify-content: space-between; align-items: center;  padding: 0.75rem 0; border-bottom: 1px solid var(--border-color);  }
    .quantity-controls { display: flex; align-items: center; gap: 0.75rem; }
    .quantity-btn { background-color: var(--border-color); color: var(--text-light); width: 2rem; height: 2rem; font-size: 1.25rem; }
    .quantity-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .simple-button { width: 100%; background-color: var(--border-color); color: var(--text-light); padding: 0.75rem 1rem; font-weight: 500; margin-top: 0.5rem; }
    .simple-button:hover { background-color: #4b5563; }
    .modal-overlay { position: fixed; inset: 0; background-color: rgba(0,0,0,0.7); display: flex; justify-content: center; align-items: center; z-index: 100; }
    .modal-content { background-color: var(--background-light); padding: 1.5rem; border-radius: 0.75rem; width: 90%; max-width: 500px; max-height: 80vh; display: flex; flex-direction: column; }
    .modal-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 1rem; }
    .modal-body { overflow-y: auto; padding: 1rem 0; }
    .modal-footer { padding-top: 1rem; border-top: 1px solid var(--border-color); }
    .modal-category-title { color: var(--brand-neon-green); font-weight: 600; margin-top: 1.5rem; margin-bottom: 0.5rem; }
    .modal-item-row { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0; }
    .quick-nav-container { position: sticky; top: 0; background-color: var(--background-dark); z-index: 10; margin-bottom: 1.5rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border-color); overflow-x: auto; white-space: nowrap; scrollbar-width: none; -ms-overflow-style: none; transition: background-color 0.2s; }
    .quick-nav-container::-webkit-scrollbar { display: none; }
    .quick-nav-list { list-style: none; padding: 0; margin: 0; display: flex; gap: 0.5rem; }
    .quick-nav-item a { display: block; padding: 0.5rem 1rem; color: var(--text-medium); text-decoration: none; font-weight: 500; border-bottom: 2px solid transparent; transition: color 0.2s, border-color 0.2s; }
    .quick-nav-item a:hover { color: var(--text-light); }
    .quick-nav-item a.active-nav-link { color: var(--brand-neon-green); border-bottom-color: var(--brand-neon-green); }
  `;
  return <style>{styles}</style>;
}

// --- MODAL COMPONENTS ---
function ExtrasModal({ onSave, onCancel, initialExtras = {} }) {
    const [selectedExtras, setSelectedExtras] = useState(initialExtras);
    const handleExtrasChange = (extra, amount) => {
        const currentQty = selectedExtras[extra.name]?.qty || 0;
        const newQty = Math.max(0, currentQty + amount);
        if (newQty > 0) { setSelectedExtras(prev => ({ ...prev, [extra.name]: { ...extra, qty: newQty } })); } 
        else { const newExtras = { ...selectedExtras }; delete newExtras[extra.name]; setSelectedExtras(newExtras); }
    };
    return ( <div className="modal-overlay" onClick={onCancel}> <div className="modal-content" onClick={(e) => e.stopPropagation()}> <div className="modal-header"> <h3 className="panel-title">Add Extras</h3> <button onClick={onCancel} className="quantity-btn" style={{width: '2.5rem', height: '2.5rem'}}>×</button> </div> <div className="modal-body"> {Object.entries(extrasData).map(([category, extras]) => ( <div key={category}> <h4 className="modal-category-title">{category}</h4> {extras.map(extra => ( <div key={extra.name} className="modal-item-row"> <div> <span style={{textTransform: 'capitalize'}}>{extra.name}</span> <span style={{color: '#9ca3af', marginLeft: '0.5rem'}}>+${extra.price.toFixed(2)}</span> </div> <div className="quantity-controls"> <button className="quantity-btn" onClick={() => handleExtrasChange(extra, -1)} disabled={!selectedExtras[extra.name]}>-</button> <span>{selectedExtras[extra.name]?.qty || 0}</span> <button className="quantity-btn" onClick={() => handleExtrasChange(extra, 1)}>+</button> </div> </div> ))} </div> ))} </div> <div className="modal-footer"> <button onClick={() => onSave(selectedExtras)} className="place-order-button">Save Extras</button> </div> </div> </div> );
}
function EditIngredientsModal({ item, onSave, onCancel, initialRemoved = [] }) {
    const [removedIngredients, setRemovedIngredients] = useState(new Set(initialRemoved));
    const handleToggle = (ingredient) => {
        setRemovedIngredients(prev => {
            const newSet = new Set(prev);
            if (newSet.has(ingredient)) { newSet.delete(ingredient); } else { newSet.add(ingredient); }
            return newSet;
        });
    };
    return ( <div className="modal-overlay" onClick={onCancel}> <div className="modal-content" onClick={(e) => e.stopPropagation()}> <div className="modal-header"> <h3 className="panel-title">Edit Ingredients</h3> <button onClick={onCancel} className="quantity-btn" style={{width: '2.5rem', height: '2.5rem'}}>×</button> </div> <div className="modal-body"> {item.ingredients?.map(ingredient => ( <div key={ingredient} className="modal-item-row"> <label htmlFor={ingredient} style={{textTransform: 'capitalize'}}>{ingredient}</label> <input type="checkbox" id={ingredient} checked={!removedIngredients.has(ingredient)} onChange={() => handleToggle(ingredient)} /> </div> ))} </div> <div className="modal-footer"> <button onClick={() => onSave(Array.from(removedIngredients))} className="place-order-button">Save Ingredients</button> </div> </div> </div> );
}

// --- UI COMPONENTS ---
function Navbar() {
    const { cart } = useCart();
    const totalItems = useMemo(() => cart.reduce((sum, item) => sum + item.qty, 0), [cart]);
    return (
        <nav style={{ backgroundColor: 'var(--background-dark)', padding: '0.5rem 1.5rem', borderBottom: `1px solid var(--brand-pink)` , position: 'sticky', top: 0, zIndex: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                
                {/* Left side of Navbar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
                    <ThemeSwitcher /> {/* <-- ADD THE THEME SWITCHER HERE */}
                    <Link to="/" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center' }}>
                        <img src="/pizza-peppers-logo.jpg" alt="Pizza Peppers Logo" style={{ height: '3.5rem' }} />
                    </Link>
                </div>

                {/* Right side of Navbar */}
                <div>
                    <Link to="/" style={{ color: 'var(--text-light)', textDecoration: 'none', marginRight: '1.5rem', fontWeight: '500' }}>Menu</Link>
                    <Link to="/checkout" style={{ color: 'var(--text-light)', textDecoration: 'none', fontWeight: '500' }}>Cart ({totalItems})</Link>
                </div>
            </div>
        </nav>
    );
}

// --- PAGE COMPONENT ---
function Home({ menuData, handleItemClick }) { // <-- Accept menuData as a prop
    const [activeCategory, setActiveCategory] = useState('');
    useEffect(() => { /* ... existing scroll logic ... */ }, []);
    return (
        <>
            <QuickNav menuData={menuData} activeCategory={activeCategory} />
            <Menu menuData={menuData} onItemClick={handleItemClick} /> {/* <-- Pass it to Menu */}
        </>
    );
}

// --- LAYOUT COMPONENT ---
// This component now holds all the state and logic for the page.
function AppLayout() {
    const { addToCart, removeFromCart } = useCart();
    
    // --- NEW STATE FOR DYNAMIC MENU ---
    // 1. We now store menuData in state, starting with an empty array.
    const [menuData, setMenuData] = useState({ categories: [] });
    // 2. We add a loading state to give feedback to the user.
    const [isLoading, setIsLoading] = useState(true);
    // ------------------------------------

    const [selectedItem, setSelectedItem] = useState(null);
    const [editingIndex, setEditingIndex] = useState(null);
    const [isExtrasModalOpen, setIsExtrasModalOpen] = useState(false);
    const [isIngredientsModalOpen, setIsIngredientsModalOpen] = useState(false);
    const [customizingItem, setCustomizingItem] = useState(null);

    // --- NEW DATA FETCHING LOGIC ---
    useEffect(() => {
        // This function runs once when the component first loads.
        const fetchMenu = async () => {
            try {
                // 3. We make a web request to the API endpoint on your brother's server.
                const response = await fetch('http://localhost:5055/api/menu');
                const rawData = await response.json();

                // 4. We need to transform the new data structure into the old one our components expect.
                const transformedMenu = {
                    categories: rawData.data.categories.map(category => {
                        // Find all products that belong to this category
                        const items = rawData.data.products
                            .filter(p => p.category_ref === category.ref)
                            .map(product => {
                                // Transform the 'skus' array into 'sizes' and 'prices' objects
                                const sizes = product.skus.map(sku => sku.name);
                                const prices = product.skus.reduce((acc, sku) => {
                                    // Clean up the price string (e.g., "14.50 AUD" -> 14.50)
                                    acc[sku.name] = parseFloat(sku.price.replace(' AUD', ''));
                                    return acc;
                                }, {});

                                return {
                                    name: product.name,
                                    description: product.description,
                                    sizes: sizes.length > 1 ? sizes : null, // Handle 'default' size
                                    prices: prices,
                                    ingredients: [], // Placeholder for now
                                };
                            });
                        
                        return {
                            name: category.name,
                            items: items,
                        };
                    })
                };

                // 5. Update our state with the new, live menu data.
                setMenuData(transformedMenu);
                setIsLoading(false); // Stop loading

            } catch (error) {
                console.error("Failed to fetch menu:", error);
                // Handle error state if the server is down
                setIsLoading(false);
            }
        };

        fetchMenu();
    }, []); // The empty array ensures this runs only once.
    // ---------------------------------

    const handleItemClick = (item) => {
        if (selectedItem && selectedItem.name === item.name) {
            setSelectedItem(null); setCustomizingItem(null); setEditingIndex(null);
        } else {
            setSelectedItem(item); setCustomizingItem({ ...item, extras: {}, removedIngredients: [] }); setEditingIndex(null);
        }
    };
    const handleEditItem = (item, index) => { setSelectedItem(item); setCustomizingItem({ ...item }); setEditingIndex(index); };
    const handleClosePanel = (itemsToAdd, isGlutenFree) => { if (itemsToAdd && itemsToAdd.length > 0) { const extrasPrice = Object.values(customizingItem.extras || {}).reduce((sum, extra) => sum + extra.price * extra.qty, 0); const finalItems = itemsToAdd.map(({ size, qty }) => ({ ...selectedItem, size, qty, price: selectedItem.prices[size] + (isGlutenFree && size === 'Large' ? 4.00 : 0) + extrasPrice, isGlutenFree: isGlutenFree && size === 'Large', extras: customizingItem.extras, removedIngredients: customizingItem.removedIngredients })); if (editingIndex !== null) removeFromCart(editingIndex); addToCart(finalItems); } setSelectedItem(null); setEditingIndex(null); setCustomizingItem(null); };
    const handleSaveExtras = (newExtras) => { setCustomizingItem(prev => ({ ...prev, extras: newExtras })); setIsExtrasModalOpen(false); };
    const handleSaveIngredients = (newRemoved) => { setCustomizingItem(prev => ({ ...prev, removedIngredients: newRemoved })); setIsIngredientsModalOpen(false); };

    return (
        <>
            {isExtrasModalOpen && customizingItem && <ExtrasModal onSave={handleSaveExtras} onCancel={() => setIsExtrasModalOpen(false)} initialExtras={customizingItem.extras} />}
            {isIngredientsModalOpen && customizingItem && <EditIngredientsModal item={customizingItem} onSave={handleSaveIngredients} onCancel={() => setIsIngredientsModalOpen(false)} initialRemoved={customizingItem.removedIngredients} />}
            
            <div className="app-grid-layout">
                {/* --- Left Pane --- */}
                <div className="left-pane">
                    <Navbar />
                    <main className="main-content-area">
                        {/* 6. Show a loading message while we fetch the data */}
                        {isLoading ? (
                            <p style={{ textAlign: 'center', fontSize: '1.2rem', marginTop: '4rem' }}>Loading menu from the store...</p>
                        ) : (
                            <Routes>
                                {/* 7. Pass the new menuData state down to the Home component */}
                                <Route path="/" element={ <Home menuData={menuData} handleItemClick={handleItemClick} /> } />
                            </Routes>
                        )}
                    </main>
                </div>

                {/* --- Right Sidebar --- */}
                <div className="right-sidebar">
                    <div className="order-panel-container">
                        {selectedItem ? (
                            <ItemDetailPanel item={selectedItem} onClose={handleClosePanel} editingIndex={editingIndex} editingItem={customizingItem} onOpenExtras={() => setIsExtrasModalOpen(true)} onOpenIngredients={() => setIsIngredientsModalOpen(true)} />
                        ) : (
                            <OrderSummaryPanel onEditItem={handleEditItem} />
                        )}
                    </div>
                </div>
            </div>
        </>
    );
}

// --- MAIN APP (JUST FOR SETUP) ---
function App() {
  return (
    <Router>
      <ThemeProvider>
        <CartProvider>
            <AppStyles /> 
            <AppLayout />
        </CartProvider>
      </ThemeProvider>
    </Router>
  );
}

export default App;