import "fake-indexeddb/auto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SidePanel } from "@/components/SidePanel";
import { SHOW_COPY_BUTTONS_DEFAULT, SHOW_COPY_BUTTONS_KEY, readBoolSetting, useShowCopyButtons, writeBoolSetting } from "@/lib/settings";
import type { SectionEntity } from "@/lib/types";

// The "Show copy buttons" preference: hidden by default (the Mac bridge replaced copy-paste),
// persisted in localStorage, and honoured by the side panel.

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

const section = {
  id: "s1",
  kind: "section",
  notebookId: "nb",
  parentId: "nb",
  hlc: "0",
  deleted: false,
  data: { title: "Q1", blocks: [], order: 0, createdAt: 0, template: "plain", minHeight: 500 },
} as unknown as SectionEntity;

const panel = () =>
  renderToStaticMarkup(
    createElement(SidePanel, { notebookId: "nb", notebookTitle: "NB", selection: null, sections: [section], current: section, sectionEl: () => undefined, follow: false, setFollow: () => {}, ipad: null, onJump: () => {} }),
  );

describe("copy buttons setting", () => {
  it("defaults to hidden, including for existing users with nothing stored", () => {
    expect(SHOW_COPY_BUTTONS_DEFAULT).toBe(false);
    expect(readBoolSetting(SHOW_COPY_BUTTONS_KEY, SHOW_COPY_BUTTONS_DEFAULT)).toBe(false);
  });

  it("persists as JSON in localStorage, like the other settings", () => {
    writeBoolSetting(SHOW_COPY_BUTTONS_KEY, true);
    expect(store.getItem(SHOW_COPY_BUTTONS_KEY)).toBe("true");
    expect(readBoolSetting(SHOW_COPY_BUTTONS_KEY, false)).toBe(true);
    writeBoolSetting(SHOW_COPY_BUTTONS_KEY, false);
    expect(store.getItem(SHOW_COPY_BUTTONS_KEY)).toBe("false");
    expect(readBoolSetting(SHOW_COPY_BUTTONS_KEY, true)).toBe(false);
  });

  it("falls back to the default for corrupt or non-boolean values", () => {
    for (const raw of ["{not json", "1", '"true"', "null", "[]"]) {
      store.setItem(SHOW_COPY_BUTTONS_KEY, raw);
      expect(readBoolSetting(SHOW_COPY_BUTTONS_KEY, false)).toBe(false);
    }
  });

  it("falls back to the default when storage throws (private mode, blocked site data)", () => {
    const spy = vi.spyOn(store, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readBoolSetting(SHOW_COPY_BUTTONS_KEY, false)).toBe(false);
    spy.mockRestore();
    vi.spyOn(store, "setItem").mockImplementationOnce(() => {
      throw new Error("QuotaExceeded");
    });
    expect(() => writeBoolSetting(SHOW_COPY_BUTTONS_KEY, true)).not.toThrow();
  });

  it("useShowCopyButtons reads the stored value", () => {
    let seen: boolean | null = null;
    const Probe = () => ((seen = useShowCopyButtons()[0]), null);
    renderToStaticMarkup(createElement(Probe));
    expect(seen).toBe(false);
    writeBoolSetting(SHOW_COPY_BUTTONS_KEY, true);
    renderToStaticMarkup(createElement(Probe));
    expect(seen).toBe(true);
  });
});

describe("side panel copy buttons", () => {
  it("are hidden by default, and the rest of the panel still renders", () => {
    const html = panel();
    expect(html).not.toContain("Copy as image");
    expect(html).not.toContain("Copy question text");
    expect(html).not.toContain('data-testid="copy-buttons"');
    expect(html).toContain("Ask AI");
    expect(html).toContain("Move up");
    expect(html).toContain("Outline");
  });

  it("show when the setting is on, before Ask AI", () => {
    writeBoolSetting(SHOW_COPY_BUTTONS_KEY, true);
    const html = panel();
    expect(html).toContain("Copy as image");
    expect(html).toContain("Copy question text");
    expect(html.indexOf("Copy as image")).toBeLessThan(html.indexOf("Ask AI"));
  });

  it("hide again when the setting is turned off", () => {
    writeBoolSetting(SHOW_COPY_BUTTONS_KEY, true);
    expect(panel()).toContain("Copy as image");
    writeBoolSetting(SHOW_COPY_BUTTONS_KEY, false);
    expect(panel()).not.toContain("Copy as image");
  });

  it("leave the Ask AI answer copy and other controls alone", () => {
    const html = panel();
    expect(html).toContain("Ask ⌘↵");
    expect(html.match(/<button/g)!.length).toBeGreaterThanOrEqual(6);
  });
});

describe("Settings page toggle", () => {
  const settings = async () => {
    vi.stubGlobal("window", { location: { search: "" }, addEventListener() {}, removeEventListener() {} });
    const { default: SettingsView } = await import("@/components/SettingsView");
    return renderToStaticMarkup(createElement(SettingsView));
  };
  const toggle = (html: string) => /<label[^>]*>(?:(?!<\/label>)[\s\S])*Show copy buttons(?:(?!<\/label>)[\s\S])*<\/label>/.exec(html)![0];

  it("is unchecked by default and checked once turned on", async () => {
    expect(toggle(await settings())).not.toMatch(/checked=""/);
    writeBoolSetting(SHOW_COPY_BUTTONS_KEY, true);
    expect(toggle(await settings())).toMatch(/checked=""/);
  });
});
