'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const readPublic = relativePath => fs.readFileSync(path.join(repoRoot, 'public', relativePath), 'utf8');

function serviceWorkerHarness({ online = false } = {}) {
  const listeners = new Map();
  const shellEntries = new Map([
    ['/', new Response('cached shell')],
    ['/js/app.js', new Response('cached script')],
  ]);
  const unrelatedEntries = new Map([
    ['/', new Response('poisoned shell')],
    ['/js/app.js', new Response('poisoned script')],
  ]);
  const stores = new Map([
    ['huqan-shell-v1', shellEntries],
    ['unrelated-cache', unrelatedEntries],
  ]);
  const added = [];
  const deleted = [];
  const cacheNames = ['huqan-shell-old', 'unrelated-cache'];
  const context = {
    URL,
    Response,
    Promise,
    fetch: async request => {
      if (!online) throw new Error('offline');
      return new Response(`network:${new URL(request.url).pathname}`);
    },
    caches: {
      async open(name) {
        if (!stores.has(name)) stores.set(name, new Map());
        const entries = stores.get(name);
        return {
          async addAll(paths) { added.push({ name, paths: [...paths] }); },
          async match(request) {
            const key = typeof request === 'string' ? request : new URL(request.url).pathname;
            return entries.get(key);
          },
          async put(request, response) {
            const key = typeof request === 'string' ? request : new URL(request.url).pathname;
            entries.set(key, response);
          },
        };
      },
      async keys() { return [...cacheNames]; },
      async delete(name) { deleted.push(name); return true; },
      async match() { throw new Error('global cache lookup is forbidden'); },
    },
    self: {
      location: { origin: 'http://127.0.0.1:3000' },
      clients: { async claim() {} },
      async skipWaiting() {},
      addEventListener(type, listener) { listeners.set(type, listener); },
    },
  };
  vm.runInNewContext(readPublic('service-worker.js'), context, { filename: 'service-worker.js' });
  return { listeners, added, deleted, stores };
}

function dispatchLifecycle(listener) {
  let completion;
  listener({ waitUntil(value) { completion = Promise.resolve(value); } });
  return completion;
}

function dispatchFetch(listener, pathname, { mode = 'cors', method = 'GET' } = {}) {
  let response;
  listener({
    request: { url: `http://127.0.0.1:3000${pathname}`, method, mode },
    respondWith(value) { response = Promise.resolve(value); },
  });
  return response;
}

function controllerHarness({ online = true, healthReachable = true } = {}) {
  const windowListeners = new Map();
  const buttonListeners = new Map();
  const registrations = [];
  const offlineBanner = { hidden: true };
  const installButton = {
    hidden: true,
    disabled: false,
    addEventListener(type, listener) { buttonListeners.set(type, listener); },
  };
  const installStatus = { textContent: '' };
  const documentElement = { dataset: {} };
  const context = {
    Promise,
    fetch: async () => {
      if (!healthReachable) throw new Error('runtime unavailable');
      return { ok: true };
    },
    document: {
      documentElement,
      getElementById(id) {
        return id === 'offline-banner' ? offlineBanner
          : id === 'install-app' ? installButton
            : id === 'install-app-status' ? installStatus : null;
      },
    },
    navigator: {
      onLine: online,
      serviceWorker: {
        async register(url, options) { registrations.push({ url, options }); },
      },
    },
    window: {
      addEventListener(type, listener) { windowListeners.set(type, listener); },
    },
  };
  vm.runInNewContext(readPublic(path.join('js', 'pwa-shell.js')), context, { filename: 'pwa-shell.js' });
  return { context, windowListeners, buttonListeners, registrations, offlineBanner, installButton, installStatus, documentElement };
}

test('PWA manifest declares an installable, same-origin dashboard', () => {
  const manifest = JSON.parse(readPublic('manifest.webmanifest'));
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.prefer_related_applications, false);
  assert.ok(manifest.name);
  assert.ok(manifest.short_name);
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);

  const sizes = new Set(manifest.icons.map(icon => icon.sizes));
  assert.ok(sizes.has('192x192'));
  assert.ok(sizes.has('512x512'));
  for (const icon of manifest.icons) {
    assert.equal(icon.type, 'image/svg+xml');
    assert.ok(icon.src.startsWith('/icons/'));
    assert.ok(fs.statSync(path.join(repoRoot, 'public', icon.src)).size > 0);
  }
});

test('service worker precaches only the bounded public application shell', async () => {
  const harness = serviceWorkerHarness();
  await dispatchLifecycle(harness.listeners.get('install'));
  assert.equal(harness.added.length, 1);
  const shell = harness.added[0].paths;
  assert.ok(shell.includes('/'));
  assert.ok(shell.includes('/manifest.webmanifest'));
  assert.ok(shell.includes('/js/pwa-shell.js'));
  assert.ok(shell.every(value => typeof value === 'string' && value.startsWith('/')));
  assert.ok(shell.every(value => !/^\/(?:api(?:\/|$)|verify(?:\/|$)|graph-data(?:\/|$)|health(?:\/|$))/i.test(value)));
  assert.equal(new Set(shell).size, shell.length, 'shell entries must be deterministic and unique');
});

