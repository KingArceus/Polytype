import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createAppServer } from '../server.mjs';

const KEY = 'test-only-secret-admin-key-with-high-entropy';
const entry = { word: 'greeting', ipa: '', type: '', meaning: '' };

async function serve(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'polytype-admin-'));
  const databasePath = join(directory, 'fixture.db');
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE words (id INTEGER PRIMARY KEY, word TEXT, lang_code TEXT);
    CREATE TABLE definitions (id INTEGER PRIMARY KEY, definition TEXT, pos TEXT, definition_lang TEXT);
    CREATE TABLE word_definitions (id INTEGER PRIMARY KEY, word_id INTEGER, definition_id INTEGER);
    CREATE TABLE pronunciations (id INTEGER PRIMARY KEY, word_id INTEGER, ipa TEXT);
    INSERT INTO words VALUES (1, 'hello', 'en');
  `);
  db.close();
  const server = await createAppServer({ databasePath, adminKey: KEY, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await rm(databasePath);
    await rmdir(directory);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = async (cookie) => (await fetch(`${base}/api/admin/session`, { headers: cookie ? { Cookie: cookie } : {} })).json();
  const login = (key = KEY, headers = {}) => fetch(`${base}/api/admin/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ key })
  });
  const update = (cookie, headers = {}) => fetch(`${base}/api/dictionary/1`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(entry)
  });
  return { base, status, login, update };
}

const cookieFrom = (response) => response.headers.get('set-cookie')?.split(';')[0];

test('public dictionary reads remain available while all writes require an authenticated session', async (t) => {
  const { base, status, update } = await serve(t);
  assert.deepEqual(await status(), { authenticated: false, configured: true });
  assert.equal((await fetch(`${base}/api/dictionary?language=en`)).status, 200);
  assert.equal((await fetch(`${base}/api/words?language=en`)).status, 200);
  assert.equal((await update()).status, 401);
  assert.equal((await update('polytype_admin=forged')).status, 401);
  assert.equal((await fetch(`${base}/api/dictionary`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: 'en', word: 'newword' })
  })).status, 401);
  for (const route of ['/', '/admin', '/admin/']) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), new RegExp(KEY));
    if (route.startsWith('/admin')) assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  for (const route of ['/admin-auth.mjs', '/server.mjs', '/.env', '/test/admin.test.mjs']) {
    assert.equal((await fetch(`${base}${route}`)).status, 404);
  }
});

test('the admin key creates an opaque protected cookie and logout revokes the session', async (t) => {
  const { base, status, login, update } = await serve(t);
  const denied = await login('incorrect');
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('set-cookie'), null);
  const response = await login();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true, configured: true });
  const header = response.headers.get('set-cookie');
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Path=\/api/);
  assert.match(header, /Max-Age=3600/);
  assert.doesNotMatch(header, /; Secure/);
  assert.ok(!header.includes(KEY));
  const cookie = cookieFrom(response);
  assert.deepEqual(await status(cookie), { authenticated: true, configured: true });
  assert.equal((await update(cookie)).status, 200);
  const logout = await fetch(`${base}/api/admin/session`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await status(cookie)).authenticated, false);
  assert.equal((await update(cookie)).status, 401);
});

test('admin sessions expire and logging in again rotates and invalidates the previous token', async (t) => {
  let time = 1000;
  const { status, login, update } = await serve(t, { adminNow: () => time, adminSessionTtlMs: 1000 });
  const first = cookieFrom(await login());
  assert.equal((await status(first)).authenticated, true);
  const second = cookieFrom(await login(KEY, { Cookie: first }));
  assert.notEqual(second, first);
  assert.equal((await status(first)).authenticated, false);
  assert.equal((await status(second)).authenticated, true);
  time = 2000;
  assert.equal((await status(second)).authenticated, false);
  assert.equal((await update(second)).status, 401);
});

test('an unconfigured server never enables dictionary writes or accepts a default admin key', async (t) => {
  const { base, status, login, update } = await serve(t, { adminKey: '' });
  assert.deepEqual(await status(), { authenticated: false, configured: false });
  assert.equal((await login()).status, 503);
  assert.equal((await update()).status, 401);
  assert.equal((await fetch(`${base}/api/dictionary?language=en`)).status, 200);
});

test('login, logout, and dictionary mutations reject cross-origin and malformed-origin requests', async (t) => {
  const { base, status, login, update } = await serve(t);
  for (const headers of [{ Origin: 'https://example.com' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await login(KEY, headers)).status, 403);
  }
  const response = await login(KEY, { Origin: base });
  assert.equal(response.status, 200);
  const cookie = cookieFrom(response);
  assert.equal((await update(cookie, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await fetch(`${base}/api/admin/session`, {
    method: 'DELETE', headers: { Cookie: cookie, Origin: 'https://example.com' }
  })).status, 403);
  assert.equal((await status(cookie)).authenticated, true);
  const unsupported = await fetch(`${base}/api/admin/session`, { method: 'PATCH' });
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get('allow'), 'GET, HEAD, POST, DELETE');
});

test('repeated incorrect keys are throttled by connection address until the cooldown expires', async (t) => {
  let time = 1000;
  const { login } = await serve(t, { adminNow: () => time });
  for (let index = 0; index < 5; index++) assert.equal((await login('wrong')).status, 401);
  const blocked = await login(KEY, { 'X-Forwarded-For': 'different-address' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '900');
  time += 15 * 60 * 1000;
  assert.equal((await login()).status, 200);
});

test('a server-side key file is supported and TLS deployments can require secure cookies', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'polytype-key-'));
  const keyFile = join(directory, 'admin.key');
  await writeFile(keyFile, `${KEY}\n`);
  t.after(async () => { await rm(keyFile); await rmdir(directory); });
  const { base, login } = await serve(t, { adminKey: undefined, adminKeyFile: keyFile, adminSecureCookie: true });
  const response = await login();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /; Secure/);
  assert.equal((await fetch(`${base}/admin.key`)).status, 404);
});
