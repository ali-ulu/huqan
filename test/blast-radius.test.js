'use strict';

// The blast radius of one action, and the justification an external action
// receipt records for its decision (#2505).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { computeBlastRadius, externalActionJustification } = require('../lib/blast-radius');
const { normalizeExternalActionEnvelope } = require('../lib/external-action-envelope');
const { evaluateExternalAction } = require('../lib/external-action-guard');

const dim = (value) => ({ value, source: 'test' });

test('a fully known action scales the taxonomy base by each dimension', () => {
  const result = computeBlastRadius({
    category: 'FILESYSTEM_WRITE',
    breadth: dim('unbounded'),
    dependency: dim('not_applicable'),
    reversibility: dim('irreversible'),
    boundary: dim('cross_workspace'),
  });
  // MEDIUM base 40, x1.5 breadth, x1.2 irreversible, x1.25 another workspace.
  assert.equal(result.score, 90);
  assert.equal(result.level, 'critical');
  assert.equal(result.status, 'computed');
  assert.deepEqual(result.unknowns, []);
  assert.deepEqual(result.dimensions.actionClass, { value: 'FILESYSTEM_WRITE', source: 'docs/action-taxonomy.md' });
});

test('a read of one target inside the workspace stays at the taxonomy base', () => {
  const result = computeBlastRadius({
    category: 'READ_ONLY',
    breadth: dim('single'),
    dependency: dim('not_applicable'),
    reversibility: dim('not_applicable'),
    boundary: dim('workspace'),
  });
  assert.equal(result.score, 10);
  assert.equal(result.level, 'low');
  assert.equal(result.status, 'computed');
});

test('a dimension that was not computed takes its worst factor and is listed, never read as harmless', () => {
  const base = { category: 'FILESYSTEM_WRITE', breadth: dim('single'), reversibility: dim('reversible'), boundary: dim('workspace') };
  const computed = computeBlastRadius({ ...base, dependency: dim('not_applicable') });
  const missing = computeBlastRadius({ ...base, dependency: { value: 'unknown', reason: 'not computed here' } });
  assert.equal(computed.score, 30);
  assert.equal(missing.score, 45);
  assert.equal(missing.status, 'upper_bound');
  assert.deepEqual(missing.unknowns, ['dependency: not computed here']);
  assert.deepEqual(missing.dimensions.dependency, { value: 'unknown', source: null, reason: 'not computed here' });

  const nothingSupplied = computeBlastRadius({ category: 'FILESYSTEM_WRITE' });
  assert.equal(nothingSupplied.score, 100);
  assert.equal(nothingSupplied.unknowns.length, 4);
});

test('without a taxonomy category there is no score: null, not 0', () => {
  const result = computeBlastRadius({
    category: 'NOT_A_CATEGORY',
    breadth: dim('single'),
    dependency: dim('not_applicable'),
    reversibility: dim('not_applicable'),
    boundary: dim('workspace'),
  });
  assert.equal(result.score, null);
  assert.equal(result.level, null);
  assert.equal(result.status, 'unknown');
  assert.match(result.unknowns[0], /^actionClass: /);
});

test('a dimension value outside its scale is rejected rather than guessed', () => {
  assert.throws(() => computeBlastRadius({ category: 'READ_ONLY', breadth: dim('everything') }), /unknown breadth value: everything/);
});

test('a missing risk score is recorded as unknown, never as 0', () => {
  const envelope = normalizeExternalActionEnvelope({ toolName: 'Read', args: { file_path: 'README.md' }, cwd: process.cwd() });
  const justification = externalActionJustification(envelope, { decision: 'review', reason: 'no_score' });
  assert.equal(justification.riskScore, null);
  assert.equal(justification.riskScoreState, 'unknown');
});

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'blast-radius-'));
fs.writeFileSync(path.join(ROOT, 'existing.md'), 'before');
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function guard(extra, options = {}) {
  return evaluateExternalAction({
    invocationId: 'blast-radius',
    agentName: 'blast-radius-agent',
    sessionId: 'blast-radius-session',
    turnId: 'turn-1',
    cwd: ROOT,
    workspaceRoot: ROOT,
    workspaceId: 'default',
    ...extra,
  }, { environment: {}, dataResidency: null, receiptWriter: { append() {} }, ...options });
}

const justificationOf = (result) => result.receipt.metadata.justification;

