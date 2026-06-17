const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isPathWithinRoot, resolvePathWithinRoot } = require('../lib/path-safety');

test('path-safety: resolvePathWithinRoot allows paths inside vault/root', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-safe-root-'));
  const inside = path.join(rootDir, 'notes', 'memory.json');
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, '{}', 'utf8');

  try {
    assert.equal(isPathWithinRoot(rootDir, inside), true);
    assert.equal(resolvePathWithinRoot(rootDir, inside), path.resolve(inside));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('path-safety: resolvePathWithinRoot blocks vault escape attempts', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-safe-root-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-safe-outside-'));
  const outside = path.join(outsideDir, 'memory.json');
  fs.writeFileSync(outside, '{}', 'utf8');

  try {
    assert.equal(isPathWithinRoot(rootDir, outside), false);
    assert.throws(
      () => resolvePathWithinRoot(rootDir, path.join(rootDir, '..', path.basename(outside))),
      /allowed root/i
    );
    assert.throws(
      () => resolvePathWithinRoot(rootDir, outside),
      /allowed root/i
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
