import type { SyncStatus } from "./sync";

// What the sync badge shows. Pure so the mapping from the engine's state can be tested without a DOM.

export type SyncView = "starting" | "syncing" | "synced" | "offline" | "retrying" | "failed" | "signed-out" | "local-only";
export type SyncIcon = "refresh" | "check" | "wifiOff" | "clock" | "alert" | "logIn" | "tablet";

export interface SyncSnapshot {
  status: SyncStatus;
  lastSyncedAt: number;
  failures: number;
  retryAt: number;
}

/** Server errors in a row before "retrying" becomes "failed" (it still retries, at most once a minute). */
export const FAILED_AFTER = 3;

export const SYNC_VIEWS: Record<SyncView, { label: string; explain: string; icon: SyncIcon; tone: string }> = {
  starting: { label: "Starting", explain: "Connecting to the sync server.", icon: "refresh", tone: "text-slate-400" },
  syncing: { label: "Syncing", explain: "Sending your changes and fetching changes from your other devices.", icon: "refresh", tone: "text-brand-600" },
  synced: { label: "Synced", explain: "Everything on this device is saved to the server.", icon: "check", tone: "text-emerald-600" },
  offline: { label: "Offline", explain: "No connection. Your changes are saved on this device and sync when you're back online.", icon: "wifiOff", tone: "text-slate-500" },
  retrying: { label: "Retrying", explain: "The server didn't answer properly. Your changes are safe on this device; sync tries again shortly.", icon: "clock", tone: "text-amber-600" },
  failed: { label: "Sync failed", explain: "Sync keeps failing. Your changes are safe on this device. It keeps trying, or you can retry now.", icon: "alert", tone: "text-rose-600" },
  "signed-out": { label: "Signed out", explain: "Sign in on the Settings page to sync. Until then your changes stay on this device.", icon: "logIn", tone: "text-rose-600" },
  "local-only": { label: "Local only", explain: "The sync server isn't set up, so notebooks are kept on this device only.", icon: "tablet", tone: "text-slate-500" },
};

export function syncView({ status, failures }: Pick<SyncSnapshot, "status" | "failures">): SyncView {
  switch (status) {
    case "idle": return "starting";
    case "syncing": return "syncing";
    case "synced": return "synced";
    case "offline": return "offline";
    case "needs-login": return "signed-out";
    case "local-only": return "local-only";
    case "error": return failures >= FAILED_AFTER ? "failed" : "retrying";
  }
}

/** Whole seconds until the next automatic attempt, or null when none is waiting. */
export function retryCountdown(retryAt: number, now: number): number | null {
  return retryAt > now ? Math.ceil((retryAt - now) / 1000) : null;
}

export function formatLastSynced(at: number, now: number): string {
  if (!at) return "Not synced yet on this device";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return "Last synced just now";
  if (s < 60) return `Last synced ${s} s ago`;
  if (s < 3600) return `Last synced ${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `Last synced ${Math.floor(s / 3600)} h ago`;
  return `Last synced ${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

export function describeSync(state: SyncSnapshot, now: number) {
  const view = syncView(state);
  const { label: base, explain, icon, tone } = SYNC_VIEWS[view];
  // Offline and signed-out also back off, but their next try is not what the user is waiting on.
  const countdown = view === "retrying" || view === "failed" ? retryCountdown(state.retryAt, now) : null;
  const label = view === "retrying" ? (countdown ? `Retrying in ${countdown} s` : "Retrying…") : base;
  return {
    view, label, explain, icon, tone, countdown,
    lastSynced: formatLastSynced(state.lastSyncedAt, now),
    canRetry: view === "failed",
  };
}

/**
 * Which state the screen-reader live region should hold after `view`. Starting and syncing are
 * passing states, so writing (synced → syncing → synced on every save) and each retry attempt stay
 * silent; a real change such as synced → offline → synced is read out.
 */
export function announcedView(prev: SyncView | null, view: SyncView): SyncView | null {
  return view === "starting" || view === "syncing" ? prev : view;
}

/** The live region's text: the state only, never the per-second countdown. */
export function syncAnnouncement(view: SyncView) {
  return `Sync status: ${SYNC_VIEWS[view].label}`;
}
