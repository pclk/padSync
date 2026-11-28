// Inside the native iPad app (ios/), notebooks open in the native editor instead of the web one.
// The app injects `window.padsyncNative` and listens on the `padsync` message handler.

interface MessageHandler { postMessage(message: unknown): void }

function handler(): MessageHandler | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as { webkit?: { messageHandlers?: { padsync?: MessageHandler } } }).webkit?.messageHandlers?.padsync;
}

export function inNativeApp() {
  return !!handler();
}

/** Opens the notebook in the native editor. False outside the app, so the caller navigates as usual. */
export function openNotebookNative(id: string): boolean {
  const h = handler();
  if (!h) return false;
  h.postMessage({ type: "openNotebook", id });
  return true;
}

/** The app fires this when a native notebook covers the web screens or uncovers them. */
export const NATIVE_COVER_EVENT = "padsync-native-cover";

/** A native notebook covers the web screens. The page still reports itself visible, but nobody sees it. */
export function nativeCovered() {
  return typeof window !== "undefined" && (window as { padsyncCovered?: boolean }).padsyncCovered === true;
}

/** Visible, and not under a native notebook: the web screens should sync and listen as if in front. */
export function pageShown() {
  return typeof document !== "undefined" && document.visibilityState === "visible" && !nativeCovered();
}
