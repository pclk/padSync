"use client";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { sectionSource } from "@/lib/export";
import type { Selection } from "@/ink/controller";
import type { SectionEntity } from "@/lib/types";
import { addRenders, cropSelection, gatherSections } from "@/lib/ask-bundle";
import { buildBundle, bundleSignature, DEFAULT_CONTEXT, type Bundle, type ContextOptions } from "@/lib/context";
import { BundlePreview, ContextControls, type TextSelection } from "@/components/ContextControls";
import type { ContextSummary } from "@/lib/chat-types";
export interface ContextHandle { prepare(): Promise<{ files: Bundle["files"]; context: ContextSummary; options: { allowEdits: boolean; allowCode: boolean } }> }
export interface ContextProps { notebookTitle: string; sections: SectionEntity[]; current: SectionEntity | null; selection: Selection | null; sectionEl(id: string): HTMLElement | undefined }
export const ContextPicker = forwardRef<ContextHandle, ContextProps>(function ContextPicker(p, ref) {
  const [scope, setScope] = useState<ContextSummary["scope"]>("section");
  const [options, setOptions] = useState<ContextOptions>(DEFAULT_CONTEXT);
  const [ids, setIds] = useState<string[]>([]);
  const [text, setText] = useState<TextSelection | null>(null);
  const [preview, setPreview] = useState<{ sig: string; bundle: Bundle } | null>(null);
  const [summary, setSummary] = useState("This section · token estimate available in Preview");
  const current = p.current;
  const [source, setSource] = useState("");
  useEffect(() => { let live = true; if (current) void sectionSource(current, false).then((s) => { if (live) setSource(s); }); return () => { live = false; }; }, [current]);
  const [error, setError] = useState("");
  const currentId = current?.id ?? "";
  const { sections, notebookTitle } = p;
  const ctx: ContextOptions = useMemo(() => ({ ...options, scope: scope === "selection" ? "selection" : scope === "notebook" ? "all" : "sections", sectionIds: scope === "section" ? [currentId] : ids }), [options, scope, currentId, ids]);
  useEffect(() => {
    let live = true;
    void gatherSections(sections).then((inputs) => {
      if (!live) return;
      if (scope === "none") { setSummary("0 sections · ~0 tokens"); return; }
      const bundle = buildBundle({ title: notebookTitle, sections: inputs, selection: scope === "selection" ? { sectionId: currentId, text: text?.text } : null }, { ...ctx, renders: false });
      const renders = ctx.renders && scope !== "selection" ? bundle.sectionIds.length : 0;
      setSummary(bundle.error ?? `${bundle.sectionIds.length} sections · ${renders} renders · ~${(bundle.tokens + renders * 1200).toLocaleString()} tokens`);
    }).catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [sections, notebookTitle, scope, ctx, currentId, text]);
  const prepare = async (sending: boolean) => {
    const inputs = await gatherSections(p.sections);
    const lasso = p.selection?.sectionId === p.current?.id ? p.selection : null;
    const key = [scope, text?.text, lasso ? [lasso.box, [...lasso.ids].sort()] : null];
    const sig = bundleSignature(p.notebookTitle, inputs, key, ctx);
    if (sending && preview?.sig === sig) return preview.bundle;
    const el = p.current && p.sectionEl(p.current.id);
    const selection = scope === "selection" && p.current ? { sectionId: p.current.id, text: text?.text, crop: lasso && el ? await cropSelection(p.current, el, lasso.box, 2, { notes: !ctx.notes, images: !ctx.images }) : null } : null;
    const bundle = scope === "none" ? { files: [], sectionIds: [], bytes: 0, tokens: 0, skipped: [] } as Bundle : buildBundle({ title: p.notebookTitle, sections: await addRenders(inputs, p.sections, ctx, p.sectionEl, selection), selection }, ctx);
    setSummary(`${bundle.sectionIds.length} sections · ~${bundle.tokens.toLocaleString()} tokens`);
    if (bundle.error) throw new Error(bundle.error);
    if (sending && preview && preview.sig !== sig) { setPreview({ sig, bundle }); throw new Error("Context changed. Review the refreshed preview, then send again."); }
    if (!sending) setPreview({ sig, bundle });
    return bundle;
  };
  useImperativeHandle(ref, () => ({ async prepare() { const b = await prepare(true); return { files: b.files, context: { scope, sectionIds: b.sectionIds, label: `${b.sectionIds.length} sections · ~${b.tokens} tokens`, bytes: b.bytes, tokens: b.tokens }, options: { allowEdits: ctx.allowEdits, allowCode: ctx.allowCode } }; } }));
  return <details className="text-xs"><summary className="cursor-pointer">Context: {scope} · {summary}</summary>
    <select aria-label="Context scope" value={scope} onChange={(e) => { setScope(e.target.value as ContextSummary["scope"]); setSummary("Preview to update estimate"); }}>{["none", "section", "selection", "sections", "notebook"].map((s) => <option key={s}>{s}</option>)}</select>
    <ContextControls o={ctx} set={(patch) => { setOptions({ ...options, ...patch }); if (patch.scope) setScope(patch.scope === "all" ? "notebook" : patch.scope); }} sections={p.sections} pickedIds={ids} setPickedIds={setIds} currentId={p.current?.id ?? ""} source={source} textSel={text} setTextSel={setText} lassoCount={p.selection?.ids.size ?? 0} summary={summary} />
    <button onClick={() => { void prepare(false).catch((e) => setError(String(e))); }}>Preview bundle</button>{error && <p role="alert">{error}</p>}{preview && <BundlePreview bundle={preview.bundle} onClose={() => setPreview(null)} />}
  </details>;
});
