// What this Mac can run: the Claude Code logins and every Codex home (~/.codex, ~/.codex_work, …),
// each with the models its own CLI cache lists. The bridge sends this to padSync so the model
// picker shows real choices, and maps a job's `account` back to its local profile. Only labels, model
// metadata and the account email/plan are read; tokens never leave auth.json.

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent } from "./lib.ts";

export interface CatalogModel {
  id: string;
  label: string;
  description?: string;
  badge?: string;
  /** Older or less common: shown under "More models". */
  more?: boolean;
  efforts: string[];
  defaultEffort?: string;
  contextWindow?: number;
}

export interface CatalogAccount {
  /** Profile name without the leading dot, such as "claude_work" or "codex". */
  id: string;
  agent: Agent;
  label: string;
  /** e.g. "you@example.com · Plus" */
  detail?: string;
  defaultModel?: string;
  defaultEffort?: string;
  models: CatalogModel[];
}

export interface Catalog {
  accounts: CatalogAccount[];
  /** account id → CODEX_HOME. Stays on this Mac. */
  homes: Record<string, string>;
  claudeWorkHome?: string;
}

export const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const MAX_MODELS = 40;
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

type Json = Record<string, unknown>;
const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const efforts = (v: unknown) => (Array.isArray(v) ? v : []).map((e) => (typeof e === "string" ? e : (e as Json)?.effort ?? (e as Json)?.id)).filter((e): e is string => typeof e === "string" && EFFORTS.includes(e));
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/;

