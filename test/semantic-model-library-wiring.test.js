'use strict';

// R51 (#3583): a library consumer that only does `require('huqan')` gets the
// own-weight model on the verify path, like the server/MCP/CLI runtimes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SSM_DIGEST = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'semantic-model-artifacts', 'ssm.json'), 'utf8')).artifactDigest;
const STORED = { text: 'coffee is a stimulant' };
const INCOMING = { text: 'coffee is not a stimulant' };

test('requiring the package root registers the semantic model provider', () => {
  const { runSemanticSignals } = require('../lib/semantic-signals');
  const previous = process.env.HUQAN_SEMANTIC_MODEL;
  process.env.HUQAN_SEMANTIC_MODEL = 'shadow';
  try {
    assert.equal(runSemanticSignals(STORED, INCOMING, {}).semanticModel, undefined);
    require('..');
    const signal = runSemanticSignals(STORED, INCOMING, {}).semanticModel;
    assert.equal(signal.artifactDigest, SSM_DIGEST);
    assert.equal(signal.mode, 'shadow');
    process.env.HUQAN_SEMANTIC_MODEL = 'off';
    assert.equal('semanticModel' in runSemanticSignals(STORED, INCOMING, {}), false);
  } finally {
    if (previous === undefined) delete process.env.HUQAN_SEMANTIC_MODEL;
    else process.env.HUQAN_SEMANTIC_MODEL = previous;
  }
});
