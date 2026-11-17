/**
 * Holds one action back for an undo window. It commits when the timer runs out, when another
 * action is scheduled (only one can be undone at a time), or on flush(); undo() takes it back.
 */
export function deferredAction<T>(commit: (item: T) => Promise<void> | void, delayMs: number) {
  let pending: { item: T; timer: ReturnType<typeof setTimeout> } | null = null;
  const take = () => {
    const p = pending;
    if (p) clearTimeout(p.timer);
    pending = null;
    return p?.item;
  };
  const flush = async () => {
    const item = take();
    if (item !== undefined) await commit(item);
  };
  return {
    /** Starts the undo window for `item`, committing the previous pending item first. */
    async schedule(item: T) {
      const prev = take();
      pending = { item, timer: setTimeout(() => void flush(), delayMs) };
      if (prev !== undefined) await commit(prev);
    },
    /** Cancels the pending action and returns it, or undefined when it already committed. */
    undo: take,
    flush,
    pending: () => pending?.item,
  };
}
