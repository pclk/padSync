import type { NotebookEntity } from "./types";

export type LibrarySort = "recent" | "newest" | "oldest" | "title";

/** Keep search literal and deterministic; never mutate the live query result. */
export function selectNotebooks(notebooks: NotebookEntity[], query: string, sort: LibrarySort, edited?: Map<string, number>) {
  const term = query.trim().toLocaleLowerCase();
  const editedAt = (nb: NotebookEntity) => edited?.get(nb.id) ?? nb.data.createdAt;
  return notebooks.filter((nb) => nb.data.title.toLocaleLowerCase().includes(term)).sort((a, b) => {
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
