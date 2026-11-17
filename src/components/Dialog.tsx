"use client";
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

/** What a key press inside a modal dialog does: Esc closes, Tab and Shift+Tab wrap around the ends. */
export function dialogKey<T>(key: string, shift: boolean, focusables: T[], active: T | null): { close: true } | { focus: T } | null {
  if (key === "Escape") return { close: true };
  if (key !== "Tab" || !focusables.length) return null;
  const i = active === null ? -1 : focusables.indexOf(active);
  if (shift && i <= 0) return { focus: focusables[focusables.length - 1] };
  if (!shift && (i === -1 || i === focusables.length - 1)) return { focus: focusables[0] };
  return null;
}

/**
 * Modal dialog as a form, so Enter in a field or on the focused confirm button submits.
 * Focus starts on `[data-autofocus]` (or the first control), stays inside, and returns on close.
 */
export function Dialog({ title, onClose, onSubmit, children }: { title: string; onClose: () => void; onSubmit: () => void; children: ReactNode }) {
  const titleId = useId();
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = form.current?.querySelector<HTMLElement>("[data-autofocus]") ?? form.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
    return () => { if (prev?.isConnected) prev.focus(); };
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    const focusables = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
    const next = dialogKey(e.key, e.shiftKey, focusables, document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    if ("close" in next) onClose();
    else next.focus.focus();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-backdrop p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form ref={form} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}
        onSubmit={(e) => { e.preventDefault(); onSubmit(); }} className="card w-full max-w-sm p-5 shadow-lift">
        <h2 id={titleId} className="text-base font-semibold text-slate-900">{title}</h2>
        {children}
      </form>
    </div>
  );
}