test('an external action receipt records why it was decided, with the blast radius and its inputs', () => {
  const read = guard({ toolName: 'Read', action: 'read', args: { file_path: 'existing.md' } });
  const justification = justificationOf(read);
  assert.equal(justification.decision, read.decision);
  assert.equal(justification.reason, read.reason);
  assert.equal(justification.riskScore, read.risk.score);
  assert.equal(justification.riskScoreState, 'computed');
  assert.equal(justification.blastRadius.score, 10);
  assert.equal(justification.blastRadius.status, 'computed');
  assert.deepEqual(justification.blastRadius.dimensions.boundary, { value: 'workspace', source: 'envelope.target.resolvedPath' });
  assert.deepEqual(justification.thresholds.levelBands[0], { floor: 75, level: 'CRITICAL' });
  assert.equal(justification.thresholds.decisionSource, 'gate_findings');
  assert.equal(justification.thresholds.blastRadiusEnforced, false);
});

test('a write that creates a file is reversible, one that overwrites a file is not', () => {
  const create = justificationOf(guard({ toolName: 'Write', action: 'write', args: { file_path: 'new.md', content: 'x' } })).blastRadius;
  const overwrite = justificationOf(guard({ toolName: 'Write', action: 'write', args: { file_path: 'existing.md', content: 'x' } })).blastRadius;
  assert.equal(create.dimensions.reversibility.value, 'reversible');
  assert.equal(overwrite.dimensions.reversibility.value, 'irreversible');
  assert.equal(create.score, 45);
  assert.equal(overwrite.score, 72);
  // What depends on a file is not computed for external actions: the score is
  // an upper bound and says why.
  assert.equal(create.status, 'upper_bound');
  assert.deepEqual(create.unknowns, ['dependency: what depends on the target is not computed for external actions']);
});

test('a write outside the workspace and a fetch to an outside service record their boundary', () => {
  const outside = justificationOf(guard({ toolName: 'Write', action: 'write', args: { file_path: '../outside.txt', content: 'x' } })).blastRadius;
  assert.equal(outside.dimensions.boundary.value, 'outside_workspace');

  const fetch = justificationOf(guard({ toolName: 'WebFetch', action: 'get', args: { url: 'https://example.com' } })).blastRadius;
  assert.equal(fetch.dimensions.boundary.value, 'external_service');
  assert.equal(fetch.dimensions.reversibility.value, 'irreversible');
  assert.equal(fetch.dimensions.dependency.value, 'not_applicable');
  assert.equal(fetch.score, 60);
  assert.equal(fetch.status, 'computed');
});

test('a shell command reports the breadth it can see and marks the rest unknown', () => {
  const recursive = justificationOf(guard({ toolName: 'Bash', args: { command: 'rm -rf build' } })).blastRadius;
  assert.equal(recursive.dimensions.breadth.value, 'unbounded');

  const opaque = justificationOf(guard({ toolName: 'Bash', args: { command: 'npm test' } })).blastRadius;
  assert.equal(opaque.dimensions.breadth.value, 'unknown');
  assert.equal(opaque.dimensions.boundary.value, 'unknown');
  assert.notEqual(opaque.status, 'computed');

  // `find . -delete` is classified READ_ONLY by its text. A shell read is a
  // pattern match, not an observation, so nothing is marked not applicable.
  const shellRead = justificationOf(guard({ toolName: 'Bash', args: { command: 'find . -name "*.tmp" -delete' } })).blastRadius;
  assert.equal(shellRead.dimensions.actionClass.value, 'READ_ONLY');
  assert.equal(shellRead.dimensions.dependency.value, 'unknown');
  assert.equal(shellRead.dimensions.reversibility.value, 'unknown');
  assert.equal(shellRead.status, 'upper_bound');
});

test('a long hostile flag does not slow the breadth check (no polynomial backtracking)', () => {
  const { externalActionBlastRadius } = require('../lib/blast-radius');
  const envelope = normalizeExternalActionEnvelope({ toolName: 'Bash', args: { command: `ls -R${'R'.repeat(50000)}!` }, cwd: ROOT });
  const started = process.hrtime.bigint();
  const result = externalActionBlastRadius(envelope);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 500, `breadth check took ${elapsedMs} ms`);
  assert.equal(result.dimensions.breadth.value, 'unknown');
  const recursive = externalActionBlastRadius(normalizeExternalActionEnvelope({ toolName: 'Bash', args: { command: 'grep -rn needle .' }, cwd: ROOT }));
  assert.equal(recursive.dimensions.breadth.value, 'unbounded');
});

test('a blocked, malformed action still records its justification', () => {
  const blocked = evaluateExternalAction({ invocationId: 'broken' }, { environment: {}, receiptWriter: { append() {} } });
  const justification = justificationOf(blocked);
  assert.equal(justification.decision, 'block');
  assert.equal(justification.riskScore, 100);
  assert.ok(justification.blastRadius.unknowns.length > 0);
});
