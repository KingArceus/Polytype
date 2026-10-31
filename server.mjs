import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { Dictionary } from './dictionary.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
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

export async function createAppServer({ databasePath = join(root, 'data/dictionary.db') } = {}) {
  const { languages } = JSON.parse(await readFile(join(root, 'languages.json'), 'utf8'));
  const dictionary = new Dictionary(databasePath, languages);
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        json(response, 405, { error: 'Method not allowed' });
        return;
      }
      const url = new URL(request.url, 'http://localhost');
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
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      console.error('Request failed:', error.message);
      if (!response.headersSent) json(response, 500, { error: 'Unable to load dictionary data' });
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
    console.error(`Unable to open data/dictionary.db: ${error.message}`);
    process.exitCode = 1;
  }
}
