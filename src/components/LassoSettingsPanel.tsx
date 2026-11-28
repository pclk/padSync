"use client";

import { LASSO_ACTIONS, LASSO_SIZES, LASSO_STEPS, defaultLasso, type LassoAction, type LassoSettings } from "@/lib/lasso-settings";
import { useLassoSettings } from "@/lib/settings";
import { Icon } from "./Icons";

/**
 * The lasso's settings: how it picks strokes, and the circle of actions over a selection (shown
 * or not, its size, how much Bigger and Smaller scale, which actions it fans out and in what
 * order). The Lasso tab of the iPad's toolbar settings and Settings → Lasso both show it.
 */
export function LassoSettingsPanel({ ipad, compact = false }: { ipad: boolean; compact?: boolean }) {
  const [s, set] = useLassoSettings(ipad);
  const update = (patch: Partial<LassoSettings>) => set({ ...s, ...patch });
  const isDefault = JSON.stringify(s) === JSON.stringify(defaultLasso(ipad));
  const move = (i: number, d: -1 | 1) => {
    const order = [...s.order];
    [order[i], order[i + d]] = [order[i + d], order[i]];
    update({ order });
  };
  const hint = compact ? "text-[11px]" : "text-xs";

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1 text-xs font-medium text-slate-700">The lasso draws</p>
        <div role="group" aria-label="The lasso draws" className="segmented flex w-full [&>button]:flex-1">
          <button aria-pressed={s.shape === "free"} onClick={() => update({ shape: "free" })}>
            A free loop
          </button>
          <button aria-pressed={s.shape === "rect"} onClick={() => update({ shape: "rect" })}>
            A rectangle
          </button>
        </div>
        <p className={`mt-1 ${hint} text-slate-500`}>Picking the lasso tool again switches. A rectangle can select empty page, to copy it as an image.</p>
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-slate-700">The lasso selects</p>
        <div role="group" aria-label="The lasso selects" className="segmented flex w-full [&>button]:flex-1">
          <button aria-pressed={s.mode === "touch"} onClick={() => update({ mode: "touch" })}>
            Anything it touches
          </button>
          <button aria-pressed={s.mode === "enclose"} onClick={() => update({ mode: "enclose" })}>
            What it encloses
          </button>
        </div>
        <p className={`mt-1 ${hint} text-slate-500`}>
          {s.mode === "touch" ? "Every stroke the lasso line crosses or passes over, and every stroke with any part inside it." : "Only strokes at least half inside the loop; strokes the line crosses stay out."}
        </p>
      </div>

      <label className="flex min-h-11 items-center justify-between text-sm">
        Press-and-hold magnifier
        <input type="checkbox" className="switch" checked={s.lens} onChange={(e) => update({ lens: e.target.checked })} />
      </label>
      {s.lens && <>
        <Range label="Lens size" unit="px" value={s.lensSize} range={{ min: 72, max: 160, step: 4 }} onChange={(lensSize) => update({ lensSize })} />
        <Range label="Magnification" unit="×" value={s.lensZoom} range={{ min: 2, max: 4, step: 1 }} onChange={(lensZoom) => update({ lensZoom })} />
      </>}

      <label className="flex min-h-11 items-center justify-between gap-3">
        <span>
          <span className="block text-sm text-slate-800">Lasso circle</span>
          <span className={`block ${hint} text-slate-500`}>A circle of actions above each selection, like the toolbar circle. Off: a bar of Delete and Duplicate.</span>
        </span>
        <input type="checkbox" className="switch" checked={s.circle} onChange={(e) => update({ circle: e.target.checked })} />
      </label>

      {s.circle && (
        <>
          <Range label="Circle size" unit="px" value={s.size} range={LASSO_SIZES} onChange={(size) => update({ size })} />
          <Range label="Bigger and Smaller step" unit="%" value={s.step} range={LASSO_STEPS} onChange={(step) => update({ step })} />
          <div>
            <p className="mb-1 text-xs font-medium text-slate-700">Actions, in fan order</p>
            <ul className="-mx-1">
              {s.order.map((a, i) => {
                const info = LASSO_ACTIONS.find((x) => x.action === a)!;
                const shown = !s.hidden.includes(a);
                return (
                  <li key={a} className="flex items-center gap-1 px-1">
                    <Icon name={info.icon} className={`shrink-0 text-lg ${shown ? "text-slate-600" : "text-slate-300"}`} />
                    <span className="min-w-0 flex-1 pl-1">
                      <span className={`block truncate text-sm ${shown ? "text-slate-800" : "text-slate-400"}`}>{info.label}</span>
                      {!compact && <span className="block truncate text-[11px] text-slate-500">{info.hint}</span>}
                    </span>
                    <button className="icon-btn h-11 w-10" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${info.label} up`}>
                      <Icon name="arrowUp" />
                    </button>
                    <button className="icon-btn h-11 w-10" disabled={i === s.order.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${info.label} down`}>
                      <Icon name="arrowDown" />
                    </button>
                    <label className="flex h-11 w-12 items-center justify-center">
                      <input
                        type="checkbox"
                        className="switch"
                        checked={shown}
                        onChange={(e) => update({ hidden: e.target.checked ? s.hidden.filter((h) => h !== a) : [...s.hidden, a as LassoAction] })}
                        aria-label={`Show ${info.label}`}
                      />
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
        <span className={`${hint} text-slate-500`}>Saved on this device only.</span>
        <button className="btn btn-ghost btn-sm" disabled={isDefault} onClick={() => set(defaultLasso(ipad))}>
          Reset lasso
        </button>
      </div>
    </div>
  );
}

function Range({ label, unit, value, range, onChange }: { label: string; unit: string; value: number; range: { min: number; max: number; step: number }; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-xs font-medium text-slate-700">
        {label}
        <span className="tabular-nums text-slate-500">
          {value} {unit}
        </span>
      </span>
      <input type="range" min={range.min} max={range.max} step={range.step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-8 w-full" aria-label={label} />
    </label>
  );
}
