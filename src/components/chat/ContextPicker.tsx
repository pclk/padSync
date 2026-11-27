"use client";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import { sectionSource } from "@/lib/export";
import type { Selection } from "@/ink/controller";
import type { PresenceEntity, SectionEntity } from "@/lib/types";
import { addRenders, cropSelection, gatherSections } from "@/lib/ask-bundle";
import {
  buildBundle,
  bundleSignature,
  DEFAULT_CONTEXT,
  type Bundle,
  type ContextOptions,
} from "@/lib/context";
import {
  BundlePreview,
  ContextControls,
  type TextSelection,
} from "@/components/ContextControls";
import type { ContextSummary } from "@/lib/chat-types";
import { focusedSection } from "@/lib/chat-ui";
import { useStoredState } from "@/lib/hooks";
import {
  isSectionSpan,
  readView,
  SECTION_SPAN_KEY,
  SECTION_SPANS,
  spanSectionIds,
  viewFor,
  viewFromRects,
  type SectionSpan,
} from "@/lib/section-span";
import { Icon, type IconName } from "../Icons";
import { usePopover } from "./Popover";
export interface ContextHandle {
  chooseScope(scope: ContextSummary["scope"]): void;
  /** `scope`: send this instead of what the picker is set to (a prompt menu prompt's own context). */
  prepare(scope?: ContextSummary["scope"]): Promise<{
    files: Bundle["files"];
    context: ContextSummary;
    options: { allowEdits: boolean };
  }>;
}
export interface ContextProps {
  notebookId: string;
  notebookTitle: string;
  sections: SectionEntity[];
  current: SectionEntity | null;
  selection: Selection | null;
  sectionEl(id: string): HTMLElement | undefined;
  /** Where the iPad is: "This section" follows it while it is in this notebook. */
  ipad: PresenceEntity | null;
}
type Scope = ContextSummary["scope"];
const title = (s: SectionEntity | null, sections: SectionEntity[]) =>
  s ? (s.data.title ?? `Section ${sections.indexOf(s) + 1}`) : "No section";

