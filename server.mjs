import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { Dictionary } from './dictionary.mjs';
import { AdminAuth } from './admin-auth.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/admin', ['index.html', 'text/html; charset=utf-8']],
  ['/admin/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/dictionary-editor.js', ['dictionary-editor.js', 'text/javascript; charset=utf-8']],
  ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
  ['/theme.js', ['theme.js', 'text/javascript; charset=utf-8']]
]);

function json(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw Object.assign(new Error('Use application/json.'), { status: 415 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
  }
}

export async function createAppServer({
  databasePath = join(root, 'data/dictionary.db'), adminKey,
  adminKeyFile = process.env.POLYTYPE_ADMIN_KEY_FILE,
  adminSecureCookie = process.env.POLYTYPE_ADMIN_SECURE_COOKIE === 'true',
  adminSessionTtlMs, adminNow
} = {}) {
  const key = adminKey !== undefined ? adminKey : adminKeyFile
    ? (await readFile(adminKeyFile, 'utf8')).trim() : process.env.POLYTYPE_ADMIN_KEY || '';
  const admin = new AdminAuth({ key, secureCookie: adminSecureCookie, sessionTtlMs: adminSessionTtlMs, now: adminNow });
  const { languages } = JSON.parse(await readFile(join(root, 'languages.json'), 'utf8'));
  const dictionary = new Dictionary(databasePath, languages);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/admin/session') {
        if (request.method === 'GET' || request.method === 'HEAD') {
          json(response, 200, { authenticated: admin.authenticated(request), configured: admin.configured });
          return;
        }
        if (request.method !== 'POST' && request.method !== 'DELETE') {
          response.setHeader('Allow', 'GET, HEAD, POST, DELETE');
          json(response, 405, { error: 'Method not allowed' });
          return;
        }
        if (!admin.sameOrigin(request)) {
          json(response, 403, { error: 'Yêu cầu quản trị phải đến từ ứng dụng này.' });
          return;
        }
        if (request.method === 'DELETE') {
          response.setHeader('Set-Cookie', admin.logout(request));
          json(response, 200, { authenticated: false, configured: admin.configured });
          return;
        }
        const values = await readJson(request);
        const result = admin.login(values?.key, request);
        if (result.error) {
          if (result.retryAfter) response.setHeader('Retry-After', result.retryAfter);
          json(response, result.status, { error: result.error });
        } else {
          response.setHeader('Set-Cookie', result.cookie);
          json(response, 200, { authenticated: true, configured: true });
        }
        return;
      }
      const entryRoute = /^\/api\/dictionary\/(\d+)$/.exec(url.pathname);
      const creating = url.pathname === '/api/dictionary' && request.method === 'POST';
      if (entryRoute || creating) {
        if (!creating && request.method !== 'PUT') {
          response.setHeader('Allow', 'PUT');
          json(response, 405, { error: 'Method not allowed' });
          return;
        }
        if (!admin.sameOrigin(request)) {
          json(response, 403, { error: 'Dictionary edits must come from this application.' });
          return;
        }
        if (!admin.authenticated(request)) {
          json(response, 401, { error: 'Vui lòng đăng nhập quản trị để thay đổi từ điển.' });
          return;
        }
        const id = entryRoute ? Number(entryRoute[1]) : null;
        if (!creating && (!Number.isSafeInteger(id) || id < 1)) {
          json(response, 400, { error: 'Invalid word ID.' });
          return;
        }
        const values = await readJson(request);
        const word = creating ? dictionary.createEntry(values?.language, values) : dictionary.updateEntry(id, values);
        json(response, creating ? 201 : 200, { word });
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('Allow', url.pathname === '/api/dictionary' ? 'GET, HEAD, POST' : 'GET, HEAD');
        json(response, 405, { error: 'Method not allowed' });
        return;
      }
      if (url.pathname === '/api/dictionary/languages') {
        json(response, 200, { languages: dictionary.getDictionaryLanguages() });
        return;
      }
      if (url.pathname === '/api/dictionary') {
        const offsetText = url.searchParams.get('offset') ?? '0';
        const limitText = url.searchParams.get('limit') ?? '25';
        const offset = Number(offsetText);
        const limit = Number(limitText);
        const query = (url.searchParams.get('q') ?? '').trim();
        if (!/^\d+$/.test(offsetText) || !Number.isSafeInteger(offset) ||
            !/^\d+$/.test(limitText) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || query.length > 200) {
          json(response, 400, { error: 'Invalid dictionary search or page.' });
          return;
        }
        const batch = dictionary.searchEntries(url.searchParams.get('language'), query, offset, limit);
        json(response, batch ? 200 : 400, batch ?? { error: 'Unsupported language' });
        return;
      }
      if (url.pathname === '/api/languages') {
        json(response, 200, { languages: dictionary.getLanguages() });
        return;
      }
      if (url.pathname === '/api/words') {
        const language = url.searchParams.get('language');
        const offsetText = url.searchParams.get('offset') ?? '0';
        const limitText = url.searchParams.get('limit') ?? '100';
        const offset = Number(offsetText);
        const limit = Number(limitText);
        const seedText = url.searchParams.get('seed');
        const seed = seedText === null ? null : Number(seedText);
        if (!/^\d+$/.test(offsetText) || !Number.isSafeInteger(offset) ||
            !/^\d+$/.test(limitText) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          json(response, 400, { error: 'Use a non-negative offset and a limit between 1 and 100.' });
          return;
        }
        if (seedText !== null && (!/^\d+$/.test(seedText) || !Number.isSafeInteger(seed) || seed > 0xffffffff)) {
          json(response, 400, { error: 'Use a seed between 0 and 4294967295.' });
          return;
        }
        const batch = dictionary.getWords(language, offset, limit, seed);
        json(response, batch ? 200 : 400, batch ?? { error: 'Unsupported language' });
        return;
      }
      const file = staticFiles.get(url.pathname);
      if (!file) {
        json(response, 404, { error: 'Not found' });
        return;
      }
      const content = await readFile(join(root, file[0]));
      response.writeHead(200, {
        'Content-Type': file[1],
        'Content-Length': content.length,
        'Cache-Control': url.pathname.startsWith('/admin') ? 'no-store' : 'no-cache',
        'Referrer-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!error.status) console.error('Request failed:', error.message);
      if (!response.headersSent) json(response, error.status || 500, { error: error.status ? error.message : 'Unable to load or save dictionary data' });
      else response.end();
    }
  });
  server.on('close', () => dictionary.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = await createAppServer();
    const port = Number(process.env.PORT || 4173);
    const host = process.env.HOST || '127.0.0.1';
    server.on('error', (error) => {
      console.error(`Unable to start server: ${error.message}`);
      server.close();
      process.exitCode = 1;
    });
    server.listen(port, host, () => console.log(`Polytype: http://${host}:${port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
  } catch (error) {
    console.error(`Unable to start Polytype: ${error.message}`);
    process.exitCode = 1;
  }
}
