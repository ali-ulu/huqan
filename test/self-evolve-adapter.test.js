'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { FractalLearn } = require('../lib/fractal-learn');

function fakeKernel(opts = {}) {
  const graph = {
    nodes: new Map(),
    edges: new Map(),
    getNodes(ws) { return Array.from(this.nodes.keys()).filter(k => k.startsWith(ws + '::')); },
    getAllEdges(ws) { return Array.from(this.edges.values()).filter(e => e.workspaceId === ws); },
    getEdge(from, to, rel, ws) {
      for (const e of this.edges.values()) {
        if (e.from === from && e.to === to && e.relation === rel && e.workspaceId === ws) return e;
      }
      return null;
    },
    addNode(id) { this.nodes.set(id, { id }); },
    addEdge(from, to, rel, ws, extras = {}) {
      const id = 'e' + (this.edges.size + 1);
      const edge = { id, from, to, relation: rel, workspaceId: ws, ...extras };
      this.edges.set(id, edge);
      return { decision: 'allow', edge };
    },
  };
  let entropy = 0.5;
  let dreamCount = 0;
  let dreamReturn = { data: { hypotheses: [], learned: [], pending: [], cycle: null } };
  return {
    graph,
    entropy: () => entropy,
    dream: () => dreamReturn,
    _setEntropy: (v) => { entropy = v; },
    _getEntropy: () => entropy,
    _setDreamReturn: (v) => { dreamReturn = v; },
    _getDreamCount: () => dreamCount,
    _setDreamCount: (v) => { dreamCount = v; },
  };
}

describe('self-evolve-adapter — L4 fractal-learn entegrasyonu', () => {
  it('modül dışa aktarılır', () => {
    const adapter = require('../lib/self-evolve-adapter');
    assert.equal(typeof adapter.runSelfEvolveAdapter, 'function');
  });

  it('adapter FractalLearn\'i sarar ve kendi tur döngüsünü kurar', () => {
    const kernel = fakeKernel();
    const adapter = require('../lib/self-evolve-adapter');
    const result = adapter.runSelfEvolveAdapter(kernel, { workspaceId: 'ws-adapter-test', maxRounds: 2, depth: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.type, 'fractal_learn_with_self_evolve');
  });

  it('self-evolve sonuçları her turda toplanır', () => {
    const kernel = fakeKernel();
    const adapter = require('../lib/self-evolve-adapter');
    const result = adapter.runSelfEvolveAdapter(kernel, { workspaceId: 'ws-collect', maxRounds: 2, depth: 1 });
    assert.equal(result.data.selfEvolveResults.length, 1, 'adapter her çağrıda bir self-evolve probe sonuçları toplar');
  });

  it('FractalLearn DI ile enjekte edilebilir', () => {
    const kernel = fakeKernel();
    const adapter = require('../lib/self-evolve-adapter');
    const fl = new FractalLearn(kernel);
    const result = adapter.runSelfEvolveAdapter(kernel, { workspaceId: 'ws-di', maxRounds: 1, fractalLearn: fl });
    assert.equal(result.data.fractalLearn, fl);
  });

  it('geçersiz kernel için fail-closed davranışı', () => {
    const adapter = require('../lib/self-evolve-adapter');
    assert.throws(() => adapter.runSelfEvolveAdapter(null, { workspaceId: 'bad' }));
  });
});