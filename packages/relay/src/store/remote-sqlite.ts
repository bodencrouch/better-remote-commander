import { Worker } from 'node:worker_threads';

/** The synchronous subset used by the relay. Remote storage remains authoritative. */
export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: (string | number | null)[]): unknown;
    all(...params: (string | number | null)[]): unknown[];
    run(...params: (string | number | null)[]): unknown;
  };
  close(): void;
}

const RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

// HTTP runs in a separate thread: the existing synchronous store can wait without
// blocking that thread's network event loop. Each call has its own response buffer.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
parentPort.on('message', async ({ request, shared }) => {
  const control = new Int32Array(shared, 0, 2);
  const output = new Uint8Array(shared, 8);
  let envelope;
  try {
    const response = await fetch(workerData.endpoint, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json',
        ...(workerData.token ? { Authorization: 'Bearer ' + workerData.token } : {}) },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(workerData.timeoutMs),
    });
    if (!response.ok) throw new Error('Remote SQL returned HTTP ' + response.status);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Remote SQL returned no response body');
    const chunks = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > output.byteLength) {
        await reader.cancel();
        throw new Error('Remote SQL response exceeds size limit');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'result')) {
      throw new Error('Remote SQL returned an invalid response');
    }
    envelope = { ok: true, result: payload.result };
  } catch (error) {
    envelope = { ok: false, error: error instanceof Error ? error.message : 'Remote SQL failed',
      fatal: error?.name === 'TimeoutError' || error?.name === 'AbortError' };
  }
  let encoded = new TextEncoder().encode(JSON.stringify(envelope));
  if (encoded.byteLength > output.byteLength) {
    encoded = new TextEncoder().encode(JSON.stringify({ ok: false, error: 'Remote SQL response exceeds size limit' }));
  }
  output.set(encoded);
  Atomics.store(control, 1, encoded.byteLength);
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
});
`;

export class RemoteSqliteDatabase implements SqlDatabase {
  private readonly worker: Worker;
  private closed = false;

  constructor(endpoint: string, token?: string) {
    const url = new URL(endpoint);
    const internal = url.origin === 'http://brc-storage';
    if (url.username || url.password || url.hash || (!internal && url.protocol !== 'https:')) {
      throw new Error('BRC_SQL_ENDPOINT must use HTTPS or the internal http://brc-storage service');
    }
    if (!internal && !token) throw new Error('BRC_SQL_TOKEN is required for external SQL endpoints');
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { endpoint: url.href, token, timeoutMs: TIMEOUT_MS },
    });
    // An unexpected worker crash is reported as a bounded timeout by the caller.
    this.worker.on('error', () => { this.closed = true; });
    this.worker.unref();
  }

  private call(mode: 'exec' | 'get' | 'all' | 'run', sql: string, params: (string | number | null)[] = []): unknown {
    if (this.closed) throw new Error('Remote SQL connection is closed');
    const shared = new SharedArrayBuffer(RESPONSE_BYTES + 8);
    const control = new Int32Array(shared, 0, 2);
    this.worker.postMessage({ request: { mode, sql, params }, shared });
    // Never retry: a timed-out write may already have committed remotely.
    if (Atomics.wait(control, 0, 0, TIMEOUT_MS + 1_000) === 'timed-out') {
      this.close();
      throw new Error('Remote SQL timed out; operation outcome is unknown, connection closed');
    }
    const length = Atomics.load(control, 1);
    const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(shared, 8, length))) as {
      ok: boolean; result?: unknown; error?: string; fatal?: boolean;
    };
    if (!payload.ok) {
      if (payload.fatal) this.close();
      throw new Error(payload.error || 'Remote SQL failed');
    }
    return payload.result;
  }

  exec(sql: string): void { this.call('exec', sql); }
  prepare(sql: string) {
    return {
      get: (...params: (string | number | null)[]) => this.call('get', sql, params) ?? undefined,
      all: (...params: (string | number | null)[]) => {
        const rows = this.call('all', sql, params);
        if (!Array.isArray(rows)) throw new Error('Remote SQL returned invalid rows');
        return rows;
      },
      run: (...params: (string | number | null)[]) => this.call('run', sql, params),
    };
  }
  close(): void {
    if (!this.closed) { this.closed = true; void this.worker.terminate(); }
  }
}
