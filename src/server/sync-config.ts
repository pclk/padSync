import 'server-only';
import type { Sql } from './db';
import { DEFAULT_DEBOUNCE_MS, validDebounce } from '@/lib/sync-policy';
export const isAdminLogin = (login: string | null) => login?.toLowerCase() === 'pclk';
export async function readSyncConfig(sql: Sql) {
  const rows = await sql.query<{ debounce_ms: number }>('select debounce_ms from sync_config where id=1');
  const value = rows[0]?.debounce_ms;
  return { debounceMs: validDebounce(value) ? value : DEFAULT_DEBOUNCE_MS };
}
