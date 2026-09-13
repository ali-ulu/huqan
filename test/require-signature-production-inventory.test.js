'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');

function productionSources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return productionSources(file);
    return entry.name.endsWith('.js') ? [file] : [];
  });
}

test('requireSignature production caller inventory remains explicit', () => {
  const sources = productionSources(path.join(ROOT, 'lib')).concat(path.join(ROOT, 'server.js'));
  const callers = [];
  for (const file of sources) {
    const source = fs.readFileSync(file, 'utf8');
    if (/requireSignature\s*:\s*[^,}]+/.test(source)) callers.push(path.relative(ROOT, file).replaceAll(path.sep, '/'));
  }
  assert.deepEqual(callers.sort(), [
    // lib/gate-hook-management.js carries the ship command's --store delivery
    // signature check, moved verbatim from bin/huqan-gate-hook.js (#2248).
    'lib/gate-hook-management.js',
    'lib/http/optional-boundaries.js',
    'lib/receipt/bounded-receipt-export.js',
    'server.js',
  ]);
});
