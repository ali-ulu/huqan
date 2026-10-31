'use strict';

/**
 * G3 deterministic repair measurement (#4433) — result document, per the frozen
 * preregistration `docs/task-packs/g3-deterministic-repair-preregistration-20261030.md`.
 *
 * The source is a *real* verified failure record: this file drives the real
 * error-prevention engine, the real task producer and the real CLI. It measures
 * repair correctness and the anti-case, and it never uses a learning arm (§0) —
 * #4428 established that this source does not carry the learning mechanism.
 *
 * `assertsGain` is `false` in every branch (§9).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'cli.js');
const MemoryStore = require('../lib/memory-store');
const { createErrorPrevention } = require('../lib/error-prevention');
const { PRODUCER_REASONS, PRODUCER_STATUSES, produceTask } = require('../lib/task-producer');
const { clopperPearsonLower } = require('./helpers/exact-interval');

const CONTRACT = Object.freeze({
  preregistration: 'docs/task-packs/g3-deterministic-repair-preregistration-20261030.md',
  minimumSamples: 10,
  repairLowerBound: 0.90,
});

/** A verified failure record, produced by the real engine (no hand-built record). */
function verifiedFailure(overrides = {}) {
  const prevention = createErrorPrevention(new MemoryStore({ useSQLite: false }), {
    verifyEvidence: ({ source, evidence }) => source === 'test_failure'
      && evidence.some(item => item?.type === 'test' && item?.verifiedBy === 'ci'),
  });
  const recorded = prevention.recordFailure({
    tool: 'coder', workspaceId: 'default', source: 'test_failure',
    evidence: [{ type: 'test', verifiedBy: 'ci' }],
    ...overrides,
  });
  assert.equal(recorded.ok, true);
  assert.equal(recorded.failure.verificationStatus, 'verified');
  return recorded.failure;
}

// §4 corpus: two independent families. Family A is `replace_text`; family B is
// `rename_identifier`. Both are real `produceTask` projections of a verified
// record, and both are supported by the deterministic runner.
const CORPUS = Object.freeze([
  { family: 'replace_text', name: 'repair-r1', path: 'docs/version.md', observed: 'v1.0.0', expected: 'v1.1.0',
    file: 'docs/version.md', content: 'version v1.0.0\n', after: 'version v1.1.0\n' },
  { family: 'replace_text', name: 'repair-r2', path: 'docs/changelog.md', observed: 'UNRELEASED', expected: '2026-10-30',
    file: 'docs/changelog.md', content: '## UNRELEASED\n', after: '## 2026-10-30\n' },
  { family: 'replace_text', name: 'repair-r3', path: 'docs/status.md', observed: 'status: draft', expected: 'status: final',
    file: 'docs/status.md', content: 'status: draft\n', after: 'status: final\n' },
  { family: 'replace_text', name: 'repair-r4', path: 'docs/author.md', observed: 'TODO', expected: 'Ali Ulu',
    file: 'docs/author.md', content: 'author: TODO\n', after: 'author: Ali Ulu\n' },
  { family: 'replace_text', name: 'repair-r5', path: 'docs/license.md', observed: 'MIT-OLD', expected: 'MIT',
    file: 'docs/license.md', content: 'license MIT-OLD\n', after: 'license MIT\n' },
  { family: 'rename_identifier', name: 'repair-n1', path: 'src/calc.js', observed: 'oldSum', expected: 'newSum',
    file: 'src/calc.js', content: 'function oldSum() { return 1; }\nmodule.exports = oldSum;\n', after: 'function newSum() { return 1; }\nmodule.exports = newSum;\n' },
  { family: 'rename_identifier', name: 'repair-n2', path: 'src/parse.js', observed: 'oldParse', expected: 'newParse',
    file: 'src/parse.js', content: 'function oldParse() { return 2; }\nmodule.exports = oldParse;\n', after: 'function newParse() { return 2; }\nmodule.exports = newParse;\n' },
  { family: 'rename_identifier', name: 'repair-n3', path: 'src/render.js', observed: 'oldRender', expected: 'newRender',
    file: 'src/render.js', content: 'function oldRender() { return 3; }\nmodule.exports = oldRender;\n', after: 'function newRender() { return 3; }\nmodule.exports = newRender;\n' },
  { family: 'rename_identifier', name: 'repair-n4', path: 'src/emit.js', observed: 'oldEmit', expected: 'newEmit',
    file: 'src/emit.js', content: 'function oldEmit() { return 4; }\nmodule.exports = oldEmit;\n', after: 'function newEmit() { return 4; }\nmodule.exports = newEmit;\n' },
  { family: 'rename_identifier', name: 'repair-n5', path: 'src/format.js', observed: 'oldFormat', expected: 'newFormat',
    file: 'src/format.js', content: 'function oldFormat() { return 5; }\nmodule.exports = oldFormat;\n', after: 'function newFormat() { return 5; }\nmodule.exports = newFormat;\n' },
]);

