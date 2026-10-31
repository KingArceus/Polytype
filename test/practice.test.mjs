import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const settle = () => new Promise(setImmediate);

async function practice(wordCount = 1000) {
  // Run the actual page script with a small DOM stub and recorded API requests.
  class Element {
    children = [];
    dataset = {};
    style = {};
    parentElement = { dataset: {} };
    classList = { add() {}, remove() {}, toggle() {} };
    listeners = new Map();
    value = 'en';
    append(child) { this.children.push(child); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    closest() { return null; }
    fire(type, event = {}) { return this.listeners.get(type)?.({ detail: 0, ...event }); }
  }
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const requests = [];
  const window = new Element();
  window.clearTimeout = () => {};
  window.setTimeout = () => 1;
  let seed = 0;
  const math = Object.create(Math);
  math.random = () => ++seed / 100;
  runInNewContext(source, {
    document: { getElementById: get, createElement: () => new Element() },
    window, Element, Math: math, URLSearchParams, performance,
    fetch: async (url) => {
      if (url === '/api/languages') {
        return { ok: true, json: async () => ({ languages: [
          { id: 'en', name: 'English', wordCount }, { id: 'de', name: 'Deutsch', wordCount }
        ] }) };
      }
      const query = new URL(url, 'http://localhost').searchParams;
      requests.push(query);
      return { ok: true, json: async () => ({
        language: query.get('language'), offset: 0, total: wordCount,
        words: Array.from({ length: Math.min(wordCount, Number(query.get('limit'))) },
          (_, id) => ({ id, word: 'hello' }))
      }) };
    }
  });
  await settle();
  return { get, requests, window };
}

test('practice caps rounds at 100 words and draws a new round after the last word', async () => {
  const { get, requests, window } = await practice();
  assert.equal(get('countDisplay').textContent, '1/100');
  assert.equal(get('progressLabel').textContent, 'Từ 1 trong 100');
  assert.equal(requests[0].get('limit'), '100');
  get('soundToggleBtn').fire('click');
  window.fire('keydown', { key: 'x', target: get('practice'), preventDefault() {} });
  assert.equal(get('accuracyDisplay').textContent, '0%');
  for (let index = 1; index < 100; index++) get('nextWordBtn').fire('click');
  assert.equal(get('countDisplay').textContent, '100/100');
  assert.equal(get('progressFill').style.width, '100%');
  assert.equal(requests.length, 1);
  get('nextWordBtn').fire('click');
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].get('offset'), '0');
  assert.notEqual(requests[1].get('seed'), requests[0].get('seed'));
  assert.equal(get('countDisplay').textContent, '1/100');
  assert.equal(get('progressFill').style.width, '1%');
  assert.equal(get('accuracyDisplay').textContent, '100%');
  get('restartBtn').fire('click');
  await settle();
  assert.notEqual(requests[2].get('seed'), requests[1].get('seed'));
  get('langSelect').value = 'de';
  await get('langSelect').fire('change');
  assert.equal(requests[3].get('language'), 'de');
  assert.notEqual(requests[3].get('seed'), requests[2].get('seed'));
  assert.equal(get('countDisplay').textContent, '1/100');
});

test('practice uses the available word count when a language has fewer than 100 words', async () => {
  const { get, requests } = await practice(3);
  assert.equal(get('countDisplay').textContent, '1/3');
  get('nextWordBtn').fire('click');
  get('nextWordBtn').fire('click');
  assert.equal(get('countDisplay').textContent, '3/3');
  get('nextWordBtn').fire('click');
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(get('countDisplay').textContent, '1/3');
});
