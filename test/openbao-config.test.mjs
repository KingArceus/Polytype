import test from 'node:test';
import assert from 'node:assert/strict';
import { readOpenBaoAdminKey } from '../openbao.mjs';

test('an unconfigured app stays public, and local secret sources are rejected', async () => {
  assert.equal(await readOpenBaoAdminKey({}), '');
  for (const name of ['POLYTYPE_ADMIN_KEY', 'POLYTYPE_ADMIN_KEY_FILE']) {
    await assert.rejects(readOpenBaoAdminKey({ [name]: 'not-to-be-read' }), /only in OpenBao/);
  }
  for (const env of [
    { POLYTYPE_OPENBAO_ROLE_ID: 'role' }, { POLYTYPE_OPENBAO_TIMEOUT_MS: '5000' },
    { POLYTYPE_OPENBAO_ADDR: '' }, { POLYTYPE_OPENBAO_SECRET_ID: '' }
  ]) {
    await assert.rejects(readOpenBaoAdminKey(env), /ADDR is required/);
  }
});

test('OpenBao requires verified HTTPS, valid paths, bounded timeouts, and a fresh SecretID', async () => {
  const configured = () => ({
    POLYTYPE_OPENBAO_ADDR: 'https://127.0.0.1:8200',
    POLYTYPE_OPENBAO_ROLE_ID: 'role', POLYTYPE_OPENBAO_SECRET_ID: 'one-use-secret'
  });
  for (const address of ['http://127.0.0.1:8200', 'https://user:password@localhost',
    'https://localhost/path', 'https://localhost/?token=secret', 'https://localhost/#secret', 'invalid']) {
    const env = { ...configured(), POLYTYPE_OPENBAO_ADDR: address };
    await assert.rejects(readOpenBaoAdminKey(env), /POLYTYPE_OPENBAO_ADDR/);
    assert.ok(!('POLYTYPE_OPENBAO_SECRET_ID' in env));
  }
  for (const path of ['../other', '/secret/data/key', 'secret/data/key?token=x', 'secret//key']) {
    await assert.rejects(readOpenBaoAdminKey({ ...configured(), POLYTYPE_OPENBAO_KV_PATH: path }), /KV_PATH/);
  }
  for (const timeout of ['0', '-1', '1.5', '60001', 'NaN']) {
    await assert.rejects(readOpenBaoAdminKey({ ...configured(), POLYTYPE_OPENBAO_TIMEOUT_MS: timeout }), /TIMEOUT_MS/);
  }
  const env = configured();
  delete env.POLYTYPE_OPENBAO_SECRET_ID;
  await assert.rejects(readOpenBaoAdminKey(env), /in-memory SecretID/);
  await assert.rejects(readOpenBaoAdminKey({ ...configured(), POLYTYPE_OPENBAO_CA_FILE: 'no-such-ca-certificate' }),
    /^Error: Unable to read the OpenBao CA certificate\.$/);
});
