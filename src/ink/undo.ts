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
    this.revision++;
    this.done.push(e);
    if (this.done.length > LIMIT) this.done.shift();
    this.undone.length = 0;
    this.emit();
  }

  private revision = 0;

  private pending: Promise<unknown> = Promise.resolve();

  private run(source: Entry[], target: Entry[], action: "undo" | "redo") {
    const operation = this.pending.then(async () => {
      const e = source[source.length - 1];
      if (!e) return null;
      const revision = this.revision;
      await e[action]();
      const index = source.indexOf(e);
      if (index !== -1) source.splice(index, 1);
      // A new edit during an undo invalidates its redo, just like a later push.
      if (action === "redo" || revision === this.revision) target.push(e);
      this.emit();
      return e.label;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  undo() {
    return this.run(this.done, this.undone, "undo");
  }

  redo() {
    return this.run(this.undone, this.done, "redo");
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
