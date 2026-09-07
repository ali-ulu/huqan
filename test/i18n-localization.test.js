'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { readHtml } = require('./helpers/dashboard-source');
const { listStaticAssetPaths } = require('../lib/http/static-assets');
const { listPublicRouteIds, isPublicRoute } = require('../lib/http/route-auth-policy');

const PUBLIC = path.join(__dirname, '..', 'public');
const SCRIPT = fs.readFileSync(path.join(PUBLIC, 'js', 'i18n.js'), 'utf8');
const LOCALES = ['tr', 'en'];

function catalogue(locale) {
  return JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', `${locale}.json`), 'utf8'));
}

function flatten(object, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value && typeof value === 'object') Object.assign(out, flatten(value, `${prefix}${key}.`));
    else out[`${prefix}${key}`] = value;
  }
  return out;
}

function annotatedKeys(html) {
  const plain = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(match => match[1]);
  const html2 = [...html.matchAll(/data-i18n-html="([^"]+)"/g)].map(match => match[1]);
  const attrs = [...html.matchAll(/data-i18n-attr="([^"]+)"/g)]
    .flatMap(match => match[1].split(',').map(pair => pair.split(':')[1]?.trim()))
    .filter(Boolean);
  return { plain, html2, attrs, all: [...new Set([...plain, ...html2, ...attrs])] };
}

test('both catalogues carry exactly the same keys, and every value is real copy', () => {
  const [tr, en] = LOCALES.map(locale => flatten(catalogue(locale)));
  const trKeys = Object.keys(tr).sort();
  const enKeys = Object.keys(en).sort();

  assert.deepEqual(trKeys, enKeys, 'a key present in one language and missing in the other renders as the raw key');
  assert.ok(trKeys.length > 300, `expected the full dashboard to be covered, got ${trKeys.length} keys`);
  for (const key of trKeys) {
    for (const [name, table] of [['tr', tr], ['en', en]]) {
      assert.equal(typeof table[key], 'string', `${name}.${key} must be a string`);
      assert.notEqual(table[key].trim(), '', `${name}.${key} must not be empty`);
    }
  }
});

test('the Turkish catalogue is actually Turkish, not English left in place', () => {
  const [tr, en] = LOCALES.map(locale => flatten(catalogue(locale)));
  // Symbols, protocol words and proper nouns legitimately match across
  // languages; prose must not.
  const prose = Object.keys(tr).filter(key => /\s/.test(en[key]) && en[key].length > 12);
  const identical = prose.filter(key => tr[key] === en[key]);
  assert.deepEqual(identical, [], 'these Turkish entries are still the English string');
});

test('every key the dashboard asks for exists in both catalogues', () => {
  const { all } = annotatedKeys(readHtml());
  const tables = LOCALES.map(locale => ({ locale, table: flatten(catalogue(locale)) }));

  // Copy the scripts own is translated where it is produced, not here, so the
  // static count is the shell only.
  assert.ok(all.length > 200, `expected the shell to be broadly annotated, found ${all.length} keys`);
  for (const key of all) {
    for (const { locale, table } of tables) {
      assert.ok(key in table, `${locale}.json has no ${key}, so the page would show the raw key`);
    }
  }
});

test('no catalogue key is annotated onto an element that owns child markup', () => {
  // applyTranslations assigns textContent, which deletes children. A wrapper
  // carrying data-i18n silently destroys the controls inside it.
  const html = readHtml();
  const offenders = [...html.matchAll(/<(\w+)([^<>]*data-i18n="[^"]+"[^<>]*)>([^]*?)<\/\1>/g)]
    .filter(match => match[3].includes('<'))
    .map(match => match[0].slice(0, 90));
  assert.deepEqual(offenders, [], 'these elements would lose their children when translated');
});

test('protocol values a filter sends are left untranslated', () => {
  const html = readHtml();
  for (const value of ['success_rate', 'p95_latency_ms', 'queue_depth', 'run_started', 'gate_decision', 'CLAIM_FLAGGED']) {
    const option = new RegExp(`<option[^>]*>${value}</option>`);
    assert.match(html, option, `${value} is an API enum the control sends; translating it would make the filter lie`);
  }
});

test('the language selector is present and offers exactly the supported locales', () => {
  const html = readHtml();
  assert.match(html, /id="locale-selector"/);
  assert.match(html, /<option value="tr"[^>]*>Türkçe<\/option>/);
  assert.match(html, /<option value="en"[^>]*>English<\/option>/);
  assert.match(html, /<script src="\/js\/i18n\.js"><\/script>/);
});

test('the script and both catalogues are served and readable without an API key', () => {
  const served = listStaticAssetPaths();
  const routes = listPublicRouteIds();
  for (const [asset, routeId] of [
    ['/js/i18n.js', 'dashboard-i18n-script'],
    ['/locales/tr.json', 'dashboard-locale-tr'],
    ['/locales/en.json', 'dashboard-locale-en'],
  ]) {
    assert.ok(served.includes(asset), `${asset} must be served, not merely present on disk`);
    assert.ok(routes.includes(routeId), `${asset} must be reachable before sign-in or the page renders raw keys`);
    assert.equal(isPublicRoute(asset, 'GET'), true);
  }
});

test('every asset the dashboard references is also published in the package', () => {
  const html = readHtml();
  const referenced = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)]
    .map(match => match[1])
    .filter(reference => reference !== '/');
  const published = new Set(require('../package.json').files);
  const missing = referenced.filter(reference => !published.has(`public${reference}`));
  assert.deepEqual(missing, [], 'the published tarball would ship an index.html referencing files it does not contain');
});

// --- module behaviour -------------------------------------------------------