test('service worker never intercepts API, authenticated, user-data, or mutation requests', () => {
  const { listeners } = serviceWorkerHarness();
  const onFetch = listeners.get('fetch');
  for (const pathname of ['/api/v2/approvals', '/verify', '/graph-data', '/health', '/workspace/private']) {
    assert.equal(dispatchFetch(onFetch, pathname), undefined, pathname);
  }
  assert.equal(dispatchFetch(onFetch, '/', { method: 'POST', mode: 'navigate' }), undefined);
  assert.equal(dispatchFetch(onFetch, '/js/app.js?workspace=private'), undefined);
});

test('offline navigation returns the cached shell without pretending live data is available', async () => {
  const { listeners } = serviceWorkerHarness();
  const response = await dispatchFetch(listeners.get('fetch'), '/', { mode: 'navigate' });
  assert.equal(await response.text(), 'cached shell');

  const html = readPublic('index.html');
  assert.match(html, /id="offline-banner"[^>]*role="status"[^>]*hidden/);
  assert.match(html, /live data and actions are unavailable/i);
});

test('activation deterministically removes old HUQAN shell caches only', async () => {
  const harness = serviceWorkerHarness();
  await dispatchLifecycle(harness.listeners.get('activate'));
  assert.deepEqual(harness.deleted, ['huqan-shell-old']);
});

test('shell fetches revalidate online and fall back only to the named HUQAN cache', async () => {
  const online = serviceWorkerHarness({ online: true });
  const fresh = await dispatchFetch(online.listeners.get('fetch'), '/js/app.js');
  assert.equal(await fresh.text(), 'network:/js/app.js');
  assert.equal(await (await online.stores.get('huqan-shell-v1').get('/js/app.js')).text(), 'network:/js/app.js');

  const offline = serviceWorkerHarness();
  const cached = await dispatchFetch(offline.listeners.get('fetch'), '/js/app.js');
  const cachedText = await cached.text();
  assert.equal(cachedText, 'cached script');
  assert.notEqual(cachedText, 'poisoned script');
});

test('dashboard exposes install affordance and registers updates without HTTP cache reuse', () => {
  const html = readPublic('index.html');
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /id="install-app"[^>]*hidden/);
  assert.match(html, /src="\/js\/pwa-shell\.js"/);

  const controller = readPublic(path.join('js', 'pwa-shell.js'));
  assert.match(controller, /beforeinstallprompt/);
  assert.match(controller, /appinstalled/);
  assert.match(controller, /updateViaCache:\s*['"]none['"]/);
  assert.match(controller, /addEventListener\(['"]online['"]/);
  assert.match(controller, /addEventListener\(['"]offline['"]/);
});

test('PWA controller reflects connectivity and completes the deferred install prompt', async () => {
  const harness = controllerHarness({ online: false });
  await Promise.resolve();
  assert.equal(harness.offlineBanner.hidden, false);
  assert.equal(harness.documentElement.dataset.connectivity, 'offline');
  assert.equal(harness.registrations.length, 1);
  assert.equal(harness.registrations[0].url, '/service-worker.js');
  assert.equal(harness.registrations[0].options.scope, '/');
  assert.equal(harness.registrations[0].options.updateViaCache, 'none');

  harness.context.navigator.onLine = true;
  await harness.windowListeners.get('online')();
  assert.equal(harness.offlineBanner.hidden, true);
  assert.equal(harness.documentElement.dataset.connectivity, 'online');

  let prevented = false;
  let prompted = false;
  const promptEvent = {
    preventDefault() { prevented = true; },
    async prompt() { prompted = true; },
    userChoice: Promise.resolve({ outcome: 'accepted' }),
  };
  harness.windowListeners.get('beforeinstallprompt')(promptEvent);
  assert.equal(prevented, true);
  assert.equal(harness.installButton.hidden, false);
  await harness.buttonListeners.get('click')();
  assert.equal(prompted, true);
  assert.equal(harness.installButton.disabled, false);
  assert.equal(harness.installButton.hidden, true);
});

test('PWA controller shows the offline shell when the HUQAN runtime is unreachable', async () => {
  const harness = controllerHarness({ online: true, healthReachable: false });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(harness.offlineBanner.hidden, false);
  assert.equal(harness.documentElement.dataset.connectivity, 'offline');
});

test('PWA controller contains an install rejection and reports it accessibly', async () => {
  const harness = controllerHarness();
  const promptEvent = {
    preventDefault() {},
    async prompt() { throw new Error('prompt failed'); },
    userChoice: Promise.resolve({ outcome: 'dismissed' }),
  };
  harness.windowListeners.get('beforeinstallprompt')(promptEvent);
  await harness.buttonListeners.get('click')();
  assert.match(harness.installStatus.textContent, /not completed/i);
  assert.equal(harness.installButton.disabled, false);
  assert.equal(harness.installButton.hidden, true);
});

test('PWA controller reports a normal native install dismissal', async () => {
  const harness = controllerHarness();
  const promptEvent = {
    preventDefault() {},
    async prompt() {},
    userChoice: Promise.resolve({ outcome: 'dismissed' }),
  };
  harness.windowListeners.get('beforeinstallprompt')(promptEvent);
  await harness.buttonListeners.get('click')();
  assert.match(harness.installStatus.textContent, /dismissed/i);
});
