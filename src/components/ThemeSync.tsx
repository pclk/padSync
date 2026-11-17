"use client";

import { useEffect } from "react";
import { useThemePreference } from "@/lib/settings";
import { DARK_QUERY, applyTheme, resolveTheme } from "@/lib/theme";

/** Keeps <html data-theme> in line with the Appearance setting and, on System, the OS appearance. */
export function ThemeSync() {
  const [pref] = useThemePreference();
  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY);
    const apply = () => applyTheme(resolveTheme(pref, mq.matches));
    apply();
    if (pref !== "system") return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [pref]);
  return null;
}
