import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountDetail, claudeModels, codexDefaults, codexHomes, codexModels, discoverCatalog } from "../bridge/catalog.ts";
import { cleanOptions } from "../bridge/lib.ts";
import { POST as catalogPost } from "@/app/api/bridge/catalog/route";
import { GET as catalogGet } from "@/app/api/chat/catalog/route";
import {
  accountFor,
  chooseModel,
  dateGroup,
  describeModel,
  fallbackCatalog,
  filterModels,
  focusedSection,
  reusableThread,
  toolsOf,
} from "@/lib/chat-ui";
import type { CatalogAccount, ThreadSummary } from "@/lib/chat-types";
import type { Sql } from "@/server/db";
import { createDeviceToken } from "@/server/tokens";
import { configureAuthEnv, freshDb, req, sessionCookie } from "./helpers/env";

// Chat revamp (2026-11-18): the Mac's logins and models feed the model picker, Codex jobs run
// under the chosen login, "New chat" reuses an empty chat, and context follows the iPad.

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const codexCache = {
  models: [
    { slug: "gpt-b", display_name: "GPT-B", description: "Legacy model", visibility: "list", priority: 2, supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }], default_reasoning_level: "low", context_window: 272000 },
    { slug: "hidden", display_name: "Hidden", visibility: "hide", priority: 0, supported_reasoning_levels: [] },
    { slug: "gpt-a", display_name: "GPT-A", description: "Fast", visibility: "list", priority: 1, supported_reasoning_levels: [{ effort: "medium" }, { effort: "bogus" }] },
  ],
};

