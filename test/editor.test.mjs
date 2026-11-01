import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../dictionary-editor.js', import.meta.url), 'utf8');
const settle = () => new Promise(setImmediate);

async function editor({ authenticated = true } = {}) {
  class Element {
    children = [];
    dataset = {};
    attributes = new Map();
    listeners = new Map();
    value = '';
    hidden = false;
    disabled = false;
    classList = { toggle() {} };
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes.set(key, value); }
    removeAttribute(key) { this.attributes.delete(key); }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    async fire(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) await listener({ preventDefault() {}, ...event });
    }
    dispatchEvent(event) { return this.fire(event.type, event); }
    querySelectorAll(tag) {
      return this.children.flatMap((child) => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]);
    }
    reportValidity() { return true; }
    focus() { this.focused = true; }
    scrollIntoView() {}
  }
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const window = new Element();
  window.polytypeAdmin = {
    authenticated,
    requireLogin(message) {
      this.authenticated = false;
      this.message = message;
      window.dispatchEvent({ type: 'polytype:adminchange', detail: { authenticated: false, reason: 'expired' } });
    }
  };
  window.location = { hash: '#dictionary' };
  window.history = { replaceState: (_, __, hash) => { window.location.hash = hash; } };
  const prompts = [];
  let discard = false;
  window.confirm = (message) => { prompts.push(message); return discard; };
  get('langSelect').value = 'en';
  const words = Array.from({ length: 30 }, (_, index) => ({
    id: index + 1, word: `word${index + 1}`, ipa: '', type: 'noun',
    meaning: `meaning ${index + 1}`, definitionLanguage: 'vi', language: 'en'
  }));
  const requests = [];
  let failSave = false;
  let expired = false;
  let savedEvents = 0;
  window.addEventListener('polytype:dictionary-saved', () => { savedEvents++; });
  runInNewContext(source, {
    document: {
      getElementById: get,
      querySelector: get,
      createElement: (tag) => Object.assign(new Element(), { tag })
    },
    window, URLSearchParams,
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      const path = new URL(url, 'http://localhost');
      if (path.pathname === '/api/dictionary/languages') {
        return { ok: true, json: async () => ({ languages: [{ id: 'en', name: 'English' }, { id: 'de', name: 'Deutsch' }] }) };
      }
      if (options.method === 'PUT' || options.method === 'POST') {
        if (expired) return { ok: false, status: 401, json: async () => ({ error: 'Admin session required.' }) };
        if (failSave) return { ok: false, json: async () => ({ error: 'Save failed. Try again.' }) };
        if (options.method === 'POST') {
          const values = JSON.parse(options.body);
          if (words.some((word) => word.word === values.word && word.language === values.language)) {
            return { ok: false, json: async () => ({ error: 'This word already exists.' }) };
          }
          const word = { id: words.length + 1, definitionLanguage: 'vi', ...values };
          words.push(word);
          return { ok: true, json: async () => ({ word: { ...word } }) };
        }
        const word = words.find((word) => word.id === Number(path.pathname.split('/').pop()));
        Object.assign(word, JSON.parse(options.body));
        return { ok: true, json: async () => ({ word: { ...word } }) };
      }
      const language = path.searchParams.get('language');
      const offset = Number(path.searchParams.get('offset'));
      const query = path.searchParams.get('q');
      const matches = words.filter((word) => word.language === language && word.word.includes(query));
      return { ok: true, json: async () => ({
        words: matches.slice(offset, offset + 25).map((word) => ({ ...word })), total: matches.length
      }) };
    }
  });
  await settle();
  return {
    get, window, words, requests, prompts,
    buttons: () => get('dictionaryList').querySelectorAll('button'),
    setDiscard: (value) => { discard = value; },
    setFailSave: (value) => { failSave = value; },
    setExpired: (value) => { expired = value; },
    savedEvents: () => savedEvents,
    navigate: async (hash) => { window.location.hash = hash; await window.fire('hashchange'); }
  };
}

