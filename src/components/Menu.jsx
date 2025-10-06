import React from 'react';
import { getImagePath, formatId } from '../utils/helpers'; // <-- Add this line

function Menu({ menuData, onItemClick }) {
    return (
        <div className="menu-content">
            {menuData.categories.map((category) => (
                <div key={category.name} className="menu-category" id={formatId(category.name)}>
                    <h2 className="category-title">{category.name}</h2>
                    <div className="menu-grid">
                        {category.items.map((item) => (
                            <div key={item.name} className="menu-item-card" onClick={() => onItemClick(item)}>
                                <div className="card-image-container">
                                    <img 
                                        src={getImagePath(item.name)} 
                                        alt={item.name} 
                                        className="card-image" 
                                        onError={(e) => { e.target.style.display = 'none'; e.target.parentElement.style.backgroundColor = '#374151'; }} 
                                    />
                                </div>
                                <div className="card-text-container">
                                    <h3 className="card-item-name">{item.name}</h3>
                                    <p className="card-item-description">{item.description}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

export default Menu;