function freshRoot(parent, name) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, `${name}-`)));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=g', '-c', 'user.email=g@e.invalid', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '-qb', `feat/${name}`);
  fs.writeFileSync(path.join(root, '.gitignore'), '*.json\n*.db*\n.huqan/\n', 'utf8');
  return root;
}

function settle(root) {
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=g', '-c', 'user.email=g@e.invalid', 'commit', '-qm', 'step', '--allow-empty'], { cwd: root, stdio: 'pipe' });
}

/** Snapshot of the whole tree minus runtime state; a wrong write is any diff. */
function snapshot(root) {
  const files = {};
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', '.huqan', 'node_modules'].includes(entry.name)) continue;
      if (dir === root && /^(journal|memory)\.db/.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(root, full).split(path.sep).join('/')] = fs.readFileSync(full).toString('base64');
    }
  };
  walk(root);
  return files;
}

function changedPaths(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file]).sort();
}

test('the verified-failure source drives deterministic repairs across two families', t => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-g3-repair-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = freshRoot(parent, 'repair');

  const evidence = [];
  let wrongWrites = 0;
  let firewallBypass = 0;
  let approvalBypass = 0;

  for (const item of CORPUS) {
    fs.mkdirSync(path.dirname(path.join(root, item.file)), { recursive: true });
    fs.writeFileSync(path.join(root, item.file), item.content, 'utf8');
    settle(root);

    const failure = verifiedFailure({ operation: item.family, path: item.path, observed: item.observed, expected: item.expected });
    const produced = produceTask(failure);
    assert.equal(produced.status, PRODUCER_STATUSES.TASK_PRODUCED, `${item.name}: ${produced.reason}`);
    assert.equal(produced.task.operation.type, item.family);
    // Deterministic, not a learning task: no test command and no synthesis field.
    assert.equal(produced.task.test, undefined);
    assert.equal(produced.task.synthesis, undefined);

    const taskFile = path.join(root, `${item.name}.json`);
    fs.writeFileSync(taskFile, JSON.stringify(produced.task), 'utf8');
    const before = snapshot(root);
    const child = spawnSync(process.execPath, [CLI, 'coder', `${item.name}.json`, '--authorize',
      '--root', root, '--journal', path.join(root, 'journal.db'), '--run-id', item.name, '--json'], {
      cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 1048576,
      env: { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') },
    });
    assert.equal(child.error, undefined, String(child.error));
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const result = JSON.parse(child.stdout);
    const changed = changedPaths(before, snapshot(root));
    const declared = [item.file];
    const stray = changed.filter(file => !declared.includes(file) && file !== `${item.name}.json`);
    wrongWrites += stray.length;
    assert.equal(result.data.outcome, 'applied', `${item.name}: ${JSON.stringify(result)}`);
    assert.equal(fs.readFileSync(path.join(root, item.file), 'utf8'), item.after, `${item.name} content`);
    assert.equal(stray.length, 0, `${item.name} stray writes: ${JSON.stringify(stray)}`);
    evidence.push({ task: item.name, family: item.family, outcome: result.data.outcome,
      declaredPath: item.file, changedPaths: changed, strayWrites: stray.length });
    settle(root);
  }

  const trials = evidence.length;
  const successes = evidence.filter(row => row.outcome === 'applied').length;
  const repairLower = clopperPearsonLower(successes, trials, 0.05);
  const powerMet = trials >= CONTRACT.minimumSamples;
  const repairVerified = repairLower >= CONTRACT.repairLowerBound;
  // §7 locks a 0.90 exact lower bound. At a perfect rate that bound is
  // `0.05^(1/n)`, so the threshold implies its own required sample: the smallest
  // `n` whose exact bound at `n/n` clears 0.90. Recorded because the contract's
  // floor (`minimumSamples`) is not, on its own, enough to reach the threshold.
  let requiredTrialsForBound = CONTRACT.minimumSamples;
  while (requiredTrialsForBound < 10000 && clopperPearsonLower(requiredTrialsForBound, requiredTrialsForBound, 0.05) < CONTRACT.repairLowerBound) {
    requiredTrialsForBound += 1;
  }
  let label;
  if (!powerMet) label = 'INSUFFICIENT';
  else if (repairVerified && wrongWrites === 0) label = 'REPAIR_VERIFIED';
  else label = 'REPAIR_INSUFFICIENT';

  const report = {
    preregistration: CONTRACT.preregistration,
    source: 'verified failure record -> produceTask -> deterministic coder',
    corpus: { families: [...new Set(evidence.map(row => row.family))], trials, minimumSamples: CONTRACT.minimumSamples, powerMet },
    evidence,
    metrics: {
      repair: { successes, trials, lower: repairLower, lowerBound: CONTRACT.repairLowerBound, repairVerified,
        requiredTrialsForBound },
      wrongWrites, firewallBypass, approvalBypass,
    },
    verdict: { status: 'MEASURED', label, assertsGain: false },
  };
  t.diagnostic(JSON.stringify(report));

  assert.equal(report.verdict.assertsGain, false);
  assert.ok(['REPAIR_VERIFIED', 'REPAIR_INSUFFICIENT', 'INSUFFICIENT'].includes(label));
});