test('dictionary tab loads lazily, pages and searches, and switches languages', async () => {
  const app = await editor();
  const { get, buttons } = app;
  assert.equal(get('practicePage').hidden, true);
  assert.equal(get('dictionary').hidden, false);
  assert.equal(buttons().length, 25);
  assert.equal(get('dictionaryNextBtn').disabled, false);
  await get('dictionaryNextBtn').fire('click');
  await settle();
  assert.equal(buttons().length, 5);
  assert.equal(buttons()[0].children[0].textContent, 'word26');
  assert.equal(get('dictionaryNextBtn').disabled, true);
  get('dictionarySearch').value = 'word30';
  await get('dictionarySearchForm').fire('submit');
  await settle();
  assert.equal(buttons().length, 1);
  await buttons()[0].fire('click');
  assert.equal(get('editWord').value, 'word30');
  assert.equal(get('editWord').focused, true);
  get('dictionaryLanguage').value = 'de';
  await get('dictionaryLanguage').fire('change');
  await settle();
  assert.equal(buttons().length, 0);
  assert.equal(get('dictionaryEditForm').hidden, true);
  assert.match(get('dictionaryStatus').textContent, /Không tìm thấy/);
});

test('unsaved changes survive canceled navigation and can be undone or explicitly discarded', async () => {
  const app = await editor();
  const { get } = app;
  await app.buttons()[0].fire('click');
  get('editMeaning').value = 'unsaved';
  await get('dictionaryEditForm').fire('input');
  assert.equal(get('dictionaryDirty').hidden, false);
  await app.navigate('#practice');
  assert.equal(app.window.location.hash, '#dictionary');
  assert.equal(get('practicePage').hidden, true);
  assert.equal(get('editMeaning').value, 'unsaved');
  assert.equal(app.prompts.length, 1);
  await app.buttons()[1].fire('click');
  assert.equal(get('editWord').value, 'word1');
  await get('dictionaryCancelBtn').fire('click');
  assert.equal(get('editMeaning').value, 'meaning 1');
  assert.equal(get('dictionarySaveBtn').disabled, true);
  get('editMeaning').value = 'unsaved again';
  app.setDiscard(true);
  await app.navigate('#practice');
  assert.equal(get('practicePage').hidden, false);
  assert.equal(get('dictionary').hidden, true);
  assert.equal(app.words[0].meaning, 'meaning 1');
});

test('save errors retain edits and successful retry persists fields and refreshes practice', async () => {
  const app = await editor();
  const { get } = app;
  await app.buttons()[0].fire('click');
  get('editWord').value = 'edited';
  get('editIpa').value = '/edit/';
  get('editType').value = 'verb';
  get('editMeaning').value = 'Nghĩa mới';
  await get('dictionaryEditForm').fire('input');
  app.setFailSave(true);
  await get('dictionaryEditForm').fire('submit');
  assert.equal(get('editWord').value, 'edited');
  assert.equal(get('dictionarySaveStatus').dataset.state, 'error');
  assert.equal(get('dictionarySaveStatus').focused, true);
  assert.equal(get('dictionarySaveBtn').disabled, false);
  assert.equal(app.savedEvents(), 0);
  app.setFailSave(false);
  await get('dictionaryEditForm').fire('submit');
  await settle();
  assert.equal(app.words[0].word, 'edited');
  assert.equal(app.words[0].ipa, '/edit/');
  assert.equal(app.words[0].type, 'verb');
  assert.equal(app.words[0].meaning, 'Nghĩa mới');
  assert.equal(app.savedEvents(), 1);
  assert.equal(get('dictionarySaveStatus').dataset.state, 'success');
  assert.equal(get('dictionaryDirty').hidden, true);
  assert.equal(get('dictionarySaveBtn').disabled, true);
  await app.navigate('#dictionaryHeading');
  assert.equal(get('dictionary').hidden, false, 'skip link must stay in the dictionary');
});

test('new words use the selected language, appear in search, and become editable after creation', async () => {
  const app = await editor();
  const { get } = app;
  get('dictionaryLanguage').value = 'de';
  await get('dictionaryLanguage').fire('change');
  await settle();
  assert.equal(app.buttons().length, 0);
  await get('dictionaryAddBtn').fire('click');
  assert.equal(get('dictionaryEditForm').hidden, false);
  assert.equal(get('dictionaryEditHeading').textContent, 'Thêm từ mới · Deutsch');
  assert.equal(get('editWord').focused, true);
  assert.equal(get('dictionarySaveBtn').textContent, 'Thêm từ');
  assert.equal(get('dictionarySaveBtn').disabled, true);
  assert.equal(get('dictionaryCancelBtn').disabled, false);
  get('editWord').value = 'hallo';
  await get('dictionaryEditForm').fire('input');
  await get('dictionaryEditForm').fire('submit');
  await settle();
  const request = app.requests.find(({ options }) => options.method === 'POST');
  assert.equal(request.url, '/api/dictionary');
  assert.deepEqual(JSON.parse(request.options.body), { language: 'de', word: 'hallo', ipa: '', type: '', meaning: '' });
  assert.equal(app.words.at(-1).language, 'de');
  assert.equal(app.buttons().length, 1);
  assert.equal(app.buttons()[0].children[0].textContent, 'hallo');
  assert.equal(get('dictionarySearch').value, 'hallo');
  assert.equal(get('dictionaryEditHeading').textContent, 'Word detail');
  assert.equal(get('dictionarySaveBtn').textContent, 'Lưu thay đổi');
  assert.equal(app.savedEvents(), 1);
  get('editMeaning').value = 'xin chào';
  await get('dictionaryEditForm').fire('input');
  await get('dictionaryEditForm').fire('submit');
  await settle();
  assert.equal(app.requests.filter(({ options }) => options.method === 'POST').length, 1);
  assert.equal(app.requests.filter(({ options }) => options.method === 'PUT').length, 1);
  assert.equal(app.words.at(-1).meaning, 'xin chào');
});

