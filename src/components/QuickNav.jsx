import React from 'react';
import { menuData } from '../data/menuData';
import { formatId } from '../utils/helpers';

function QuickNav({ menuData, activeCategory }) {
    return (
        <div className="quick-nav-container">
            <ul className="quick-nav-list">
                {menuData.categories.map(category => {
                    const categoryId = formatId(category.name);
                    const isActive = activeCategory === categoryId;
                    return (
                        <li key={category.name} className="quick-nav-item">
                            <a href={`#${categoryId}`} className={isActive ? 'active-nav-link' : ''}>
                                {category.name}
                            </a>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

export default QuickNav;