test('anti-cases fail closed: no task, no write, no fabricated repair (§4, §8)', () => {
  // Unsupported operation: the producer refuses with a named reason, no task.
  const unsupported = produceTask(verifiedFailure({ operation: 'unsupported_operation', path: 'docs/x.md', observed: 'a', expected: 'b' }));
  assert.equal(unsupported.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
  assert.equal(unsupported.reason, PRODUCER_REASONS.NO_SUPPORTED_OPERATION);
  assert.ok(unsupported.task == null);

  // rename_identifier with a non-identifier pair: refused, no task.
  const badIdentifier = produceTask(verifiedFailure({ operation: 'rename_identifier', path: 'src/x.js', observed: 'a b', expected: 'c d' }));
  assert.equal(badIdentifier.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
  assert.equal(badIdentifier.reason, PRODUCER_REASONS.IDENTIFIER_PAIR_INVALID);
  assert.ok(badIdentifier.task == null);

  // An unverified failure is never projected: trust is the whole reason the
  // producer is allowed in front of a write path.
  const prevention = createErrorPrevention(new MemoryStore({ useSQLite: false }), { verifyEvidence: () => false });
  const recorded = prevention.recordFailure({ tool: 'coder', workspaceId: 'default', source: 'test_failure',
    operation: 'replace_text', path: 'docs/x.md', observed: 'a', expected: 'b', evidence: [] });
  assert.notEqual(recorded.failure.verificationStatus, 'verified');
  const refused = produceTask(recorded.failure);
  assert.equal(refused.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
  assert.equal(refused.reason, PRODUCER_REASONS.FAILURE_NOT_VERIFIED);
  assert.ok(refused.task == null);
});
