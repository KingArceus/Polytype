import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, rmdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Dictionary } from '../dictionary.mjs';
import { createAppServer } from '../server.mjs';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'polytype-dictionary-'));
  const filename = join(directory, 'fixture.db');
  const db = new DatabaseSync(filename);
  db.exec(`
    CREATE TABLE words (id INTEGER PRIMARY KEY, word TEXT, lang_code TEXT);
    CREATE TABLE definitions (id INTEGER PRIMARY KEY, definition TEXT, pos TEXT, definition_lang TEXT);
    CREATE TABLE word_definitions (id INTEGER PRIMARY KEY, word_id INTEGER, definition_id INTEGER);
    CREATE TABLE pronunciations (id INTEGER PRIMARY KEY, word_id INTEGER, ipa TEXT);
    INSERT INTO words VALUES
      (1, 'hello', 'en'), (2, 'can''t', 'en'), (3, 'two words', 'en'),
      (4, '123', 'en'), (5, '<markup>', 'en'), (6, 'bonjour', 'fr'),
      (7, '日本', 'ja'), (8, 'nihon', 'ja'), (9, 'мама', 'ru'),
      (10, 'latin', 'ru'), (11, 'casa', 'es'), (12, 'übung', 'de'),
      (13, 'word-with-hyphens', 'en'), (14, 'a', 'en'),
      (15, 'abcdefghijklmnopqrstuvwxyz', 'en');
    INSERT INTO definitions VALUES
      (1, 'English greeting', 'noun', 'en'),
      (2, 'Xin chào, chào bạn.', 'thán từ', 'vi'),
      (3, 'Lời chào khác', 'noun', 'vi'),
      (4, 'Cannot', 'verb', 'en');
    INSERT INTO word_definitions VALUES (1,1,1), (2,1,2), (3,1,3), (4,2,4);
    INSERT INTO pronunciations VALUES (1,1,''), (2,1,'/həˈloʊ/'), (3,1,'/həˈləʊ/');
  `);
  db.close();
  return {
    filename,
    cleanup: async () => {
      await rm(filename, { force: true });
      await rmdir(directory);
    }
  };
}

test('dictionary filters untypeable entries and pages unique words with preferred metadata', async (t) => {
  const data = await fixture();
  const dictionary = new Dictionary(data.filename, ['en', 'fr', 'de', 'es', 'ru', 'ja'].map((id) => ({ id })));
  t.after(() => dictionary.close());
  t.after(data.cleanup);
  const first = dictionary.getWords('en', 0, 1);
  assert.equal(first.total, 3);
  assert.deepEqual(first.words[0], {
    id: 1, word: 'hello', meaning: 'Xin chào, chào bạn.', type: 'thán từ', ipa: '/həˈloʊ/'
  });
  assert.equal(dictionary.getWords('en', 1, 1).words[0].word, "can't");
  assert.equal(dictionary.getWords('en', 1, 1).words[0].meaning, 'Cannot');
  assert.equal(dictionary.getWords('en', 2, 1).words[0].word, 'word-with-hyphens');
  assert.deepEqual(dictionary.getWords('en', 3, 1).words, []);
  assert.deepEqual(dictionary.getWords('ja').words.map((word) => word.word), ['nihon']);
  assert.deepEqual(dictionary.getWords('ru').words.map((word) => word.word), ['мама']);
  assert.equal(dictionary.getWords('de').words[0].ipa, '');
  assert.equal(dictionary.getWords("en' OR 1=1 --"), null);
  assert.throws(() => dictionary.db.exec('DELETE FROM words'), /readonly/i);
});

