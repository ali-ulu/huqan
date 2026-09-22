'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  evaluateSemverGate,
  isRequiredMajorBump,
  parseStableSemver,
  previousReleaseTag,
} = require('../scripts/api-semver-gate');

test('API semver gate parses stable releases and chooses the latest lower release', () => {
  assert.deepEqual(parseStableSemver('v1.2.3'), {
    major: 1,
    minor: 2,
    patch: 3,
    version: '1.2.3',
  });
  assert.equal(parseStableSemver('v1.2.3-rc.1'), null);
  assert.equal(
    previousReleaseTag(['v0.11.0', 'v0.11.1', 'v0.12.0', 'v1.0.0'], '0.12.0'),
    'v0.11.1',
  );
});

test('breaking API changes require a strictly higher X.0.0 major', () => {
  assert.equal(isRequiredMajorBump('0.12.0', '1.0.0'), true);
  assert.equal(isRequiredMajorBump('1.4.2', '2.0.0'), true);
  assert.equal(isRequiredMajorBump('1.4.2', '1.5.0'), false);
  assert.equal(isRequiredMajorBump('1.4.2', '2.1.0'), false);
  assert.equal(isRequiredMajorBump('1.4.2', '2.0.1'), false);
});

test('API semver verdict blocks a breaking diff without the major bump', () => {
  const base = {
    exports: [{ name: 'KernelV2', target: 'KernelV2' }],
    types: [], cli: { canonical: [], compatibility: [] }, mcp: [],
    rest: { declared: [], workflows: [] }, schemas: [], migrations: [],
  };
  const current = structuredClone(base);
  current.exports = [];

  const blocked = evaluateSemverGate(base, current, '1.4.2', '1.5.0');
  assert.equal(blocked.breaking, true);
  assert.equal(blocked.ok, false);

  const allowed = evaluateSemverGate(base, current, '1.4.2', '2.0.0');
  assert.equal(allowed.breaking, true);
  assert.equal(allowed.ok, true);
});


test('semver gate does not silently bootstrap past a legacy release without a committed baseline', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'api-semver-gate.js'), 'utf8');
  assert.match(source, /function buildSnapshotAtTag\(tag\)/);
  assert.match(source, /worktree', 'add'/);
  assert.match(source, /reconstructed historical snapshot/);
  assert.doesNotMatch(source, /predates api-snapshot-baseline\.json/);
});
