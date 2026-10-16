'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkBaselineRatchet,
  checkReport,
  scoreMutants,
} = require('../scripts/check-mutation-score');
const { selectMutationTargetsFromFiles } = require('../scripts/list-mutation-targets');

const baseline = {
  schemaVersion: 1,
  minimumScore: 80,
  files: {
    'lib/a.js': 80,
    'lib/b.js': 90,
  },
};

function mutant(status) {
  return { id: status, mutatorName: 'test', replacement: '', location: {}, status };
}

test('mutation score counts detected and undetected statuses and ignores non-scored statuses', () => {
  const score = scoreMutants([
    mutant('Killed'),
    mutant('Timeout'),
    mutant('Survived'),
    mutant('NoCoverage'),
    mutant('Ignored'),
  ]);
  assert.equal(score, 50);
});

test('report gate enforces per-file baseline scores', () => {
  const report = {
    files: {
      'lib/a.js': { mutants: [mutant('Killed'), mutant('Killed'), mutant('Killed'), mutant('Killed'), mutant('Survived')] },
      'lib/b.js': { mutants: [mutant('Killed'), mutant('Killed'), mutant('Killed'), mutant('Killed'), mutant('Survived')] },
    },
  };
  const result = checkReport(report, baseline);
  assert.deepEqual(result.failures, ['lib/b.js: 80.00% < required 90.00%']);
});

test('partial report only requires mutation targets present in the report', () => {
  const report = {
    files: {
      'lib/a.js': { mutants: [mutant('Killed'), mutant('Killed'), mutant('Killed'), mutant('Killed'), mutant('Survived')] },
    },
  };
  assert.deepEqual(checkReport(report, baseline, { allowPartial: true }).failures, []);
  assert.deepEqual(checkReport(report, baseline).failures, ['lib/b.js: missing from mutation report']);
});

test('baseline ratchet cannot remove a target or lower a stored score', () => {
  const current = {
    schemaVersion: 1,
    minimumScore: 80,
    files: { 'lib/a.js': 79 },
  };
  assert.throws(() => checkBaselineRatchet(current, baseline), /invalid mutation baseline score/);

  const lowerButValid = {
    schemaVersion: 1,
    minimumScore: 70,
    files: { 'lib/a.js': 80, 'lib/b.js': 85 },
  };
  assert.deepEqual(checkBaselineRatchet(lowerButValid, baseline), [
    'minimumScore decreased: 80 -> 70',
    'lib/b.js: baseline decreased: 90 -> 85',
  ]);
});

test('PR mutation target selection is changed-source-only after the bootstrap', () => {
  assert.deepEqual(
    selectMutationTargetsFromFiles(['stryker.conf.json', 'config/mutation-baseline.json'], baseline),
    [],
    'mutation infrastructure alone does not force a full run once a trusted baseline exists',
  );

  assert.deepEqual(
    selectMutationTargetsFromFiles(['lib/a.js', 'README.md', 'lib/b.js'], baseline),
    ['lib/a.js', 'lib/b.js'],
  );
});

test('the introducing PR measures every protected target once before the baseline is trusted', () => {
  assert.deepEqual(
    selectMutationTargetsFromFiles(['README.md'], baseline, { bootstrap: true }),
    ['lib/a.js', 'lib/b.js'],
  );
});
