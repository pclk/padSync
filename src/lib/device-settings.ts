"use client";

import { getPrefs, putPref } from "./chat-api";
import { DEVICE_SETTING_KEYS, type DeviceSettingKey } from "./device-setting-keys";
import type { DeviceKind } from "./types";

export { DEVICE_SETTING_KEYS };

// This device's settings (toolbar, prompts, gestures, lasso, pen…) live in localStorage, which a
// new deployment's address or Safari's storage clean-up can leave empty. A copy is kept on the
// server, one per kind of device so the iPad and the Mac still keep their own, and comes back
// whenever this browser's copy is missing or older.

const IS_DEVICE_KEY = new Set<string>(DEVICE_SETTING_KEYS);

/** When each setting was last changed on purpose here (ms), to compare with the server copy's. */
const CHANGED_AT_KEY = "padsync.deviceSettingsAt";

type DeviceKey = DeviceSettingKey;
/** Each setting's stored JSON, exactly as in localStorage, and when it was last changed. */
export type DeviceSettingsBackup = Partial<Record<DeviceKey, { v: string; at: number }>>;
export const prefKeyFor = (kind: DeviceKind) => `device.${kind}` as const;

// --- notifying readers ---------------------------------------------------------------------
// useSetting and useStoredState re-read when told, so restored settings show without a reload.

const listeners = new Set<() => void>();
export function subscribeSettings(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
export const notifySettings = () => listeners.forEach((fn) => fn());

// --- recording changes ----------------------------------------------------------------------

const local = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

type Stamps = Partial<Record<DeviceKey, number>>;
const readStamps = (store: Pick<Storage, "getItem">): Stamps => {
  try {
    const v = JSON.parse(store.getItem(CHANGED_AT_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

let kind: DeviceKind | null = null;
/** The server copy has been compared with this browser's: only then may it be overwritten. */
let compared = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Called after a setting is written. A deliberate change to a device setting is stamped and
 * backed up shortly after. `automatic` writes (a screen saving its default into empty storage)
 * are not stamped: an unstamped value never wins over the server copy, so a wiped browser's
 * defaults can't replace the settings it lost.
 */
export function noteSettingWrite(key: string, before: string | null, after: string | null, automatic = false) {
  if (!IS_DEVICE_KEY.has(key) || before === after || (automatic && before === null)) return;
  const store = local();
  if (!store) return;
  try {
    store.setItem(CHANGED_AT_KEY, JSON.stringify({ ...readStamps(store), [key]: Date.now() }));
  } catch {}
  scheduleBackup();
}

function scheduleBackup(ms = 1500) {
  if (!kind || !compared) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void backup(), ms);
}

/** What this browser would back up: every device setting it has, with its change time (0: never changed here). */
export function snapshotSettings(store: Pick<Storage, "getItem">): DeviceSettingsBackup {
  const stamps = readStamps(store);
  const out: DeviceSettingsBackup = {};
  for (const k of DEVICE_SETTING_KEYS) {
    const v = store.getItem(k);
    if (v !== null) out[k] = { v, at: stamps[k] ?? 0 };
  }
  return out;
}

/**
 * Merges the server copy into `store`, setting by setting: the server's value wins where it was
 * changed later than this browser's (or this browser has none). Returns whether anything here
 * changed, and whether this browser has something newer to send back. Pure apart from `store`.
 */
export function mergeBackup(store: Pick<Storage, "getItem" | "setItem">, remote: DeviceSettingsBackup | null | undefined) {
  const stamps = readStamps(store);
  let changed = false;
  let newer = false;
  for (const k of DEVICE_SETTING_KEYS) {
    const r = remote?.[k];
    const here = store.getItem(k);
    const at = stamps[k] ?? 0;
    if (r && typeof r.v === "string" && (here === null || r.at > at)) {
      if (here !== r.v) {
        store.setItem(k, r.v);
        changed = true;
      }
      stamps[k] = r.at;
    } else if (here !== null && (!r || (at > r.at && here !== r.v))) newer = true;
  }
  try {
    store.setItem(CHANGED_AT_KEY, JSON.stringify(stamps));
  } catch {}
  return { changed, newer };
}

async function backup() {
  timer = null;
  const store = local();
  if (!store || !kind) return;
  await putPref(prefKeyFor(kind), snapshotSettings(store)).catch(() => {});
}

/**
 * Once per page load: fetch this kind of device's copy, take what is newer there, and send back
 * what is newer here. Signed out or offline, settings simply stay in this browser.
 */
export async function startDeviceSettings(deviceKind: DeviceKind) {
  if (kind) return;
  kind = deviceKind;
  const store = local();
  if (!store) return;
  let remote: DeviceSettingsBackup | undefined;
  try {
    remote = (await getPrefs()).prefs[prefKeyFor(deviceKind)] as DeviceSettingsBackup | undefined;
  } catch {
    return;
  }
  compared = true;
  const { changed, newer } = mergeBackup(store, remote);
  if (changed) notifySettings();
  if (newer) scheduleBackup(0);
  // Leaving soon after a change: send it now rather than lose it with the page.
  document.addEventListener("visibilitychange", () => {
    if (timer && document.visibilityState === "hidden") {
      clearTimeout(timer);
      void backup();
    }
  });
}