describe("bridge catalog discovery", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "catalog-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });
  const codexDir = async (name: string, auth = true) => {
    await mkdir(join(home, name));
    if (auth) await writeFile(join(home, name, "auth.json"), JSON.stringify({ tokens: { id_token: jwt({ email: `${name}@x.test`, "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } }), access_token: "SECRET" } }));
    await writeFile(join(home, name, "models_cache.json"), JSON.stringify(codexCache));
    await writeFile(join(home, name, "config.toml"), 'model = "gpt-a"\nmodel_reasoning_effort = "max"\n[projects."x"]\nmodel = "nope"\n');
  };

  it("finds every Codex home with a login and skips backups and half-set-up folders", async () => {
    await codexDir(".codex");
    await codexDir(".codex_work");
    await codexDir(".codex_work_setup_backup");
    await codexDir(".codex_empty", false);
    expect(Object.keys(await codexHomes(home)).sort()).toEqual(["codex", "codex_work"]);
    expect(await codexHomes(home, { extra: "/opt/x", "../bad": "/etc" })).toMatchObject({ extra: "/opt/x" });
  });

  it("lists listed models by priority with their efforts, and never the tokens", async () => {
    await codexDir(".codex_work");
    const c = await discoverCatalog({ home, agents: ["codex"] });
    expect(c.homes).toEqual({ codex_work: join(home, ".codex_work") });
    const [a] = c.accounts;
    expect(a).toMatchObject({ id: "codex_work", agent: "codex", label: "Codex · Work", detail: ".codex_work@x.test · Plus", defaultModel: "gpt-a", defaultEffort: "max" });
    expect(a.models.map((m) => [m.id, m.efforts, !!m.more])).toEqual([
      ["gpt-a", ["medium"], false],
      ["gpt-b", ["low", "max"], true],
    ]);
    expect(JSON.stringify(c)).not.toContain("SECRET");
  });

  it("discovers Claude Work separately and preserves its selection", async () => {
    const discover = () => discoverCatalog({ home, agents: ["claude"] });
    expect((await discover()).accounts.map(a => a.id)).toEqual(["claude"]);
    const dir = join(home, ".claude_work");
    await mkdir(dir);
    await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "work@example.com" } }));
    const { accounts, claudeWorkHome } = await discover();
    expect(claudeWorkHome).toBe(dir);
    const work = accounts[1];
    expect(work).toMatchObject({ id: "claude_work", detail: "work@example.com" });
    const selected = chooseModel({}, work, work.models[0]);
    expect(accountFor(accounts, selected)).toBe(work);
    expect(accountFor(accounts.slice(0, 1), selected)).toBeUndefined();
    expect(chooseModel(selected.options, accounts[0], accounts[0].models[0]).options.account).toBeUndefined();
  });

  it("reads Claude Code's cached catalog, the CLI surface first, else a built-in list", () => {
    const file = (surface: string, at: number, id: string) => ({ fetchedAt: at, catalog: { surface, config: { models: [{ id, name: id.toUpperCase(), section: "main", runtime: { effort_levels: ["low", "high"], default_effort: "low", max_input_tokens: 1000 } }, { id: "old-1", name: "Old", section: "overflow" }] } } });
    const models = claudeModels([file("ccd", 2, "desktop"), file("cc", 1, "cli")]);
    expect(models.map((m) => [m.id, !!m.more])).toEqual([["cli", false], ["old-1", true]]);
    expect(models[0]).toMatchObject({ label: "CLI", efforts: ["low", "high"], defaultEffort: "low", contextWindow: 1000 });
    expect(claudeModels([])).toEqual([]);
  });

  it("parses only top-level config keys and tolerates odd auth files", () => {
    expect(codexDefaults('model = "m"\n[x]\nmodel_reasoning_effort = "low"')).toEqual({ model: "m", effort: undefined });
    expect(accountDetail(null)).toBeUndefined();
    expect(accountDetail({ OPENAI_API_KEY: "k" })).toBe("API key");
    expect(accountDetail({ tokens: { id_token: "garbage" } })).toBeUndefined();
    expect(codexModels({ models: "nope" } as never)).toEqual([]);
  });

  it("preserves named logins for both CLIs", () => {
    expect(cleanOptions("codex", { account: "codex_work" }).account).toBe("codex_work");
    expect(cleanOptions("codex", { account: "../etc" }).account).toBeUndefined();
    expect(cleanOptions("claude", { account: "claude_work" }).account).toBe("claude_work");
  });
});

describe("catalog API", () => {
  let sql: Sql;
  beforeEach(async () => {
    configureAuthEnv();
    ({ sql } = await freshDb());
  });
  const accounts: CatalogAccount[] = [
    { id: "claude", agent: "claude", label: "Claude", models: [{ id: "claude-opus-5-5", label: "Opus 5.5", efforts: ["low", "max"] }] },
    { id: "codex_work", agent: "codex", label: "Codex · Work", detail: "me@x.test · Education", models: [] },
  ];

  it("stores what the bridge sends and serves the newest to signed-in users", async () => {
    const empty = await catalogGet(req("/api/chat/catalog", { session: sessionCookie() }));
    expect(await empty.json()).toEqual({ accounts: null, updatedAt: null });
    const { token } = await createDeviceToken(sql, "Mac", "pclk");
    expect((await catalogPost(req("/api/bridge/catalog", { body: { accounts }, bearer: token }))).status).toBe(200);
    const res = await catalogGet(req("/api/chat/catalog", { session: sessionCookie() }));
    expect(((await res.json()) as { accounts: unknown }).accounts).toEqual(accounts);
    expect((await catalogGet(req("/api/chat/catalog", { session: false }))).status).toBe(401);
  });

  it("rejects bad catalogs and unauthenticated bridges", async () => {
    const { token } = await createDeviceToken(sql, "Mac", "pclk");
    const bad = [{ ...accounts[0], id: "../x" }];
    expect((await catalogPost(req("/api/bridge/catalog", { body: { accounts: bad }, bearer: token }))).status).toBe(400);
    expect((await catalogPost(req("/api/bridge/catalog", { body: { accounts } }))).status).toBe(401);
  });
});

const thread = (o: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id: "t1", notebookId: "nb", title: "", agent: "claude", options: {}, pinned: false, archived: false,
  createdAt: "2026-11-18T00:00:00Z", updatedAt: "2026-11-18T00:00:00Z", lastMessageAt: null,
  turnCount: 0, lastStatus: null, preview: "", forkedFrom: null, ...o,
});

