'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pkg = require('../package.json');

const REQUIRED_FILES = [
  'plugins/self-healer-audit.js',
  'lib/self-healer/dryrun-runner.js',
  'lib/self-healer/finding-schema.js',
  'lib/self-healer/safety-decision.js',
  'lib/self-healer/source-dependency-graph.js',
  'lib/self-healer/source-dogfood-simulator.js',
  'lib/code-change-gate.js',
  'lib/code-change-path-classification.js',
  'sandboxRunner.js',
  'dream.js',
  'rustGraph.js',
];

test('package allowlist contains the self-healer dogfood runtime dependency closure', () => {
  const shipped = new Set(pkg.files || []);
  for (const file of REQUIRED_FILES) {
    assert.equal(shipped.has(file), true, `package.json files is missing ${file}`);
  }
});
