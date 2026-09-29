'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { mineCommandAllowlist } = require('../lib/command-allowlist-miner');
const { commandShapeLogPathFor } = require('../lib/command-shape-log');
const { commandShape } = require('../lib/external-action-envelope');
const { evaluateExternalAction, recordExternalActionOutcome } = require('../lib/external-action-guard');

const ROOT = path.resolve(__dirname, '..');

// The identity gate is orthogonal to what this miner learns and has its own
// suites; with it on, every call here would block for the same unrelated reason
// (the benign-false-block-rate corpus makes the same choice).
const GUARD_OPTIONS = Object.freeze({ requireIdentityCard: false, requireSignedIdentityCard: false });

let invocation = 0;
function envelopeFor(command, workspaceId = 'default') {
  return {
    invocationId: `cmd-inv-${++invocation}`,
    agentName: 'test-agent',
    sessionId: 'session',
    toolName: 'Bash',
    args: { command },
    cwd: ROOT,
    workspaceRoot: ROOT,
    workspaceId,
  };
}

/**
 * A history built by running the real guard, not by hand-writing receipts:
 * a miner tested against typed fixtures is tested against somebody's idea of
 * the trail rather than the trail.
 */
function history(entries) {
  const receipts = [];
  const shapes = [];
  const receiptWriter = { append(receipt) { receipts.push(receipt); } };
  const commandShapeWriter = { append(entry) { shapes.push(entry); } };
  for (const [command, verdict, workspaceId] of entries) {
    const envelope = envelopeFor(command, workspaceId);
    const admission = evaluateExternalAction(envelope, { ...GUARD_OPTIONS, receiptWriter, commandShapeWriter });
    if (verdict) {
      recordExternalActionOutcome(envelope, admission.receipt,
        { status: verdict === 'approved' ? 'success' : 'blocked' }, { receiptWriter });
    }
  }
  return { receipts, shapes };
}

function mine(trail, options = {}) {
  return mineCommandAllowlist(trail.receipts, { shapes: trail.shapes, ...options });
}

const times = (n, entry) => Array.from({ length: n }, () => entry);

// ─── the loop ────────────────────────────────────────────────────────────────

test('commands a person keeps approving are proposed as allowedCommands', () => {
  const mined = mine(history([
    ...times(3, ['npm test', 'approved']),
    ...times(4, ['npm run build -- --watch', 'approved']),
  ]));

  assert.deepEqual(mined.proposals, [
    { workspaceId: 'default', allowedCommands: ['npm run build', 'npm test'] },
  ]);
});

test('applying the proposal by hand turns the reviewed command into an allow', () => {
  const proposal = mine(history(times(3, ['npm test', 'approved']))).proposals[0];

  const before = evaluateExternalAction(envelopeFor('npm test'), { ...GUARD_OPTIONS, receiptWriter: { append() {} } });
  const after = evaluateExternalAction(envelopeFor('npm test'), {
    ...GUARD_OPTIONS,
    receiptWriter: { append() {} },
    allowedCommands: proposal.allowedCommands,
  });

  assert.equal(before.decision, 'review');
  assert.equal(after.decision, 'allow');
  assert.equal(after.receipt.metadata.allowlistedCommand, 'npm test');
});

// ─── fail closed ─────────────────────────────────────────────────────────────

test('one refusal disqualifies a command -- no majority vote', () => {
  const mined = mine(history([
    ...times(9, ['npm test', 'approved']),
    ['npm test', 'refused'],
  ]));

  assert.deepEqual(mined.proposals, []);
  assert.equal(mined.unresolved[0].shape, 'npm test');
  assert.equal(mined.unresolved[0].refused, 1);
  assert.match(mined.unresolved[0].why, /refused/);
});

test('a refusal is not erased by a later outcome for the same admission', () => {
  // Outcomes are appended, so one admission can carry several. A later
  // `executed` must not overwrite the refusal that came before it.
  const trail = history(times(3, ['npm test', 'approved']));
  const reviewed = trail.receipts.find((receipt) => receipt.receiptKind === 'external_action_review_receipt');
  const { receipts } = trail;
  const at = receipts.findIndex((receipt) => receipt.receiptKind === 'external_action_outcome_receipt'
    && receipt.admissionId === reviewed.admissionId);
  const replayed = [
    ...receipts.slice(0, at),
    { ...receipts[at], status: 'blocked' },
    ...receipts.slice(at),
  ];

  const mined = mine({ receipts: replayed, shapes: trail.shapes });
  assert.deepEqual(mined.proposals, []);
  assert.equal(mined.unresolved[0].refused, 1);
});

test('a review nobody resolved is silence, never evidence', () => {
  const mined = mine(history(times(5, ['npm test', null])));

  assert.deepEqual(mined.proposals, []);
  assert.equal(mined.unresolved[0].unresolved, 5);
  assert.equal(mined.unresolved[0].approved, 0);
});

