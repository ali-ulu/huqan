'use strict';

// #3474 I6 mutation tests. Each disables one critical behavior on real source
// and proves the corresponding acceptance assertion turns red, so the port,
// the model boundary and the B7 safety gates are not decorative.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const port = require('../lib/cognitive-model-port');
const { MODEL_AUTHORITY } = require('../lib/cognitive-model-port');
const { createLocalNeuralModel } = require('../lib/cognitive-model-local-ssm');
const { splitReport, overallStatus } = require('../lib/cognitive-lab-neural-experiment');
const { DESIGN } = require('../lib/cognitive-lab-neural-design');

function mutant(relative, original, replacement) {
  const file = path.resolve(__dirname, '..', relative);
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(source.split(original).length - 1, 1, 'mutation must have exactly one target');
  const compiledFile = file.replace(/\.js$/, '.mutant.cjs');
  const compiled = new Module(compiledFile, module);
  compiled.filename = compiledFile;
  compiled.paths = module.paths;
  compiled._compile(source.replace(original, replacement), compiledFile);
  return compiled.exports;
}

test('accepting an external locality breaks the local-only port assertion', () => {
  const proposal = {
    schemaVersion: 'huqan-cognitive-model-v1', modelId: 'm', kind: 'SSM', locality: 'EXTERNAL',
    modelDigest: 'a'.repeat(64), answer: { label: 'positive', score: 0.5 }, confidence: 0.5,
    budget: { modelCalls: 0, tokens: 0, operations: 1 },
  };
  const assertion = ({ validateProposal }) => assert.equal(validateProposal(proposal).status, 'REJECT');
  assertion(port);
  const broken = mutant('lib/cognitive-model-port.js', "if (input.locality === 'EXTERNAL') {", 'if (false) {');
  assert.throws(() => assertion(broken), { code: 'ERR_ASSERTION' });
});

test('returning a raw object breaks the candidate-only boundary assertion', () => {
  const assertion = (model) => {
    model.train([{ sequence: Array(8).fill(1), label: 1 }]);
    const proposal = model.predict(Array(8).fill(0));
    assert.equal(proposal.authority, MODEL_AUTHORITY);
    assert.equal(proposal.canonical, false);
  };
  assertion(createLocalNeuralModel({ reservoir: 8 }));
  const { createLocalNeuralModel: Mutant } = mutant('lib/cognitive-model-local-ssm.js', 'return buildProposal({', 'return ({');
  assert.throws(() => assertion(Mutant({ reservoir: 8 })), { code: 'ERR_ASSERTION' });
});

test('ignoring the safety checks breaks the safety-not-hidden-by-a-small-sample assertion', () => {
  // An inadequate sample whose safety check failed must still be REJECT, never
  // INSUFFICIENT: the `safe` short-circuit is what enforces that.
  const rows = Array.from({ length: 10 }, (_, i) => ({ correct: 1, majorityCorrect: 0, memorylessCorrect: 0, falsePositive: 0,
    falseNegative: 0, confidence: 0.5, finiteScore: i === 0 ? 0 : 1, valid: 1, authority: MODEL_AUTHORITY, canonical: false }));
  const assertion = (module_) => assert.equal(module_.splitReport('holdout', rows, DESIGN.thresholds).status, 'REJECT');
  assertion({ splitReport });
  const broken = mutant('lib/cognitive-lab-neural-experiment.js', 'const safe = checks.allValid && checks.finiteScores;', 'const safe = true;');
  assert.throws(() => assertion(broken), { code: 'ERR_ASSERTION' });
});

test('letting KEEP win over a budget mismatch breaks the equal-budget assertion', () => {
  const keep = { status: 'KEEP' };
  const assertion = (module_) => assert.equal(module_.overallStatus({ reports: [keep, keep], frozenInputs: true, worldLaw: true, sourceDirty: false, equalExternalBudget: false }), 'REJECT');
  assertion({ overallStatus });
  const broken = mutant('lib/cognitive-lab-neural-experiment.js',
    'if (!equalExternalBudget || reports.some((item) => item.status === \'REJECT\')) return \'REJECT\';', 'if (false) return \'REJECT\';');
  assert.throws(() => assertion(broken), { code: 'ERR_ASSERTION' });
});
