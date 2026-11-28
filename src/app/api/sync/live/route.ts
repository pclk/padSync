import type { NextRequest } from 'next/server';
import { createRealtime, rawSql } from '@neon/realtime/server';
import { requireLogin } from '@/server/guard';
import { databaseUrl } from '@/server/db';

// The app admits a single GitHub account and shares its notebooks across devices.
// Only a metadata hint is sealed; notebook contents still require authenticated HTTP sync.
// Renewed every minute by each open device, so it never touches the database: Neon can then scale
// to zero while devices sit idle with realtime connected.
export async function POST(req: NextRequest) {
  const auth = requireLogin(req);
  if (auth instanceof Response) return auth;
  const headers = { 'Cache-Control': 'no-store' };
  const url = process.env.NEON_REALTIME_URL;
  const secret = process.env.NEON_REALTIME_SECRET;
  if (!url || !secret) return Response.json({ enabled: false }, { headers });
  try {
    const database = decodeURIComponent(new URL(databaseUrl()!).pathname.slice(1));
    if (!database) throw new Error('Missing database name');
    const realtime = createRealtime({ secret, db: database });
    const query = await realtime.seal({ query: rawSql<{ id: string; seq: string }>(
      'SELECT id, seq FROM entities ORDER BY seq DESC LIMIT 1',
    ) });
    return Response.json({ enabled: true, url, query, login: auth.login.toLowerCase() }, { headers });
  } catch {
    return Response.json({ error: 'Realtime unavailable; HTTP sync remains active.' }, { status: 503, headers });
  }
}
