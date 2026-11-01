import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { readOpenBaoAdminKey } from '../openbao.mjs';
import { createAppServer } from '../server.mjs';

// Optional real OpenBao check: BAO_TEST_BINARY=/path/to/bao node --test test/openbao.test.mjs
const binary = process.env.BAO_TEST_BINARY;

test('OpenBao stores the admin key exclusively and the app reads it directly over verified TLS', {
  skip: !binary && 'Set BAO_TEST_BINARY to a verified OpenBao executable.', timeout: 60000
}, async (t) => {
  const validation = spawnSync(binary, ['operator', 'validate-config',
    `-config=${fileURLToPath(new URL('../deploy/openbao/server.hcl', import.meta.url))}`], {
    stdio: 'ignore', windowsHide: true, timeout: 5000
  });
  assert.equal(validation.status, 0, 'The shipped production server HCL must pass OpenBao validation.');
  const directory = await mkdtemp(join(tmpdir(), 'polytype-openbao-integration-'));
  const apps = [];
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `https://127.0.0.1:${port}`;
  const rootToken = randomBytes(32).toString('hex');
  const environment = { ...process.env, BAO_DEV_ROOT_TOKEN_ID: rootToken };
  for (const key of ['BAO_TOKEN', 'VAULT_TOKEN', 'BAO_ADDR', 'VAULT_ADDR',
    'BAO_CACERT', 'VAULT_CACERT', 'BAO_SKIP_VERIFY', 'VAULT_SKIP_VERIFY']) delete environment[key];
  // Only this isolated test uses dev mode. Never persist its token to the user's token helper.
  const server = spawn(binary, ['server', '-dev', '-dev-tls', '-dev-no-store-token',
    `-dev-tls-cert-dir=${directory}`, `-dev-listen-address=127.0.0.1:${port}`], {
    env: environment, stdio: 'ignore', windowsHide: true
  });
  let serverError;
  server.on('error', (error) => { serverError = error; });
  t.after(async () => {
    for (const app of apps) {
      await new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); });
    }
    if (server.exitCode === null && !serverError) {
      const stopped = once(server, 'exit');
      server.kill();
      await stopped;
    }
    await rm(directory, { recursive: true, force: true });
  });

  let ca;
  let caFile;
  const api = (path, { token = rootToken, method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const req = request(`${base}/v1/${path}`, {
      method, ca, headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' }, timeout: 2000
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('OpenBao test request timed out.')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (serverError) throw serverError;
    assert.equal(server.exitCode, null, 'The isolated OpenBao test server must stay running.');
    try {
      const name = (await readdir(directory)).find((name) => /ca\.(pem|crt)$/.test(name));
      if (name) {
        caFile = join(directory, name);
        ca = await readFile(caFile);
        if ((await api('sys/health')).status === 200) { ready = true; break; }
      }
    } catch { /* Wait for the temporary TLS listener and certificate. */ }
    await delay(100);
  }
  assert.ok(ready, 'The isolated OpenBao TLS test server must become healthy.');
  assert.equal((await api('sys/auth/approle', { method: 'POST', body: { type: 'approle' } })).status, 204);
  const policy = await readFile(new URL('../deploy/openbao/polytype-admin-read.hcl', import.meta.url), 'utf8');
  assert.equal((await api('sys/policies/acl/polytype-admin-read', { method: 'PUT', body: { policy } })).status, 204);
  const operatorPolicy = await readFile(new URL('../deploy/openbao/polytype-operator.hcl', import.meta.url), 'utf8');
  assert.equal((await api('sys/policies/acl/polytype-operator', {
    method: 'PUT', body: { policy: operatorPolicy }
  })).status, 204);
  const operatorToken = (await api('auth/token/create', {
    method: 'POST', body: { policies: ['polytype-operator'], ttl: '5m' }
  })).data.auth.client_token;
  assert.equal((await api('auth/approle/role/polytype', { method: 'POST', body: {
    token_policies: ['polytype-admin-read'], token_ttl: '1m', token_max_ttl: '1m', token_num_uses: 0,
    secret_id_ttl: '10m', secret_id_num_uses: 1,
    secret_id_bound_cidrs: ['127.0.0.1/32'], token_bound_cidrs: ['127.0.0.1/32']
  } })).status, 204);
  const roleId = (await api('auth/approle/role/polytype/role-id')).data.data.role_id;
  const secretId = (await api('auth/approle/role/polytype/secret-id', { method: 'POST', body: {} })).data.data.secret_id;
  const login = await api('auth/approle/login', { method: 'POST', body: { role_id: roleId, secret_id: secretId } });
  assert.equal(login.status, 200);
  const token = login.data.auth.client_token;
  const secretPath = 'secret/data/polytype/admin';
  const put = async (data) => {
    assert.equal((await api(secretPath, { token: operatorToken, method: 'POST', body: { data } })).status, 200);
  };
  const key = randomBytes(32).toString('hex');
  await put({ POLYTYPE_ADMIN_KEY: key });
  assert.equal((await api(secretPath, { token })).status, 200);
  assert.equal((await api('secret/metadata/polytype/admin', { token: operatorToken })).status, 200);
  assert.equal((await api('secret/data/unrelated', { token })).status, 403);
  assert.equal((await api(secretPath, { token, method: 'POST', body: { data: {} } })).status, 403);
  const nextEnv = async () => ({
    POLYTYPE_OPENBAO_ADDR: base, POLYTYPE_OPENBAO_CA_FILE: caFile, POLYTYPE_OPENBAO_ROLE_ID: roleId,
    POLYTYPE_OPENBAO_SECRET_ID: (await api('auth/approle/role/polytype/secret-id', {
      token: operatorToken, method: 'POST', body: {}
    })).data.data.secret_id
  });
  const accessors = async () => (await api('auth/token/accessors', { method: 'LIST' })).data.data.keys.sort();
  const beforeTokens = await accessors();
  const files = (await readdir(directory)).sort();
  const env = await nextEnv();
  const oneUseSecret = env.POLYTYPE_OPENBAO_SECRET_ID;
  assert.equal(await readOpenBaoAdminKey(env), key);
  assert.ok(!('POLYTYPE_OPENBAO_SECRET_ID' in env));
  assert.deepEqual(await accessors(), beforeTokens, 'The app must revoke its read token immediately.');
  assert.deepEqual((await readdir(directory)).sort(), files, 'No runtime key or credential file may be created.');
  await assert.rejects(readOpenBaoAdminKey({ ...env, POLYTYPE_OPENBAO_SECRET_ID: oneUseSecret }), /login failed \(HTTP 400\)/);
  await assert.rejects(readOpenBaoAdminKey({ ...await nextEnv(), POLYTYPE_OPENBAO_CA_FILE: undefined }),
    /^Error: OpenBao AppRole login failed\.$/);
  await assert.rejects(readOpenBaoAdminKey({ ...await nextEnv(), POLYTYPE_OPENBAO_KV_PATH: 'secret/data/unrelated' }),
    /admin-key read failed \(HTTP 403\)/);

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
  const serve = async () => {
    const app = await createAppServer({ databasePath, openBaoEnv: await nextEnv() });
    apps.push(app);
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    return `http://127.0.0.1:${app.address().port}`;
  };
  const loginApp = (base, key, cookie) => fetch(`${base}/api/admin/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ key })
  });
  const first = await serve();
  const signedIn = await loginApp(first, key);
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.get('set-cookie').split(';')[0];
  const rotated = randomBytes(32).toString('hex');
  await put({ POLYTYPE_ADMIN_KEY: rotated });
  assert.equal((await loginApp(first, rotated)).status, 401);
  const restarted = await serve();
  assert.equal((await loginApp(restarted, key)).status, 401);
  assert.equal((await loginApp(restarted, rotated)).status, 200);
  const status = await fetch(`${restarted}/api/admin/session`, { headers: { Cookie: cookie } });
  assert.equal((await status.json()).authenticated, false);
  for (const data of [{ different_field: 'missing expected key' }, { POLYTYPE_ADMIN_KEY: '' },
    { POLYTYPE_ADMIN_KEY: 123 }, { POLYTYPE_ADMIN_KEY: ' whitespace ' }]) {
    await put(data);
    await assert.rejects(createAppServer({ databasePath, openBaoEnv: await nextEnv() }), /OpenBao must contain/);
  }
  for (const path of ['/openbao.mjs', '/run/polytype-secrets/admin-key', '/.env']) {
    assert.equal((await fetch(`${restarted}${path}`)).status, 404);
  }
  await api('sys/seal', { method: 'POST' });
  await assert.rejects(readOpenBaoAdminKey({ ...env, POLYTYPE_OPENBAO_SECRET_ID: 'fresh-test-placeholder' }),
    /login failed \(HTTP 503\)/);

  assert.ok(!(await readFile(databasePath)).includes(Buffer.from(key)));
  assert.ok(!(await readFile(databasePath)).includes(Buffer.from(rotated)));
});
