'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

// One defect, five sites: a lookup table built as an object literal, indexed by
// a key that comes from data. `Object.freeze` seals the contents but leaves the
// prototype chain, so `TABLE[key]` answers `Object.prototype` names -- and it
// answers with something *truthy*, which is what makes this quiet: the `||`,
// `if (!x)` and `x ? ... : fallback` guards that were supposed to catch an
// unknown key are exactly the guards a truthy inherited value walks through.
//
// The names below are the whole population that matters. `toString` and
// `valueOf` reach a table only where the code does not lowercase-fold first;
// `constructor` and `__proto__` are already lowercase and reach every one.
// `__proto__` is the worst of the three shapes, because on the write side it
// sets the prototype instead of a key: the call reports success and stores
// nothing.
const PROTOTYPE_NAMES = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'];

test('#1270 receiptReadFailure falls back for prototype names instead of returning an inherited value', () => {
  const { receiptReadFailure, RECEIPT_READ_FAILURES } = require('../lib/http/receipt-read-failures');

  // The real rows still work.
  assert.equal(receiptReadFailure('not_found').statusCode, 404);
  assert.equal(receiptReadFailure('chain_invalid').statusCode, 409);
  // An ordinary unknown status already fell back correctly; the point is that
  // prototype names now behave the same way.
  assert.deepEqual(receiptReadFailure('nope'), RECEIPT_READ_FAILURES.invalid_request);

  for (const name of PROTOTYPE_NAMES) {
    const failure = receiptReadFailure(name);
    assert.deepEqual(
      failure,
      RECEIPT_READ_FAILURES.invalid_request,
      `${name} must fall back to the malformed-request answer`,
    );
    // The documented invariant is "never 200"; a missing statusCode breaks it
    // just as surely, because res.writeHead(undefined) throws.
    assert.equal(typeof failure.statusCode, 'number', `${name} must carry a numeric status`);
    assert.notEqual(failure.statusCode, 200);
  }
});

test('#1204 enableCapability refuses prototype names the way it refuses a typo', () => {
  const Kernel = require('../kernel');
  const kernel = new Kernel();

  const refuse = (name) => {
    assert.throws(
      () => kernel.enableCapability(name),
      (error) => error.code === 'CAPABILITY_UNKNOWN' && error.capability === name,
      `${name} must be refused as an unknown capability`,
    );
    assert.equal(kernel.hasCapability(name), false, `${name} must not be enabled`);
  };

  // A real capability still enables, and an ordinary typo is still refused --
  // the two behaviours this guard exists to separate.
  assert.equal(kernel.enableCapability('temporal'), true);
  assert.equal(kernel.hasCapability('temporal'), true);
  refuse('bogusCapability');

  for (const name of PROTOTYPE_NAMES) refuse(name);

  // `__proto__` used to return without throwing while enabling nothing. Beyond
  // the refusal, the capability bag itself must be unharmed.
  assert.equal(Object.getPrototypeOf(kernel.capabilities), Object.prototype);
  assert.equal(kernel.hasCapability('graph'), true);
});

test('#1191 finding classifier falls back to medium for prototype names', () => {
  const {
    classifyFindingKind,
    classifySeverity,
  } = require('../lib/self-healer/finding-classifier');

  // A real alias and an ordinary unknown still behave as before.
  assert.equal(typeof classifySeverity({ kind: 'bug' }), 'string');
  assert.equal(classifyFindingKind({ kind: 'notAKind' }), null);
  assert.equal(classifySeverity({ kind: 'notAKind' }), 'medium');

  for (const name of PROTOTYPE_NAMES) {
    assert.equal(classifyFindingKind({ kind: name }), null, `kind=${name} must not resolve`);
    assert.equal(classifySeverity({ kind: name }), 'medium', `kind=${name} must fall back`);
    assert.equal(
      classifySeverity({ severitySignal: name }),
      'medium',
      `severitySignal=${name} must fall back`,
    );
  }

  // The reason the fallback matters: an undefined severity sorts below 'info'
  // through SEVERITY_ORDER.indexOf, so an unclassifiable finding would have
  // ranked as less urgent than the least urgent real one.
  const SEVERITY_ORDER = ['info', 'low', 'medium', 'high', 'critical'];
  for (const name of PROTOTYPE_NAMES) {
    assert.ok(SEVERITY_ORDER.indexOf(classifySeverity({ kind: name })) > 0);
  }
});

