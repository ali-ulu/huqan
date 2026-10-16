'use strict';

// H-06: aynı iddia tekrar learn edilince weight şişmemeli.
// Kapsam yalnız kernel-öğrenme yoludur; doğrudan graph.addEdge
// davranışını şart koşan graph.test.js "tavan 1.0" testi korunur.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const Kernel = require('./kernel');
const Graph = require('./graph');
const { isolatedKernelOptions, isolatedGraphOptions } = require('./test/helpers/isolated-persistence');

const BYPASS = Kernel.createAdmissionBypassOpts('h06_test');

function freshKernel(label = 'h06') {
  const kernel = new Kernel(isolatedKernelOptions(label));
  const learn = kernel.learn.bind(kernel);
  kernel.learn = (text, learnOpts = {}) => learn(text, { ...learnOpts, ...BYPASS });
  return kernel;
}

describe('H-06 learn weight drift', () => {
  it('aynı metin 6x learn -> weight artmaz, reaffirmed izi düşer', () => {
    const k = freshKernel('h06-same');
    const text = 'Kedi hayvandır';
    for (let i = 0; i < 6; i++) k.learn(text);
    const edges = k.graph.getEdges('kedi').filter((e) => e.relation === 'tür' && e.to === 'hayvan');
    assert.strictEqual(edges.length, 1);
    const edge = edges[0];
    assert.strictEqual(edge.weight, 0.5);
    assert.deepStrictEqual(edge.evidence, [text]);
    assert.strictEqual(edge.confidence, 0.5);
    const reaffirmed = (edge.confidence_history || []).filter((h) => h.event === 'reaffirmed');
    assert.strictEqual(reaffirmed.length, 5);
  });

  it('farklı kanıt metni -> weight artabilir', () => {
    const k = freshKernel('h06-diff');
    k.learn('Kedi hayvandır');
    const before = k.graph.getEdge('kedi', 'hayvan', 'tür').weight;
    k.learn('Kedi bir hayvandır');
    const after = k.graph.getEdge('kedi', 'hayvan', 'tür');
    assert.ok(after.weight > before);
    assert.strictEqual(after.evidence.length, 2);
  });

  it('doğrudan graph.addEdge bayraksız çağrıda eski +0.1 davranışı korunur', () => {
    const g = new Graph(isolatedGraphOptions('h06-graph'));
    g.addNode('a', 'x');
    g.addNode('b', 'y');
    g.addEdge('a', 'b', 'bag');
    const w1 = g.getEdge('a', 'b', 'bag').weight;
    g.addEdge('a', 'b', 'bag');
    const w2 = g.getEdge('a', 'b', 'bag').weight;
    assert.ok(w2 > w1);
  });
});
