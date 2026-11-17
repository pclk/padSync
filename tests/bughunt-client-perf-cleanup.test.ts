import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("presence clock state is isolated from the panel and AskPanel", () => {
  const panel = source("components/SidePanel.tsx");
  const parent = panel.slice(panel.indexOf("export function SidePanel"), panel.indexOf("function PresenceAge"));
  expect(parent).not.toContain("setInterval");
  expect(panel).toContain("<PresenceAge at={p.ipad.data.at}");
});

test("overlay detach cancels scheduled paint and releases its bitmap", () => {
  const controller = source("ink/controller.ts");
  expect(controller).toContain("cancelAnimationFrame(this.frame)");
  expect(controller).toContain("this.live.width = 0");
  expect(controller).toContain("this.pending.clear()");
});
