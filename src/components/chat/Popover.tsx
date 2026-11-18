"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** Open state for a menu or popover that closes on Escape and on a press outside it. */
export function usePopover<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      ref.current?.querySelector<HTMLElement>("[data-popover-trigger]")?.focus();
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/** A menu row: icon, label and an optional hint on the right. */
export function MenuItem({
  children,
  onClick,
  danger,
  hint,
}: {
  children: ReactNode;
  onClick(): void;
  danger?: boolean;
  hint?: string;
}) {
  return (
    <button
      role="menuitem"
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-slate-100 ${danger ? "text-rose-700" : "text-slate-700"}`}
      onClick={onClick}
    >
      {children}
      {hint && <span className="ml-auto pl-4 text-xs text-slate-400">{hint}</span>}
    </button>
  );
}