describe("chat UI decisions", () => {
  const accounts: CatalogAccount[] = [
    { id: "claude", agent: "claude", label: "Claude", defaultModel: "claude-opus-5-5", models: [{ id: "claude-opus-5-5", label: "Opus 5.5", efforts: ["low", "max"] }, { id: "claude-haiku", label: "Haiku", efforts: [] }] },
    { id: "codex", agent: "codex", label: "Codex · Default", models: [{ id: "gpt-a", label: "GPT-A", efforts: ["low"] }] },
    { id: "codex_work", agent: "codex", label: "Codex · Work", detail: "me@nus", models: [{ id: "gpt-a", label: "GPT-A (work)", efforts: ["low"] }] },
  ];

  it("New chat goes to an untouched chat in this notebook before making one", () => {
    const used = thread({ id: "used", turnCount: 2 });
    const fresh = thread({ id: "fresh" });
    expect(reusableThread([used, fresh], "nb")?.id).toBe("fresh");
    expect(reusableThread([used, thread({ id: "other", notebookId: "x" }), thread({ id: "arch", archived: true })], "nb")).toBeNull();
    // The open chat already has a turn the list hasn't caught up with yet.
    expect(reusableThread([fresh], "nb", { id: "fresh", turns: 1 })).toBeNull();
    expect(reusableThread([thread({ id: "a" }), fresh], "nb", { id: "fresh", turns: 0 })?.id).toBe("fresh");
  });

  it("maps a thread to its login and model, defaulting to the agent's own login", () => {
    expect(describeModel(accounts, { agent: "claude", options: {} })).toMatchObject({ label: "Opus 5.5", account: { id: "claude" } });
    expect(describeModel(accounts, { agent: "codex", options: { model: "gpt-a", account: "codex_work" } }).label).toBe("GPT-A (work)");
    expect(accountFor(accounts, { agent: "codex", options: {} })?.id).toBe("codex");
    expect(accountFor(accounts, { agent: "codex", options: { account: "gone" } })).toBeUndefined();
    expect(describeModel(accounts, { agent: "codex", options: { model: "custom-x", account: "gone" } }).label).toBe("custom-x");
  });

  it("switching models keeps a supported effort, drops others, and selects the requested login", () => {
    const opts = { effort: "max", webSearch: false };
    expect(chooseModel(opts, accounts[0], accounts[0].models[0])).toEqual({ agent: "claude", options: { effort: "max", webSearch: false, model: "claude-opus-5-5", account: undefined } });
    expect(chooseModel(opts, accounts[2], accounts[2].models[0]).options).toMatchObject({ account: "codex_work", model: "gpt-a", effort: undefined });
    expect(chooseModel(opts, accounts[0], { id: "custom" }).options.effort).toBe("max");
  });

  it("filters models by any word across label, id and login", () => {
    expect(filterModels(accounts, "work").map((a) => a.id)).toEqual(["codex_work"]);
    expect(filterModels(accounts, "opus max").length).toBe(0);
    expect(filterModels(accounts, "")).toBe(accounts);
  });

  it("web search and code are on unless turned off", () => {
    expect(toolsOf({})).toEqual({ webSearch: true, allowCode: true });
    expect(toolsOf({ webSearch: false, allowCode: false })).toEqual({ webSearch: false, allowCode: false });
  });

  it("groups the sidebar by local day, pinned first", () => {
    const now = new Date(2026, 10, 18, 9).getTime();
    const at = (d: number) => thread({ lastMessageAt: new Date(2026, 10, d, 23).toISOString() });
    expect(dateGroup(at(18), now)).toBe("Today");
    expect(dateGroup(at(17), now)).toBe("Yesterday");
    expect(dateGroup(at(13), now)).toBe("Previous 7 days");
    expect(dateGroup(at(1), now)).toBe("Previous 30 days");
    expect(dateGroup(thread({ lastMessageAt: new Date(2026, 5, 1).toISOString() }), now)).toBe("Older");
    expect(dateGroup(thread({ pinned: true }), now)).toBe("Pinned");
  });

  it("'this section' is the iPad's section while the iPad is in this notebook", () => {
    const s = [{ id: "a" }, { id: "b" }];
    expect(focusedSection(s, s[0], { notebookId: "nb", sectionId: "b" }, "nb")).toEqual({ section: s[1], fromIpad: true });
    expect(focusedSection(s, s[0], { notebookId: "other", sectionId: "b" }, "nb")).toEqual({ section: s[0], fromIpad: false });
    expect(focusedSection(s, s[0], { notebookId: "nb", sectionId: "deleted" }, "nb").fromIpad).toBe(false);
    expect(focusedSection(s, null, null, "nb").section).toBeNull();
  });

  it("falls back to the built-in model list", () => {
    expect(fallbackCatalog().map((a) => a.id)).toEqual(["claude", "codex"]);
    expect(fallbackCatalog()[0].models.every((m) => m.id)).toBe(true);
  });
});
