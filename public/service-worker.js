'use strict';

const SHELL_CACHE = 'huqan-shell-v1';
const SHELL_PATHS = Object.freeze([
  '/',
  '/css/app.css',
  '/icons/huqan-192.svg',
  '/icons/huqan-512.svg',
  '/js/app.js',
  '/js/home-navigation.js',
  '/js/ingest-run-detail.js',
  '/js/learn-review.js',
  '/js/pwa-shell.js',
  '/manifest.webmanifest',
]);
const SHELL_PATH_SET = new Set(SHELL_PATHS);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE)
    .then(cache => cache.addAll(SHELL_PATHS))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(names => Promise.all(names
      .filter(name => name.startsWith('huqan-shell-') && name !== SHELL_CACHE)
      .map(name => caches.delete(name))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.search !== '') return;

  if (request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(networkFirst(request, '/'));
    return;
  }

  if (!SHELL_PATH_SET.has(url.pathname)) return;
  event.respondWith(networkFirst(request, url.pathname));
});

async function networkFirst(request, cacheKey) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok && (response.type === 'basic' || response.type === 'default')) {
      await cache.put(cacheKey, response.clone());
    }
    return response;
  } catch (_) {
    return cache.match(cacheKey);
  }
}
