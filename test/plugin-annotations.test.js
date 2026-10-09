'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Kernel = require('../kernel');

function makeKernel(t, memoryPath) {
  if (!memoryPath) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-annotations-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    memoryPath = path.join(dir, 'memory.json');
  }
  return new Kernel({ noLoad: true, loadPlugins: false, useSQLite: false, memoryPath });
}

const seedOpts = Kernel.createAdmissionBypassOpts('test_fixture_seed');
const risk = { highRisk: true, riskScore: 0.87 };

function annotate(kernel) {
  kernel.usePlugin({
    name: 'risk-plugin',
    beforeLearn() { return { aura: risk }; },
    beforeAsk() { return { aura: risk }; },
  });
}

test('learn returns namespaced annotations without losing text or opts, including durable replay', t => {
  const k = makeKernel(t);
  annotate(k);
  k.usePlugin({ name: 'classifier', beforeLearn() { return { aura: { category: 'animal' } }; } });
  k.usePlugin({ name: 'translator', beforeLearn(_k, data) {
    return { ...data, text: 'kedi hayvandir' };
  } });
  const opts = { ...seedOpts, mutationOperationId: 'annotated-learn', workspaceId: 'tenant' };
  const result = k.learn('cat is an animal', opts);
  const expected = { 'risk-plugin': { aura: risk }, classifier: { aura: { category: 'animal' } } };
  assert.ok(result.data.learned > 0);
  assert.deepEqual(result.data.annotations, expected);
  assert.ok(k.graph.getNode('kedi', 'tenant'));
  assert.equal(k.graph.getNode('kedi', 'default'), null);

  // Replay must return committed annotations, even if the plugin now differs.
  k.plugins.plugins.find(p => p.name === 'risk-plugin').beforeLearn = () => ({ aura: { riskScore: 0 } });
  const replay = k.learn('cat is an animal', opts);
  assert.equal(replay.meta.replayed, true);
  assert.deepEqual(replay.data.annotations, expected);
  const restored = makeKernel(t, k.graph.memoryPath);
  restored.graph.load();
  const afterRestart = restored.learn('cat is an animal', opts);
  assert.equal(afterRestart.meta.replayed, true);
  assert.deepEqual(afterRestart.data.annotations, expected);
});

test('annotations cannot replace admission decisions or authorize an unapproved learn', t => {
  const k = makeKernel(t);
  k.usePlugin({ name: 'advisory', beforeLearn() {
    return { admission: { outcome: 'allow', graphWrite: true }, learned: 999 };
  } });
  const result = k.learn('kedi hayvandir');
  assert.equal(result.data.learned, 0);
  assert.notEqual(result.data.admission.outcome, 'allow');
  assert.equal(k.graph.getNode('kedi'), null);
  assert.equal(result.data.annotations.advisory.admission.outcome, 'allow');
  assert.equal(result.data.annotations.advisory.learned, 999);
});

test('ask preserves annotations on known, unknown, edgeless and delegated reason paths', t => {
  const k = makeKernel(t);
  k.learn('kedi hayvandir', seedOpts);
  k.graph.addNode('yalniz', 'yalniz');
  annotate(k);
  k.usePlugin({ name: 'alias', beforeAsk(_k, data) { data.question = data.question.replace('cat', 'kedi'); } });
  for (const question of ['cat nedir', 'bilinmeyen nedir', 'yalniz nedir', 'neden kedi', 'kedi ne olur']) {
    const result = k.ask(question);
    assert.deepEqual(result.data.annotations, { 'risk-plugin': { aura: risk } }, question);
    if (question === 'cat nedir') assert.match(result.data.answer, /hayvan/);
    if (question === 'yalniz nedir') assert.equal(result.data.unknown, true);
  }
});

test('no annotation state leaks into a later call and ordinary result shapes stay unchanged', t => {
  const k = makeKernel(t);
  let calls = 0;
  k.usePlugin({ name: '__proto__', beforeAsk() {
    if (calls++ === 0) return { aura: risk };
  } });
  const first = k.ask('kedi nedir');
  assert.equal(Object.hasOwn(first.data.annotations, '__proto__'), true);
  assert.deepEqual(first.data.annotations.__proto__, { aura: risk });
  assert.equal(Object.hasOwn(k.ask('kedi nedir').data, 'annotations'), false);
  assert.equal(Object.hasOwn(k.learn('kedi hayvandir', seedOpts).data, 'annotations'), false);
});

test('synchronous learn still fails closed on throwing and async hooks', t => {
  for (const beforeLearn of [() => { throw new Error('plugin refusal'); }, () => Promise.resolve({ aura: risk })]) {
    const k = makeKernel(t);
    k.usePlugin({ name: 'invalid', beforeLearn });
    assert.throws(() => k.learn('kedi hayvandir', seedOpts), /plugin refusal|returned a Promise/);
    assert.equal(k.graph.getNode('kedi'), null);
  }
});
