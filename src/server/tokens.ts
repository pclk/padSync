import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "./db";

// Device tokens let non-browser clients (the Mac bridge) call padSync without a GitHub session.
// - The plaintext token is shown once at creation; only its SHA-256 is stored.
// - Tokens are high-entropy (256 bits), so a plain hash is enough (no slow KDF needed) and lookup
//   is a single indexed equality on the hash.
// - Tokens are scoped to the bridge API. They cannot read notebooks, sync, or mint more tokens.
// - Revocation is immediate: every request re-checks revoked_at.

export const TOKEN_PREFIX = "psd_";
const TOKEN_BYTES = 32;
const TOKEN_RE = /^psd_[A-Za-z0-9_-]{43}$/;
const LAST_USED_RESOLUTION_S = 15;

export interface DeviceToken {
  id: string;
  name: string;
  hint: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastSeenInfo: Record<string, unknown> | null;
  revokedAt: string | null;
}

interface Row {
  id: string;
  name: string;
  hint: string;
  created_by: string;
  created_at: string | Date;
  last_used_at: string | Date | null;
  last_seen_info: Record<string, unknown> | null;
  revoked_at: string | Date | null;
}

const iso = (v: string | Date | null) => (v == null ? null : new Date(v).toISOString());

function toToken(r: Row): DeviceToken {
  return {
    id: r.id,
    name: r.name,
    hint: r.hint,
    createdBy: r.created_by,
    createdAt: iso(r.created_at)!,
    lastUsedAt: iso(r.last_used_at),
    lastSeenInfo: r.last_seen_info,
    revokedAt: iso(r.revoked_at),
  };
}

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isWellFormedToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** Extracts a bearer token from the Authorization header, if any. */
export function bearerToken(headers: Headers): string | null {
  const m = headers.get("authorization")?.match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
}

export async function createDeviceToken(sql: Sql, name: string, createdBy: string) {
  const token = generateToken();
  const id = "dt_" + randomBytes(9).toString("base64url");
  const hint = token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 4);
  const rows = await sql.query<Row>(
    `insert into device_tokens (id, name, token_hash, hint, created_by) values ($1, $2, $3, $4, $5)
     returning id, name, hint, created_by, created_at, last_used_at, last_seen_info, revoked_at`,
    [id, name, hashToken(token), hint, createdBy],
  );
  return { token, record: toToken(rows[0]) };
}

export async function listDeviceTokens(sql: Sql): Promise<DeviceToken[]> {
  const rows = await sql.query<Row>(
    `select id, name, hint, created_by, created_at, last_used_at, last_seen_info, revoked_at
     from device_tokens order by created_at desc`,
  );
  return rows.map(toToken);
}

export async function revokeDeviceToken(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql.query(`update device_tokens set revoked_at = now() where id = $1 and revoked_at is null returning id`, [id]);
  return rows.length > 0;
}

/**
 * Returns the active token record for a presented token, or null. Malformed tokens are rejected
 * before touching the database. last_used_at is refreshed at most every few seconds.
 */
export async function verifyDeviceToken(sql: Sql, token: string | null, seenInfo?: Record<string, unknown>): Promise<DeviceToken | null> {
  if (!token || !isWellFormedToken(token)) return null;
  const rows = await sql.query<Row>(
    `select id, name, hint, created_by, created_at, last_used_at, last_seen_info, revoked_at
     from device_tokens where token_hash = $1 and revoked_at is null`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  await sql.query(
    `update device_tokens set last_used_at = now(), last_seen_info = coalesce($2::jsonb, last_seen_info)
     where id = $1 and (last_used_at is null or last_used_at < now() - make_interval(secs => $3) or $2::jsonb is not null)`,
    [row.id, seenInfo ? JSON.stringify(seenInfo) : null, LAST_USED_RESOLUTION_S],
  );
  return toToken(row);
}

/** Most recent activity of any active token: the bridge counts as online if this is recent. */
export async function lastBridgeActivity(sql: Sql): Promise<string | null> {
  const rows = await sql.query<{ at: string | Date | null }>(`select max(last_used_at) as at from device_tokens where revoked_at is null`);
  return iso(rows[0]?.at ?? null);
}
