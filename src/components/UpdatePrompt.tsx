"use client";

import { useEffect, useRef, useState } from "react";

// A deploy installs a new service worker (public/sw.js) that waits while any padSync tab is open,
// so open notebooks keep the build they started with. This bar offers to switch now: the waiting
// worker takes over and the page reloads on the new build.

const CHECK_MS = 10 * 60_000;

export function UpdatePrompt() {
  const [ready, setReady] = useState<{ worker: ServiceWorker | null } | null>(null);
  const requested = useRef(false);
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;
    const sw = navigator.serviceWorker;
    let reg: ServiceWorkerRegistration | undefined;
    // Only an update counts: the very first install has no controller to replace.
    const offer = (worker: ServiceWorker | null) => {
      if (sw.controller) setReady({ worker });
    };
    void sw.ready.then((r) => {
      reg = r;
      if (r.waiting) offer(r.waiting);
      r.addEventListener("updatefound", () => {
        const w = r.installing;
        w?.addEventListener("statechange", () => {
          if (w.state === "installed") offer(w);
        });
      });
    });
    // Another tab switched: this one's build is retired too, so offer the reload here as well.
    const onController = () => {
      if (requested.current) location.reload();
      else setReady({ worker: null });
    };
    sw.addEventListener("controllerchange", onController);
    // The app navigates without page loads, so ask for new deploys when it comes back and now and then.
    const check = () => {
      if (document.visibilityState === "visible") reg?.update().catch(() => {});
    };
    document.addEventListener("visibilitychange", check);
    const timer = setInterval(check, CHECK_MS);
    return () => {
      sw.removeEventListener("controllerchange", onController);
      document.removeEventListener("visibilitychange", check);
      clearInterval(timer);
    };
  }, []);
  if (!ready) return null;
  const reload = () => {
    requested.current = true;
    if (ready.worker) ready.worker.postMessage({ type: "SKIP_WAITING" });
    else location.reload();
  };
  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 flex justify-center px-4 pointer-events-none"
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-slate-200 bg-white py-2 pl-4 pr-2 text-sm text-slate-700 shadow-lift">
        A new version of padSync is ready.
        <button className="btn btn-primary btn-sm" onClick={reload}>
          Reload
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setReady(null)}>
          Later
        </button>
      </div>
    </div>
  );
}
