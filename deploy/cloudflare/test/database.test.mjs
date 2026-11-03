import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('Durable Object SQL commits survive runtime replacement and validates requests', async () => {
  const persist = await mkdtemp(path.join(os.tmpdir(), 'brc-do-'));
  const bundle = await build({ stdin: { contents: `import { RelayDatabase } from './src/database.ts'; export { RelayDatabase }; export default {fetch(req, env) { return env.DB.getByName('primary').fetch(req); }}`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', external: ['cloudflare:workers'] });
  const config = { modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-11-01', durableObjects: { DB: {className: 'RelayDatabase', useSQLite: true} }, resourcePersistencePath: persist };
  let mf = new Miniflare(convertV4MiniflareOptions(config));
  const query = async (mode, sql, params = []) => { const res = await mf.dispatchFetch('http://test/', { method: 'POST', body: JSON.stringify({mode,sql,params}) }); assert.equal(res.status, 200, await res.clone().text()); return (await res.json()).result; };
  try {
    await query('exec', 'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE tokens (hash TEXT PRIMARY KEY, revoked INTEGER);');
    await query('run', 'INSERT INTO users VALUES (?, ?)', ['u1','test']);
    await query('run', 'INSERT INTO tokens VALUES (?, ?)', ['hashed-test-token',0]);
    await mf.dispose();
    mf = new Miniflare(convertV4MiniflareOptions(config));
    assert.deepEqual(await query('get', 'SELECT * FROM users WHERE id = ?', ['u1']), {id:'u1',name:'test'});
    await query('run', 'UPDATE tokens SET revoked = 1 WHERE hash = ?', ['hashed-test-token']);
    await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(config));
    assert.equal((await query('get','SELECT revoked FROM tokens')).revoked, 1);
    assert.equal((await mf.dispatchFetch('http://test/')).status,405);
    assert.equal((await mf.dispatchFetch('http://test/',{method:'POST',body:JSON.stringify({mode:'bad',sql:'SELECT 1'})})).status,400);
    const failure = await mf.dispatchFetch('http://test/',{method:'POST',body:JSON.stringify({mode:'all',sql:'SELECT * FROM secret_not_a_table'})});
    assert.equal(failure.status,500); assert.equal((await failure.text()).includes('secret_not_a_table'),false);
  } finally { await mf.dispose(); await rm(persist,{recursive:true,force:true}); }
});
