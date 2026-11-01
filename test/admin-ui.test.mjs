import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../admin.js', import.meta.url), 'utf8');
const settle = () => new Promise(setImmediate);

async function adminPage({ pathname = '/admin/', authenticated = false, configured = true } = {}) {
  class Target {
    value = '';
    open = false;
    hidden = true;
    dataset = {};
    listeners = new Map();
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    dispatchEvent(event) {
      for (const listener of this.listeners.get(event.type) || []) listener(event);
      return !event.defaultPrevented;
    }
    async fire(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) await listener({ preventDefault() {}, ...event });
    }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() { this.focused = true; }
    reportValidity() { return true; }
  }
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Target());
    return elements.get(id);
  };
  const window = new Target();
  window.location = { pathname, hash: '', assign: (url) => { window.destination = url; } };
  window.history = { replaceState: (_, __, hash) => { window.location.hash = hash; } };
  const requests = [];
  const changes = [];
  let pendingStatus = null;
  window.addEventListener('polytype:adminchange', (event) => changes.push(event.detail));
  runInNewContext(source, {
    document: { getElementById: get }, window,
    CustomEvent: class {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; this.cancelable = options.cancelable; }
      preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      const method = options.method || 'GET';
      if (method === 'GET') {
        if (pendingStatus) return pendingStatus;
        return { ok: true, json: async () => ({ authenticated, configured }) };
      }
      if (method === 'POST') {
        const valid = JSON.parse(options.body).key === 'test-only-admin-key';
        if (valid) authenticated = true;
        return { ok: valid, json: async () => valid ? { authenticated, configured } : { error: 'Wrong admin key.' } };
      }
      authenticated = false;
      return { ok: true, json: async () => ({ authenticated, configured }) };
    }
  });
  await settle();
  return {
    get, window, requests, changes,
    deferStatus() {
      let resolve;
      pendingStatus = new Promise((done) => { resolve = done; });
      return (value) => resolve({ ok: true, json: async () => value });
    }
  };
}

test('public route never requests admin authentication or opens the popup', async () => {
  const app = await adminPage({ pathname: '/', authenticated: true });
  assert.equal(app.window.polytypeAdmin.authenticated, false);
  assert.equal(app.get('adminDialog').open, false);
  assert.equal(app.requests.length, 0);
  app.window.polytypeAdmin.requireLogin('ignored on public page');
  assert.equal(app.get('adminDialog').open, false);
});

test('admin popup verifies keys, clears the input, unlocks controls, and logs out', async () => {
  const app = await adminPage();
  const { get, window } = app;
  assert.equal(window.location.hash, '#dictionary');
  assert.equal(get('adminDialog').open, true);
  assert.equal(window.polytypeAdmin.authenticated, false);
  get('adminKey').value = 'wrong';
  await get('adminLoginForm').fire('submit');
  assert.equal(get('adminKey').value, '');
  assert.equal(get('adminDialog').open, true);
  assert.equal(get('adminLoginStatus').dataset.state, 'error');
  get('adminKey').value = 'test-only-admin-key';
  await get('adminLoginForm').fire('submit');
  assert.equal(window.polytypeAdmin.authenticated, true);
  assert.equal(get('adminDialog').open, false);
  assert.equal(get('adminLogoutBtn').hidden, false);
  assert.equal(get('adminKey').value, '');
  const login = app.requests.at(-1);
  assert.equal(login.url, '/api/admin/session');
  assert.equal(login.options.method, 'POST');
  assert.equal(login.options.credentials, 'same-origin');
  assert.equal(login.url.includes('test-only-admin-key'), false);
  await get('adminLogoutBtn').fire('click');
  assert.equal(app.requests.at(-1).options.method, 'DELETE');
  assert.equal(window.polytypeAdmin.authenticated, false);
  assert.equal(get('adminLogoutBtn').hidden, true);
  assert.equal(get('adminDialog').open, true);
});

test('missing server key stays locked and cancel returns to the public dictionary', async () => {
  const app = await adminPage({ configured: false });
  assert.equal(app.get('adminDialog').open, true);
  assert.equal(app.get('adminLoginBtn').disabled, true);
  assert.equal(app.get('adminKey').disabled, true);
  assert.match(app.get('adminLoginStatus').textContent, /chưa cấu hình/);
  await app.get('adminDialog').fire('cancel');
  assert.equal(app.window.destination, '/#dictionary');
});

test('focus preserves a key being entered and stale session checks cannot unlock an expired session', async () => {
  const locked = await adminPage();
  locked.get('adminKey').value = 'partially entered';
  await locked.window.fire('focus');
  assert.equal(locked.get('adminKey').value, 'partially entered');
  assert.equal(locked.requests.length, 1);

  const app = await adminPage({ authenticated: true });
  const resolve = app.deferStatus();
  const checking = app.window.fire('focus');
  app.window.polytypeAdmin.requireLogin('Session expired.');
  resolve({ authenticated: true, configured: true });
  await checking;
  assert.equal(app.window.polytypeAdmin.authenticated, false);
  assert.equal(app.get('adminDialog').open, true);
  assert.equal(app.get('adminLoginStatus').textContent, 'Session expired.');
});

test('unsaved-edit logout guard can cancel logout before a server request', async () => {
  const app = await adminPage({ authenticated: true });
  app.window.addEventListener('polytype:before-admin-logout', (event) => event.preventDefault());
  await app.get('adminLogoutBtn').fire('click');
  assert.equal(app.requests.length, 1);
  assert.equal(app.window.polytypeAdmin.authenticated, true);
});