function harness({ stored = null, fetchImpl, language = 'tr-TR' } = {}) {
  const store = new Map();
  if (stored !== null) store.set('huqan-locale', stored);
  const documentElement = { lang: '' };
  const context = {
    console: { warn() {}, error() {} },
    navigator: { language },
    document: {
      documentElement,
      readyState: 'complete',
      querySelectorAll: () => [],
      getElementById: () => null,
      addEventListener() {},
    },
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    },
    window: { dispatchEvent() {} },
    fetch: fetchImpl,
    CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
  };
  context.window.window = context.window;
  vm.runInNewContext(SCRIPT, context);
  return { api: context.window.HUQAN_I18N, store, documentElement };
}

function catalogueFetch(available = LOCALES) {
  return async url => {
    const locale = String(url).match(/\/locales\/(\w+)\.json/)?.[1];
    if (!locale || !available.includes(locale)) return { ok: false, status: 404 };
    return { ok: true, json: async () => catalogue(locale) };
  };
}

test('a stored preference wins over the browser language, and an unknown one is ignored', async () => {
  const chosen = harness({ stored: 'en', fetchImpl: catalogueFetch(), language: 'tr-TR' });
  assert.equal(await chosen.api.initI18n(), 'en');
  assert.equal(chosen.documentElement.lang, 'en');

  const forged = harness({ stored: 'xx', fetchImpl: catalogueFetch(), language: 'en-GB' });
  assert.equal(await forged.api.initI18n(), 'en', 'an unsupported stored value falls through to detection');

  const unknownBrowser = harness({ fetchImpl: catalogueFetch(), language: 'fr-FR' });
  assert.equal(await unknownBrowser.api.initI18n(), 'tr', 'an unsupported browser language falls back to the default');
});

test('lookup resolves nested keys, interpolates, and never renders undefined', async () => {
  const { api } = harness({ stored: 'en', fetchImpl: catalogueFetch() });
  await api.initI18n();

  assert.equal(api.t('nav.verify'), 'Verify');
  assert.equal(api.t('onboarding.progress', { done: 2, total: 3 }), '2 of 3 done');
  assert.equal(api.t('onboarding.progress', { done: 2 }), '2 of {total} done', 'a missing parameter keeps its placeholder rather than printing undefined');
  assert.equal(api.t('nav.doesNotExist'), 'nav.doesNotExist', 'a missing key renders as the key, never as undefined');
  assert.equal(api.tSafe('nav.doesNotExist'), null);
  assert.equal(api.hasKey('nav.verify'), true);
  assert.equal(api.hasKey('nav'), false, 'a branch is not a translatable string');
});

test('a locale whose catalogue cannot be fetched falls back instead of rendering nothing', async () => {
  const { api, documentElement } = harness({ stored: 'en', fetchImpl: catalogueFetch(['tr']) });
  assert.equal(await api.initI18n(), 'tr');
  assert.equal(documentElement.lang, 'tr');
  assert.equal(api.t('nav.verify'), catalogue('tr').nav.verify);
});

test('setLocale refuses an unsupported locale and leaves the current one intact', async () => {
  const { api, store } = harness({ stored: 'tr', fetchImpl: catalogueFetch() });
  await api.initI18n();

  assert.equal(api.setLocale('de'), false);
  assert.equal(api.getCurrentLocale(), 'tr');
  assert.equal(store.get('huqan-locale'), 'tr');
  // Spread it: an array built inside the vm realm has a different prototype,
  // which deepStrictEqual reports as unequal even when the contents match.
  assert.deepEqual([...api.getSupportedLocales()], ['tr', 'en']);
});

test('a browser that refuses storage still resolves and renders a locale', async () => {
  const context = {
    console: { warn() {}, error() {} },
    navigator: { language: 'en-US' },
    document: { documentElement: {}, readyState: 'complete', querySelectorAll: () => [], getElementById: () => null, addEventListener() {} },
    // A browser set to block site data throws on access rather than returning
    // null, which is the case that used to take the whole page down with it.
    localStorage: {
      getItem() { throw new Error('storage blocked'); },
      setItem() { throw new Error('storage blocked'); },
    },
    window: { dispatchEvent() {} },
    fetch: catalogueFetch(),
    CustomEvent: class {},
  };
  context.window.window = context.window;
  vm.runInNewContext(SCRIPT, context);

  assert.equal(await context.window.HUQAN_I18N.initI18n(), 'en');
  assert.equal(context.window.HUQAN_I18N.t('nav.verify'), 'Verify');
});

test('a failed switch keeps the language the page can actually render', async () => {
  // Before this fix the handler moved currentLocale and the stored preference
  // first and only then fetched, so a failed load left the next visit opening
  // a language whose catalogue had never arrived.
  const selector = { value: 'tr', listeners: {}, addEventListener(event, handler) { this.listeners[event] = handler; } };
  const store = new Map([['huqan-locale', 'tr']]);
  const context = {
    console: { warn() {}, error() {} },
    navigator: { language: 'tr-TR' },
    document: {
      documentElement: {}, readyState: 'complete',
      querySelectorAll: () => [],
      getElementById: id => (id === 'locale-selector' ? selector : null),
      addEventListener() {},
    },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    window: { dispatchEvent() {} },
    fetch: catalogueFetch(['tr']),
    CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
  };
  context.window.window = context.window;
  vm.runInNewContext(SCRIPT, context);
  const api = context.window.HUQAN_I18N;
  await api.initI18n();

  await selector.listeners.change({ target: { value: 'en' } });

  assert.equal(api.getCurrentLocale(), 'tr', 'the failed language must not become current');
  assert.equal(store.get('huqan-locale'), 'tr', 'nor may it be stored for the next visit');
  assert.equal(selector.value, 'tr', 'and the control must show what is actually rendered');
  assert.equal(api.t('nav.verify'), catalogue('tr').nav.verify);
});
