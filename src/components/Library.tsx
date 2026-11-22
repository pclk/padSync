"use client";
import PdfImport, { dragHasFiles, type PdfImportHandle } from "./PdfImport";
import { forgetPdf, sweepStoredPdfs } from "@/lib/pdf";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  folderOf, folderPath, formatEdited, isWithin, itemName, movable, parentFolder, rangeIds, selectNotebooks, sortFolders,
  type LibraryItem, type LibrarySort,
} from "@/lib/library";
import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { db, deviceId } from "@/lib/db";
import {
  createFolder, createNotebook, deleteFolders, lastEditedTimes, listFolders, listNotebooks, moveItems, putEntities, restoreFolders,
  setDeleted as setEntitiesDeleted,
} from "@/lib/store";
import type { FolderEntity, NotebookEntity, PresenceEntity, SectionData } from "@/lib/types";
import { SyncBadge } from "./SyncBadge";
import { Icon, Logo, type IconName } from "./Icons";
import { Dialog } from "./Dialog";
import { NotebookThumb } from "./NotebookThumb";
import { deferredAction } from "@/lib/deferred";
import { openNotebookNative } from "@/lib/native";
import { NATIVE_INBOX_EVENT, nativeStore } from "@/lib/native-store";
import { useMarquee, type MarqueeMode } from "./useMarquee";

/** How long the "Undo" toast stays; a notebook delete is only written after it. */
export const UNDO_MS = 6000;

/** The open folder is kept for the tab, so coming back from a notebook lands in the same folder. */
const FOLDER_KEY = "padsync.library.folder";
const VIEW_KEY = "padsync.library.view";
const DRAG_TYPE = "application/x-padsync-items";
const LONG_PRESS_MS = 480;
type Item = LibraryItem;
type View = "grid" | "list";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const noSubscribe = () => () => {};
const readStore = (key: string) => { try { return sessionStorage.getItem(key); } catch { return null; } };
const readLocal = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };

export default function Library() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibrarySort>("recent");
  const [view, setViewState] = useState<View>(() => (readLocal(VIEW_KEY) === "list" ? "list" : "grid"));
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch {} };
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  // In the iPad app, search also looks through handwriting the app has read (HandwritingIndex).
  const inApp = useSyncExternalStore(noSubscribe, () => !!nativeStore(), () => false);
  const [ink, setInk] = useState<{ term: string; hits: Map<string, string> }>();
  const inkTerm = query.trim();
  useEffect(() => {
    const store = nativeStore();
    if (!store || !inkTerm) return;
    let live = true;
    const t = setTimeout(() => {
      store.searchInk(inkTerm).then((hits) => {
        if (live) setInk({ term: inkTerm.toLocaleLowerCase(), hits: new Map(hits.map((h) => [h.notebookId, h.line])) });
      }).catch(() => {});
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [inkTerm]);
  // PDFs shared to the iPad app from other apps import as notebooks at the top level.
  useEffect(() => {
    const store = nativeStore();
    if (!store) return;
    let taking = false;
    const take = async () => {
      if (taking) return;
      taking = true;
      try {
        const waiting = await store.inbox();
        if (!waiting.length || !pdf.current) return;
        pdf.current.importFiles(waiting.map((f) => new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name, { type: "application/pdf" })), "");
        await store.clearInbox(waiting.map((f) => f.id));
      } catch {
        // Left in the inbox for next time.
      } finally {
        taking = false;
      }
    };
    void take();
    window.addEventListener(NATIVE_INBOX_EVENT, take);
    return () => window.removeEventListener(NATIVE_INBOX_EVENT, take);
  }, []);
  const mainRef = useRef<HTMLElement>(null);
  const pdf = useRef<PdfImportHandle>(null);
  const [error, setError] = useState("");
  const mutate = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try { await action(); }
    catch { setError("Could not save your change on this device. Please try again."); }
    finally { pending.current = false; setBusy(false); }
  };

  const [folder, setFolderState] = useState(() => readStore(FOLDER_KEY) ?? "");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const clearSelection = () => { setSelected(new Set()); anchor.current = null; setSelectMode(false); };
  const setFolder = (id: string) => {
    setFolderState(id);
    setQuery("");
    clearSelection();
    try { sessionStorage.setItem(FOLDER_KEY, id); } catch {}
  };

  const [renaming, setRenaming] = useState<Item | null>(null);
  const [naming, setNaming] = useState<{ group?: string[] } | null>(null);
  const [moving, setMoving] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragging = useRef<string[]>([]);
  // Cut and paste moves without dragging: cut here, open the destination, paste.
  const [cut, setCut] = useState<string[] | null>(null);
  const [toast, setToast] = useState<{ key: number; message: string; undo?: () => Promise<void> } | null>(null);
  const showToast = (message: string, undo?: () => Promise<void>) => setToast((t) => ({ key: (t?.key ?? 0) + 1, message, undo }));
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast((t) => (t?.key === toast.key ? null : t)), UNDO_MS);
    return () => clearTimeout(id);
  }, [toast]);

  // Notebooks being deleted are hidden until the undo window closes; only then is the delete
  // written, so undo never reaches sync (the server removes stored PDFs as soon as it sees one).
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const commitDelete = async (nbs: NotebookEntity[]) => {
    const ids = new Set(nbs.map((n) => n.id));
    setHidden((h) => new Set([...h].filter((id) => !ids.has(id))));
    try {
      const rows = (await db.entities.bulkGet(nbs.map((n) => n.id))).map((r, i) => (r as NotebookEntity | undefined) ?? nbs[i]);
      await putEntities(rows.map((r) => ({ ...r, deleted: 1 as const })));
    } catch {
      setError(nbs.length === 1 ? `Could not delete “${nbs[0].data.title}” on this device. Please try again.` : "Could not delete those notebooks on this device. Please try again.");
      return;
    }
    // The server removes stored PDFs of deleted notebooks; this device's copy goes now.
    const secs = (await Promise.all(nbs.map((nb) => db.entities.where("[notebookId+kind]").equals([nb.id, "section"]).toArray()))).flat();
    for (const id of new Set(secs.flatMap((s) => (s.data as SectionData).pdf?.documentId ?? []))) await forgetPdf(id).catch(() => {});
  };
  const [deletion] = useState(() => deferredAction(commitDelete, UNDO_MS));
  // Leaving the library or closing the tab ends the undo window early.
  useEffect(() => {
    const flush = () => void deletion.flush();
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, [deletion]);
  // Clears stored PDFs of notebooks deleted on any device, including before this fix shipped.
  useEffect(() => { void sweepStoredPdfs(); }, []);
  const notebooks = useLiveQuery(listNotebooks, []);
  const counts = useLiveQuery(async () => {
    const secs = await db.entities.where("kind").equals("section").filter((s) => !s.deleted).toArray();
    const m = new Map<string, number>();
    secs.forEach((s) => m.set(s.notebookId, (m.get(s.notebookId) ?? 0) + 1));
    return m;
  }, []);
  const ipad = useLiveQuery(async () => {
    const ps = (await db.entities.where("kind").equals("presence").toArray()) as PresenceEntity[];
    return ps.filter((p) => p.data.deviceKind === "ipad" && p.data.device !== deviceId()).sort((a, b) => b.data.at - a.data.at)[0];
  }, []);
  const edited = useLiveQuery(() => lastEditedTimes(), []);
  const folders = useLiveQuery(listFolders, []);
  // "Edited 5 min ago" has to keep counting while the library sits open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const live = hidden.size ? notebooks?.filter((n) => !hidden.has(n.id)) : notebooks;
  const byId = new Map((folders ?? []).map((f) => [f.id, f]));
  const items = new Map<string, Item>([...(folders ?? []), ...(live ?? [])].map((i) => [i.id, i]));
  // A folder deleted on another device drops back to the top level.
  const current = byId.has(folder) ? folder : "";
  const path = folderPath(current, byId);
  const parent = path.length ? path.at(-2)?.id ?? "" : null;
  const term = query.trim().toLocaleLowerCase();
  const searching = !!term;
  // A search looks through every folder; otherwise the library shows the open folder.
  const scope = searching ? live ?? [] : (live ?? []).filter((n) => folderOf(n, byId) === current);
  const inkHits = ink?.term === term ? ink.hits : undefined;
  const sorted = selectNotebooks(scope, query, sort, edited, inkHits && new Set(inkHits.keys()));
  const folderList = (folders ?? []).filter((f) => (searching ? f.data.name.toLocaleLowerCase().includes(term) : folderOf(f, byId) === current));
  const shownFolders = sort === "newest" || sort === "oldest"
    ? [...folderList].sort((a, b) => (sort === "newest" ? b.data.createdAt - a.data.createdAt : a.data.createdAt - b.data.createdAt) || a.id.localeCompare(b.id))
    : sortFolders(folderList);
  const order = [...shownFolders, ...sorted].map((i) => i.id);
  // Items can vanish under the selection (moved, deleted, synced away); only what is shown counts.
  const sel = order.filter((id) => selected.has(id));
  const selecting = selectMode || sel.length > 0;
  const inside = (id: string) => (live ?? []).filter((n) => folderOf(n, byId) === id).length + (folders ?? []).filter((f) => folderOf(f, byId) === id).length;
  const where = (item: Item) => folderPath(folderOf(item, byId), byId).map((f) => f.data.name).join(" › ") || "Top level";
  const folderName = (id: string) => (id ? `“${byId.get(id)?.data.name ?? "folder"}”` : "the top level");
  const ipadNb = ipad && live?.find((n) => n.id === ipad.notebookId);
  const resolve = (ids: string[]) => ids.map((id) => items.get(id)).filter((i): i is Item => !!i);

  // ---------------------------------------------------------------------------------------------
  // Selection

  const select = (ids: string[], mode: MarqueeMode, base = selected) => {
    const next = mode === "replace" ? new Set<string>() : new Set(base);
    for (const id of ids) {
      if (mode === "toggle" && base.has(id)) next.delete(id);
      else next.add(id);
    }
    setSelected(next);
  };
  const marqueeBase = useRef<Set<string>>(new Set());
  const marquee = useMarquee(mainRef, {
    onStart: () => { marqueeBase.current = new Set(sel); setMenu(null); },
    onSelect: (ids, mode) => select(ids, mode, marqueeBase.current),
    onEmptyClick: (mode) => { if (mode === "replace" && !selectMode) clearSelection(); },
    onCancel: () => setSelected(new Set(marqueeBase.current)),
  });

  // ---------------------------------------------------------------------------------------------
  // Actions. Each takes ids, so a menu, the selection bar, a key or a drop can run it.

  const open = (item: Item, newTab = false) => {
    if (item.kind === "folder") return setFolder(item.id);
    if (newTab) window.open(`/notebook?id=${item.id}`, "_blank", "noopener");
    else if (!openNotebookNative(item.id)) router.push(`/notebook?id=${item.id}`);
  };

  const newBlank = () => mutate(async () => {
    const id = await createNotebook("Untitled notebook", [], undefined, undefined, undefined, current || undefined);
    if (!openNotebookNative(id)) router.push(`/notebook?id=${id}`);
  });

  /** Moves, then offers to put each item back where it was. */
  const runMoves = (moves: { item: Item; to: string }[], message: string) => {
    if (!moves.length) return;
    const back = moves.map(({ item }) => ({ id: item.id, to: folderOf(item, byId) }));
    void mutate(async () => {
      await moveItems(moves.map(({ item, to }) => ({ id: item.id, to })));
      showToast(message, () => moveItems(back));
    });
  };

  const moveTo = (ids: string[], to: string) => {
    setMoving(null);
    const all = resolve(ids);
    const ok = movable(all, to, byId);
    if (!ok.length) {
      if (all.some((i) => i.kind === "folder" && to && isWithin(to, i.id, byId))) setError("A folder can't go inside itself.");
      return;
    }
    runMoves(ok.map((item) => ({ item, to })), `Moved ${ok.length === 1 ? `“${itemName(ok[0])}”` : plural(ok.length, "item")} to ${folderName(to)}`);
  };

  const cutItems = (ids: string[]) => { setCut(ids); clearSelection(); };
  const paste = () => {
    if (!cut) return;
    setCut(null);
    moveTo(cut, current);
  };
  const cutLive = cut ? resolve(cut) : [];

  /** Up one level from wherever each item is (in a search they can be in different folders). */
  const moveUp = (ids: string[]) => {
    const all = resolve(ids);
    const moves = all.flatMap((item) => {
      const to = parentFolder(item, byId);
      return to === null || !movable([item], to, byId).length || !movable(all, to, byId).includes(item) ? [] : [{ item, to }];
    });
    const targets = new Set(moves.map((m) => m.to));
    runMoves(moves, `Moved ${moves.length === 1 ? `“${itemName(moves[0].item)}”` : plural(moves.length, "item")} up to ${targets.size === 1 ? folderName([...targets][0]) : "their parent folders"}`);
  };
  const canMoveUp = (ids: string[]) => resolve(ids).some((i) => parentFolder(i, byId) !== null);

  const group = (ids: string[], name: string) => {
    setNaming(null);
    const all = resolve(ids);
    void mutate(async () => {
      const id = await createFolder(name, current || undefined);
      const ok = movable(all, id, byId);
      const back = ok.map((item) => ({ id: item.id, to: folderOf(item, byId) }));
      await moveItems(ok.map((item) => ({ id: item.id, to: id })));
      setSelected(new Set([id]));
      anchor.current = id;
      showToast(`Made “${name}” with ${plural(ok.length, "item")}`, async () => {
        await moveItems(back);
        await setEntitiesDeleted([id], true);
      });
    });
  };

  const newFolder = (name: string) => {
    setNaming(null);
    void mutate(async () => {
      const id = await createFolder(name, current || undefined);
      setSelected(new Set([id]));
      anchor.current = id;
    });
  };

  const rename = (item: Item, name: string) => {
    setRenaming(null);
    if (!name || name === itemName(item)) return;
    void mutate(async () => {
      const row = (await db.entities.get(item.id)) as Item | undefined;
      if (!row || row.deleted) return;
      await putEntities([row.kind === "folder" ? { ...row, data: { ...row.data, name } } : { ...row, data: { ...row.data, title: name } }]);
    });
  };

  const remove = (ids: string[]) => {
    setDeleting(null);
    const all = resolve(ids);
    const nbs = all.filter((i): i is NotebookEntity => i.kind === "notebook");
    const fs = all.filter((i): i is FolderEntity => i.kind === "folder");
    if (!all.length) return;
    setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))));
    const message = all.length === 1 ? `Deleted “${itemName(all[0])}”` : `Deleted ${plural(all.length, "item")}`;
    void mutate(async () => {
      // Leave a folder that is going away for the nearest one that stays.
      if (current && fs.some((f) => isWithin(current, f.id, byId))) {
        const stay = folderPath(current, byId).reverse().find((f) => !fs.some((d) => isWithin(f.id, d.id, byId)));
        setFolder(stay?.id ?? "");
      }
      const undone = fs.length ? await deleteFolders(fs, nbs.map((n) => n.id)) : null;
      if (nbs.length) {
        setHidden((h) => new Set([...h, ...nbs.map((n) => n.id)]));
        await deletion.schedule(nbs);
      }
      showToast(message, async () => {
        const back = deletion.undo();
        if (back) setHidden((h) => new Set([...h].filter((id) => !back.some((n) => n.id === id))));
        if (undone) await restoreFolders(undone);
      });
    });
  };

  // ---------------------------------------------------------------------------------------------
  // Pointer and keyboard on cards

  const lastPointer = useRef<string>("mouse");
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const swallowClick = useRef(false);
  const cancelPress = () => { if (press.current) clearTimeout(press.current.timer); press.current = null; };

  const cardPointerDown = (item: Item) => (e: ReactPointerEvent) => {
    lastPointer.current = e.pointerType;
    // iOS doesn't always send a click after a long press, so a stale swallow ends at the next press.
    swallowClick.current = false;
    if (e.pointerType === "mouse") return;
    // Touch and pencil: a long press selects, the way Photos and Files do.
    cancelPress();
    const timer = setTimeout(() => {
      press.current = null;
      swallowClick.current = true;
      setSelectMode(true);
      setSelected((s) => new Set(s).add(item.id));
      anchor.current = item.id;
      navigator.vibrate?.(10);
    }, LONG_PRESS_MS);
    press.current = { timer, x: e.clientX, y: e.clientY };
  };
  const cardPointerMove = (e: ReactPointerEvent) => {
    if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 8) cancelPress();
  };

  /** Click: opens, unless selecting. Shift picks a range, Cmd/Ctrl toggles one. */
  const cardClick = (item: Item) => (e: ReactMouseEvent) => {
    if (swallowClick.current) { swallowClick.current = false; e.preventDefault(); return; }
    if (e.button !== 0) return;
    const range = e.shiftKey, toggle = e.metaKey || e.ctrlKey;
    if (!range && !toggle && !selecting) {
      if (item.kind === "folder") return open(item);
      if (openNotebookNative(item.id)) e.preventDefault(); // otherwise the link opens it
      return;
    }
    e.preventDefault();
    if (range) select(rangeIds(order, anchor.current, item.id), toggle ? "add" : "replace", selected);
    else if (toggle || selectMode || lastPointer.current !== "mouse") {
      select([item.id], "toggle");
      anchor.current = item.id;
    } else {
      // A plain mouse click while others are selected selects just this one; double-click opens.
      select([item.id], "replace");
      anchor.current = item.id;
    }
  };
  const toggleOne = (item: Item) => {
    select([item.id], "toggle");
    anchor.current = item.id;
  };

  const openMenu = (ids: string[], x: number, y: number) => setMenu({ x, y, ids });
  const cardContextMenu = (item: Item) => (e: ReactMouseEvent) => {
    e.preventDefault();
    cancelPress();
    // The keyboard menu key (or Shift+F10) has no pointer position: open by the card.
    if (!e.clientX && !e.clientY) {
      const r = e.currentTarget.getBoundingClientRect();
      e = { ...e, clientX: r.left + 24, clientY: r.top + 24 };
    }
    // Right-clicking an unselected item acts on it alone, as in Finder.
    const ids = selected.has(item.id) ? sel : [item.id];
    if (!selected.has(item.id)) { setSelected(new Set([item.id])); anchor.current = item.id; }
    openMenu(ids, e.clientX, e.clientY);
  };

  /** Space toggles the focused card; arrows move focus between cards, Shift+arrows extend the selection. */
  const cardKeyDown = (item: Item) => (e: ReactKeyboardEvent) => {
    if (!(e.target instanceof HTMLElement) || !e.target.matches("[data-opener]")) return;
    if (e.key === " ") {
      e.preventDefault();
      toggleOne(item);
      return;
    }
    if (!e.key.startsWith("Arrow") || e.metaKey || e.ctrlKey || e.altKey) return;
    const cards = Array.from(mainRef.current?.querySelectorAll<HTMLElement>("[data-item-id]") ?? []);
    const here = cards.findIndex((c) => c.dataset.itemId === item.id);
    let next: HTMLElement | undefined;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") next = cards[here + (e.key === "ArrowRight" ? 1 : -1)];
    else {
      // Up and down go to the nearest card in the row above or below.
      const r = cards[here].getBoundingClientRect();
      const down = e.key === "ArrowDown";
      const cx = r.left + r.width / 2;
      next = cards
        .filter((c) => { const b = c.getBoundingClientRect(); return down ? b.top >= r.bottom - 1 : b.bottom <= r.top + 1; })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          const dy = down ? ra.top - rb.top : rb.bottom - ra.bottom;
          return dy || Math.abs(ra.left + ra.width / 2 - cx) - Math.abs(rb.left + rb.width / 2 - cx);
        })[0];
    }
    if (!next) return;
    e.preventDefault();
    const id = next.dataset.itemId!;
    next.querySelector<HTMLElement>("[data-opener]")?.focus();
    next.scrollIntoView({ block: "nearest" });
    if (e.shiftKey) {
      if (!anchor.current || !sel.length) anchor.current = item.id;
      select(rangeIds(order, anchor.current, id), "replace");
    } else if (sel.length) {
      select([id], "replace");
      anchor.current = id;
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || document.querySelector('[role="dialog"]') || menu) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "a" && order.length) {
        e.preventDefault();
        setSelected(new Set(order));
      } else if (mod && e.key.toLowerCase() === "z" && !e.shiftKey && toast?.undo) {
        e.preventDefault();
        const undo = toast.undo;
        setToast(null);
        void mutate(undo);
      } else if (mod && e.key.toLowerCase() === "x" && sel.length) {
        e.preventDefault();
        cutItems(sel);
      } else if (mod && e.key.toLowerCase() === "v" && cutLive.length) {
        e.preventDefault();
        paste();
      } else if (e.key === "Escape" && selecting) {
        clearSelection();
      } else if (e.key === "Escape" && cut) {
        setCut(null);
      } else if ((e.key === "Delete" || e.key === "Backspace") && sel.length) {
        e.preventDefault();
        setDeleting(sel);
      } else if (e.key === "F2" && sel.length === 1) {
        e.preventDefault();
        setRenaming(items.get(sel[0]) ?? null);
      } else if (e.key === "Enter" && sel.length === 1 && !(e.target instanceof HTMLAnchorElement || e.target instanceof HTMLButtonElement)) {
        const item = items.get(sel[0]);
        if (item) open(item, mod);
      } else if (mod && e.key === "ArrowUp" && sel.length && canMoveUp(sel)) {
        e.preventDefault();
        moveUp(sel);
      } else if (mod && e.key === "ArrowUp" && !sel.length && parent !== null) {
        e.preventDefault();
        setFolder(parent);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------------------------------------------------------------------------------------------
  // Drag and drop: cards onto folders, crumbs or "Back"; PDFs from outside onto a folder or the page.

  const dragProps = (item: Item) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      // Touch and pencil drags fight with scrolling and long-press selection; those move through the menu.
      if (lastPointer.current !== "mouse") { e.preventDefault(); return; }
      cancelPress();
      const ids = selected.has(item.id) ? sel : [item.id];
      if (!selected.has(item.id)) { setSelected(new Set([item.id])); anchor.current = item.id; }
      dragging.current = ids;
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
      e.dataTransfer.effectAllowed = "move";
      if (ids.length > 1) {
        const ghost = document.createElement("div");
        ghost.textContent = `${ids.length} items`;
        ghost.style.cssText = "position:fixed;top:-100px;left:0;padding:6px 12px;border-radius:999px;background:#4a6cf7;color:#fff;font:600 13px system-ui";
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 16, 16);
        setTimeout(() => ghost.remove());
      }
    },
    onDragEnd: () => { dragging.current = []; setDropTarget(null); },
  });
  const accepts = (to: string) => {
    const all = resolve(dragging.current);
    return all.length > 0 && movable(all, to, byId).length > 0;
  };
  // One set of handlers for every drop target; each names its folder in data-drop.
  const dropTo = (e: DragEvent) => (e.currentTarget as HTMLElement).dataset.drop ?? "";
  const onDropOver = (e: DragEvent) => {
    const files = dragHasFiles(e), to = dropTo(e);
    if (!files && !(e.dataTransfer.types.includes(DRAG_TYPE) && accepts(to))) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = files ? "copy" : "move";
    setDropTarget(to);
  };
  const onDropLeave = (e: DragEvent) => { const to = dropTo(e); setDropTarget((t) => (t === to ? null : t)); };
  const onDropHere = (e: DragEvent) => {
      const to = dropTo(e);
      setDropTarget(null);
      if (dragHasFiles(e)) {
        e.preventDefault();
        e.stopPropagation();
        pdf.current?.importFiles(Array.from(e.dataTransfer.files), to);
        return;
      }
      const raw = e.dataTransfer.getData(DRAG_TYPE);
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      try { moveTo(JSON.parse(raw) as string[], to); } catch {}
  };
  const dropHandlers = { onDragOver: onDropOver, onDragLeave: onDropLeave, onDrop: onDropHere };
  const isDrop = (to: string) => dropTarget === to;

  // ---------------------------------------------------------------------------------------------
  // Render

  /** What the menu offers for `ids` (empty: the page itself). Plain data; runMenu does the work. */
  const menuItems = (ids: string[]): MenuEntry[] => {
    const all = resolve(ids);
    if (!all.length) return [
      { id: "new-notebook", icon: "plus", label: "New notebook" },
      { id: "new-folder", icon: "folderPlus", label: "New folder" },
      ...(cutLive.length ? [{ id: "paste" as const, icon: "copy" as const, label: `Paste ${plural(cutLive.length, "item")} here`, hint: "⌘V" }] : []),
      ...(order.length ? [{ id: "select-all" as const, icon: "check" as const, label: "Select all", hint: "⌘A" }] : []),
    ];
    const one = all.length === 1 ? all[0] : null;
    const up = all.map((i) => parentFolder(i, byId)).filter((p): p is string => p !== null);
    const upLabel = up.length && new Set(up).size === 1 ? `Move up to ${up[0] ? `“${byId.get(up[0])?.data.name}”` : "the top level"}` : "Move up a level";
    const entries: (MenuEntry | false)[] = [
      !!one && { id: "open", icon: one.kind === "folder" ? "folder" : "notebook", label: "Open", hint: "↵" },
      one?.kind === "notebook" && { id: "open-tab", icon: "globe", label: "Open in new tab" },
      !!one && { id: "rename", icon: "edit", label: "Rename", hint: "F2" },
      { id: "move", icon: "folderMove", label: "Move to…" },
      { id: "cut", icon: "copy", label: "Cut to move elsewhere", hint: "⌘X" },
      !!up.length && { id: "move-up", icon: "arrowUp", label: upLabel, hint: "⌘↑" },
      { id: "group", icon: "folderPlus", label: one ? "New folder with this" : `New folder with ${plural(all.length, "item")}` },
      all.every((i) => selected.has(i.id))
        ? { id: "deselect", icon: "x", label: all.length === 1 ? "Deselect" : "Clear selection" }
        : { id: "select", icon: "check", label: "Select" },
      { id: "delete", icon: "trash", label: one ? "Delete" : `Delete ${plural(all.length, "item")}`, hint: "⌫", danger: true },
    ];
    return entries.filter((e): e is MenuEntry => !!e);
  };
  const runMenu = (action: MenuAction, ids: string[]) => {
    const one = ids.length === 1 ? items.get(ids[0]) : undefined;
    switch (action) {
      case "new-notebook": return void newBlank();
      case "new-folder": return setNaming({});
      case "select-all": return setSelected(new Set(order));
      case "open": return one && open(one);
      case "open-tab": return one && open(one, true);
      case "rename": return setRenaming(one ?? null);
      case "move": return setMoving(ids);
      case "cut": return cutItems(ids);
      case "paste": return paste();
      case "move-up": return moveUp(ids);
      case "group": return setNaming({ group: ids });
      case "deselect": return setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))));
      case "select": setSelectMode(true); select(ids, "add"); anchor.current = ids[0]; return;
      case "delete": return setDeleting(ids);
    }
  };

  const card = (item: Item) => {
    const isSel = selected.has(item.id) && sel.includes(item.id);
    const name = itemName(item);
    const isFolder = item.kind === "folder";
    const n = isFolder ? inside(item.id) : counts?.get(item.id);
    const meta = isFolder
      ? plural(n ?? 0, "item")
      : <>{counts === undefined ? "…" : plural(n ?? 0, "section")} · <span title={`Created ${new Date(item.data.createdAt).toLocaleDateString()}`}>{edited === undefined ? "…" : formatEdited(edited.get(item.id) ?? item.data.createdAt, now)}</span></>;
    const at = searching ? where(item) : "";
    const inkLine = !isFolder ? inkHits?.get(item.id) : undefined;
    const found = inkLine && <span className="block truncate text-xs italic text-brand-700" title="Found in the handwriting">✎ {inkLine}</span>;
    const check = (
      <button type="button" role="checkbox" aria-checked={isSel} aria-label={`Select ${name}`} onClick={() => toggleOne(item)}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs transition-opacity ${isSel ? "border-brand-600 bg-brand-600 text-on-accent" : "border-slate-300 bg-white text-transparent hover:border-brand-500"} ${selecting || isSel ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}>
        <Icon name="tick" />
      </button>
    );
    const more = (
      <button type="button" disabled={busy} aria-label={`More actions for ${name}`} aria-haspopup="menu" title="More actions"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openMenu(selected.has(item.id) ? sel : [item.id], r.right, r.bottom + 4);
        }}
        className="icon-btn h-8 w-8 shrink-0"><Icon name="more" /></button>
    );
    const common = {
      "data-item-id": item.id,
      "data-selected": isSel || undefined,
      onContextMenu: cardContextMenu(item),
      onKeyDown: cardKeyDown(item),
      onPointerDown: cardPointerDown(item),
      onPointerMove: cardPointerMove,
      onPointerUp: cancelPress,
      onPointerCancel: cancelPress,
      ...dragProps(item),
      ...(isFolder ? { "data-drop": item.id, ...dropHandlers } : {}),
    };
    const dim = cut?.includes(item.id) ? "opacity-50" : "";
    const ring = dim + " " + (isSel ? "!border-brand-500 ring-2 ring-brand-500/40" : isFolder && isDrop(item.id) ? "!border-brand-400 bg-brand-50" : "");
    // A notebook opens through its link (so it can open in a new tab); a folder through a button.
    const opener = (className: string, children: ReactNode) => isFolder
      ? <button type="button" data-opener onClick={cardClick(item)} onDoubleClick={() => open(item)} className={className}>{children}</button>
      : <Link href={`/notebook?id=${item.id}`} data-opener onClick={cardClick(item)} onDoubleClick={() => open(item)} draggable={false} className={className}>{children}</Link>;

    if (view === "list") return (
      <li key={item.id} {...common} className={`group flex items-center gap-3 border-b border-slate-100 py-1.5 pl-3 pr-2 last:border-b-0 [-webkit-touch-callout:none] ${dim} ${isSel ? "bg-brand-50" : isFolder && isDrop(item.id) ? "bg-brand-50" : "hover:bg-slate-50"}`}>
        {check}
        {opener("flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1.5 text-left", <>
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base ${isFolder ? "bg-brand-50 text-brand-600" : "bg-slate-100 text-slate-500"}`}><Icon name={isFolder ? "folder" : "notebook"} /></span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-slate-900" title={name}>{name}</span>
            {at && <span className="block truncate text-xs text-slate-500">In {at}</span>}
            {found}
          </span>
          <span className="hidden shrink-0 text-xs text-slate-500 sm:block">{meta}</span>
        </>)}
        {more}
      </li>
    );

    if (isFolder) return (
      <li key={item.id} {...common} className={`group card relative transition-shadow hover:shadow-lift [-webkit-touch-callout:none] ${ring}`}>
        {opener("flex w-full items-center gap-3 rounded-2xl py-3 pl-11 pr-12 text-left", <>
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-xl text-brand-600"><Icon name="folder" /></span>
          <span className="min-w-0">
            <span className="block truncate font-medium text-slate-900" title={name}>{name}</span>
            <span className="block truncate text-xs text-slate-500">{at ? `In ${at} · ` : ""}{meta}</span>
          </span>
        </>)}
        <div className="absolute left-3 top-1/2 -translate-y-1/2">{check}</div>
        <div className="absolute right-2 top-1/2 -translate-y-1/2">{more}</div>
      </li>
    );

    return (
      <li key={item.id} {...common} className={`group card relative overflow-hidden transition-shadow hover:shadow-lift [-webkit-touch-callout:none] ${ring}`}>
        {opener("block rounded-2xl", <>
          <div className="relative m-3 mb-0 aspect-[16/10] overflow-hidden rounded-xl border border-slate-100 bg-[#fdfdfb]">
            <NotebookThumb notebookId={item.id} stamp={edited === undefined ? undefined : edited.get(item.id) ?? item.data.createdAt} />
            {isSel && <div className="absolute inset-0 bg-brand-500/10" />}
          </div>
          <div className="py-3 pl-4 pr-12">
            <div className="truncate font-medium text-slate-900" title={name}>{name}</div>
            {at && <div className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-slate-500"><Icon name="folder" className="shrink-0" /><span className="truncate">{at}</span></div>}
            <div className="mt-0.5 text-xs text-slate-500">{meta}</div>
            {found && <div className="mt-0.5">{found}</div>}
          </div>
        </>)}
        <div className="absolute left-5 top-5">{check}</div>
        <div className="absolute bottom-2.5 right-2">{more}</div>
      </li>
    );
  };

  const loading = live === undefined || folders === undefined;
  const nothingAtAll = !loading && live.length === 0 && folders.length === 0;
  const crumbs = [{ id: "", name: "All notebooks" }, ...path.slice(0, -1).map((f) => ({ id: f.id, name: f.data.name }))];

  return (
    <>
      <main
        ref={mainRef}
        onPointerDown={marquee.onPointerDown}
        onContextMenu={(e) => { if (e.target instanceof Element && !e.target.closest("a, button, input, select, textarea, [data-item-id], [data-no-marquee]")) { e.preventDefault(); openMenu([], e.clientX, e.clientY); } }}
        onDragOver={(e) => { if (dragHasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
        onDrop={(e) => { if (dragHasFiles(e)) { e.preventDefault(); pdf.current?.importFiles(Array.from(e.dataTransfer.files), current); } }}
        className={`mx-auto min-h-screen max-w-6xl px-4 pt-5 sm:px-8 sm:pt-8 ${selecting ? "pb-32" : "pb-16"}`}
      >
        <header className="mb-10 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2.5">
            <Logo />
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">padSync</h1>
          </div>
          <SyncBadge align="start" />
          <nav aria-label="Library" className="ml-auto flex flex-wrap items-center gap-1.5">
            <Link href="/import" className="btn btn-ghost"><Icon name="sparkles" className="text-brand-600" />AI import</Link>
            <Link href="/settings" className="icon-btn" aria-label="Settings" title="Settings"><Icon name="settings" className="text-lg" /></Link>
            <button disabled={busy} onClick={() => setNaming({})} className="btn btn-secondary"><Icon name="folderPlus" />New folder</button>
            <button disabled={busy} onClick={newBlank} className="btn btn-primary"><Icon name="plus" />{busy ? "Saving…" : "New notebook"}</button>
          </nav>
        </header>

        <section className="mb-6 flex flex-wrap items-end justify-between gap-4" aria-labelledby="library-title">
          <div className="min-w-0">
            {!!path.length && (
              <nav aria-label="Folders" className="mb-1 flex flex-wrap items-center gap-1 text-sm text-slate-500">
                {crumbs.map((c) => (
                  <span key={c.id} className="flex items-center gap-1">
                    <button type="button" onClick={() => setFolder(c.id)} data-drop={c.id} {...dropHandlers} className={`rounded-md px-1 hover:text-brand-700 hover:underline ${isDrop(c.id) ? "bg-brand-100 text-brand-800 ring-2 ring-brand-400" : ""}`}>{c.name}</button>
                    <Icon name="chevronRight" className="text-slate-400" />
                  </span>
                ))}
              </nav>
            )}
            <h2 id="library-title" className="break-words text-3xl font-semibold tracking-tight text-slate-900">{path.at(-1)?.data.name ?? "Your notebooks"}</h2>
            {parent !== null ? (
              <button type="button" onClick={() => setFolder(parent)} data-drop={parent} {...dropHandlers} title="Drop here to move up a level"
                className={`mt-1 flex items-center gap-1 rounded-md px-1 text-sm text-slate-500 hover:text-brand-700 ${isDrop(parent) ? "bg-brand-100 text-brand-800 ring-2 ring-brand-400" : ""}`}>
                <Icon name="back" />Back to {path.at(-2)?.data.name ?? "all notebooks"}
              </button>
            ) : <p className="mt-1 text-sm text-slate-500">A place to write, practise, and bring your notes together.</p>}
          </div>
          {!nothingAtAll && !loading && (
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <label className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
                <span className="sr-only">Search notebooks</span>
                <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input ref={searchInput} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={inApp ? "Search titles and handwriting…" : path.length ? "Search all notebooks…" : "Search by title…"} className="field pl-9" />
              </label>
              <label>
                <span className="sr-only">Sort by</span>
                <select value={sort} onChange={(e) => setSort(e.target.value as LibrarySort)} className="field w-auto pr-8">
                  <option value="recent">Recently edited</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="title">Title A–Z</option>
                </select>
              </label>
              <div role="group" aria-label="View" className="flex rounded-[0.625rem] border border-slate-200 p-0.5">
                <button type="button" aria-pressed={view === "grid"} onClick={() => setView("grid")} className="btn btn-ghost btn-sm" title="Grid"><Icon name="layers" /><span className="sr-only">Grid view</span></button>
                <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")} className="btn btn-ghost btn-sm" title="List"><Icon name="list" /><span className="sr-only">List view</span></button>
              </div>
              <button type="button" aria-pressed={selectMode} onClick={() => (selectMode ? clearSelection() : setSelectMode(true))} className="btn btn-ghost">{selectMode ? "Done" : "Select"}</button>
            </div>
          )}
        </section>

        {error && <p role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</p>}
        {ipadNb && (
          <Link href={`/notebook?id=${ipadNb.id}`} onClick={(e) => { if (openNotebookNative(ipadNb.id)) e.preventDefault(); }} className="mb-6 flex items-center gap-3 rounded-2xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800 transition-colors hover:bg-brand-100">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600 text-on-accent"><Icon name="tablet" /></span>
            <span className="min-w-0 break-words">Currently on <strong>{ipadNb.data.title}</strong>. Open and follow →</span>
          </Link>
        )}

        <div data-no-marquee><PdfImport ref={pdf} folderId={current} /></div>

        {loading ? <p role="status" className="py-12 text-center text-slate-500">Loading notebooks…</p> : nothingAtAll ? (
          <div className="mt-8 rounded-2xl border border-slate-200 bg-white px-6 py-14 text-center shadow-card">
            <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-2xl text-brand-600"><Icon name="notebook" /></span>
            <p className="mb-2 text-lg font-semibold text-slate-900">Start your first notebook</p>
            <p className="mx-auto max-w-md text-sm text-slate-500">
              Import PDFs above, drop your lecture notes into <Link href="/import" className="font-medium text-brand-700 hover:underline">AI import</Link> to get notes and practice to write on, or start a blank notebook.
            </p>
            <button disabled={busy} onClick={newBlank} className="btn btn-primary mt-6"><Icon name="plus" />New notebook</button>
          </div>
        ) : !order.length ? (
          searching ? (
            <div className="card mt-8 p-10 text-center">
              <h3 className="font-medium text-slate-900">No matching notebooks</h3>
              <p className="mt-2 text-sm text-slate-500">Try another title or clear your search to see all your notebooks.</p>
              <button onClick={() => { setQuery(""); searchInput.current?.focus(); }} className="btn btn-secondary mt-4">Clear search</button>
            </div>
          ) : (
            <div className="mt-8 rounded-2xl border border-dashed border-slate-200 px-6 py-12 text-center">
              <p className="mb-2 font-medium text-slate-900">{path.length ? "This folder is empty" : "Nothing at the top level"}</p>
              <p className="mx-auto max-w-md text-sm text-slate-500">Import PDFs above or start a notebook here. To bring in notebooks from elsewhere, select them and use Move to….</p>
              <button disabled={busy} onClick={newBlank} className="btn btn-primary mt-5"><Icon name="plus" />New notebook</button>
            </div>
          )
        ) : (
          <>
            <div className="mb-3 mt-8 flex items-center gap-3">
              {view === "list" && (
                <button type="button" role="checkbox" aria-checked={sel.length === order.length ? true : sel.length ? "mixed" : false} aria-label="Select all"
                  onClick={() => (sel.length === order.length ? clearSelection() : setSelected(new Set(order)))}
                  className={`ml-3 flex h-6 w-6 items-center justify-center rounded-full border text-xs ${sel.length ? "border-brand-600 bg-brand-600 text-on-accent" : "border-slate-300 text-transparent"}`}>
                  <Icon name={sel.length && sel.length < order.length ? "minus" : "tick"} />
                </button>
              )}
              <p role="status" className="text-xs font-medium uppercase tracking-wide text-slate-400">
                {[shownFolders.length ? plural(shownFolders.length, "folder") : "", sorted.length || !shownFolders.length ? `${sorted.length} of ${plural(scope.length, "notebook")}` : ""].filter(Boolean).join(" · ")}
                {searching && " found in all folders"}
                {searching && !!path.length && <span className="normal-case tracking-normal"> · new items go to “{path.at(-1)!.data.name}”</span>}
              </p>
            </div>
            {view === "list" ? (
              <ul aria-label="Notebooks and folders" className="card overflow-hidden">{[...shownFolders, ...sorted].map(card)}</ul>
            ) : (
              <>
                {!!shownFolders.length && <ul aria-label="Folders" className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{shownFolders.map(card)}</ul>}
                {!!sorted.length && <ul aria-label="Notebooks" className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{sorted.map(card)}</ul>}
              </>
            )}
            {!sorted.length && !searching && path.length > 0 && <p className="mt-6 text-center text-sm text-slate-400">No notebooks in this folder yet.</p>}
          </>
        )}
      </main>

      {!!cutLive.length && !selecting && (
        <div role="status" data-no-marquee className="card fixed bottom-6 left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-wrap items-center gap-2 py-2 pl-4 pr-2 text-sm text-slate-700 shadow-lift">
          <span className="min-w-0 flex-1">{plural(cutLive.length, "item")} ready to move. Open the folder you want, then paste.</span>
          <button type="button" disabled={busy || !movable(cutLive, current, byId).length} onClick={paste} className="btn btn-primary btn-sm">Paste in {path.at(-1)?.data.name ?? "top level"}</button>
          <button type="button" onClick={() => setCut(null)} className="btn btn-ghost btn-sm">Cancel</button>
        </div>
      )}

      {marquee.box && (
        <div aria-hidden className="pointer-events-none fixed z-30 rounded-sm border border-brand-500 bg-brand-500/10"
          style={{ left: marquee.box.left, top: marquee.box.top, width: marquee.box.right - marquee.box.left, height: marquee.box.bottom - marquee.box.top }} />
      )}

      {selecting && (
        <SelectionBar
          count={sel.length}
          total={order.length}
          busy={busy}
          canMoveUp={canMoveUp(sel)}
          onSelectAll={() => setSelected(new Set(order))}
          onMove={() => setMoving(sel)}
          onMoveUp={() => moveUp(sel)}
          onGroup={() => setNaming({ group: sel })}
          onDelete={() => setDeleting(sel)}
          onDone={clearSelection}
        />
      )}

      {menu && <ItemMenu x={menu.x} y={menu.y} entries={menuItems(menu.ids)} onPick={(action) => runMenu(action, menu.ids)} onClose={() => setMenu(null)} />}
      {renaming && (renaming.kind === "folder"
        ? <FolderNameDialog folder={renaming} onCancel={() => setRenaming(null)} onSave={(name) => rename(renaming, name)} />
        : <RenameDialog notebook={renaming} onCancel={() => setRenaming(null)} onRename={(title) => rename(renaming, title)} />)}
      {naming && <FolderNameDialog count={naming.group?.length} onCancel={() => setNaming(null)} onSave={(name) => (naming.group ? group(naming.group, name) : newFolder(name))} />}
      {moving && <MoveDialog items={resolve(moving)} folders={folders ?? []} onCancel={() => setMoving(null)} onMove={(to) => moveTo(moving, to)}
        onCreate={async (name, under) => createFolder(name, under || undefined)} />}
      {deleting && <DeleteDialog items={resolve(deleting)} inside={inside} onCancel={() => setDeleting(null)} onDelete={() => remove(deleting)} />}
      {toast && <UndoToast key={toast.key} message={toast.message} raised={selecting || !!cutLive.length} onUndo={toast.undo && (() => { const undo = toast.undo!; setToast(null); void mutate(undo); })} onClose={() => setToast(null)} />}
    </>
  );
}

// -----------------------------------------------------------------------------------------------

type MenuAction = "new-notebook" | "new-folder" | "select-all" | "cut" | "paste" | "open" | "open-tab" | "rename" | "move" | "move-up" | "group" | "deselect" | "select" | "delete";
interface MenuEntry { id: MenuAction; icon: IconName; label: string; hint?: string; danger?: boolean }

/** A context menu at a point, kept on screen. Closes on Escape, a press outside, scroll or resize. */
export function ItemMenu({ x, y, entries, onPick, onClose }: { x: number; y: number; entries: MenuEntry[]; onPick: (action: MenuAction) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, y + r.height > window.innerHeight - 8 ? y - r.height : y)}px`;
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [x, y]);
  useEffect(() => {
    const onClose = () => close.current();
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const rows = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
        const i = rows.indexOf(document.activeElement as HTMLElement);
        rows[(i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
      }
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, []);
  return (
    <div ref={ref} role="menu" data-no-marquee className="card fixed z-50 min-w-52 p-1 shadow-lift" style={{ left: x, top: y }}>
      {entries.map((m) => (
        <button key={m.id} type="button" role="menuitem" onClick={() => { onClose(); onPick(m.id); }}
          className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none transition-colors hover:bg-slate-100 focus:bg-slate-100 pointer-coarse:py-3 pointer-coarse:text-[15px] ${m.danger ? "text-rose-700" : "text-slate-700"}`}>
          <Icon name={m.icon} className="shrink-0" />
          <span className="flex-1">{m.label}</span>
          {m.hint && <span className="pl-4 text-xs text-slate-400 pointer-coarse:hidden">{m.hint}</span>}
        </button>
      ))}
    </div>
  );
}

export function SelectionBar({ count, total, busy, canMoveUp, onSelectAll, onMove, onMoveUp, onGroup, onDelete, onDone }: {
  count: number; total: number; busy: boolean; canMoveUp: boolean;
  onSelectAll: () => void; onMove: () => void; onMoveUp: () => void; onGroup: () => void; onDelete: () => void; onDone: () => void;
}) {
  const none = busy || !count;
  return (
    <div role="toolbar" aria-label="Selection" data-no-marquee className="card fixed bottom-6 left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 flex-wrap items-center gap-1 p-2 text-sm shadow-lift">
      <span role="status" className="px-2 font-medium text-slate-800">{count ? `${count} selected` : "Select items"}</span>
      {count < total && <button type="button" onClick={onSelectAll} className="btn btn-ghost btn-sm">Select all</button>}
      <span className="ml-auto flex flex-wrap items-center gap-1">
        <button type="button" disabled={none} onClick={onMove} className="btn btn-ghost btn-sm"><Icon name="folderMove" />Move to…</button>
        <button type="button" disabled={none || !canMoveUp} onClick={onMoveUp} className="btn btn-ghost btn-sm" title="Move to the parent folder"><Icon name="arrowUp" />Move up</button>
        <button type="button" disabled={none} onClick={onGroup} className="btn btn-ghost btn-sm"><Icon name="folderPlus" />New folder</button>
        <button type="button" disabled={none} onClick={onDelete} className="btn btn-ghost btn-sm !text-rose-700 hover:!bg-rose-50"><Icon name="trash" />Delete</button>
        <button type="button" onClick={onDone} aria-label="Clear selection" title="Clear selection (Esc)" className="icon-btn h-8 w-8"><Icon name="x" /></button>
      </span>
    </div>
  );
}

export function RenameDialog({ notebook, onCancel, onRename }: { notebook: NotebookEntity; onCancel: () => void; onRename: (title: string) => void }) {
  const [title, setTitle] = useState(notebook.data.title);
  return (
    <Dialog title="Rename notebook" onClose={onCancel} onSubmit={() => { if (title.trim()) onRename(title.trim()); }}>
      <label className="mt-4 block">
        <span className="sr-only">Notebook title</span>
        <input data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} className="field" />
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={!title.trim()} className="btn btn-primary">Rename</button>
      </div>
    </Dialog>
  );
}

/** Names a new folder, renames one, or (with `count`) names the folder the selection goes into. */
export function FolderNameDialog({ folder, count, onCancel, onSave }: { folder?: FolderEntity; count?: number; onCancel: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(folder?.data.name ?? "");
  return (
    <Dialog title={folder ? "Rename folder" : count ? `New folder with ${plural(count, "item")}` : "New folder"} onClose={onCancel} onSubmit={() => { if (name.trim()) onSave(name.trim()); }}>
      <label className="mt-4 block">
        <span className="sr-only">Folder name</span>
        <input data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Folder name" maxLength={200} className="field" />
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={!name.trim()} className="btn btn-primary">{folder ? "Rename" : "Create"}</button>
      </div>
    </Dialog>
  );
}

/**
 * Picks where the items go. A folder can't move into itself or a folder inside it, and a new
 * folder can be made on the way.
 */
export function MoveDialog({ items, folders, onCancel, onMove, onCreate }: {
  items: Item[]; folders: FolderEntity[]; onCancel: () => void; onMove: (folderId: string) => void; onCreate?: (name: string, under: string) => Promise<string>;
}) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const froms = new Set(items.map((i) => folderOf(i, byId)));
  const from = froms.size === 1 ? [...froms][0] : null;
  // Items from different folders start with nothing chosen, so the move is a deliberate pick.
  const [to, setTo] = useState<string | null>(from);
  const [adding, setAdding] = useState<string | null>(null);
  const blocked = (id: string) => items.some((i) => i.kind === "folder" && id && isWithin(id, i.id, byId));
  // Depth-first, so each folder sits under its parent. Moving folders and what's inside them are left out.
  const rows: { id: string; name: string; depth: number }[] = [{ id: "", name: "All notebooks (top level)", depth: 0 }];
  const walk = (parent: string, depth: number) => {
    for (const f of sortFolders(folders.filter((f) => folderOf(f, byId) === parent))) {
      if (blocked(f.id)) continue;
      rows.push({ id: f.id, name: f.data.name, depth });
      walk(f.id, depth + 1);
    }
  };
  walk("", 1);
  const canMove = to !== null && movable(items, to, byId).length > 0;
  const create = async () => {
    const name = adding?.trim();
    if (!name || !onCreate) return;
    setAdding(null);
    setTo(await onCreate(name, to ?? ""));
  };
  const title = items.length === 1 ? `Move “${itemName(items[0])}”` : `Move ${plural(items.length, "item")}`;
  return (
    <Dialog title={title} onClose={onCancel} onSubmit={() => { if (adding !== null) void create(); else if (canMove) onMove(to!); }}>
      <div role="radiogroup" aria-label="Destination folder" className="mt-4 max-h-80 space-y-0.5 overflow-y-auto rounded-xl border border-slate-200 p-1">
        {rows.map((r) => (
          <label key={r.id} onDoubleClick={() => { if (movable(items, r.id, byId).length) onMove(r.id); }}
            className={`flex cursor-pointer items-center gap-2 rounded-lg py-2 pr-2 text-sm ${to === r.id ? "bg-brand-50 text-brand-800" : "text-slate-700 hover:bg-slate-50"}`} style={{ paddingLeft: 8 + r.depth * 16 }}>
            <input type="radio" name="destination" checked={to === r.id} onChange={() => setTo(r.id)} className="sr-only" />
            <Icon name={r.id ? "folder" : "notebook"} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
            {r.id === from && <span className="shrink-0 text-xs text-slate-400">Current</span>}
          </label>
        ))}
      </div>
      {onCreate && (adding === null ? (
        <button type="button" onClick={() => setAdding("")} className="btn btn-ghost btn-sm mt-2"><Icon name="folderPlus" />New folder in {to ? `“${byId.get(to)?.data.name}”` : "the top level"}</button>
      ) : (
        <div className="mt-2 flex gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">New folder name</span>
            <input data-autofocus autoFocus value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Folder name" maxLength={200} className="field" />
          </label>
          <button type="button" onClick={() => setAdding(null)} className="btn btn-secondary">Cancel</button>
          <button type="button" disabled={!adding.trim()} onClick={() => void create()} className="btn btn-secondary">Create</button>
        </div>
      ))}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
        <button type="submit" data-autofocus={adding === null || undefined} disabled={!canMove && adding === null} className="btn btn-primary">{to === null ? "Choose a folder" : `Move to ${to ? `“${byId.get(to)?.data.name}”` : "top level"}`}</button>
      </div>
    </Dialog>
  );
}

export function DeleteDialog({ items, inside, onCancel, onDelete }: { items: Item[]; inside?: (id: string) => number; onCancel: () => void; onDelete: () => void }) {
  const folders = items.filter((i) => i.kind === "folder");
  const notebooks = items.length - folders.length;
  const kept = folders.reduce((n, f) => n + (inside?.(f.id) ?? 0), 0);
  const title = items.length === 1 ? `Delete “${itemName(items[0])}”?` : `Delete ${plural(items.length, "item")}?`;
  return (
    <Dialog title={title} onClose={onCancel} onSubmit={onDelete}>
      <div className="mt-2 space-y-1 break-words text-sm text-slate-500">
        {!!notebooks && <p>{notebooks === 1 && items.length === 1 ? "The notebook and its pages are" : `${plural(notebooks, "notebook")} and their pages are`} removed from all your devices.</p>}
        {!!folders.length && <p>{kept ? `Nothing else inside ${folders.length === 1 ? "the folder" : "these folders"} is deleted: it moves up a level.` : folders.length === 1 ? "The folder is empty." : "The folders are removed."}</p>}
        <p>You can undo this for a few seconds.</p>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
        <button type="submit" data-autofocus className="btn btn-secondary !border-rose-200 !text-rose-700 hover:!bg-rose-50"><Icon name="trash" />Delete</button>
      </div>
    </Dialog>
  );
}

export function UndoToast({ message, raised, onUndo, onClose }: { message: string; raised?: boolean; onUndo?: () => void; onClose?: () => void }) {
  return (
    <div role="status" data-no-marquee className={`card fixed left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 items-center gap-3 py-2 pl-4 pr-2 text-sm text-slate-700 shadow-lift ${raised ? "bottom-28 sm:bottom-24" : "bottom-6"}`}>
      <span className="min-w-0 flex-1 truncate">{message}</span>
      {onUndo && <button type="button" onClick={onUndo} className="btn btn-sm btn-ghost font-semibold !text-brand-700">Undo</button>}
      {onClose && <button type="button" onClick={onClose} aria-label="Dismiss" className="icon-btn h-7 w-7"><Icon name="x" /></button>}
    </div>
  );
}
