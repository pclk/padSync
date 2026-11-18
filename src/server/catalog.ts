import "server-only";
import { z } from "zod";
import type { Sql } from "./db";
import type { CatalogAccount, CatalogResponse } from "@/lib/chat-types";

// The model picker's choices: what the Mac bridge found in ~/.claude and the ~/.codex* homes
// (bridge/catalog.ts). Stored on the bridge's device token; the newest one wins.

const text = (max: number) => z.string().trim().min(1).max(max);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/;
const EFFORT = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);

const modelSchema = z.object({
  id: z.string().regex(ID_RE),
  label: text(60),
  description: text(200).optional(),
  badge: text(60).optional(),
  more: z.boolean().optional(),
  efforts: z.array(EFFORT).max(6),
  defaultEffort: EFFORT.optional().catch(undefined),
  contextWindow: z.number().int().positive().max(100_000_000).optional(),
});

export const catalogSchema = z.object({
  accounts: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/),
        agent: z.enum(["claude", "codex"]),
        label: text(60),
        detail: text(160).optional(),
        defaultModel: z.string().regex(ID_RE).optional().catch(undefined),
        defaultEffort: EFFORT.optional().catch(undefined),
        models: z.array(modelSchema).max(40),
      }),
    )
    .max(12),
});

export async function saveCatalog(sql: Sql, deviceId: string, accounts: CatalogAccount[]) {
  await sql.query(`update device_tokens set catalog = $2::jsonb, catalog_at = now() where id = $1`, [deviceId, JSON.stringify(accounts)]);
}

export async function loadCatalog(sql: Sql): Promise<CatalogResponse> {
  const rows = await sql.query<{ catalog: CatalogAccount[]; at: string | Date }>(
    `select catalog, catalog_at as at from device_tokens
     where revoked_at is null and catalog is not null order by catalog_at desc limit 1`,
  );
  const r = rows[0];
  return r ? { accounts: r.catalog, updatedAt: new Date(r.at).toISOString() } : { accounts: null, updatedAt: null };
}
