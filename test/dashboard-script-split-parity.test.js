'use strict';

/**
 * The dashboard script was one hand-minified file: ~56 KB in 38 lines, one
 * line 39 KB long, because a one-statement-per-line pasting had collapsed it.
 * `scripts/check-file-size.js` could count its lines and still pass it. It is
 * now `public/js/app-*.js`, split at top-level statement boundaries.
 *
 * Splitting JavaScript is only safe if the browser sees the same program, and
 * nothing here runs a browser. These tests assemble the dashboard the way a
 * browser does -- every same-origin `<script src>` in `index.html`, in order,
 * in one global scope -- and assert the result, so the split is checked by
 * behaviour rather than by which file the bytes sit in.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readHtml } = require('./helpers/dashboard-source');
const { run } = require('./helpers/dashboard-runtime');

const PUBLIC_ROOT = path.join(__dirname, '..', 'public');
const MODULES = ['app-core.js', 'app-net.js', 'app-health.js', 'app-graph.js',
  'app-approvals.js', 'app-verify.js', 'app-activity.js', 'app-evidence.js', 'app-wiring.js'];
const AS_REF = (name) => `/js/${name}`;
const SNAPSHOT_KEYS = ['textContent', 'innerHTML', 'hidden', 'onclick', 'onchange', 'onkeydown'];

test('the dashboard script is split, not one collapsed file', () => {
  const dir = path.join(PUBLIC_ROOT, 'js');
  for (const name of MODULES) assert.ok(fs.existsSync(path.join(dir, name)), `${name} must exist`);
  assert.equal(fs.existsSync(path.join(dir, 'app.js')), false, 'the collapsed bundle is gone');

  for (const name of MODULES) {
    const lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n');
    assert.ok(lines.length > 1, `${name} must not be a one-line paste`);
    assert.ok(Math.max(...lines.map((line) => line.length)) <= 1500,
      `${name} must not carry a whole-file line for the density gate to miss`);
  }
});

test('index.html loads every module once, in the order the bundle had', () => {
  const refs = [...readHtml().matchAll(/<script[^>]+src="\/js\/(app-(?!observability)[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(refs, MODULES, 'script order is the load contract; it must not drift');
  assert.equal(new Set(refs).size, refs.length, 'no module may be loaded twice');

  const all = [...readHtml().matchAll(/<script[^>]+src="(\/js\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(all.filter((r) => r === '/js/app.js').length, 0, 'nothing still loads the bundle');
});

test('the split modules carry the whole dashboard, not a fragment', () => {
  // A split that dropped a statement would still parse; these are the entry
  // points the one bundle defined and every other contract test relies on.
  const joined = MODULES.map((name) => fs.readFileSync(path.join(PUBLIC_ROOT, 'js', name), 'utf8')).join('\n');
  for (const symbol of ['const T=(key,fallback,params)=>',
    "addEventListener('huqan-i18n-ready',relocalize)",
    "addEventListener('huqan-locale-change',relocalize)",
    'function noEvidence(', 'function renderHealth(', 'function probeAuthMode(']) {
    assert.ok(joined.includes(symbol), `${symbol} must survive the split`);
  }
});

test('the assembled dashboard executes with the split modules and no bundle', async () => {
  const { refs } = await run({});
  assert.ok(refs.includes(AS_REF('app-core.js')));
  assert.ok(!refs.includes('/js/app.js'));
  assert.deepEqual(appErrors(await run({})), [],
    'the nine modules -- and only they -- run top to bottom without a reference error');
});

test('the split renders the same DOM as the bundle it replaced', async () => {
  // Reconstruct the pre-split bundle from the modules, run both the split order
  // and that bundle in the same fake DOM, and compare every rendered node.
  const split = await run({});
  const bundle = MODULES.map((name) => fs.readFileSync(path.join(PUBLIC_ROOT, 'js', name), 'utf8')).join('\n');
  const collapsed = await run({ files: { '/js/app.js': bundle }, scripts: withSingleBundle(split.refs) });

  assert.deepEqual(appErrors(collapsed), appErrors(split),
    'the dashboard modules reference exactly the same names before and after the split');

  const ids = new Set([...Object.keys(split.snapshot), ...Object.keys(collapsed.snapshot)]);
  assert.ok(ids.size > 0, 'the harness actually rendered something');
  for (const id of ids) {
    for (const key of SNAPSHOT_KEYS) {
      assert.equal(
        String((split.snapshot[id] || {})[key]),
        String((collapsed.snapshot[id] || {})[key]),
        `${id}.${key} differs between the split modules and the single bundle`,
      );
    }
  }
});

function appErrors(result) {
  // Only the dashboard modules are under test; the unrelated panels ask for
  // browser APIs the minimal document does not implement, identically in both
  // assemblies.
  return result.errors.filter((line) => /\/js\/app-/.test(line));
}

function withSingleBundle(refs) {
  const out = [];
  for (const ref of refs) {
    if (ref === AS_REF('app-core.js')) { out.push('/js/app.js'); continue; }
    if (MODULES.some((name) => ref === AS_REF(name))) continue;
    out.push(ref);
  }
  return out;
}
