import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RemoteSqliteDatabase } from '../dist/store/remote-sqlite.js';

// The preload replaces only the worker's HTTP transport with a real SQLite-backed
// service, exercising serialization, worker signaling, and every store SQL query.
function runRemote(code, fetchBody = '') {
  const dir = mkdtempSync(path.join(tmpdir(), 'brc-remote-sql-'));
  const preload = path.join(dir, 'transport.cjs');
  writeFileSync(preload, `
    const { DatabaseSync } = require('node:sqlite');
    const { isMainThread } = require('node:worker_threads');
    if (!isMainThread) {
      const db = new DatabaseSync(${JSON.stringify(path.join(dir, 'state.sqlite'))});
      globalThis.fetch = async (url, options) => {
        ${fetchBody}
        if (url !== 'http://brc-storage/sql') throw new Error('Unexpected SQL destination');
        if (options.redirect !== 'error') throw new Error('Redirect protection missing');
        const { mode, sql, params } = JSON.parse(options.body);
        let result;
        if (mode === 'exec') { db.exec(sql); result = null; }
        else result = db.prepare(sql)[mode](...params) ?? null;
        return new Response(JSON.stringify({ result }, (_, v) => typeof v === 'bigint' ? Number(v) : v));
      };
    }
  `);
  try {
    execFileSync(process.execPath, ['--require', preload, '-e', `
      (async () => {
        const assert = (await import('node:assert/strict')).default;
        const { SqliteStore, sha256 } = await import('./packages/relay/dist/store/sqlite.js');
        const { RemoteSqliteDatabase } = await import('./packages/relay/dist/store/remote-sqlite.js');
        ${code}
      })().catch(e => { console.error(e); process.exitCode = 1; });
    `], {
      cwd: new URL('../../../', import.meta.url),
      env: { ...process.env, BRC_SQL_ENDPOINT: 'http://brc-storage/sql' },
      timeout: 30_000,
      stdio: 'pipe',
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('remote SQL rejects insecure or unauthenticated external destinations', () => {
  for (const endpoint of ['http://example.com/sql', 'http://brc-storage.evil/sql', 'http://brc-storage:8080/sql', 'https://user:password@example.com/sql']) {
    assert.throws(() => new RemoteSqliteDatabase(endpoint, 'token'));
  }
  assert.throws(() => new RemoteSqliteDatabase('https://example.com/sql'), /TOKEN/);
});

test('remote SQL supports store operations and survives a new connection', () => {
  runRemote(`
    let store = new SqliteStore('/not-created/remotely.sqlite');
    const user = store.upsertUser('remote-user', 'test-password');
    assert.equal(store.getUserByName('remote-user').id, user.id);
    assert.equal(store.getUser('missing'), undefined);
    const now = Date.now();
    store.insertClient({ client_id: 'c', client_secret: null, metadata: '{}', created_at: now });
    store.insertAuthCode({ code: 'code', client_id: 'c', user_id: user.id, code_challenge: 'challenge', redirect_uri: 'https://example.com', scopes: '', resource: null, expires_at: now + 60000 });
    assert.equal(store.takeAuthCode('code').code, 'code');
    assert.equal(store.takeAuthCode('code'), undefined);
    store.insertToken({ token_hash: sha256('token'), kind: 'access', client_id: 'c', user_id: user.id, scopes: '', resource: null, expires_at: null, created_at: now, revoked: 0 });
    assert.equal(store.getToken('token', 'access').user_id, user.id);
    store.revokeToken('token');
    assert.equal(store.getToken('token', 'access'), undefined);
    const deviceToken = store.issueDeviceToken('device', user.id, 'Desktop', 'linux');
    assert.equal(store.getDeviceByToken(deviceToken).name, 'Desktop');
    store.setDevicePaused('device', true);
    store.touchDevice('device');
    assert.equal(store.listDevices(user.id)[0].paused, 1);
    const pair = store.createDeviceCode('client', 60000);
    store.approveDeviceCode(pair.device_code, user.id, 'device');
    assert.equal(store.getDeviceCodeByUserCode(pair.user_code).approved, 1);
    const key = store.createApiKey(user.id, 'test');
    assert.equal(store.getApiKey(key.raw).user_id, user.id);
    store.audit({ ts: now, user_id: user.id, device_id: 'device', client: null, tool: 'test', args_hash: null, ok: 1, ms: 12, error: null });
    assert.equal(store.auditStats(user.id).total, 1);
    assert.equal(store.recentAudit(user.id)[0].tool, 'test');
    store.vacuumExpired();
    store.close();
    store = new SqliteStore(':memory:');
    assert.equal(store.getUser(user.id).username, 'remote-user');
    assert.equal(store.listClients().length, 1);
    assert.equal(store.getApiKey(key.raw).name, 'test');
    store.revokeApiKey(user.id, key.prefix);
    assert.equal(store.getApiKey(key.raw), undefined);
    store.close();
    assert.throws(() => store.getUser(user.id), /closed/);
  `);
});

test('HTTP failure propagates without local fallback', () => {
  runRemote(`assert.throws(() => new SqliteStore(':memory:'), /HTTP 503/);`, `return new Response('unavailable', { status: 503 });`);
});

test('malformed remote responses fail closed', () => {
  runRemote(`assert.throws(() => new SqliteStore(':memory:'), /invalid response/);`, `return new Response('{}');`);
});

test('failed requests are not retried automatically', () => {
  runRemote(`assert.throws(() => new SqliteStore(':memory:'), /HTTP 503/);`, `
    globalThis.requests = (globalThis.requests || 0) + 1;
    if (globalThis.requests === 1) return new Response('unavailable', { status: 503 });
  `);
});

test('timeout closes the bridge instead of permitting later writes', () => {
  runRemote(`
    const db = new RemoteSqliteDatabase('http://brc-storage/sql');
    assert.throws(() => db.exec('CREATE TABLE a (id)'), /timed out/);
    assert.throws(() => db.exec('INSERT INTO a VALUES (1)'), /closed/);
  `, `throw new DOMException('Request timed out', 'TimeoutError');`);
});

test('oversized responses are rejected', () => {
  runRemote(`assert.throws(() => new SqliteStore(':memory:'), /size limit/);`, `
    return new Response(JSON.stringify({ result: 'x'.repeat(8 * 1024 * 1024) }));
  `);
});
