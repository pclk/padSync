// Where this device last was in each notebook: a section and the logical offset into it. The editor reopens a
// notebook there; writing one first opens a notebook at a chosen page (the Material tab's links to other notebooks).
export type Position = { sectionId: string; offsetY: number };
export const positionKey = (notebookId: string) => `padsync.position.${notebookId}`;

export function readPosition(notebookId: string): Position | null {
  try {
    const p = JSON.parse(localStorage.getItem(positionKey(notebookId)) ?? "null");
    return p && typeof p.sectionId === "string" && typeof p.offsetY === "number" ? p : null;
  } catch {
    return null;
  }
}

export function writePosition(notebookId: string, position: Position) {
  try {
    localStorage.setItem(positionKey(notebookId), JSON.stringify(position));
  } catch {}
}