test('new-word errors keep the draft for retry and unsaved drafts are protected', async () => {
  const app = await editor();
  const { get } = app;
  await get('dictionaryAddBtn').fire('click');
  get('editWord').value = 'word1';
  await get('dictionaryEditForm').fire('input');
  await get('dictionaryEditForm').fire('submit');
  assert.equal(get('dictionarySaveStatus').dataset.state, 'error');
  assert.equal(get('editWord').value, 'word1');
  assert.equal(get('dictionarySaveBtn').textContent, 'Thêm từ');
  await app.navigate('#practice');
  assert.equal(get('dictionary').hidden, false);
  assert.equal(get('editWord').value, 'word1');
  get('editWord').value = 'newword';
  app.setFailSave(true);
  await get('dictionaryEditForm').fire('submit');
  assert.equal(get('editWord').value, 'newword');
  app.setFailSave(false);
  await get('dictionaryEditForm').fire('submit');
  await settle();
  assert.equal(app.words.length, 31);
  assert.equal(app.savedEvents(), 1);
  await get('dictionaryAddBtn').fire('click');
  await get('dictionaryCancelBtn').fire('click');
  assert.equal(get('dictionaryEditForm').hidden, true);
  assert.equal(app.words.length, 31);
});

test('public dictionary shows read-only Word detail and cannot submit hidden add or edit actions', async () => {
  const app = await editor({ authenticated: false });
  const { get } = app;
  assert.equal(get('dictionaryAddBtn').hidden, true);
  await app.buttons()[0].fire('click');
  assert.equal(get('dictionaryEditHeading').textContent, 'Word detail');
  assert.equal(get('dictionaryEditHeading').focused, true);
  assert.equal(get('editWord').value, 'word1');
  for (const id of ['editWord', 'editIpa', 'editType', 'editMeaning']) assert.equal(get(id).readOnly, true);
  assert.equal(get('dictionarySaveBtn').hidden, true);
  assert.equal(get('dictionaryCancelBtn').hidden, true);
  assert.equal(get('dictionaryFormActions').hidden, true);
  await get('dictionaryAddBtn').fire('click');
  get('editMeaning').value = 'scripted change';
  await get('dictionaryEditForm').fire('submit');
  assert.equal(app.requests.filter(({ options }) => options.method).length, 0);
  assert.equal(app.words[0].meaning, 'meaning 1');
});

test('expired sessions lock controls, retain the draft, and allow saving after reauthentication', async () => {
  const app = await editor();
  const { get } = app;
  await app.buttons()[0].fire('click');
  get('editMeaning').value = 'unsaved meaning';
  await get('dictionaryEditForm').fire('input');
  app.setExpired(true);
  await get('dictionaryEditForm').fire('submit');
  assert.equal(app.window.polytypeAdmin.authenticated, false);
  assert.match(app.window.polytypeAdmin.message, /hết hạn/);
  assert.equal(get('editMeaning').value, 'unsaved meaning');
  assert.equal(get('editMeaning').readOnly, true);
  assert.equal(get('dictionarySaveBtn').hidden, true);
  assert.equal(get('dictionaryAddBtn').hidden, true);
  app.window.polytypeAdmin.authenticated = true;
  await app.window.fire('polytype:adminchange', { detail: { authenticated: true, reason: 'login' } });
  app.setExpired(false);
  assert.equal(get('editMeaning').readOnly, false);
  await get('dictionaryEditForm').fire('submit');
  await settle();
  assert.equal(app.words[0].meaning, 'unsaved meaning');
});
