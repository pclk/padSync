/** Per-request timings; no extra queries, no shared mutable request state. */
export function syncServerTiming(enabled: boolean) {
  const started = performance.now();
  let previous = started;
  const metrics: string[] = [];
  return {
    mark(name: string) {
      if (!enabled) return;
      const now = performance.now();
      metrics.push(`${name};dur=${(now - previous).toFixed(2)}`);
      previous = now;
    },
    respond(response: Response) {
      if (enabled) {
        metrics.push(`total;dur=${(performance.now() - started).toFixed(2)}`);
        response.headers.set('Server-Timing', metrics.join(', '));
        response.headers.set('Cache-Control', 'no-store');
        response.headers.set('X-PadSync-Server-Region', process.env.VERCEL_REGION ?? 'local');
        if (process.env.VERCEL_GIT_COMMIT_SHA) response.headers.set('X-PadSync-Server-Build', process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 12));
      }
      return response;
    },
  };
}