test('below the observation floor nothing is proposed', () => {
  const trail = history(times(2, ['npm test', 'approved']));

  assert.deepEqual(mine(trail).proposals, []);
  assert.match(mine(trail).unresolved[0].why, /only 2 approval/);
  assert.deepEqual(mine(trail, { minObservations: 2 }).proposals[0].allowedCommands, ['npm test']);
});

test('a command the gate decided on its own is not a human decision', () => {
  // `git status` is allowed without asking and `git push` is blocked without
  // asking; an `executed` outcome on either says nothing about what a person
  // wanted, and neither is logged in the first place.
  const trail = history([
    ...times(4, ['git status', 'approved']),
    ...times(4, ['git push origin main', 'approved']),
  ]);

  assert.deepEqual(trail.shapes, []);
  assert.deepEqual(mine(trail).evidence, []);
});

test('a one-word shape is reported, never proposed', () => {
  // `node` would allow `node -e <anything>`.
  const mined = mine(history(times(3, ['node -e "console.log(1)"', 'approved'])));

  assert.deepEqual(mined.proposals, []);
  assert.equal(mined.unresolved[0].shape, 'node');
  assert.match(mined.unresolved[0].why, /one-word/);
});

test('a shape the allowlist cannot promote is not proposed', () => {
  // A write keeps its category whatever the list says; proposing it would read
  // as a fix while changing nothing.
  const mined = mine(history(times(3, ['mkdir build dist', 'approved'])));

  assert.deepEqual(mined.proposals, []);
  assert.match(mined.unresolved[0].why, /FILESYSTEM_WRITE/);
});

test('proposals stay inside the workspace that approved them', () => {
  const mined = mine(history([
    ...times(3, ['npm test', 'approved', 'alpha']),
    ...times(3, ['npm run lint', 'approved', 'beta']),
    ['npm test', 'refused', 'beta'],
  ]));

  assert.deepEqual(mined.proposals, [
    { workspaceId: 'alpha', allowedCommands: ['npm test'] },
    { workspaceId: 'beta', allowedCommands: ['npm run lint'] },
  ]);
});

test('a log line that disagrees with the trail is not evidence', () => {
  // The log is not hash-covered. A line placing an admission in another
  // workspace, or an id logged with two different commands, describes
  // something the trail cannot vouch for.
  const trail = history(times(3, ['npm test', 'approved']));
  const moved = trail.shapes.map((entry, i) => (i === 0 ? { ...entry, workspaceId: 'elsewhere' } : entry));
  // The conflicting line comes first, so a last-line-wins reader would still
  // see three clean `npm test` approvals.
  const doubled = [{ ...trail.shapes[1], shape: 'npm run deploy' }, ...trail.shapes];

  assert.deepEqual(mine({ receipts: trail.receipts, shapes: moved }).proposals, []);
  assert.deepEqual(mine({ receipts: trail.receipts, shapes: doubled }).proposals, []);
  assert.deepEqual(mineCommandAllowlist(trail.receipts).proposals, []);
});

test('a log line naming an admission nobody reviewed is not evidence', () => {
  // The gate never logs these, so a line like this was written by something
  // else; an allowed admission that then ran carries no human judgement.
  const trail = history(times(3, ['git status', 'approved']));
  const forged = trail.receipts
    .filter((receipt) => receipt.receiptKind === 'external_action_admission_receipt')
    .map((receipt) => ({ admissionId: receipt.admissionId, workspaceId: receipt.workspaceId, shape: 'npm test', riskCategory: 'TOOL_CHAIN_EXECUTION' }));

  assert.equal(forged.length, 3);
  assert.deepEqual(mine({ receipts: trail.receipts, shapes: forged }).evidence, []);
});

// ─── what is kept, and where ─────────────────────────────────────────────────

test('the receipt still carries no command; the log carries only its shape', () => {
  const trail = history([['npm test -- --grep secret-name ./private/path', null]]);

  assert.doesNotMatch(JSON.stringify(trail.receipts), /npm test|secret-name|private/);
  assert.equal(trail.shapes.length, 1);
  assert.deepEqual(
    { shape: trail.shapes[0].shape, riskCategory: trail.shapes[0].riskCategory },
    { shape: 'npm test', riskCategory: 'TOOL_CHAIN_EXECUTION' },
  );
  assert.equal(trail.shapes[0].admissionId, trail.receipts[0].admissionId);
  assert.doesNotMatch(JSON.stringify(trail.shapes), /secret-name|private/);
});

