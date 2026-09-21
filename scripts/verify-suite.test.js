'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { STAGES, runVerify, renderSummary } = require('./verify-suite');

const repoRoot = path.join(__dirname, '..');

const okStage = (name) => ({ name, command: [process.execPath, '-e', 'process.exit(0)'] });

test('verify manifest is fast-first with the test suite last', () => {
  assert.ok(STAGES.length > 1, 'the manifest must list more than the test suite');
  assert.equal(STAGES[0].name, 'environment', 'the environment check runs first');
  assert.equal(STAGES[STAGES.length - 1].name, 'tests', 'the full test suite runs last');
  assert.equal(STAGES.filter((stage) => stage.slow).length, 1, 'only the test suite is marked slow');
});

test('verify manifest keeps the checks the gate historically ran', () => {
  const names = STAGES.map((stage) => stage.name);
  for (const name of ['environment', 'lint', 'cycles', 'module-boundary', 'layers', 'file-size', 'docs-drift', 'package-closure', 'property-tests', 'fuzz-tests', 'tests']) {
    assert.ok(names.includes(name), `missing historical check: ${name}`);
  }
});

test('verify manifest includes the checks added after the one-liner era', () => {
  const names = STAGES.map((stage) => stage.name);
  for (const name of ['action-pins', 'licenses', 'architecture-trackers']) {
    assert.ok(names.includes(name), `missing check: ${name}`);
  }
});

test('every manifest stage names an npm script that exists', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  for (const stage of STAGES) {
    if (stage.command[0] !== 'npm') continue;
    const tokens = stage.command.slice(1).filter((token) => !token.startsWith('-'));
    const scriptName = tokens[0] === 'run' ? tokens[1] : tokens[0];
    assert.ok(
      Object.hasOwn(pkg.scripts, scriptName),
      `stage ${stage.name} runs npm run ${scriptName}, which package.json does not define`,
    );
  }
});

test('runVerify stops at the first failing stage', () => {
  const stages = [
    okStage('first'),
    { name: 'bad', command: [process.execPath, '-e', 'process.exit(3)'] },
    okStage('never'),
  ];
  const results = runVerify(stages);
  assert.deepEqual(results.map((result) => result.name), ['first', 'bad']);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
});

test('renderSummary reports timings, failure output and skipped stages', () => {
  const stages = [
    { name: 'slow-ok', command: [process.execPath, '-e', 'process.exit(0)'] },
    { name: 'loud-fail', command: [process.execPath, '-e', 'console.error("the specific root cause"); process.exit(1)'] },
    okStage('skipped'),
  ];
  const results = runVerify(stages);
  const summary = renderSummary(results, stages);

  assert.match(summary, /PASS slow-ok \(\d+\.\d+s\)/);
  assert.match(summary, /FAIL loud-fail \(\d+\.\d+s\)/);
  assert.match(summary, /the specific root cause/);
  assert.match(summary, /NOT RUN \(stopped at first failure\): skipped/);
  assert.match(summary, /verify: 1\/3 checks passed in \d+\.\d+s/);
});

test('renderSummary explains a stage that was killed instead of failing cleanly', () => {
  const stages = [{ name: 'killed', command: ['irrelevant'] }];
  const results = [
    { name: 'killed', ok: false, timedOut: false, abnormal: 'killed by signal SIGTERM', durationMs: 1234, output: '' },
  ];
  const summary = renderSummary(results, stages);
  assert.match(summary, /FAIL killed \(1\.2s, killed by signal SIGTERM\)/);
});

test('renderSummary reports an all-pass run without a skipped list', () => {
  const stages = [okStage('only')];
  const summary = renderSummary(runVerify(stages), stages);
  assert.match(summary, /PASS only/);
  assert.match(summary, /verify: 1\/1 checks passed in \d+\.\d+s/);
  assert.doesNotMatch(summary, /NOT RUN/);
});

test('package.json wires verify to the orchestrator, not a shell chain', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.verify, 'node scripts/verify-suite.js');
});
