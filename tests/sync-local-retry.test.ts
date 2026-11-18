import { expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {}, deviceId: () => "dev", getMeta: vi.fn(), setMeta: vi.fn() }));

// Safari's IndexedDB throws UnknownError now and then; sync retries those within a second
// instead of backing off as if the network were down.

it("treats IndexedDB and Dexie storage errors as local, and others not", async () => {
  const { isLocalStorageError } = await import("@/lib/sync");
  expect(isLocalStorageError(new DOMException("x", "UnknownError"))).toBe(true);
  expect(isLocalStorageError({ name: "DatabaseClosedError" })).toBe(true);
  expect(isLocalStorageError({ name: "Error", inner: { name: "AbortError" } })).toBe(true);
  expect(isLocalStorageError(new SyntaxError("bad JSON"))).toBe(false);
  expect(isLocalStorageError(new TypeError("Load failed"))).toBe(false);
  expect(isLocalStorageError(null)).toBe(false);
});
