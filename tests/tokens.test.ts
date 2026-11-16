import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "@/server/db";
import {
  bearerToken,
  createDeviceToken,
  generateToken,
  hashToken,
  isWellFormedToken,
  lastBridgeActivity,
  listDeviceTokens,
  revokeDeviceToken,
  verifyDeviceToken,
} from "@/server/tokens";
import { freshDb } from "./helpers/env";

describe("token format", () => {
  it("generates psd_ + 43 base64url chars (256 bits)", () => {
    const t = generateToken();
    expect(t).toMatch(/^psd_[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedToken(t)).toBe(true);
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 2000 }, generateToken));
    expect(seen.size).toBe(2000);
  });

  it.each([
    ["", false],
    ["psd_", false],
    ["psd_short", false],
    ["xyz_" + "a".repeat(43), false],
    ["psd_" + "a".repeat(42), false],
    ["psd_" + "a".repeat(44), false],
    ["psd_" + "a".repeat(42) + "!", false],
    [" psd_" + "a".repeat(43), false],
    ["psd_" + "a".repeat(43), true],
  ])("isWellFormedToken(%j) = %s", (t, ok) => {
    expect(isWellFormedToken(t)).toBe(ok);
  });

  it("hashes to sha256 hex, distinct from the token", () => {
    const t = generateToken();
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
    expect(hashToken(t)).toBe(hashToken(t));
  });
});

describe("bearerToken", () => {
  const h = (v?: string) => new Headers(v === undefined ? {} : { authorization: v });
  it("extracts a bearer token", () => expect(bearerToken(h("Bearer abc"))).toBe("abc"));
  it("is case-insensitive on the scheme", () => expect(bearerToken(h("bearer abc"))).toBe("abc"));
  it("ignores other schemes", () => expect(bearerToken(h("Basic abc"))).toBeNull());
  it("rejects multiple values", () => expect(bearerToken(h("Bearer a b"))).toBeNull());
  it("returns null when absent", () => expect(bearerToken(h())).toBeNull());
});

describe("device token store", () => {
  let sql: Sql;
  beforeEach(async () => {
    ({ sql } = await freshDb());
  });

  it("stores only the hash, never the plaintext", async () => {
    const { token, record } = await createDeviceToken(sql, "Mac", "pclk");
    const rows = await sql.query(`select * from device_tokens`);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(token.slice(4));
    expect(rows[0].token_hash).toBe(hashToken(token));
    expect(record).not.toHaveProperty("token_hash");
    expect(record.hint).toBe(token.slice(4, 8));
    expect(record.createdBy).toBe("pclk");
  });

  it("verifies a valid token and records use", async () => {
    const { token, record } = await createDeviceToken(sql, "Mac", "pclk");
    const v = await verifyDeviceToken(sql, token, { hostname: "mbp" });
    expect(v?.id).toBe(record.id);
    const [row] = await sql.query<{ last_used_at: unknown; last_seen_info: unknown }>(`select last_used_at, last_seen_info from device_tokens`);
    expect(row.last_used_at).not.toBeNull();
    expect(row.last_seen_info).toEqual({ hostname: "mbp" });
    expect(await lastBridgeActivity(sql)).not.toBeNull();
  });

  it("rejects unknown and null tokens", async () => {
    await createDeviceToken(sql, "Mac", "pclk");
    expect(await verifyDeviceToken(sql, generateToken())).toBeNull();
    expect(await verifyDeviceToken(sql, null)).toBeNull();
  });

  it("rejects malformed tokens without querying the database", async () => {
    const spy = { query: vi.fn() } as unknown as Sql;
    expect(await verifyDeviceToken(spy, "psd_nope")).toBeNull();
    expect(await verifyDeviceToken(spy, "' or 1=1 --")).toBeNull();
    expect(spy.query).not.toHaveBeenCalled();
  });

  it("rejects a revoked token immediately", async () => {
    const { token, record } = await createDeviceToken(sql, "Mac", "pclk");
    expect(await verifyDeviceToken(sql, token)).not.toBeNull();
    expect(await revokeDeviceToken(sql, record.id)).toBe(true);
    expect(await verifyDeviceToken(sql, token)).toBeNull();
    expect(await revokeDeviceToken(sql, record.id)).toBe(false);
    expect(await lastBridgeActivity(sql)).toBeNull();
  });

  it("revoking one token leaves others working", async () => {
    const a = await createDeviceToken(sql, "A", "pclk");
    const b = await createDeviceToken(sql, "B", "pclk");
    await revokeDeviceToken(sql, a.record.id);
    expect(await verifyDeviceToken(sql, a.token)).toBeNull();
    expect((await verifyDeviceToken(sql, b.token))?.id).toBe(b.record.id);
  });

  it("lists tokens newest first without secrets", async () => {
    await createDeviceToken(sql, "first", "pclk");
    await new Promise((r) => setTimeout(r, 5));
    const second = await createDeviceToken(sql, "second", "pclk");
    const list = await listDeviceTokens(sql);
    expect(list.map((t) => t.name)).toEqual(["second", "first"]);
    expect(JSON.stringify(list)).not.toContain(second.token);
  });
});
