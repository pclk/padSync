import type { NotebookEntity } from "./types";

export type LibrarySort = "newest" | "oldest" | "title";

/** Keep search literal and deterministic; never mutate the live query result. */
export function selectNotebooks(notebooks: NotebookEntity[], query: string, sort: LibrarySort) {
  const term = query.trim().toLocaleLowerCase();
  return notebooks.filter((nb) => nb.data.title.toLocaleLowerCase().includes(term)).sort((a, b) => {
    const order = sort === "title"
      ? a.data.title.localeCompare(b.data.title)
      : sort === "oldest" ? a.data.createdAt - b.data.createdAt : b.data.createdAt - a.data.createdAt;
    return order || a.id.localeCompare(b.id);
  });
}
