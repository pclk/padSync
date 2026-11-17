import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readThemePreference, useThemePreference, writeThemePreference } from "@/lib/settings";
import { THEME_DEFAULT, THEME_KEY, applyTheme, resolveTheme, themeScript } from "@/lib/theme";

// Dark mode: the Light / Dark / System preference, the inline script that applies it before
// paint, and the CSS contract that keeps the page paper light.

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}
const store = new MemoryStorage();

beforeAll(() => vi.stubGlobal("localStorage", store));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => store.clear());

/** Runs the inline <head> script against a fake document and matchMedia; returns data-theme. */
function runScript(systemDark: boolean | "throws", storage: unknown = store) {
  const attrs = new Map<string, string>();
  const documentElement = { setAttribute: (k: string, v: string) => attrs.set(k, v) };
  const matchMedia = () => {
    if (systemDark === "throws") throw new Error("no matchMedia");
    return { matches: systemDark };
  };
  new Function("window", "document", "localStorage", themeScript)({ matchMedia }, { documentElement }, storage);
  return attrs.get("data-theme");
}

describe("theme preference setting", () => {
  it("defaults to System", () => {
    expect(THEME_DEFAULT).toBe("system");
    expect(readThemePreference()).toBe("system");
  });

  it("persists as JSON in localStorage, like the other settings", () => {
    writeThemePreference("dark");
    expect(store.getItem(THEME_KEY)).toBe('"dark"');
    expect(readThemePreference()).toBe("dark");
    writeThemePreference("light");
    expect(readThemePreference()).toBe("light");
  });

  it("falls back to System for corrupt or unknown values", () => {
    for (const raw of ["{not json", "dark", '"sepia"', "true", "null"]) {
      store.setItem(THEME_KEY, raw);
      expect(readThemePreference()).toBe("system");
    }
  });

  it("useThemePreference reads the stored value", () => {
    let seen: string | null = null;
    const Probe = () => ((seen = useThemePreference()[0]), null);
    renderToStaticMarkup(createElement(Probe));
    expect(seen).toBe("system");
    writeThemePreference("dark");
    renderToStaticMarkup(createElement(Probe));
    expect(seen).toBe("dark");
  });

  it("resolves System from the device appearance and keeps an explicit choice", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("applyTheme sets data-theme and the theme-color metas", () => {
    const attrs = new Map<string, string>();
    const metas = [new Map<string, string>(), new Map<string, string>()];
    const doc = {
      documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v) },
      querySelectorAll: () => metas.map((m) => ({ setAttribute: (k: string, v: string) => m.set(k, v) })),
    } as unknown as Document;
    applyTheme("dark", doc);
    expect(attrs.get("data-theme")).toBe("dark");
    expect(metas.every((m) => m.get("content") === "#161b23")).toBe(true);
  });
});

describe("inline theme script", () => {
  it("follows the system when nothing is stored or System is chosen", () => {
    expect(runScript(true)).toBe("dark");
    expect(runScript(false)).toBe("light");
    writeThemePreference("system");
    expect(runScript(true)).toBe("dark");
  });

  it("uses an explicit choice regardless of the system", () => {
    writeThemePreference("light");
    expect(runScript(true)).toBe("light");
    writeThemePreference("dark");
    expect(runScript(false)).toBe("dark");
  });

  it("agrees with resolveTheme for corrupt values, and never throws", () => {
    store.setItem(THEME_KEY, '"sepia"');
    expect(runScript(true)).toBe("dark");
    store.setItem(THEME_KEY, "{bad");
    expect(runScript(false)).toBe("light");
    expect(runScript("throws")).toBe("light");
    const blocked = { getItem: () => { throw new Error("SecurityError"); } };
    expect(runScript(true, blocked)).toBe("dark");
  });

  it("is rendered in <head> by the root layout", () => {
    const layout = readFileSync("src/app/layout.tsx", "utf8");
    expect(layout).toMatch(/<head>\s*<script dangerouslySetInnerHTML=\{\{ __html: themeScript \}\} \/>/);
    expect(layout).toContain("suppressHydrationWarning");
    expect(layout).toContain("<ThemeSync />");
  });
});

describe("dark tokens", () => {
  const css = readFileSync("src/app/globals.css", "utf8");
  const block = (selector: string) => {
    const i = css.indexOf(`${selector} {`);
    expect(i).toBeGreaterThanOrEqual(0);
    return css.slice(i, css.indexOf("}", i));
  };
  const vars = (b: string) => new Set([...b.matchAll(/(--[\w-]+):/g)].map((m) => m[1]));

  it("restore every remapped palette colour inside the page paper", () => {
    const dark = vars(block(':root[data-theme="dark"]'));
    const paper = vars(block(':root[data-theme="dark"] .paper'));
    const palette = [...dark].filter((v) => v.startsWith("--color-") && v !== "--color-canvas" && v !== "--color-backdrop");
    expect(palette.length).toBeGreaterThan(30);
    expect(palette.filter((v) => !paper.has(v))).toEqual([]);
    expect(block(':root[data-theme="dark"] .paper')).toContain("color-scheme: light");
  });

  it("are used by the shared components instead of fixed light colours", () => {
    const components = css.slice(css.indexOf("@layer components"));
    for (const cls of [".card", ".btn-secondary", ".field", ".segmented", ".dropzone"]) {
      expect(block(`  ${cls}`)).toMatch(/var\(--(surface|border|text|accent)/);
    }
    // Only the switch knob stays literally white.
    expect(components.match(/background: white;/g)).toHaveLength(1);
  });
});

describe("Settings page theme choice", () => {
  const settings = async () => {
    vi.stubGlobal("window", { location: { search: "" }, addEventListener() {}, removeEventListener() {} });
    const { default: SettingsView } = await import("@/components/SettingsView");
    return renderToStaticMarkup(createElement(SettingsView));
  };
  const pressed = (html: string) => [...html.matchAll(/<button[^>]*aria-pressed="true"[^>]*>(System|Light|Dark)<\/button>/g)].map((m) => m[1]);

  it("offers System, Light and Dark with the stored choice pressed", async () => {
    const html = await settings();
    expect(html).toContain('aria-label="Theme"');
    for (const label of ["System", "Light", "Dark"]) expect(html).toContain(`>${label}</button>`);
    expect(pressed(html)).toEqual(["System"]);
    writeThemePreference("dark");
    expect(pressed(await settings())).toEqual(["Dark"]);
  });
});