export const ContextPicker = forwardRef<ContextHandle, ContextProps>(
  function ContextPicker(p, ref) {
    const { open, setOpen, ref: box } = usePopover();
    const [scope, setScope] = useState<Scope>("section");
    const [options, setOptions] = useState<ContextOptions>(DEFAULT_CONTEXT);
    const [ids, setIds] = useState<string[]>([]);
    // Highlighted text, with the section it came from: it counts only while that section is the
    // current one, so text picked in one section is never sent as another's.
    const [textAt, setTextAt] = useState<{ sectionId: string; sel: TextSelection } | null>(null);
    const [preview, setPreview] = useState<{
      sig: string;
      bundle: Bundle;
    } | null>(null);
    const [summary, setSummary] = useState("");
    const current = p.current;
    const focused = focusedSection(
      p.sections,
      current,
      p.ipad ? { notebookId: p.ipad.notebookId, sectionId: p.ipad.data.sectionId } : null,
      p.notebookId,
    );
    const focusedId = focused.section?.id ?? "";
    const [storedSpan, setSpan] = useStoredState<SectionSpan>(SECTION_SPAN_KEY, "section");
    const span = isSectionSpan(storedSpan) ? storedSpan : "section";
    // What the followed screen shows: the iPad's when following it, else this one's.
    const screen = () =>
      focused.fromIpad
        ? readView(p.ipad?.data.view)
        : viewFromRects(
            p.sections.flatMap((s) => {
              const el = p.sectionEl(s.id);
              return el ? [{ id: s.id, rect: el.getBoundingClientRect() }] : [];
            }),
            { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth },
          );
    const [source, setSource] = useState("");
    useEffect(() => {
      let live = true;
      if (current)
        void sectionSource(current, false).then((s) => {
          if (live) setSource(s);
        });
      return () => {
        live = false;
      };
    }, [current]);
    const [error, setError] = useState("");
    const currentId = current?.id ?? "";
    const text = textAt && textAt.sectionId === currentId ? textAt.sel : null;
    const { sections, notebookTitle } = p;
    const ctxFor = (sc: Scope): ContextOptions => {
      const view = sc === "section" && span === "viewport" ? screen() : null;
      const sectionIds = sc === "section" ? spanSectionIds(p.sections, focusedId, span, view) : ids;
      return {
        ...options,
        scope: sc === "selection" ? "selection" : sc === "notebook" ? "all" : "sections",
        sectionIds,
        view: sc === "section" ? viewFor(span, view, sectionIds) : null,
      };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const ctx: ContextOptions = useMemo(() => ctxFor(scope), [options, scope, focusedId, ids, span, p.ipad, p.sections]);
    useEffect(() => {
      let live = true;
      // Nothing from the notebook needs none of its strokes read.
      void (scope === "none" ? Promise.resolve([]) : gatherSections(sections))
        .then((inputs) => {
          if (!live) return;
          if (scope === "none") {
            setSummary("Nothing from the notebook");
            return;
          }
          const bundle = buildBundle(
            {
              title: notebookTitle,
              sections: inputs,
              selection:
                scope === "selection"
                  ? { sectionId: currentId, text: text?.text }
                  : null,
            },
            { ...ctx, renders: false },
          );
          const renders =
            ctx.renders && scope !== "selection" ? bundle.sectionIds.length : 0;
          setSummary(
            bundle.error ??
              `${bundle.sectionIds.length} section${bundle.sectionIds.length === 1 ? "" : "s"} · ${renders} render${renders === 1 ? "" : "s"} · ~${(bundle.tokens + renders * 1200).toLocaleString()} tokens`,
          );
        })
        .catch((e) => {
          if (live) setError(String(e));
        });
      return () => {
        live = false;
      };
    }, [sections, notebookTitle, scope, ctx, currentId, text]);
    const scopeNow = scope;
    const previewNow = preview;
    // `override`: a prompt's own scope, sent as is, without the review a changed preview asks for.
    const prepare = async (sending: boolean, override?: Scope) => {
      const scope = override ?? scopeNow;
      // Built afresh: what's on the screen moves after the picker last looked.
      const ctx = ctxFor(scope);
      const preview = override ? null : previewNow;
      if (scope === "none") return { files: [], sectionIds: [], bytes: 0, tokens: 0, skipped: [] } as Bundle;
      const inputs = await gatherSections(p.sections);
      // The lasso's own section, which needn't be the one the screen is centred on (the lasso
      // circle's Ask AI can be used on a selection lower down).
      const lassoed = p.selection ? (p.sections.find((s) => s.id === p.selection!.sectionId) ?? null) : null;
      const target = scope === "selection" && lassoed ? lassoed : p.current;
      const lasso = p.selection && lassoed && p.selection.sectionId === target?.id ? p.selection : null;
      const key = [
        scope,
        text?.text,
        lasso ? [lasso.box, [...lasso.ids].sort()] : null,
      ];
      const sig = bundleSignature(p.notebookTitle, inputs, key, ctx);
      if (sending && preview?.sig === sig) return preview.bundle;
      const el = target && p.sectionEl(target.id);
      const selection =
        scope === "selection" && target
          ? {
              sectionId: target.id,
              // Highlighted text belongs to the screen's section; with another section's lasso, leave it out.
              text: target.id === p.current?.id ? text?.text : undefined,
              crop:
                lasso && el
                  ? await cropSelection(target, el, lasso.box, 2, {
                      notes: !ctx.notes,
                      images: !ctx.images,
                    })
                  : null,
            }
          : null;
      const bundle = buildBundle(
              {
                title: p.notebookTitle,
                sections: await addRenders(
                  inputs,
                  p.sections,
                  ctx,
                  p.sectionEl,
                  selection,
                ),
                selection,
              },
              ctx,
            );
      if (bundle.error) throw new Error(bundle.error);
      if (sending && preview && preview.sig !== sig) {
        setPreview({ sig, bundle });
        setOpen(true);
        throw new Error(
          "Context changed. Review the refreshed preview, then send again.",
        );
      }
      if (!sending) setPreview({ sig, bundle });
      return bundle;
    };
    const choose = (next: Scope) => {
      setScope(next);
      setPreview(null);
      if (next === "sections" && !ids.length && focusedId) setIds([focusedId]);
    };
    useImperativeHandle(ref, () => ({
      chooseScope: choose,
      async prepare(override) {
        const b = await prepare(true, override);
        const scope = override ?? scopeNow;
        return {
          files: b.files,
          context: {
            scope,
            sectionIds: b.sectionIds,
            label:
              scope === "none"
                ? "No context"
                : scope === "section" && b.sectionIds.length === 1
                  ? `${title(p.sections.find((s) => s.id === b.sectionIds[0]) ?? focused.section, p.sections)} · ~${b.tokens.toLocaleString()} tokens`
                  : `${b.sectionIds.length} section${b.sectionIds.length === 1 ? "" : "s"} · ~${b.tokens.toLocaleString()} tokens`,
            bytes: b.bytes,
            tokens: b.tokens,
          },
          options: { allowEdits: ctx.allowEdits },
        };
      },
    }));
    const spanNote =
      span === "viewport" ? (focused.fromIpad ? "iPad screen" : "Screen") : span === "above" ? "+ above" : span === "below" ? "+ below" : "";
    const SCOPES: { v: Scope; icon: IconName; label: string; hint: string }[] = [
      {
        v: "section",
        icon: focused.fromIpad ? "tablet" : "file",
        label: focused.fromIpad ? "Section on the iPad" : "This section",
        hint: `${title(focused.section, p.sections)}${span === "section" ? "" : `, ${spanNote}`}`,
      },
      { v: "selection", icon: "lasso", label: "Selection", hint: "Highlighted text or lassoed ink" },
      { v: "sections", icon: "layers", label: "Pick sections", hint: ids.length ? `${ids.length} chosen` : "Choose which ones" },
      { v: "notebook", icon: "notebook", label: "Whole notebook", hint: `${p.sections.length} sections` },
      { v: "none", icon: "x", label: "No context", hint: "Just chat" },
    ];
    const active = SCOPES.find((s) => s.v === scope)!;
    const chip =
      scope === "section"
        ? span === "viewport"
          ? spanNote
          : `${title(focused.section, p.sections)}${spanNote ? ` ${spanNote}` : ""}`
        : scope === "sections"
          ? `${ids.length} section${ids.length === 1 ? "" : "s"}`
          : active.label;
    return (
      <div ref={box} className="static min-w-0">
        <button
          data-popover-trigger
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Context: ${active.label}${scope === "section" ? `, ${chip}` : ""}`}
          title={summary}
          className={`flex h-8 min-w-0 max-w-[14rem] items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors aria-expanded:bg-slate-100 pointer-coarse:h-10 pointer-coarse:text-[13px] ${scope === "none" ? "border-slate-200 text-slate-500 hover:bg-slate-100" : "border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100"}`}
          onClick={() => setOpen(!open)}
        >
          <Icon name={active.icon} className="shrink-0" />
          <span className="truncate">{chip}</span>
        </button>
        {open && (
          <div
            role="dialog"
            aria-label="What to send with your message"
            className="absolute inset-x-0 bottom-full z-40 mb-2 max-h-[min(72vh,40rem)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-2 text-sm shadow-lift"
          >
            <p className="px-2 pb-1 pt-0.5 text-xs font-semibold text-slate-700">Send with your message</p>
            <div role="radiogroup" aria-label="Context scope" className="grid gap-0.5">
              {SCOPES.map((s) => (
                <button
                  key={s.v}
                  role="radio"
                  aria-checked={scope === s.v}
                  className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-slate-100 pointer-coarse:py-2.5 ${scope === s.v ? "bg-slate-100" : ""}`}
                  onClick={() => choose(s.v)}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                    <Icon name={s.icon} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-slate-800">{s.label}</span>
                    <span className="block truncate text-xs text-slate-500">{s.hint}</span>
                  </span>
                  {scope === s.v && <Icon name="tick" className="shrink-0 text-brand-600" />}
                </button>
              ))}
            </div>
            {scope === "section" && (
              <div className="mt-1 px-1">
                <div
                  role="radiogroup"
                  aria-label="How much around the section"
                  className="flex rounded-lg border border-slate-200 bg-white p-0.5 text-xs"
                >
                  {SECTION_SPANS.map((s) => (
                    <button
                      key={s.v}
                      role="radio"
                      aria-checked={span === s.v}
                      title={
                        s.v === "viewport"
                          ? `Exactly what ${focused.fromIpad ? "the iPad" : "this screen"} shows, zoom included`
                          : s.v === "section"
                            ? "Only this section"
                            : `This section and the one ${s.v}`
                      }
                      className={`flex-1 rounded-md px-1.5 py-1 pointer-coarse:py-2 ${span === s.v ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
                      onClick={() => {
                        setSpan(s.v);
                        setPreview(null);
                      }}
                    >
                      {s.v === "viewport" && focused.fromIpad ? "iPad screen" : s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {scope !== "none" && (
              <div className="mt-2 border-t border-slate-200 px-1 pt-2">
                <ContextControls
                  hideScope
                  hideCode
                  o={ctx}
                  set={(patch) => {
                    const { scope: s, ...rest } = patch;
                    setOptions({ ...options, ...rest });
                    if (s) choose(s === "all" ? "notebook" : s);
                  }}
                  sections={p.sections}
                  pickedIds={ids}
                  setPickedIds={setIds}
                  currentId={focusedId}
                  source={source}
                  textSel={text}
                  setTextSel={(sel) => setTextAt(sel ? { sectionId: currentId, sel } : null)}
                  lassoCount={p.selection?.ids.size ?? 0}
                  summary={summary}
                />
                <button
                  className="btn btn-ghost btn-sm mt-1 w-full"
                  onClick={() => {
                    void prepare(false).catch((e) => setError(String(e)));
                  }}
                >
                  Preview exactly what is sent
                </button>
              </div>
            )}
            {error && <p role="alert" className="px-2 text-xs text-rose-700">{error}</p>}
            {preview && (
              <BundlePreview
                bundle={preview.bundle}
                onClose={() => setPreview(null)}
              />
            )}
          </div>
        )}
      </div>
    );
  },
);