async function readJson(path: string): Promise<Json | null> {
  try {
    const v = JSON.parse(await readFile(path, "utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** Email and plan from the id token's claims (the payload only; nothing is verified or kept). */
export function accountDetail(auth: Json | null): string | undefined {
  const idToken = (auth?.tokens as Json | undefined)?.id_token;
  if (typeof idToken !== "string") return auth?.OPENAI_API_KEY ? "API key" : undefined;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as Json;
    const plan = str((claims["https://api.openai.com/auth"] as Json | undefined)?.chatgpt_plan_type, 40);
    return [str(claims.email, 120), plan && plan[0].toUpperCase() + plan.slice(1)].filter(Boolean).join(" · ") || undefined;
  } catch {
    return undefined;
  }
}

/** `model = "…"` and `model_reasoning_effort = "…"` from the top of config.toml (before any table). */
export function codexDefaults(toml: string) {
  const top = toml.split(/^\s*\[/m)[0];
  const get = (key: string) => top.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
  return { model: get("model"), effort: get("model_reasoning_effort") };
}

export function codexModels(cache: Json | null): CatalogModel[] {
  const list = Array.isArray(cache?.models) ? (cache.models as Json[]) : [];
  return list
    .filter((m) => m && m.visibility === "list" && typeof m.slug === "string" && MODEL_RE.test(m.slug))
    .sort((a, b) => Number(a.priority ?? 99) - Number(b.priority ?? 99))
    .slice(0, MAX_MODELS)
    .map((m) => {
      const description = str(m.description);
      return {
        id: m.slug as string,
        label: str(m.display_name, 60) ?? (m.slug as string),
        description,
        more: /^(legacy|previous)/i.test(description ?? ""),
        efforts: efforts(m.supported_reasoning_levels),
        defaultEffort: str(m.default_reasoning_level, 20),
        contextWindow: typeof m.context_window === "number" ? m.context_window : undefined,
      };
    });
}

/** Claude Code's cached model catalog (~/.claude/cache/model-catalog), the CLI surface ("cc") first. */
export function claudeModels(files: Json[]): CatalogModel[] {
  const pick = [...files].sort((a, b) => {
    const surface = (f: Json) => ((f.catalog as Json | undefined)?.surface === "cc" ? 1 : 0);
    return surface(b) - surface(a) || Number(b.fetchedAt ?? 0) - Number(a.fetchedAt ?? 0);
  })[0];
  const list = (((pick?.catalog as Json | undefined)?.config as Json | undefined)?.models ?? []) as Json[];
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m && typeof m.id === "string" && MODEL_RE.test(m.id))
    .slice(0, MAX_MODELS)
    .map((m) => {
      const runtime = (m.runtime ?? {}) as Json;
      return {
        id: m.id as string,
        label: str(m.name, 60) ?? (m.id as string),
        description: str(m.description),
        badge: str((m.badge as Json | undefined)?.message, 60),
        more: m.section !== "main",
        efforts: efforts(runtime.effort_levels),
        defaultEffort: str(runtime.default_effort, 20),
        contextWindow: typeof runtime.max_input_tokens === "number" ? runtime.max_input_tokens : undefined,
      };
    });
}

/** Shipped choices for when Claude Code has no cached catalog yet. */
const CLAUDE_FALLBACK: CatalogModel[] = [
  { id: "opus", label: "Opus", description: "For complex work and everyday tasks", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "sonnet", label: "Sonnet", description: "Most efficient for simpler tasks", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "fable", label: "Fable", description: "For your toughest challenges", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "haiku", label: "Haiku", description: "Fastest for quick answers", efforts: ["low", "medium", "high", "xhigh", "max"] },
];

function codexLabel(id: string) {
  const name = id.replace(/^codex_?/, "").replace(/[_-]+/g, " ").trim();
  return `Codex · ${name ? name[0].toUpperCase() + name.slice(1) : "Default"}`;
}

/** ~/.codex and ~/.codex_<name> folders that hold a login (backups and half-set-up ones don't). */
export async function codexHomes(home: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const names = await readdir(home).catch(() => [] as string[]);
  for (const name of names.sort()) {
    if (!/^\.codex(_[A-Za-z0-9_-]+)?$/.test(name) || /_backup$/i.test(name)) continue;
    const dir = join(home, name);
    if (!(await stat(join(dir, "auth.json")).catch(() => null))?.isFile()) continue;
    out[name.slice(1)] = dir;
  }
  for (const [id, dir] of Object.entries(extra)) if (ACCOUNT_RE.test(id) && typeof dir === "string") out[id] = dir;
  return out;
}

export async function discoverCatalog(opts: { home?: string; agents: Agent[]; codexHomes?: Record<string, string> }): Promise<Catalog> {
  const home = opts.home ?? homedir();
  const accounts: CatalogAccount[] = [];
  let claudeWorkHome: string | undefined;
  if (opts.agents.includes("claude")) {
    for (const work of [false, true]) {
      const profile = join(home, work ? ".claude_work" : ".claude");
      if (work) {
        if (!(await stat(join(profile, ".claude.json")).catch(() => null))?.isFile()) continue;
        claudeWorkHome = profile;
      }
      const dir = join(profile, "cache", "model-catalog");
      const files = (await Promise.all((await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).map((f) => readJson(join(dir, f))))).filter((f): f is Json => !!f);
      const settings = await readJson(join(profile, "settings.json"));
      const oauth = (await readJson(join(work ? profile : home, ".claude.json")))?.oauthAccount as Json | undefined;
      const models = claudeModels(files);
      accounts.push({
        id: work ? "claude_work" : "claude",
        agent: "claude",
        label: work ? "Claude · Work" : "Claude · Personal",
        detail: str(oauth?.emailAddress, 120),
        defaultModel: str(settings?.model, 80),
        models: models.length ? models : CLAUDE_FALLBACK,
      });
    }
  }
  const homes = opts.agents.includes("codex") ? await codexHomes(home, opts.codexHomes) : {};
  for (const [id, dir] of Object.entries(homes)) {
    const toml = await readFile(join(dir, "config.toml"), "utf8").catch(() => "");
    const defaults = codexDefaults(toml);
    accounts.push({
      id,
      agent: "codex",
      label: codexLabel(id),
      detail: accountDetail(await readJson(join(dir, "auth.json"))),
      defaultModel: defaults.model,
      defaultEffort: defaults.effort,
      models: codexModels(await readJson(join(dir, "models_cache.json"))),
    });
  }
  return { accounts, homes, claudeWorkHome };
}