test('a log that cannot be written never changes the decision, and says so', () => {
  const failing = { append() { throw new Error('disk full'); } };
  const quiet = evaluateExternalAction(envelopeFor('npm test'), { ...GUARD_OPTIONS, receiptWriter: { append() {} } });
  const result = evaluateExternalAction(envelopeFor('npm test'), {
    ...GUARD_OPTIONS,
    receiptWriter: { append() {} },
    commandShapeWriter: failing,
  });

  assert.equal(result.decision, quiet.decision);
  assert.equal(result.commandShapeError, 'disk full');
  assert.equal('commandShapeError' in quiet, false);
});

test('nothing is logged for an admission whose receipt was never written', () => {
  const shapes = [];
  const commandShapeWriter = { append(entry) { shapes.push(entry); } };
  const failed = evaluateExternalAction(envelopeFor('npm test'), {
    ...GUARD_OPTIONS,
    receiptWriter: { append() { throw new Error('trail unavailable'); } },
    commandShapeWriter,
  });
  // No trail at all: still a review, but there is no receipt to annotate.
  const unrecorded = evaluateExternalAction(envelopeFor('npm test'), { ...GUARD_OPTIONS, commandShapeWriter });

  assert.equal(failed.receiptPersisted, false);
  assert.equal(unrecorded.decision, 'review');
  assert.equal(unrecorded.receiptPersisted, false);
  assert.deepEqual(shapes, []);
});

test('command shape stops at data and refuses composed or secret-looking commands', () => {
  assert.equal(commandShape('npx tsc --noEmit'), 'npx tsc');
  assert.equal(commandShape('npm run build'), 'npm run build');
  assert.equal(commandShape('node ./scripts/x.js'), 'node');
  assert.equal(commandShape('FOO=1 npm test'), '');
  assert.equal(commandShape('npm test && rm -rf build'), '');
  assert.equal(commandShape('mytool login sk-abcdefghijklmnopqrstu'), '');
  assert.equal(commandShape(undefined), '');
});

test('command-proposals reads both logs and never writes a policy file', () => {
  // Proposal, never application: the printed report is the whole effect.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cmd-miner-'));
  try {
    const trail = history(times(3, ['npm test', 'approved']));
    const receiptLog = path.join(dir, 'external-action-receipts.jsonl');
    writeJsonl(receiptLog, trail.receipts);
    writeJsonl(commandShapeLogPathFor(receiptLog), trail.shapes);
    const cli = spawnSync(process.execPath, [
      path.join(ROOT, 'bin', 'huqan-gate-hook.js'), 'command-proposals', '--receipt-log', receiptLog,
    ], { encoding: 'utf8', env: { ...process.env, HUQAN_EXTERNAL_GUARD_POLICY: path.join(dir, 'policy.json') } });

    assert.equal(cli.status, 0, cli.stderr);
    assert.ok(cli.stdout.endsWith('}\n'));
    const report = JSON.parse(cli.stdout);
    assert.deepEqual(report.proposals, [{ workspaceId: 'default', allowedCommands: ['npm test'] }]);
    assert.equal(report.receiptsRead, trail.receipts.length);
    assert.equal(report.shapesRead, 3);
    assert.equal(fs.existsSync(path.join(dir, 'policy.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the hook logs a reviewed command beside the trail it annotates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cmd-hook-'));
  try {
    const receiptLog = path.join(dir, 'receipts.jsonl');
    const run = (command) => spawnSync(process.execPath, [
      path.join(ROOT, 'bin', 'huqan-gate-hook.js'),
      '--profile', 'generic',
      '--workspace-root', ROOT,
      '--receipt-log', receiptLog,
      '--memory-path', path.join(dir, 'memory.json'),
      '--db-path', path.join(dir, 'memory.db'),
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      input: JSON.stringify({
        invocationId: `hook-${++invocation}`,
        agentName: 'hook-agent',
        sessionId: 'hook-session',
        toolName: 'shell',
        args: { command },
        cwd: ROOT,
        workspaceRoot: ROOT,
      }),
      // Identity is not what this pins; see external-action-hook-cli.test.js.
      env: {
        ...process.env,
        HUQAN_EXTERNAL_GUARD_REQUIRE_IDENTITY: 'allow',
        HUQAN_EXTERNAL_GUARD_REQUIRE_SIGNED_IDENTITY: 'allow',
      },
    });

    assert.equal(JSON.parse(run('npm test -- --grep x').stdout).decision, 'review');
    assert.equal(JSON.parse(run('git status').stdout).decision, 'allow');

    const logged = fs.readFileSync(commandShapeLogPathFor(receiptLog), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(logged.map((entry) => entry.shape), ['npm test']);
    assert.match(logged[0].admissionId, /^hook-\d+$/);
    assert.doesNotMatch(fs.readFileSync(receiptLog, 'utf8'), /npm test|git status/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeJsonl(file, lines) {
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'));
}
