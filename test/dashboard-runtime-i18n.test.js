'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// #1957. The dashboard shipped a complete two-language catalogue whose runtime
// half was never called: `test/i18n-localization.test.js` compared the
// catalogues against each other and against the static `data-i18n` shell, both
// of which were correct, so it stayed green while 206 of 441 keys were dead and
// every string app.js wrote into the DOM was hardcoded English.
//
// That gap is invisible to any check that only reads the catalogue. These
// assertions look at the other side: what the scripts actually ask for.

const PUBLIC_ROOT = path.join(__dirname, '..', 'public');
const norm = text => text.replace(/\r\n/g, '\n');

const catalogues = {
  en: JSON.parse(fs.readFileSync(path.join(PUBLIC_ROOT, 'locales', 'en.json'), 'utf8')),
  tr: JSON.parse(fs.readFileSync(path.join(PUBLIC_ROOT, 'locales', 'tr.json'), 'utf8')),
};

const scriptNames = fs.readdirSync(path.join(PUBLIC_ROOT, 'js')).filter(name => name.endsWith('.js'));
const scripts = new Map(scriptNames.map(name => [name, norm(fs.readFileSync(path.join(PUBLIC_ROOT, 'js', name), 'utf8'))]));
const appScript = scripts.get('app.js');

const lookup = (table, key) => key.split('.').reduce((node, part) => (node && typeof node === 'object' && part in node ? node[part] : undefined), table);

function flatten(node, prefix = '', out = []) {
  for (const key of Object.keys(node)) {
    const value = node[key];
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flatten(value, name, out);
    else out.push(name);
  }
  return out;
}

// T('key','English fallback') and M('key','English fallback'), plus the object
// form {k:'key',f:`…${interpolated}…`} used where the copy carries a value.
function requestedPairs(source) {
  const pairs = [];
  for (const match of source.matchAll(/[^A-Za-z0-9_$](?:T|M)\('([A-Za-z0-9_.]+)','((?:[^'\\]|\\.)*)'/g)) {
    pairs.push({ key: match[1], fallback: match[2].replace(/\\'/g, "'") });
  }
  return pairs;
}

function requestedKeys(source) {
  const keys = [...source.matchAll(/[^A-Za-z0-9_$](?:T|M)\('([A-Za-z0-9_.]+)'/g)].map(m => m[1]);
  keys.push(...[...source.matchAll(/\bk:'([A-Za-z0-9_.]+)'/g)].map(m => m[1]));
  return [...new Set(keys)];
}

test('every key the scripts ask for exists in both catalogues', () => {
  const missing = [];
  for (const [name, source] of scripts) {
    for (const key of requestedKeys(source)) {
      for (const locale of ['en', 'tr']) {
        if (typeof lookup(catalogues[locale], key) !== 'string') missing.push(`${name} → ${locale}.json has no ${key}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'a key the script requests but the catalogue lacks renders as the inline fallback in every language, silently');
});

test('each inline fallback is the same text the English catalogue holds', () => {
  // The fallback is what a visitor sees before the catalogue arrives, and in a
  // test VM it is all there is. If it drifts from en.json the page shows two
  // different English strings depending on how fast the network was.
  const drifted = [];
  for (const [name, source] of scripts) {
    for (const { key, fallback } of requestedPairs(source)) {
      const english = lookup(catalogues.en, key);
      if (typeof english === 'string' && english !== fallback) drifted.push(`${name} → ${key}: fallback ${JSON.stringify(fallback)} vs en.json ${JSON.stringify(english)}`);
    }
  }
  assert.deepEqual(drifted, [], 'inline fallback and catalogue copy must not diverge');
});

test('the dashboard resolves its runtime copy through the catalogue', () => {
  assert.match(appScript, /const T=\(key,fallback,params\)=>/, 'app.js must keep the catalogue lookup helper');
  assert.match(appScript, /const M=\(key,fallback\)=>\(\{k:key,f:fallback\}\)/, 'stored copy must keep its key so a locale switch can re-resolve it');
  const calls = (appScript.match(/[^A-Za-z0-9_$](?:T|M|Tx)\(/g) || []).length;
  assert.ok(calls >= 100, `app.js resolves only ${calls} strings through the catalogue; the wiring has been removed`);
});

test('a locale change repaints what was drawn from stored state', () => {
  // Without this the surfaces keep whichever language won the initial race:
  // app.js paints before i18n.js has fetched a catalogue.
  assert.match(scripts.get('i18n.js'), /huqan-i18n-ready/, 'i18n.js must announce that the catalogue arrived');
  assert.match(appScript, /addEventListener\('huqan-i18n-ready',relocalize\)/);
  assert.match(appScript, /addEventListener\('huqan-locale-change',relocalize\)/);
});

test('dates render in the reader\'s locale, not a hardcoded one', () => {
  const hardcoded = [...appScript.matchAll(/Intl\.DateTimeFormat\('([a-zA-Z-]+)'/g)].map(m => m[1]);
  assert.deepEqual(hardcoded, [], 'DateTimeFormat must take the active locale');
});

// A ratchet, not a target. Every entry below is copy that exists in both
// languages but that nothing asks for, so it renders as hardcoded English.
// Wiring more of the dashboard lowers this number; it must never rise. Raising
// it means new dead copy was added, which is how the original gap was created.
//
// 206 → 184 (#1957) → 69 (#1958). What remains is four vocabularies rather than
// dashboard copy: `common`, `emptyStates` and `validation` are generic word
// lists no surface renders, and `viewer.*` describes public/viewer/index.html —
// a page that carries no data-i18n and never loads i18n.js. Wiring the viewer is
// its own change; deleting the vocabularies is a product decision.
const UNWIRED_BUDGET = 69;

test('unused catalogue copy only ever shrinks', () => {
  const referenced = [norm(fs.readFileSync(path.join(PUBLIC_ROOT, 'index.html'), 'utf8')), ...scripts.values()].join('\n');
  const unused = flatten(catalogues.en).filter(key => !referenced.includes(key));
  assert.ok(
    unused.length <= UNWIRED_BUDGET,
    `${unused.length} catalogue keys are unreferenced, above the recorded ${UNWIRED_BUDGET}. New copy must be wired to a T()/M()/data-i18n site, not only translated. First offenders: ${unused.slice(0, 8).join(', ')}`,
  );
});
