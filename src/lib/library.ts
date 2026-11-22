import type { FolderEntity, NotebookEntity } from "./types";

export type LibrarySort = "recent" | "newest" | "oldest" | "title";

/** Keep search literal and deterministic; never mutate the live query result. `alsoMatching` are
 *  notebooks the search found another way (their handwriting, in the iPad app). */
export function selectNotebooks(notebooks: NotebookEntity[], query: string, sort: LibrarySort, edited?: Map<string, number>, alsoMatching?: ReadonlySet<string>) {
  const term = query.trim().toLocaleLowerCase();
  const editedAt = (nb: NotebookEntity) => edited?.get(nb.id) ?? nb.data.createdAt;
  return notebooks.filter((nb) => nb.data.title.toLocaleLowerCase().includes(term) || !!alsoMatching?.has(nb.id)).sort((a, b) => {
    const order = sort === "title"
      ? a.data.title.localeCompare(b.data.title)
      : sort === "recent" ? editedAt(b) - editedAt(a)
      : sort === "oldest" ? a.data.createdAt - b.data.createdAt : b.data.createdAt - a.data.createdAt;
    return order || a.id.localeCompare(b.id);
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Edited 5 min ago". A stamp from a clock ahead of ours reads as "just now". */
export function formatEdited(at: number, now: number) {
  const ago = Math.max(0, now - at);
  if (ago < MINUTE) return "Edited just now";
  if (ago < HOUR) return `Edited ${Math.floor(ago / MINUTE)} min ago`;
  if (ago < DAY) return `Edited ${Math.floor(ago / HOUR)} h ago`;
  const days = Math.floor(ago / DAY);
  if (days === 1) return "Edited yesterday";
  if (days < 7) return `Edited ${days} days ago`;
  return `Edited ${new Date(at).toLocaleDateString()}`;
}

/** The folder an item sits in, or "" for the top level (also when its folder is gone). */
export function folderOf(item: NotebookEntity | FolderEntity, folders: Map<string, FolderEntity>) {
  const id = item.data.folderId;
  return id && folders.has(id) ? id : "";
}

/** The folders from the top level down to `id` (empty at the top level). Stops on a cycle. */
export function folderPath(id: string, folders: Map<string, FolderEntity>) {
  const path: FolderEntity[] = [];
  for (let f = folders.get(id); f && !path.includes(f); f = f.data.folderId ? folders.get(f.data.folderId) : undefined) path.unshift(f);
  return path;
}

/** Whether `id` is `ancestor` or sits somewhere inside it; a folder can't move into these. */
export function isWithin(id: string, ancestor: string, folders: Map<string, FolderEntity>) {
  return id === ancestor || folderPath(id, folders).some((f) => f.id === ancestor);
}

export function sortFolders(folders: FolderEntity[]) {
  return [...folders].sort((a, b) => a.data.name.localeCompare(b.data.name, undefined, { numeric: true }) || a.id.localeCompare(b.id));
}

export type LibraryItem = NotebookEntity | FolderEntity;

export const itemName = (i: LibraryItem) => (i.kind === "folder" ? i.data.name : i.data.title);

/**
 * Shift-click: the items from the anchor to `id` in display order. With no usable anchor it is
 * just `id`.
 */
export function rangeIds(order: string[], anchor: string | null, id: string) {
  const a = anchor ? order.indexOf(anchor) : -1;
  const b = order.indexOf(id);
  if (b < 0) return [];
  if (a < 0) return [id];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export interface Box { left: number; top: number; right: number; bottom: number }

/** The rectangle two corners span, either way round. */
export function boxFrom(x1: number, y1: number, x2: number, y2: number): Box {
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), right: Math.max(x1, x2), bottom: Math.max(y1, y2) };
}

export function boxesOverlap(a: Box, b: Box) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Which of `items` can go into folder `to`: not ones already there, and not a folder into itself
 * or into a folder inside it. Items whose folder is also moving stay put inside it, so they are
 * left out too (moving a folder carries its contents).
 */
export function movable(items: LibraryItem[], to: string, folders: Map<string, FolderEntity>) {
  const moving = new Set(items.filter((i) => i.kind === "folder").map((i) => i.id));
  return items.filter((i) => {
    if (folderOf(i, folders) === to) return false;
    if (i.kind === "folder" && to && isWithin(to, i.id, folders)) return false;
    return !folderPath(folderOf(i, folders), folders).some((f) => moving.has(f.id));
  });
}

/** The folder one level above where an item sits, or null when it is already at the top level. */
export function parentFolder(item: LibraryItem, folders: Map<string, FolderEntity>) {
  const at = folderOf(item, folders);
  return at ? folderOf(folders.get(at)!, folders) : null;
}
