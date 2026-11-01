import { readFile } from 'node:fs/promises';
import { request } from 'node:https';

const SECRET_PATH = 'secret/data/polytype/admin';
const MAX_RESPONSE_BYTES = 65536;

function call(base, path, { ca, timeoutMs, method = 'GET', token, body, operation }) {
  return new Promise((resolve, reject) => {
    const failure = () => new Error(`OpenBao ${operation} failed.`);
    const req = request(new URL(`/v1/${path}`, base), {
      method, ca, rejectUnauthorized: true, signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'X-Vault-Request': 'true',
        ...(token ? { 'X-Vault-Token': token } : {})
      }
    }, (response) => {
      response.on('error', () => reject(failure()));
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`OpenBao ${operation} failed (HTTP ${response.statusCode}).`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) response.destroy(failure());
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(text ? JSON.parse(text) : null);
        } catch { reject(failure()); }
      });
    });
    req.on('error', () => reject(failure()));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

// No key files, environment-variable keys, response caches, or token-helper writes.
export async function readOpenBaoAdminKey(env = process.env) {
  const configured = ['ADDR', 'ROLE_ID', 'SECRET_ID', 'CA_FILE', 'KV_PATH', 'TIMEOUT_MS']
    .some((setting) => `POLYTYPE_OPENBAO_${setting}` in env);
  const secretId = env.POLYTYPE_OPENBAO_SECRET_ID;
  delete env.POLYTYPE_OPENBAO_SECRET_ID;
  if ('POLYTYPE_ADMIN_KEY' in env || 'POLYTYPE_ADMIN_KEY_FILE' in env) {
    throw new Error('Store POLYTYPE_ADMIN_KEY only in OpenBao; environment and key-file sources are no longer supported.');
  }
  const address = env.POLYTYPE_OPENBAO_ADDR;
  if (!address) {
    if (configured) {
      throw new Error('POLYTYPE_OPENBAO_ADDR is required when OpenBao settings are supplied.');
    }
    return '';
  }
  let base;
  try { base = new URL(address); } catch { throw new Error('Invalid POLYTYPE_OPENBAO_ADDR.'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('POLYTYPE_OPENBAO_ADDR must be an HTTPS origin without credentials, path, query, or fragment.');
  }
  const roleId = env.POLYTYPE_OPENBAO_ROLE_ID;
  if (!roleId || !secretId) throw new Error('OpenBao requires a RoleID and an in-memory SecretID for each start.');
  const path = env.POLYTYPE_OPENBAO_KV_PATH || SECRET_PATH;
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)+$/.test(path)) {
    throw new Error('Invalid POLYTYPE_OPENBAO_KV_PATH. Use the KV v2 API path including /data/.');
  }
  const timeoutMs = Number(env.POLYTYPE_OPENBAO_TIMEOUT_MS || 5000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new Error('POLYTYPE_OPENBAO_TIMEOUT_MS must be between 1 and 60000.');
  }
  let ca;
  if (env.POLYTYPE_OPENBAO_CA_FILE) {
    try { ca = await readFile(env.POLYTYPE_OPENBAO_CA_FILE); }
    catch { throw new Error('Unable to read the OpenBao CA certificate.'); }
  }
  const options = { ca, timeoutMs };
  const login = await call(base, 'auth/approle/login', {
    ...options, method: 'POST', body: { role_id: roleId, secret_id: secretId }, operation: 'AppRole login'
  });
  const token = login?.auth?.client_token;
  if (typeof token !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(token)) {
    throw new Error('OpenBao AppRole login did not return a valid token.');
  }
  try {
    const response = await call(base, path, { ...options, token, operation: 'admin-key read' });
    const key = response?.data?.data?.POLYTYPE_ADMIN_KEY;
    if (typeof key !== 'string' || !key.trim() || key !== key.trim() || key.length > 4096) {
      throw new Error('OpenBao must contain a non-empty POLYTYPE_ADMIN_KEY string of at most 4096 characters without surrounding whitespace.');
    }
    return key;
  } finally {
    await call(base, 'auth/token/revoke-self', { ...options, token, method: 'POST', operation: 'token revocation' });
  }
}
