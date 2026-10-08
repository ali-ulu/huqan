'use strict';

// R50 PR4 (issue #3582): the no-external-dependency regression. The
// contradiction lab must stay a deterministic, local, offline measurement:
//
//   - the require graph from every contradiction lab entry point never reaches
//     a model-calling module (`llmAdapter.js`);
//   - no entry point requires an external model/embedding package or a network
//     primitive;
//   - the authority surface stays CANDIDATE_ONLY: no canonical write, no
//     auto-block/reject/promotion, zero model/token/external budget.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { checkDeterministicPath, MODEL_CALLING_MODULES } = require('../scripts/check-deterministic-path.js');
const { FUSION_STATUS, AUTHORITY, fitFusion } = require('../lib/cognitive-lab-contradiction-fusion.js');
const { joinCorpusLabels } = require('../lib/cognitive-lab-contradiction-evaluator.js');

const ENTRY_POINTS = Object.freeze([
  'lib/cognitive-lab-contradiction-features.js',
  'lib/cognitive-lab-contradiction-fusion.js',
  'lib/cognitive-lab-contradiction-calibrator.js',
  'lib/cognitive-lab-contradiction-evaluator.js',
  'lib/cognitive-lab-contradiction-report.js',
  'lib/cognitive-lab-contradiction-policy.js',
]);

const FORBIDDEN_REQUIRES = Object.freeze([
  'llmAdapter', 'huggingface', 'transformers', 'onnxruntime', '@xenova', 'openai', 'anthropic',
  'node:http', 'node:https', 'node:net', 'node:dns', 'node:tls', 'http', 'https', 'axios', 'node-fetch',
]);

test('the contradiction lab require graph never reaches a model-calling module', () => {
  const result = checkDeterministicPath({ entryPoints: [...ENTRY_POINTS] });
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.deepEqual(MODEL_CALLING_MODULES, ['llmAdapter.js']);
});

test('no contradiction lab entry point requires a model package or a network primitive', () => {
  for (const entry of ENTRY_POINTS) {
    const source = fs.readFileSync(path.join(__dirname, '..', entry), 'utf8');
    const allRequireCalls = [...source.matchAll(/\brequire\s*\(/g)].length;
    const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
    assert.equal(requires.length, allRequireCalls, `${entry} must only use literal require calls`);
    for (const request of requires) {
      for (const forbidden of FORBIDDEN_REQUIRES) {
        assert.equal(request.includes(forbidden), false, `${entry} must not require ${forbidden}`);
      }
    }
  }
});

test('the fusion authority stays candidate-only with zero model, token and external budget', () => {
  const records = joinCorpusLabels(
    JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/contradiction-eval-v1.corpus.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/contradiction-eval-v1.labels.json'), 'utf8')),
  );
  const fusion = fitFusion({
    trainRecords: records.filter((record) => record.split === 'train'),
    calibrationRecords: records.filter((record) => record.split === 'calibration'),
    contract: { minimumSamples: 10, smoothingAlpha: 0.5 },
    sourceCommit: 'a'.repeat(40),
  });
  assert.equal(fusion.status, FUSION_STATUS.MEASURED);
  assert.deepEqual(fusion.authority, AUTHORITY);
  assert.equal(fusion.authority.canonical, false);
  assert.equal(fusion.authority.modelCalls, 0);
  assert.equal(fusion.authority.tokens, 0);
  assert.equal(fusion.authority.externalCalls, 0);
});
