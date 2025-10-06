import React, { useState, createContext, useContext, useEffect } from 'react';

const ThemeContext = createContext();

export function ThemeProvider({ children }) {
    // We'll default to the user's system preference or 'standard'
    const [theme, setTheme] = useState('standard');

    // This effect runs whenever the theme changes
    useEffect(() => {
        // We set a `data-theme` attribute on the body element
        document.body.setAttribute('data-theme', theme);
    }, [theme]);

    const value = { theme, setTheme };

    return (
        <ThemeContext.Provider value={value}>
            {children}
        </ThemeContext.Provider>
    );
}

// Custom hook to easily use the theme context
export function useTheme() {
    return useContext(ThemeContext);
}