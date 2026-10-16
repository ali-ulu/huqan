'use strict';

// #3912: negation was not modelled. "X degildir" was learned as its own
// POSITIVE node (`hayvan degil`, `ucamaz`), so the graph held both A and ¬A as
// affirmative facts and `verify` reported both as verified while `ask` returned
// them side by side. The trust gate's central promise -- grounded verification
// -- cannot hold if the graph agrees with a claim and its negation at once.
//
// Three defects are covered here, each at the surface the issue names:
//   A. the ASCII spelling `degildir` fell through the parser's diacritic-only
//      regex to the `-dir` copula rule and became a positive `tür` edge;
//   B. `verify` matched a stored `değil` edge as positive support;
//   C. `learn` reported `conflicts: []` for a negated fact predicate.

const test = require('node:test');
const assert = require('node:assert/strict');

const Kernel = require('../kernel');
const { parsePredicate, isCopulaNegationPredicate } = require('../lib/predicate-parser');
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');

function makeKernel(label) {
  const kernel = new Kernel(isolatedKernelOptions(`3912-${label}`, {
    noLoad: true, loadPlugins: false, useSQLite: false,
  }));
  // Keep the run deterministic: no auto-maintenance, no background ticks.
  kernel._autoMaintain = () => {};
  kernel.maintenanceEvery = Number.MAX_SAFE_INTEGER;
  kernel._learnCount = 0;
  return kernel;
}

function admittedOpts(n) {
  return {
    workspaceId: 'default',
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: `apr_${n}`,
    admissionRequired: true,
    provenance: {
      provenanceId: `prov-${n}`,
      sourceType: 'manual',
      sourceRef: `t:${n}`,
      actor: 'test',
      workspaceId: 'default',
      timestamp: '2026-06-29T00:00:00.000Z',
      trustPolicyVersion: '1.0.0',
    },
  };
}

const data = result => (result && result.data) ? result.data : result;

function closeKernel(kernel) {
  kernel.graph.close();
  kernel.memory.close();
}

test('#3912 (A) an ASCII copula negation parses to the değil relation, not a positive tür', () => {
  for (const spelling of ['llm değildir', 'llm degildir', 'hayvan değildir', 'hayvan degildir']) {
    assert.deepEqual(
      parsePredicate(spelling, word => word),
      { object: spelling.split(' ')[0], relation: 'değil' },
      `${spelling} must be a negation`,
    );
  }
  for (const spelling of ['llm değildir', 'llm degildir']) {
    assert.equal(isCopulaNegationPredicate(spelling), true, `${spelling} is a copula negation`);
  }
});

test('#3912 (A) a taught ASCII negation never becomes a positive type edge', () => {
  const kernel = makeKernel('ascii-learn');
  try {
    data(kernel.learn('kus bir hayvandir', admittedOpts(1)));
    data(kernel.learn('kus bir hayvan degildir', admittedOpts(2)));

    const edges = kernel.graph.getEdges('kus', 'default');
    const positiveTypeTo = edges.filter(e => e.relation === 'tür').map(e => e.to);
    assert.deepEqual(positiveTypeTo, ['hayvan'], 'no "hayvan degil" positive type node');
    assert.equal(
      edges.some(e => e.relation === 'değil' && e.to.includes('hayvan')),
      true,
      'the negation is stored as a değil edge',
    );
    assert.ok(
      !kernel.graph.getNode('hayvan degil', 'default'),
      'no literal "hayvan degil" node is created',
    );
  } finally {
    closeKernel(kernel);
  }
});

test('#3912 (B) an affirmative claim is refuted by a stored negation, not verified', () => {
  const kernel = makeKernel('verify');
  try {
    data(kernel.learn('kedi ucabilir', admittedOpts(1)));
    data(kernel.learn('kedi ucamaz', admittedOpts(2)));

    const affirmative = data(kernel.verify('kedi ucabilir', { workspaceId: 'default' }));
    const negated = data(kernel.verify('kedi ucamaz', { workspaceId: 'default' }));

    assert.equal(affirmative.status, 'contradicted', 'the affirmative claim is contradicted');
    assert.equal(negated.status, 'verified', 'the learned negation stays verified');
    assert.notEqual(affirmative.status, negated.status, 'A and ¬A must not both be verified');
  } finally {
    closeKernel(kernel);
  }
});

test('#3912 (C) learn reports the negation conflict for a fact predicate', () => {
  const kernel = makeKernel('conflict');
  try {
    data(kernel.learn('kedi ucabilir', admittedOpts(1)));
    const second = data(kernel.learn('kedi ucamaz', admittedOpts(2)));

    const negation = second.conflicts.find(c => c.type === 'negation');
    assert.ok(negation, 'the negation conflict is reported');
    assert.equal(negation.current, 'ucamaz');
    assert.equal(negation.existing, 'ucabilir');
  } finally {
    closeKernel(kernel);
  }
});
