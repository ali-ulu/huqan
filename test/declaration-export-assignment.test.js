'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('CommonJS declaration helpers live in their export-assignment namespaces (#1075)', () => {
  for (const [file, symbol] of [['kernel.d.ts', 'Kernel'], ['cli.d.ts', 'CLI']]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, new RegExp(`declare namespace ${symbol} \\{`));
    assert.match(source, new RegExp(`export = ${symbol};\\s*$`));
    const assignment = source.lastIndexOf(`export = ${symbol};`);
    const namespace = source.indexOf(`declare namespace ${symbol} {`);
    assert.ok(namespace >= 0 && namespace < assignment);
    const outside = source.slice(0, namespace) + source.slice(assignment);
    assert.doesNotMatch(outside, /^export\s+(?:type|interface|function|class)\b/m);
  }
});
