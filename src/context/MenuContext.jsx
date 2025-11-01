// src/context/MenuContext.jsx
import React, { createContext, useContext } from 'react';
import { useMenu } from '../hooks/useMenu.js';

const MenuContext = createContext({ menu: null, loading: true, error: null });

export function MenuProvider({ children }) {
  const value = useMenu();
  return <MenuContext.Provider value={value}>{children}</MenuContext.Provider>;
}

export function useMenuContext() {
  return useContext(MenuContext);
}
