"use client";

import { createContext, useContext, useEffect, ReactNode } from "react";

type Theme = "dark";

type ThemeContextType = {
    theme: Theme;
    toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
    useEffect(() => {
        // Synapse is dark-only. We keep the provider to avoid refactors elsewhere.
        document.documentElement.setAttribute("data-theme", "dark");
    }, []);

    const toggleTheme = () => {
        // no-op (dark-only)
    };

    return (
        <ThemeContext.Provider value={{ theme: "dark", toggleTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const context = useContext(ThemeContext);
    if (context === undefined) {
        throw new Error("useTheme must be used within a ThemeProvider");
    }
    return context;
}
