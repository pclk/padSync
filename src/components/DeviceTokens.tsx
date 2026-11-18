"use client";

import { useCallback, useEffect, useState } from "react";

// Device tokens for the Mac bridge. The plaintext token is shown exactly once, right after
// creation; the server only keeps its hash.

interface DeviceToken {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastSeenInfo: { hostname?: string; version?: string } | null;
  revokedAt: string | null;
}

async function fetchTokens() {
  const res = await fetch("/api/tokens").catch(() => null);
  return res?.ok ? ((await res.json()) as { tokens: DeviceToken[] }).tokens : null;
}

export function DeviceTokens() {
  const [tokens, setTokens] = useState<DeviceToken[] | null>(null);
  const [name, setName] = useState("MacBook bridge");
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"cmd" | "token" | null>(null);

  const load = useCallback(() => fetchTokens().then((t) => t && setTokens(t)), []);

  useEffect(() => {
    fetchTokens().then((t) => t && setTokens(t));
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(data.error ?? `Failed (${res.status})`);
    setFresh(data.token);
    setCopied(null);
    await load();
  };

  const revoke = async (t: DeviceToken) => {
    if (!confirm(`Revoke “${t.name}”? The bridge using it stops working immediately.`)) return;
    await fetch(`/api/tokens/${t.id}`, { method: "DELETE" });
    await load();
  };

  const copy = async (what: "cmd" | "token", text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(what);
  };

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const commands = `pbpaste | node bridge/padsync-bridge.ts setup --server ${origin}\nnode bridge/padsync-bridge.ts install`;
  const active = tokens?.filter((t) => !t.revokedAt) ?? [];
  const revoked = tokens?.filter((t) => t.revokedAt) ?? [];

  return (
    <section className="card mb-5 p-5">
      <h2 className="mb-1 text-base font-semibold text-slate-900">Mac bridge tokens</h2>
      <p className="mb-3 text-xs text-slate-500">
        For the Mac bridge that runs Claude Code / Codex. A token can only pick up and answer AI jobs: it cannot read your notebooks or create more tokens.
      </p>

      {fresh && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="mb-2 font-medium text-amber-900">This token is shown only once. Set up the bridge on your Mac now:</p>
          <ol className="list-decimal space-y-2 pl-5 text-xs text-amber-900">
            <li>
              In Terminal, in the padSync repo, paste these commands. <strong>Don&apos;t run them yet.</strong>
              <div className="mt-1 flex gap-2">
                <pre className="flex-1 overflow-x-auto rounded bg-slate-900 p-2 text-xs text-slate-100">{commands}</pre>
                <button className={`copy-btn self-start rounded-lg bg-slate-900 px-3 py-1.5 text-white ${copied === "cmd" ? "copied" : ""}`} onClick={() => copy("cmd", commands)}>
                  {copied === "cmd" ? "✓ Copied" : "Copy"}
                </button>
              </div>
            </li>
            <li>
              Copy the device token:
              <div className="mt-1 flex gap-2">
                <code className="flex-1 select-all break-all rounded bg-white px-2 py-1.5 text-xs text-slate-800">{fresh}</code>
                <button className={`copy-btn self-start rounded-lg bg-slate-900 px-3 py-1.5 text-white ${copied === "token" ? "copied" : ""}`} onClick={() => copy("token", fresh)}>
                  {copied === "token" ? "✓ Copied" : "Copy"}
                </button>
              </div>
            </li>
            <li>Go back to Terminal and press Return. Setup reads the token from the clipboard, then the bridge starts in the background and at every login.</li>
          </ol>
          <button className="mt-2 text-xs text-amber-900 underline" onClick={() => setFresh(null)}>
            I&apos;ve saved it
          </button>
        </div>
      )}

      <form onSubmit={create} className="mb-3 flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="field flex-1" placeholder="Token name" />
        <button className="btn btn-primary">Create token</button>
      </form>
      {error && <p className="mb-2 text-rose-700">{error}</p>}

      {tokens === null ? null : active.length === 0 ? (
        <p className="text-slate-500">No active tokens.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {active.map((t) => (
            <li key={t.id} className="flex items-center gap-3 py-2">
              <div className="flex-1">
                <div className="font-medium text-slate-800">
                  {t.name} <code className="text-xs text-slate-400">psd_{t.hint}…</code>
                </div>
                <div className="text-xs text-slate-500">
                  created {new Date(t.createdAt).toLocaleDateString()} ·{" "}
                  {t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleString()}` : "never used"}
                  {t.lastSeenInfo?.hostname ? ` · ${t.lastSeenInfo.hostname}` : ""}
                </div>
              </div>
              <button className="btn btn-danger btn-sm" onClick={() => revoke(t)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {revoked.length > 0 && <p className="mt-2 text-xs text-slate-400">{revoked.length} revoked token(s) kept for the record.</p>}
    </section>
  );
}
