import { DurableObject } from 'cloudflare:workers';

export class RelayDatabase extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (Number(request.headers.get('content-length') ?? 0) > 1_048_576) return new Response('Too large', { status: 413 });
    try {
      const raw = await request.text();
      if (raw.length > 1_048_576) return new Response('Too large', { status: 413 });
      const { mode, sql, params = [] } = JSON.parse(raw);
      if (!['exec', 'get', 'all', 'run'].includes(mode) || typeof sql !== 'string' || !Array.isArray(params) || params.length > 100 || params.some((p: unknown) => p !== null && typeof p !== 'string' && (typeof p !== 'number' || !Number.isFinite(p)))) {
        return new Response('Invalid query', { status: 400 });
      }
      // transactionSync + the DO output gate commit before acknowledging writes.
      const result = this.ctx.storage.transactionSync(() => {
        const cursor = this.ctx.storage.sql.exec(sql, ...params);
        const rows = cursor.toArray();
        if (mode === 'get') return rows[0] ?? null;
        if (mode === 'all') return rows;
        if (mode === 'run') return { changes: cursor.rowsWritten, lastInsertRowid: this.ctx.storage.sql.exec('SELECT last_insert_rowid() AS id').one().id };
        return null;
      });
      return Response.json({ result });
    } catch {
      // Do not leak SQL, tokens, passwords, or bound parameters to logs/clients.
      return Response.json({ error: 'Durable database operation failed' }, { status: 500 });
    }
  }
}

