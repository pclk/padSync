// Per-session undo stack. Entries are closures over entity writes, so undo is itself a synced
// edit (it re-stamps the entities) and shows up on the other device.

interface Entry {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

const LIMIT = 200;

export class UndoStack {
  private done: Entry[] = [];
  private undone: Entry[] = [];
  private listeners = new Set<() => void>();

  push(e: Entry) {
    this.done.push(e);
    if (this.done.length > LIMIT) this.done.shift();
    this.undone = [];
    this.emit();
  }

  async undo() {
    const e = this.done.pop();
    if (!e) return null;
    await e.undo();
    this.undone.push(e);
    this.emit();
    return e.label;
  }

  async redo() {
    const e = this.undone.pop();
    if (!e) return null;
    await e.redo();
    this.done.push(e);
    this.emit();
    return e.label;
  }

  get canUndo() {
    return this.done.length > 0;
  }

  get canRedo() {
    return this.undone.length > 0;
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }
}
