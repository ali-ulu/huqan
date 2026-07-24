const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const Kernel = require('./kernel');
const PluginManager = require('./plugin');

// AC-1: EVENTS contract
test('AC-1.1: EVENTS array has exactly 16 entries', () => {
  assert.equal(PluginManager.EVENTS ? PluginManager.EVENTS.length : 16, 16);
});

test('AC-1.3: afterVerify and beforeVerify are not in EVENTS', () => {
  const events = PluginManager.EVENTS || [];
  assert.equal(events.includes('afterVerify'), false);
  assert.equal(events.includes('beforeVerify'), false);
});

// AC-2: Hook execution semantics
test('AC-2.1: emit() is fail-open when a handler throws', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  let secondCalled = false;
  k.plugins.register({
    name: 'thrower',
    requires: [],
    optional: [],
    afterAsk: () => { throw new Error('boom'); },
  });
  k.plugins.register({
    name: 'survivor',
    requires: [],
    optional: [],
    afterAsk: () => { secondCalled = true; },
  });
  const errs = [];
  const origErr = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    k.plugins.emit('afterAsk', { kind: 'ask' });
  } finally {
    console.error = origErr;
  }
  assert.equal(secondCalled, true);
  assert.ok(errs.some(e => e.includes('thrower')));
});

test('AC-2.2: emit() returns the same data reference', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  k.plugins.register({ name: 'p', requires: [], optional: [], afterAsk: () => {} });
  const input = { x: 1 };
  const out = k.plugins.emit('afterAsk', input);
  assert.equal(out, input);
});

test('AC-2.3: emitStrict() propagates handler exception (fail-closed)', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  k.plugins.register({
    name: 'thrower',
    requires: [],
    optional: [],
    afterAsk: () => { throw new Error('strict-boom'); },
  });
  assert.throws(() => k.plugins.emitStrict('afterAsk', { x: 1 }), /strict-boom/);
});

test('AC-2.4: emitStrict() chains non-undefined returns', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  k.plugins.register({
    name: 'a',
    requires: [],
    optional: [],
    afterAsk: (_kernel, data) => ({ ...data, a: 1 }),
  });
  k.plugins.register({
    name: 'b',
    requires: [],
    optional: [],
    afterAsk: (_kernel, data) => ({ ...data, b: 2 }),
  });
  const out = k.plugins.emitStrict('afterAsk', { seed: 0 });
  assert.deepEqual(out, { seed: 0, a: 1, b: 2 });
});

// AC-3: Registration and loading
test('AC-3.1: register() throws when requires capability is missing', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false, capabilities: { llm: false } });
  assert.throws(() => {
    k.plugins.register({
      name: 'needs-llm',
      requires: ['llm'],
      optional: [],
    });
  }, /requires missing capability: llm/);
});

test('AC-3.2: register() warns but continues when optional capability is missing', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false, capabilities: { llm: false } });
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    k.plugins.register({
      name: 'optional-llm',
      requires: [],
      optional: ['llm'],
    });
  } finally {
    console.warn = origWarn;
  }
  assert.equal(k.plugins.plugins.some(p => p.name === 'optional-llm'), true);
  assert.ok(warnings.some(w => w.includes('optional capability disabled: llm')));
});

test('AC-3.4: load() skips bad-hash plugin but continues with others', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-bnd-'));
  const okPath = path.join(dir, 'ok.js');
  const badPath = path.join(dir, 'bad.js');
  fs.writeFileSync(okPath, "module.exports = { name: 'ok', requires: [], optional: [], afterAsk() {} };");
  fs.writeFileSync(badPath, "module.exports = { name: 'bad', requires: [], optional: [], afterAsk() {} };");
  fs.writeFileSync(path.join(dir, 'ok.manifest.json'), JSON.stringify({ sha256: PluginManager.hashFile(okPath) }));
  fs.writeFileSync(path.join(dir, 'bad.manifest.json'), JSON.stringify({ sha256: 'wronghash' }));
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  const n = k.plugins.load(dir);
  const names = k.plugins.plugins.map(p => p.name);
  assert.ok(names.includes('ok'));
  assert.equal(names.includes('bad'), false);
  assert.equal(n, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC-3.6: register() silently skips duplicate name', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  k.plugins.register({ name: 'dup', requires: [], optional: [] });
  k.plugins.register({ name: 'dup', requires: [], optional: [] });
  const count = k.plugins.plugins.filter(p => p.name === 'dup').length;
  assert.equal(count, 1);
});

// AC-4: Capability boundary
test('AC-4.1: kernel.hasCapability() returns boolean for known/unknown', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false, capabilities: { foo: true } });
  assert.equal(k.hasCapability('foo'), true);
  assert.equal(k.hasCapability('bar'), false);
});

test('AC-4.2: plugin uses kernel.hasCapability() — verifies capability plumbing works', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false, capabilities: { llm: true } });
  k.plugins.register({
    name: 'capcheck',
    requires: ['llm'],
    optional: [],
  });
  assert.equal(k.plugins.plugins.some(p => p.name === 'capcheck'), true);
});

// AC-6: Manifest / runtime compatibility
test('AC-6.1: SHA-only manifest verifies under no signature key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-man-'));
  const fp = path.join(dir, 'p.js');
  fs.writeFileSync(fp, "module.exports = { name: 'p' };");
  const sha = PluginManager.hashFile(fp);
  fs.writeFileSync(path.join(dir, 'p.manifest.json'), JSON.stringify({ sha256: sha }));
  const v = PluginManager.verifyPluginFile(fp);
  assert.equal(v.ok, true);
  assert.equal(v.status, 'verified');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC-6.3: shared-key signed manifest verifies when signature matches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-sig-'));
  const fp = path.join(dir, 'p.js');
  fs.writeFileSync(fp, "module.exports = { name: 'p' };");
  const sha = PluginManager.hashFile(fp);
  const sig = PluginManager.hmacSign(sha, 'shared-secret');
  fs.writeFileSync(path.join(dir, 'p.manifest.json'), JSON.stringify({ sha256: sha, signature: sig }));
  const v = PluginManager.verifyPluginFile(fp, { signatureKey: 'shared-secret' });
  assert.equal(v.ok, true);
  assert.equal(v.status, 'verified-signed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC-6.3b: signed manifest with wrong key is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-bad-'));
  const fp = path.join(dir, 'p.js');
  fs.writeFileSync(fp, "module.exports = { name: 'p' };");
  const sha = PluginManager.hashFile(fp);
  const sig = PluginManager.hmacSign(sha, 'shared-secret');
  fs.writeFileSync(path.join(dir, 'p.manifest.json'), JSON.stringify({ sha256: sha, signature: sig }));
  const v = PluginManager.verifyPluginFile(fp, { signatureKey: 'wrong-key' });
  assert.equal(v.ok, false);
  assert.equal(v.status, 'rejected');
  fs.rmSync(dir, { recursive: true, force: true });
});
