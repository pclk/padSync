import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

function worker() {
  const handlers: Record<string, (event: unknown) => void> = {};
  const put = vi.fn();
  const addAll = vi.fn();
  const match = vi.fn();
  const fetch = vi.fn(async () => new Response("missing", { status: 404 }));
  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    importScripts: vi.fn(),
    Request: class { constructor(readonly url: string) {} },
    self: { padSyncBuild: {cache: "padsync-build-test", assets: ["/_next/static/chunks/library.js"]}, location: { origin: "https://app.test" }, addEventListener: (name: string, fn: (event: unknown) => void) => { handlers[name] = fn; } },
    URL, fetch, caches: { match: async () => undefined, open: async () => ({ put, addAll, match }) },
  });
  return { handlers, put, addAll, match };
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

it("installs the lazy library chunk together with the notebook shell", async () => {
  const { handlers, addAll } = worker();
  let installed: Promise<void> | undefined;
  handlers.install({ waitUntil: (p: Promise<void>) => { installed = p; } });
  await installed;
  expect(addAll.mock.calls[0][0].map((r: Request) => r.url)).toEqual(expect.arrayContaining(["/", "/notebook", "/_next/static/chunks/library.js"]));
});

it("opens a saved notebook from its build's cached shell", async () => {
  const { handlers, match } = worker();
  match.mockResolvedValue(new Response("notebook"));
  let response: Promise<Response> | undefined;
  handlers.fetch({ request: { method: "GET", url: "https://app.test/notebook?id=saved", mode: "navigate" }, respondWith: (r: Promise<Response>) => { response = r; } });
  expect(await (await response)?.text()).toBe("notebook");
  expect(match).toHaveBeenCalledWith("/notebook", { ignoreVary: true });
});
