import React from 'react';
import { useTheme } from '../context/ThemeContext';

function ThemeSwitcher() {
    const { theme, setTheme } = useTheme();

    // src/components/ThemeSwitcher.jsx

// ... imports and function definition

    const buttonStyle = {
        width: '2rem',
        height: '2rem',
        borderRadius: '50%',
        cursor: 'pointer',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        fontSize: '1.2rem',
        backgroundColor: 'var(--background-light)',
        // --- UPDATED PART ---
        borderWidth: '2px',
        borderStyle: 'solid',
        borderColor: 'var(--border-color)',
    };
    
    const activeStyle = {
        ...buttonStyle,
        borderColor: 'var(--brand-neon-green)',
    };

// ... rest of the component

    return (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button 
                style={theme === 'standard' ? activeStyle : buttonStyle} 
                onClick={() => setTheme('standard')} 
                title="Standard Theme"
            >
                🎨
            </button>
            <button 
                style={theme === 'light' ? activeStyle : buttonStyle} 
                onClick={() => setTheme('light')} 
                title="Light Theme"
            >
                ☀️
            </button>
            <button 
                style={theme === 'dark' ? activeStyle : buttonStyle} 
                onClick={() => setTheme('dark')} 
                title="Dark Theme"
            >
                🌙
            </button>
        </div>
    );
}

export default ThemeSwitcher;