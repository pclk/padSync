import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

function worker() {
  const handlers: Record<string, (event: unknown) => void> = {};
  const put = vi.fn();
  const fetch = vi.fn(async () => new Response("missing", { status: 404 }));
  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    self: { location: { origin: "https://app.test" }, addEventListener: (name: string, fn: (event: unknown) => void) => { handlers[name] = fn; } },
    URL, fetch, caches: { match: async () => undefined, open: async () => ({ put }) },
  });
  return { handlers, put };
}
it("does not intercept API root or Next flight requests", () => {
  const { handlers } = worker();
  for (const path of ["/api", "/notebook?_rsc=123"]) {
    const respondWith = vi.fn();
    handlers.fetch({ request: { method: "GET", url: `https://app.test${path}`, mode: "cors" }, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  }
});
it("does not cache missing build assets", async () => {
  const { handlers, put } = worker();
  let response: Promise<Response> | undefined;
  handlers.fetch({ request: { method: "GET", url: "https://app.test/_next/static/old.js" }, respondWith: (r: Promise<Response>) => { response = r; } });
  await response;
  expect(put).not.toHaveBeenCalled();
});
