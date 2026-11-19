import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Toolbar, prompt, gesture and lasso settings live in localStorage, which a new deployment's
// address can leave empty; a per-kind-of-device server copy brings them back.

vi.mock("@/lib/chat-api", () => ({ getPrefs: vi.fn(), putPref: vi.fn(async () => ({})) }));

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("merging the server copy", () => {
  it("restores every setting into a wiped browser", async () => {
    const { mergeBackup } = await import("@/lib/device-settings");
    const store = memory();
    const remote = { "padsync.rail": { v: '{"style":"circle"}', at: 100 }, "padsync.prompts": { v: "[]", at: 90 } };
    expect(mergeBackup(store, remote)).toEqual({ changed: true, newer: false });
    expect(store.getItem("padsync.rail")).toBe('{"style":"circle"}');
    expect(store.getItem("padsync.prompts")).toBe("[]");
  });

  it("lets a default a screen saved by itself lose to the copy", async () => {
    const { mergeBackup, noteSettingWrite } = await import("@/lib/device-settings");
    const store = memory();
    vi.stubGlobal("localStorage", store);
    // The editor mounts first and saves its default into the empty browser.
    store.setItem("padsync.rail", '{"style":"bar"}');
    noteSettingWrite("padsync.rail", null, '{"style":"bar"}', true);
    expect(mergeBackup(store, { "padsync.rail": { v: '{"style":"circle"}', at: 100 } }).changed).toBe(true);
    expect(store.getItem("padsync.rail")).toBe('{"style":"circle"}');
  });

  it("keeps a setting changed here since the copy, and asks to send it", async () => {
    const { mergeBackup, noteSettingWrite } = await import("@/lib/device-settings");
    const store = memory();
    vi.stubGlobal("localStorage", store);
    store.setItem("padsync.prompts", "[1]");
    noteSettingWrite("padsync.prompts", "[0]", "[1]");
    // A setting changed only here and one changed only there both survive.
    const r = mergeBackup(store, { "padsync.prompts": { v: "[0]", at: 1 }, "padsync.lasso": { v: "{}", at: 1 } });
    expect(r).toEqual({ changed: true, newer: true });
    expect(store.getItem("padsync.prompts")).toBe("[1]");
    expect(store.getItem("padsync.lasso")).toBe("{}");
  });

  it("ignores writes that aren't device settings or don't change anything", async () => {
    const { noteSettingWrite, snapshotSettings } = await import("@/lib/device-settings");
    const store = memory();
    vi.stubGlobal("localStorage", store);
    noteSettingWrite("padsync.lastSyncedAt", "1", "2");
    noteSettingWrite("padsync.rail", "{}", "{}");
    expect(store.getItem("padsync.deviceSettingsAt")).toBe(null);
    store.setItem("padsync.rail", "{}");
    expect(snapshotSettings(store)).toEqual({ "padsync.rail": { v: "{}", at: 0 } });
  });
});

describe("starting up", () => {
  it("restores a wiped browser on load and tells the screens", async () => {
    const api = await import("@/lib/chat-api");
    const store = memory();
    vi.stubGlobal("localStorage", store);
    vi.stubGlobal("document", { addEventListener() {}, visibilityState: "visible" });
    vi.mocked(api.getPrefs).mockResolvedValue({ prefs: { "device.ipad": { "padsync.rail": { v: '{"dock":"right"}', at: 5 } } }, updatedAt: {} });
    const { startDeviceSettings, subscribeSettings } = await import("@/lib/device-settings");
    const told = vi.fn();
    subscribeSettings(told);
    await startDeviceSettings("ipad");
    expect(store.getItem("padsync.rail")).toBe('{"dock":"right"}');
    expect(told).toHaveBeenCalled();
  });

  it("keeps the iPad's and the Mac's copies apart, and refuses unknown keys", async () => {
    vi.doMock("server-only", () => ({}));
    const { PREF_SCHEMAS, isPrefKey } = await import("@/server/prefs");
    expect(isPrefKey("device.ipad") && isPrefKey("device.desktop")).toBe(true);
    expect(PREF_SCHEMAS["device.ipad"].safeParse({ "padsync.rail": { v: "{}", at: 1 } }).success).toBe(true);
    expect(PREF_SCHEMAS["device.ipad"].safeParse({ "padsync.secret": { v: "x", at: 1 } }).success).toBe(false);
  });
});
