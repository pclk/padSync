import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./helpers/env";
import type { Sql } from "@/server/db";
import { readPrefs, writePref } from "@/server/prefs";
import { modelChoice, newChatSettings, sameModel } from "@/lib/chat-ui";

describe("default model for new chats", () => {
  const lastUsed = { agent: "codex" as const, options: { model: "gpt-6.2-sol", effort: "medium", account: "codex_work", webSearch: false, allowCode: true } };

  it("takes the model from the synced default and the tools from this device", () => {
    const def = { agent: "claude" as const, options: { model: "claude-opus-5-5", effort: "high" } };
    expect(newChatSettings(lastUsed, def)).toEqual({
      agent: "claude",
      options: { model: "claude-opus-5-5", effort: "high", webSearch: false, allowCode: true },
    });
    expect(newChatSettings(lastUsed, null)).toBe(lastUsed);
  });

  it("compares only the model part", () => {
    expect(modelChoice(lastUsed)).toEqual({ agent: "codex", options: { model: "gpt-6.2-sol", effort: "medium", account: "codex_work" } });
    expect(sameModel({ ...lastUsed, options: { ...lastUsed.options, webSearch: true } }, modelChoice(lastUsed))).toBe(true);
    expect(sameModel(lastUsed, { agent: "codex", options: { model: "gpt-6.2-sol" } })).toBe(false);
    expect(sameModel(lastUsed, null)).toBe(false);
  });
});

describe("synced preferences", () => {
  let sql: Sql;
  beforeEach(async () => {
    ({ sql } = await freshDb());
  });

  it("stores one default per login, readable from any device, and clears it", async () => {
    const value = { agent: "claude", options: { model: "claude-sonnet-5-5", effort: "low" } };
    await writePref(sql, "Alice", "chat.defaultModel", value);
    expect((await readPrefs(sql, "alice")).prefs["chat.defaultModel"]).toEqual(value);
    expect((await readPrefs(sql, "bob")).prefs).toEqual({});
    await writePref(sql, "alice", "chat.defaultModel", { agent: "codex", options: {} });
    expect((await readPrefs(sql, "alice")).prefs["chat.defaultModel"]).toEqual({ agent: "codex", options: {} });
    await writePref(sql, "alice", "chat.defaultModel", null);
    expect((await readPrefs(sql, "alice")).prefs).toEqual({});
  });

  it("refuses values that are not a model choice", async () => {
    await expect(writePref(sql, "alice", "chat.defaultModel", { agent: "gpt", options: {} })).rejects.toThrow();
    await expect(writePref(sql, "alice", "chat.defaultModel", { agent: "claude", options: { webSearch: true } })).rejects.toThrow();
    await expect(writePref(sql, "alice", "chat.defaultModel", { agent: "claude", options: { model: "bad id!" } })).rejects.toThrow();
  });
});