async function serve(t, options) {
  const server = await createAppServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('seeded sessions shuffle the full list and page without repeats', async (t) => {
  const data = await fixture();
  const base = await serve(t, { databasePath: data.filename });
  t.after(data.cleanup);
  const batch = async (seed, offset = 0, limit = 100) => {
    const response = await fetch(`${base}/api/words?language=en&seed=${seed}&offset=${offset}&limit=${limit}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const orders = new Set();
  for (const seed of [0, 1, 2, 3, 4294967295]) {
    const full = await batch(seed);
    assert.equal(full.total, 3);
    assert.deepEqual(full.words.map((word) => word.id).sort((a, b) => a - b), [1, 2, 13]);
    orders.add(full.words.map((word) => word.id).join(','));
    const pages = [];
    for (let offset = 0; offset < full.total; offset++) {
      pages.push(...(await batch(seed, offset, 1)).words);
    }
    assert.deepEqual(pages, full.words);
    // Another session can replace the cache without changing this session's order.
    await batch(seed === 0 ? 1 : 0);
    assert.deepEqual((await batch(seed)).words, full.words);
    assert.deepEqual((await batch(seed, full.total)).words, []);
  }
  assert.ok(orders.size > 1, 'different seeds must produce different orders');
  for (const seed of ['', '-1', '1.5', 'Infinity', '4294967296', 'abc']) {
    assert.equal((await fetch(`${base}/api/words?language=en&seed=${seed}`)).status, 400, seed);
  }
});

test('API exposes dictionary-backed languages, bounded pages, and static application files', async (t) => {
  const data = await fixture();
  const base = await serve(t, { databasePath: data.filename });
  t.after(data.cleanup);
  const response = await fetch(`${base}/api/languages`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  const { languages } = await response.json();
  assert.equal(languages.length, 6);
  assert.equal(languages.find((language) => language.id === 'en').wordCount, 3);
  assert.ok(languages.every((language) => !('file' in language)));
  const batch = await (await fetch(`${base}/api/words?language=en&offset=1&limit=1`)).json();
  assert.equal(batch.offset, 1);
  assert.equal(batch.total, 3);
  assert.equal(batch.words.length, 1);
  assert.equal(batch.words[0].word, "can't");
  assert.deepEqual((await (await fetch(`${base}/api/words?language=en&offset=300`)).json()).words, []);
  for (const query of ['language=xx', 'language=en&limit=101', 'language=en&limit=0',
    'language=en&offset=-1', 'language=en&offset=1.5', 'language=en&offset=Infinity',
    'language=en&offset=9007199254740992', 'language=en&limit=abc', 'language=en&offset=']) {
    assert.equal((await fetch(`${base}/api/words?${query}`)).status, 400, query);
  }
  for (const pathname of ['/data/dictionary.db', '/server.mjs', '/.git/config', '/not-found']) {
    assert.equal((await fetch(`${base}${pathname}`)).status, 404, pathname);
  }
  assert.equal((await fetch(`${base}/api/words`, { method: 'POST' })).status, 405);
  const html = await (await fetch(base)).text();
  assert.match(html, /id="wordDisplayContainer"/);
  assert.match(await (await fetch(`${base}/app.js`)).text(), /\/api\/words/);
  assert.equal((await fetch(`${base}/styles.css`, { method: 'HEAD' })).status, 200);
});

test('real dictionary serves all configured languages and preserves source word identity', async (t) => {
  const base = await serve(t);
  const { languages } = await (await fetch(`${base}/api/languages`)).json();
  const config = JSON.parse(await readFile(new URL('../languages.json', import.meta.url), 'utf8'));
  assert.deepEqual(languages.map((language) => language.id), config.languages.map((language) => language.id));
  const db = new DatabaseSync(new URL('../data/dictionary.db', import.meta.url), { readOnly: true });
  t.after(() => db.close());
  const source = db.prepare('SELECT word, lang_code FROM words WHERE id = ?');
  for (const language of languages) {
    const first = await (await fetch(`${base}/api/words?language=${language.id}&limit=2`)).json();
    assert.equal(first.total, language.wordCount);
    assert.equal(first.words.length, 2);
    for (const word of first.words) {
      const entry = source.get(word.id);
      assert.equal(word.word, entry.word.normalize('NFC'));
      assert.equal(entry.lang_code, language.id);
    }
    const next = await (await fetch(`${base}/api/words?language=${language.id}&offset=2&limit=2`)).json();
    assert.ok(next.words.every((word) => !first.words.some((previous) => previous.id === word.id)));
  }
});

test('real practice rounds return 100 unique random words rather than the full dictionary', async (t) => {
  const base = await serve(t);
  const round = async (seed) => {
    const response = await fetch(`${base}/api/words?language=en&offset=0&limit=100&seed=${seed}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await round(1);
  const second = await round(2);
  assert.ok(first.total > 100);
  assert.equal(first.words.length, 100);
  assert.equal(second.words.length, 100);
  const firstIds = first.words.map((word) => word.id);
  const secondIds = second.words.map((word) => word.id);
  assert.equal(new Set(firstIds).size, 100);
  assert.equal(new Set(secondIds).size, 100);
  assert.notDeepEqual([...firstIds].sort((a, b) => a - b), [...secondIds].sort((a, b) => a - b));
});
