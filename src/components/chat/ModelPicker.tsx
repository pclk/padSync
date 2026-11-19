"use client";
import { useMemo, useState } from "react";
import type { CatalogAccount, CatalogModel, ChatAgent, ChatOptions } from "@/lib/chat-types";
import { EFFORTS, chooseModel, describeModel, filterModels, modelChoice, sameModel, type ModelChoice } from "@/lib/chat-ui";
import { Icon } from "../Icons";
import { usePopover } from "./Popover";

type Settings = { agent: ChatAgent; options: ChatOptions };

const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max", ultra: "Ultra" };
const tokens = (n?: number) => (!n ? "" : n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}k`);

/** The composer's model button: every login on the Mac, its models, and the reasoning effort. */
export function ModelPicker(p: {
  accounts: CatalogAccount[];
  /** The list is the built-in one (no bridge has reported its logins yet). */
  fallback: boolean;
  value: Settings;
  onChange(next: Settings): void;
  /** The synced default for new chats, and saving it (null clears it). */
  defaultModel: ModelChoice | null;
  setDefaultModel(next: ModelChoice | null): void;
}) {
  const { open, setOpen, ref } = usePopover();
  const [q, setQ] = useState("");
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [custom, setCustom] = useState("");
  const current = describeModel(p.accounts, p.value);
  const shown = useMemo(() => filterModels(p.accounts, q), [p.accounts, q]);
  const efforts = current.model?.efforts ?? EFFORTS[p.value.agent];
  const multipleOfAgent = (agent: ChatAgent) => p.accounts.filter((a) => a.agent === agent).length > 1;
  const isDefault = sameModel(p.value, p.defaultModel);
  const fallbackDefault = p.defaultModel && describeModel(p.accounts, p.defaultModel);
  // On a touch screen, focusing the search box would raise the keyboard over the list.
  const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

  const pick = (account: CatalogAccount, model: { id: string; efforts?: string[] }) => {
    p.onChange(chooseModel(p.value.options, account, model));
    setOpen(false);
    setQ("");
  };
  const row = (account: CatalogAccount, m: CatalogModel) => {
    const selected = current.account?.id === account.id && current.model?.id === m.id;
    const mine = !!p.defaultModel && p.defaultModel.agent === account.agent && describeModel(p.accounts, p.defaultModel).account?.id === account.id && p.defaultModel.options.model === m.id;
    return (
      <button
        key={m.id}
        role="menuitemradio"
        aria-checked={selected}
        className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-slate-100 pointer-coarse:py-2.5 ${selected ? "bg-slate-100" : ""}`}
        onClick={() => pick(account, m)}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 font-medium text-slate-800">
            {m.label}
            {m.badge && <span className="rounded-full bg-amber-50 px-1.5 text-[10px] font-medium text-amber-700">{m.badge}</span>}
            {mine && <span className="rounded-full bg-brand-50 px-1.5 text-[10px] font-medium text-brand-700">Default</span>}
            {!mine && account.defaultModel === m.id && <span className="text-[10px] font-normal text-slate-400">CLI default</span>}
          </span>
          {(m.description || m.contextWindow) && (
            <span className="block truncate text-xs text-slate-500">
              {[m.description, m.contextWindow && `${tokens(m.contextWindow)} context`].filter(Boolean).join(" · ")}
            </span>
          )}
        </span>
        {selected && <Icon name="tick" className="mt-1 shrink-0 text-brand-600" />}
      </button>
    );
  };

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        data-popover-trigger
        aria-label="Model"
        aria-haspopup="menu"
        aria-expanded={open}
        title={[current.account?.label, current.account?.detail].filter(Boolean).join(" · ")}
        className="flex h-8 min-w-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 aria-expanded:bg-slate-100 pointer-coarse:h-10 pointer-coarse:text-[13px]"
        onClick={() => setOpen(!open)}
      >
        <span className="truncate">
          {current.label}
          {current.account && multipleOfAgent(current.account.agent) && current.account.label.includes("·") && (
            <span className="font-normal text-slate-400"> · {current.account.label.split("·").pop()!.trim()}</span>
          )}
        </span>
        {current.effort && <span className="shrink-0 font-normal text-slate-400">{EFFORT_LABEL[current.effort] ?? current.effort}</span>}
        <Icon name="chevronDown" className="shrink-0 text-slate-400" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Choose a model"
          className="absolute bottom-full right-0 z-40 mb-2 flex max-h-[min(70vh,34rem)] w-[min(21rem,calc(100vw-2rem))] flex-col rounded-2xl border border-slate-200 bg-white text-sm shadow-lift"
        >
          <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
            <Icon name="search" className="shrink-0 text-slate-400" />
            <input
              autoFocus={!touch}
              aria-label="Search models"
              placeholder="Search models"
              className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {p.fallback && (
              <p className="px-2.5 pb-1.5 pt-1 text-xs text-slate-500">
                Built-in list. Restart the Mac bridge (0.3+) to see your own logins and models.
              </p>
            )}
            {shown.map((a) => {
              const main = a.models.filter((m) => !m.more);
              const extra = a.models.filter((m) => m.more);
              const expanded = more[a.id] || !!q || !main.length;
              return (
                <div key={a.id} className="mb-1">
                  <div className="flex items-baseline gap-2 px-2.5 pb-0.5 pt-2">
                    <span className="text-xs font-semibold text-slate-700">{a.label}</span>
                    {a.detail && <span className="truncate text-[11px] text-slate-400">{a.detail}</span>}
                  </div>
                  {main.map((m) => row(a, m))}
                  {extra.length > 0 && !expanded && (
                    <button
                      className="flex w-full items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-100"
                      onClick={() => setMore({ ...more, [a.id]: true })}
                    >
                      More models ({extra.length}) <Icon name="chevronRight" />
                    </button>
                  )}
                  {expanded && extra.map((m) => row(a, m))}
                  {!a.models.length && <p className="px-2.5 py-1 text-xs text-slate-400">No models cached yet. Open this CLI once.</p>}
                </div>
              );
            })}
            {!shown.length && <p className="px-2.5 py-3 text-center text-xs text-slate-500">No model matches “{q}”.</p>}
          </div>
          <div className="space-y-2 border-t border-slate-200 p-2.5">
            <div className="flex min-h-8 items-center gap-2 text-xs">
              {isDefault ? (
                <>
                  <Icon name="tick" className="shrink-0 text-brand-600" />
                  <span className="min-w-0 flex-1 text-slate-600">Default for new chats on all your devices</span>
                  <button className="shrink-0 rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800" onClick={() => p.setDefaultModel(null)}>
                    Clear
                  </button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-slate-500">
                    {fallbackDefault ? `Default: ${fallbackDefault.label}${p.defaultModel?.options.effort ? ` · ${EFFORT_LABEL[p.defaultModel.options.effort] ?? p.defaultModel.options.effort}` : ""}` : "No default: new chats use the last model picked"}
                  </span>
                  <button
                    className="shrink-0 rounded-full border border-slate-200 px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-100 pointer-coarse:py-2"
                    onClick={() => p.setDefaultModel(modelChoice(p.value))}
                  >
                    Make default
                  </button>
                </>
              )}
            </div>
            {efforts.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="w-12 shrink-0 text-xs text-slate-500">Effort</span>
                <div className="segmented flex-1 justify-between overflow-x-auto" role="radiogroup" aria-label="Effort">
                  {["", ...efforts].map((e) => (
                    <button
                      key={e || "auto"}
                      role="radio"
                      aria-checked={(p.value.options.effort ?? "") === e}
                      title={e ? undefined : `Model default${current.model?.defaultEffort ? ` (${EFFORT_LABEL[current.model.defaultEffort] ?? current.model.defaultEffort})` : ""}`}
                      className="!px-1.5 text-xs"
                      onClick={() => p.onChange({ ...p.value, options: { ...p.value.options, effort: e || undefined } })}
                    >
                      {e ? (EFFORT_LABEL[e] ?? e) : "Auto"}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const id = custom.trim();
                if (!id || !current.account) return;
                pick(current.account, { id });
                setCustom("");
              }}
            >
              <span className="w-12 shrink-0 text-xs text-slate-500">Other</span>
              <input
                aria-label="Custom model"
                placeholder={`Model id for ${current.account?.label ?? "this login"}`}
                pattern="[A-Za-z0-9][A-Za-z0-9._:\[\]\-]{0,79}"
                className="field h-7 py-0 text-xs"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
              />
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