test('#1323 toCanonicalVerdict fails closed on prototype names', () => {
  const {
    toCanonicalVerdict,
    fromAdmissionDecision,
    serializeVerdict,
  } = require('../lib/verdict/action-verdict');

  // The mapping itself is untouched.
  assert.equal(toCanonicalVerdict('admission', 'allow'), 'allow');
  assert.equal(toCanonicalVerdict('admission', 'reject'), 'block');
  assert.throws(
    () => toCanonicalVerdict('admission', 'nonsense'),
    (error) => error.code === 'UNKNOWN_VERDICT_SOURCE',
  );

  for (const name of PROTOTYPE_NAMES) {
    assert.throws(
      () => toCanonicalVerdict('admission', name),
      (error) => error.code === 'UNKNOWN_VERDICT_SOURCE',
      `admission/${name} must refuse to guess a verdict`,
    );
    assert.throws(
      () => toCanonicalVerdict('mcp', name),
      (error) => error.code === 'UNKNOWN_VERDICT_SOURCE',
      `mcp/${name} must refuse to guess a verdict`,
    );
  }

  // The end-to-end shape that made this worth fixing: the envelope used to be
  // built and frozen with a function in `verdict`, and serializing it dropped
  // the field, leaving a record that looks well-formed and carries no verdict.
  for (const name of PROTOTYPE_NAMES) {
    assert.throws(
      () => fromAdmissionDecision({ decision: name, reason: 'r', workspaceId: 'w1' }),
      (error) => error.code === 'UNKNOWN_VERDICT_SOURCE',
    );
  }

  const envelope = fromAdmissionDecision({ decision: 'reject', reason: 'r', workspaceId: 'w1' });
  assert.equal(envelope.verdict, 'block');
  assert.equal(JSON.parse(JSON.stringify(serializeVerdict(envelope))).verdict, 'block');
});

test('#1275 workspace-sync records prototype-named goals instead of inventing a block', () => {
  const workspaceSync = require('../plugins/workspace-sync');
  const { recordRun } = workspaceSync._test;

  for (const name of PROTOTYPE_NAMES) {
    const kernel = {};

    // First run of this goal: there is no previous workspace, so there is no
    // crossing to evaluate and no decision to report.
    assert.equal(
      recordRun(kernel, { goal: name, workspaceId: 'tenant-a' }),
      null,
      `first run of goal=${name} must not produce a cross-workspace decision`,
    );

    // The run must actually be recorded -- `__proto__` used to write the
    // prototype instead of a key and lose the entry silently.
    const stored = kernel._workspaceSyncState.byGoal[name];
    assert.equal(stored && stored.workspaceId, 'tenant-a', `goal=${name} must be recorded`);

    // The operator-visible surface: a fabricated decision used to be written
    // into the plugin's own log (and telemetry) as a real AB11 block.
    assert.deepEqual(
      workspaceSync.run(kernel, { action: 'log' }).log,
      [],
      `first run of goal=${name} must log no crossing`,
    );
    assert.equal(workspaceSync.run(kernel, { action: 'bygoal' }).byGoal[name].workspaceId, 'tenant-a');

    // And a genuine crossing must still be caught for that same goal.
    const decision = recordRun(kernel, { goal: name, workspaceId: 'tenant-b' });
    assert.ok(decision, `a real crossing for goal=${name} must still be evaluated`);
    assert.equal(decision.actorWorkspaceId, 'tenant-a');
    assert.equal(decision.targetWorkspaceId, 'tenant-b');
  }
});

test('#1275 a prototype-named goal does not poison later unrelated goals', () => {
  const workspaceSync = require('../plugins/workspace-sync');
  const { recordRun } = workspaceSync._test;
  const kernel = {};

  recordRun(kernel, { goal: '__proto__', workspaceId: 'tenant-a' });

  // These names are own properties of the entry object that `__proto__` used to
  // install as the prototype, so afterwards every one of them read as a prior
  // run and produced a fabricated AB11 decision on its first use.
  for (const goal of ['goal', 'workspaceId', 'runAt']) {
    assert.equal(
      recordRun(kernel, { goal, workspaceId: 'tenant-b' }),
      null,
      `first run of goal=${goal} must not inherit a previous run`,
    );
  }
});
