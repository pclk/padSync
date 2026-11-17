"use client";

import Link from "next/link";
import { useSyncStatus } from "@/lib/hooks";

const LABEL: Record<string, [string, string]> = {
  idle: ["Starting", "bg-slate-300"],
  syncing: ["Syncing", "bg-amber-400"],
  synced: ["Synced", "bg-emerald-500"],
  offline: ["Offline · saved on device", "bg-slate-400"],
  "local-only": ["Local only · server not set up", "bg-slate-400"],
  "needs-login": ["Sign in to sync", "bg-rose-500"],
  error: ["Sync error · retrying", "bg-rose-500"],
};

export function SyncBadge() {
  const { status } = useSyncStatus();
  const [label, dot] = LABEL[status];
  return (
    <Link href="/settings" className="flex items-center gap-2 rounded-full px-2 py-1 text-xs text-slate-500 hover:bg-slate-100" title={label} aria-label={`Sync status: ${label}. Open settings`}>
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${dot}`} />
      <span className="hidden lg:inline">{label}</span>
    </Link>
  );
}
