"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { parsePayload, payloadToSections } from "@/lib/payload";
import { createNotebook } from "@/lib/store";

export default function ImportView() {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const result = useMemo(() => (raw.trim() ? parsePayload(raw) : null), [raw]);

  const onFile = async (f: File | undefined) => {
    if (f) setRaw(await f.text());
  };

  const create = async () => {
    if (!result?.ok) return;
    const p = result.payload;
    const id = await createNotebook(p.title, payloadToSections(p), p.description);
    router.push(`/notebook?id=${id}`);
  };

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/" className="text-sm text-slate-500">‹ Library</Link>
      <h1 className="mb-1 mt-2 text-2xl font-semibold text-slate-900">Import payload</h1>
      <p className="mb-6 text-sm text-slate-600">
        Paste the AI&apos;s reply (code fences and surrounding text are fine) or drop a .json file. Need the format? Use the{" "}
        <Link href="/prompt" className="text-blue-700 underline">AI prompt</Link> page.
      </p>
      <textarea
        className="h-80 w-full rounded-xl border border-slate-300 bg-white p-3 font-mono text-xs outline-none focus:border-blue-500"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void onFile(e.dataTransfer.files[0]);
        }}
        placeholder='{"padsync": 1, "title": "…", "sections": [ … ]}'
      />
      <div className="mt-3 flex items-center gap-3">
        <label className="cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50">
          Choose file
          <input type="file" accept=".json,application/json,text/plain" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
        <button disabled={!result?.ok} onClick={create} className="ml-auto rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-30">
          Create notebook
        </button>
      </div>
      {result && !result.ok && <pre className="mt-4 whitespace-pre-wrap rounded-lg bg-rose-50 p-3 text-xs text-rose-800">{result.error}</pre>}
      {result?.ok && (
        <div className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
          <strong>{result.payload.title}</strong>: {result.payload.sections.length} sections,{" "}
          {result.payload.sections.filter((s) => s.solution).length} with hidden solutions.
        </div>
      )}
    </main>
  );
}
