"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { deviceId, deviceKind } from "@/lib/db";
import { useSyncStatus } from "@/lib/hooks";
import { requestSync, resetCursor } from "@/lib/sync";

interface Status {
  db: boolean;
  auth: boolean;
  authed: boolean;
  canvas: { configured: boolean; expiresAt: string | null };
}

interface CanvasCheck {
  ok: boolean;
  name?: string;
  error?: string;
}

export default function SettingsView() {
  const sync = useSyncStatus();
  const [status, setStatus] = useState<Status | null>(null);
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [canvas, setCanvas] = useState<CanvasCheck | null>(null);

  const load = () =>
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));

  useEffect(() => {
    void load();
  }, []);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    setMsg(res.ok ? "Signed in on this device." : res.status === 503 ? "PADSYNC_PASSWORD is not set on the server." : "Wrong password.");
    setPassword("");
    await load();
    requestSync(0);
  };

  const checkCanvas = async () => {
    setCanvas(null);
    const r = await fetch("/api/canvas/status", { method: "POST" });
    setCanvas(await r.json());
  };

  const [now] = useState(() => Date.now());
  const daysLeft = status?.canvas.expiresAt ? Math.ceil((new Date(status.canvas.expiresAt).getTime() - now) / 86_400_000) : null;

  return (
    <main className="mx-auto max-w-2xl px-6 py-10 text-sm">
      <Link href="/" className="text-slate-500">‹ Library</Link>
      <h1 className="mb-6 mt-2 text-2xl font-semibold text-slate-900">Settings</h1>

      <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 font-semibold text-slate-800">Sync</h2>
        <Row k="Status" v={sync.status} />
        <Row k="Last synced" v={sync.lastSyncedAt ? new Date(sync.lastSyncedAt).toLocaleTimeString() : "—"} />
        <Row k="Database" v={status ? (status.db ? "connected" : "not configured (DATABASE_URL)") : "unreachable"} />
        <Row k="This device" v={`${deviceKind()} · ${deviceId()}`} />
        <div className="mt-3 flex gap-2">
          <button className="rounded-lg border px-3 py-1.5" onClick={() => requestSync(0)}>Sync now</button>
          <button className="rounded-lg border px-3 py-1.5" onClick={() => resetCursor()}>Re-download everything</button>
        </div>
      </section>

      <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 font-semibold text-slate-800">Sign in</h2>
        {status && !status.auth ? (
          <p className="text-slate-600">Set <code>PADSYNC_PASSWORD</code> in the Vercel project to enable sync.</p>
        ) : status?.authed ? (
          <p className="text-emerald-700">This device is signed in.</p>
        ) : (
          <form onSubmit={login} className="flex gap-2">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="padSync password" className="flex-1 rounded-lg border px-3 py-2" />
            <button className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white">Sign in</button>
          </form>
        )}
        {msg && <p className="mt-2 text-slate-600">{msg}</p>}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 font-semibold text-slate-800">NUS Canvas</h2>
        <Row k="Token" v={status?.canvas.configured ? "configured on server" : "not set (CANVAS_TOKEN)"} />
        <Row k="Expires" v={daysLeft == null ? "—" : daysLeft > 0 ? `in ${daysLeft} days` : "expired: generate a new one"} />
        <button className="mt-3 rounded-lg border px-3 py-1.5 disabled:opacity-40" disabled={!status?.canvas.configured} onClick={checkCanvas}>
          Check token
        </button>
        {canvas && <p className={`mt-2 ${canvas.ok ? "text-emerald-700" : "text-rose-700"}`}>{canvas.ok ? `Connected as ${canvas.name}` : canvas.error}</p>}
        <p className="mt-3 text-xs text-slate-500">
          NUS caps tokens at 30 days. Create a new one at canvas.nus.edu.sg → Account → Settings → Approved Integrations, then update CANVAS_TOKEN and
          CANVAS_TOKEN_EXPIRES in Vercel.
        </p>
      </section>
    </main>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-b border-slate-100 py-1.5 last:border-0">
      <span className="text-slate-500">{k}</span>
      <span className="text-slate-800">{v}</span>
    </div>
  );
}
