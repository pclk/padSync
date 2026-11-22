import "server-only";
import { createRealtime, rawSql } from "@neon/realtime/server";
import { databaseUrl } from "./db";

/**
 * Seals a Neon Realtime live query for the caller to watch (src/lib/live-query.ts). Only seal
 * queries whose rows are a harmless wake-up signal (ids, statuses, times): contents still go over
 * authenticated HTTP. Disabled when Realtime isn't configured; callers then just poll.
 */
export async function sealLive(sql: string, params: string[] = []) {
  const url = process.env.NEON_REALTIME_URL;
  const secret = process.env.NEON_REALTIME_SECRET;
  if (!url || !secret) return { enabled: false as const };
  const database = decodeURIComponent(new URL(databaseUrl()!).pathname.slice(1));
  if (!database) throw new Error("Missing database name");
  const query = await createRealtime({ secret, db: database }).seal({ query: rawSql(sql, params) });
  return { enabled: true as const, url, query };
}
