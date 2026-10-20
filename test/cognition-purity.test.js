'use strict';

// COG Faz 0 PR-0a (#4061): lib/cognition/* is pure, deterministic and Core-ring.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assignLayer } = require('../scripts/architecture-dependency-graph');

const ROOT = path.join(__dirname, '..');
const COGNITION_DIR = path.join(ROOT, 'lib', 'cognition');
const FORBIDDEN_BUILTINS = new Set(['fs', 'child_process', 'net', 'http', 'https', 'os', 'dgram', 'tls', 'worker_threads']);
const REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const cognitionFiles = () => fs.readdirSync(COGNITION_DIR).filter((f) => f.endsWith('.js')).sort();
const readStripped = (file) => stripComments(fs.readFileSync(path.join(COGNITION_DIR, file), 'utf8'));

test('lib/cognition and the pure K1 envelope are assigned to the Core ring', () => {
  assert.equal(assignLayer('lib/cognition/contract.js'), 'Core');
  assert.equal(assignLayer('lib/cognition/nested/x.js'), 'Core');
  assert.equal(assignLayer('lib/memory-cognitive-message.js'), 'Core');
});

test('other memory-* and sqlite-* modules stay in the Adapters ring', () => {
  assert.equal(assignLayer('lib/memory-recency-decay.js'), 'Adapters');
  assert.equal(assignLayer('lib/memory-consolidation.js'), 'Adapters');
  assert.equal(assignLayer('lib/sqlite-store.js'), 'Adapters');
});

test('cognition modules require only Core modules', () => {
  const files = cognitionFiles();
  assert.ok(files.length > 0, 'lib/cognition has no modules');
  for (const file of files) {
    for (const [, spec] of readStripped(file).matchAll(REQUIRE_RE)) {
      assert.ok(!FORBIDDEN_BUILTINS.has(spec.replace(/^node:/, '')), `${file} requires I/O builtin ${spec}`);
      if (!spec.startsWith('.')) continue;
      const rel = path.relative(ROOT, path.resolve(COGNITION_DIR, spec)).split(path.sep).join('/');
      const target = rel.endsWith('.js') ? rel : `${rel}.js`;
      assert.equal(assignLayer(target), 'Core', `${file} requires non-Core module ${target}`);
      assert.ok(!/(^|\/)(graph|kernel)(\.v2)?\.js$/.test(target), `${file} requires ${target}`);
    }
  }
});

test('cognition modules do not call Date.now or Math.random', () => {
  for (const file of cognitionFiles()) {
    const src = readStripped(file);
    assert.ok(!/\bDate\s*\.\s*now\s*\(|\bnew\s+Date\s*\(\s*\)|\bMath\s*\.\s*random\s*\(/.test(src), `${file} reads the clock or randomness`);
    assert.ok(!/\bprocess\s*\.\s*(env|hrtime|cwd)\b|\bperformance\s*\.\s*now\s*\(/.test(src), `${file} reads ambient state`);
  }
});

test('cognition modules stay within the 400 line limit', () => {
  for (const file of cognitionFiles()) {
    const lines = fs.readFileSync(path.join(COGNITION_DIR, file), 'utf8').split('\n').length;
    assert.ok(lines <= 400, `${file} has ${lines} lines`);
  }
});
