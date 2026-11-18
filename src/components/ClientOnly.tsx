"use client";

import dynamic from "next/dynamic";
import { Suspense, useEffect } from "react";
import { startSync } from "@/lib/sync";

// Every screen reads IndexedDB, so screens render only in the browser. The server sends a
// static shell, which the service worker caches for offline use.

const views = {
  library: dynamic(() => import("./Library"), { ssr: false }),
  notebook: dynamic(() => import("./NotebookEditor"), { ssr: false }),
  import: dynamic(() => import("./AiImportView"), { ssr: false }),
  settings: dynamic(() => import("./SettingsView"), { ssr: false }),
  "pencil-lab": dynamic(() => import("./PencilLab"), { ssr: false }),
  "pencil-test": dynamic(() => import("./PencilTestView"), { ssr: false }),
};
// Browser-only too: it reads its settings from localStorage, so server HTML would never match.
const SyncDebugOverlay = dynamic(() => import("./SyncDebugOverlay").then((m) => m.SyncDebugOverlay), { ssr: false });

export function ClientOnly({ view }: { view: keyof typeof views }) {
  useEffect(() => {
    startSync();
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    navigator.storage?.persist?.().catch(() => {});
  }, []);
  const View = views[view];
  return (
    <Suspense fallback={null}>
      <View />
      <SyncDebugOverlay />
    </Suspense>
  );
}
