// Colour theme for the app chrome. The preference lives in localStorage (see settings.ts); the
// resolved theme is set as `data-theme="light" | "dark"` on <html>, first by an inline script in
// the root layout (before paint, so no flash) and then by ThemeSync when the choice or the system
// appearance changes. The page paper stays light in both themes (globals.css).

export const THEME_KEY = "padsync.theme";
export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type Theme = "light" | "dark";
export const THEME_DEFAULT: ThemePreference = "system";
export const DARK_QUERY = "(prefers-color-scheme: dark)";
/** Browser/status bar colour per theme; matches the white (light) or dark surface of the top bars. */
export const THEME_COLORS: Record<Theme, string> = { light: "#ffffff", dark: "#161b23" };

export const isThemePreference = (v: unknown): v is ThemePreference => (THEME_PREFERENCES as readonly unknown[]).includes(v);

export const resolveTheme = (pref: ThemePreference, systemDark: boolean): Theme => (pref === "system" ? (systemDark ? "dark" : "light") : pref);

export function applyTheme(theme: Theme, doc: Document = document) {
  doc.documentElement.setAttribute("data-theme", theme);
  doc.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", THEME_COLORS[theme]));
}

/** Runs synchronously in <head>: same rules as resolveTheme, with storage or matchMedia failures falling back to light/system. */
export const themeScript = `(function(){var p=null;try{p=JSON.parse(localStorage.getItem(${JSON.stringify(THEME_KEY)}))}catch(e){}var t=p==="light"||p==="dark"?p:"light";if(t!==p)try{if(window.matchMedia(${JSON.stringify(DARK_QUERY)}).matches)t="dark"}catch(e){}document.documentElement.setAttribute("data-theme",t)})()`;
