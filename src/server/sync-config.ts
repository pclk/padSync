import 'server-only';
import type { Sql } from './db';
import { normalizeSyncConfig } from '@/lib/sync-policy';
export const isAdminLogin = (login: string | null) => login?.toLowerCase() === 'pclk';
export async function readSyncConfig(sql: Sql) {
  const rows = await sql.query<{ debounce_ms: number; visible_poll_ms: number; hidden_poll_ms: number; retry_base_ms: number }>('select debounce_ms, visible_poll_ms, hidden_poll_ms, retry_base_ms from sync_config where id=1');
  const row = rows[0];
  return normalizeSyncConfig({ debounceMs: row?.debounce_ms, visiblePollMs: row?.visible_poll_ms, hiddenPollMs: row?.hidden_poll_ms, retryBaseMs: row?.retry_base_ms });
}
