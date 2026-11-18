import "fake-indexeddb/auto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// Settings groups its sections so the everyday ones come first and both Pencil tools sit
// together under Troubleshooting, each saying what it is for.

beforeAll(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) });
  vi.stubGlobal("window", { location: { search: "" }, addEventListener() {}, removeEventListener() {} });
});
afterAll(() => vi.unstubAllGlobals());

const render = async () => {
  const { default: SettingsView } = await import("@/components/SettingsView");
  return renderToStaticMarkup(createElement(SettingsView));
};
const headings = (html: string) => [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
const sections = (html: string) => html.split("<section").slice(1);

it("puts account and everyday settings before the troubleshooting tools", async () => {
  expect(headings(await render())).toEqual(["Account and sync", "Appearance", "Notebook", "NUS Canvas", "Troubleshooting"]);
});

it("keeps both Pencil tools in one section, each with its purpose", async () => {
  const html = await render();
  const tools = sections(html).filter((s) => s.includes('href="/pencil-test"') || s.includes('href="/pencil-lab"'));
  expect(tools).toHaveLength(1);
  expect(tools[0]).toContain("Troubleshooting");
  expect(tools[0]).toContain('href="/pencil-test"');
  expect(tools[0]).toContain('href="/pencil-lab"');
  expect(tools[0]).toContain("what Safari sends");
  expect(tools[0]).toContain("how padSync draws it");
});

it("explains the layout idle delay in terms of Auto layout", async () => {
  const notebook = sections(await render()).find((s) => s.includes(">Notebook</h2>"))!;
  expect(notebook).toContain('aria-label="Layout idle delay"');
  expect(notebook).toContain("Auto layout: switch to chat after 15 s");
});
