'use strict';

/**
 * The source facts behind ADR-012's classification.
 *
 * ADR-012 asks how a failure to produce audit evidence should affect the
 * admission decision, and answers it by *position*: whether the audit write
 * happens before the mutation (where a failure can still prevent it) or after
 * (where it cannot, and refusing would only hide a completed write).
 *
 * That classification is the whole basis of the decision, so it must not be a
 * reading someone did once. These tests pin it. They deliberately assert
 * **what the code does today**, including the three places ADR-012 identifies
 * as inconsistent -- a test that asserted the proposed contract instead would
 * fail before the decision was taken and would quietly pressure the outcome.
 *
 * When ADR-012 is accepted, the expectations below change with the code, and
 * the diff shows exactly which behaviours the decision altered.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.join(__dirname, '..');

function readSource(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

// --- finding 1: the contract that already exists ----------------------------

test('the CLI gate blocks a mutation whose pre-write audit failed', () => {
  const { evaluateCliMutationGate } = require('../lib/cli-mutation-gate.js');

  // A kernel with no audit seam is an unavailable sink, not an exemption.
  const outcome = evaluateCliMutationGate({ kernel: {}, command: 'kaydet', args: [] });

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.canExecute, false);
  assert.equal(outcome.metadata.auditRecorded, false);
});

test('the CLI gate allows the same command when the audit is written', () => {
  // The contrast matters: the block above is caused by the audit failure, not
  // by the command being inadmissible.
  const { evaluateCliMutationGate } = require('../lib/cli-mutation-gate.js');
  const kernel = { recordCliMutationAudit: () => ({ auditRecorded: true, event: { auditId: 'a' } }) };

  const outcome = evaluateCliMutationGate({ kernel, command: 'kaydet', args: [] });

  assert.equal(outcome.allowed, true);
  assert.equal(outcome.metadata.auditRecorded, true);
});

test('a read-only command stays usable when the audit sink is down', () => {
  // Blocking on audit failure must not become "the CLI stops working when the
  // sink is down". Commands with nothing to audit are not gated.
  const { evaluateCliMutationGate } = require('../lib/cli-mutation-gate.js');

  const outcome = evaluateCliMutationGate({ kernel: {}, command: 'ruya', args: [] });

  assert.equal(outcome.allowed, true);
});

test('the post-mutation CLI audit reports rather than blocks', () => {
  // The other half of the contract, and the reason position is the axis: the
  // state change already happened, so refusing here would only hide it.
  assert.match(
    readSource('cli.js'),
    /_commitCliMutation\(command, classification = null\) \{[\s\S]{0,300}?auditRecorded \? '' : `\\nUyari:/,
    'a failed commit audit must degrade to a warning, not a refusal',
  );
});

// --- finding 2: the classification ------------------------------------------

/**
 * Every audit write in the family, by position, with what it does on failure.
 *
 * `pre` includes writes that record a *refusal*: no mutation has happened and
 * none will, so a failed write there still loses evidence that a security
 * decision was taken.
 */
const CLASSIFICATION = Object.freeze([
  { site: 'lib/cli-mutation-gate.js', position: 'pre', onFailure: 'blocks', consistent: true },
  { site: 'cli.js', position: 'post', onFailure: 'reports', consistent: true },
  { site: 'agent.v3.js', position: 'pre', onFailure: 'swallows', consistent: false },
  { site: 'lib/workbench/ingest-approval-audit-writer.js', position: 'post', onFailure: 'surfaces', consistent: true },
  { site: 'kernel.js:pre', position: 'pre', onFailure: 'swallows', consistent: false },
  { site: 'kernel.js:post', position: 'post', onFailure: 'swallows', consistent: false },
]);

test('the kernel chokepoint straddles both positions', () => {
  // This is ADR-012's load-bearing finding: _appendAuditEvent is not one
  // contract behind one method, it is two. Routing it as a single unit would
  // impose one error contract on both halves, and either choice is wrong for
  // one of them.
  const source = readSource('kernel.js');

  // Post-mutation: the audit follows a completed graph write on the same path.
  // The window has to tolerate a gap -- the derived-edge site writes through
  // `if (edge) { written++; ... }` before auditing -- while refusing to jump
  // over an intervening sink call or audit call, which would let a pre-mutation
  // site be miscounted as post-mutation by proximity alone.
  const postMutation = source.match(
    /this\.graph\.add(?:Node|Edge)\([^;]*\);(?:(?!_appendAuditEvent|graph\.add)[\s\S]){0,200}?this\._appendAuditEvent\(/g,
  ) || [];
  assert.equal(postMutation.length, 3, 'post-mutation kernel audit sites');

  // Pre-mutation: the remainder record a refusal or a rejection.
  const total = (source.match(/this\._appendAuditEvent\s*\(/g) || []).length;
  assert.equal(total, 8, 'total kernel audit call sites');
  assert.equal(total - postMutation.length, 5, 'pre-mutation kernel audit sites');
});

test('the kernel swallows failures at both positions today', () => {
  // Recorded as the current state, not endorsed. Under ADR-012's recommendation
  // the pre sites would block and the post sites would report; both are
  // decisions to be taken, so this test asserts what is, and will change with
  // the code when it is.
  assert.match(
    readSource('kernel.js'),
    /_appendAuditEvent\([\s\S]{0,400}?catch \(error\) \{[\s\S]{0,120}?return null;/,
    'the chokepoint still swallows, at both positions',
  );
});

test('agent.v3 is the one pre-mutation write that does not block', () => {
  const source = readSource('agent.v3.js');

  // The audit records an AB10 refusal. It is a pre-mutation position by
  // ADR-012's test, and it swallows -- the inconsistency the ADR names.
  assert.match(source, /_recordBudgetAuditEvent[\s\S]{0,900}?catch \(_\) \{/);

  // What is lost is the evidence of a refusal, not the refusal. Stated as a
  // test so the ADR's "bounded, not alarming" claim is checkable: the refusal
  // is returned to the caller independently of the audit write succeeding.
  assert.match(source, /this\._recordBudgetAuditEvent\(goal, workspaceId, budgetCheck\);\s*return/);
});

test('the ingest writer is the only post-mutation write that surfaces the gap', () => {
  // The existence proof for option B1: a post-mutation failure can be turned
  // into a bounded reconciliation state instead of a log line.
  const { auditEvidenceGap } = require('../lib/workbench/ingest-approval-audit.js');

  const gap = auditEvidenceGap({
    approval: { id: 'a' }, receipt: { receiptId: 'r', decision: 'approved' },
    committed: true, reason: 'audit_append_failed', message: 'm',
  });

  assert.equal(gap.status, 409);
  assert.equal(gap.json.error.code, 'AUDIT_EVIDENCE_MISSING');
  // Not retryable: re-running an approved ingest risks a duplicate write.
  assert.equal(gap.json.reconciliation.retry, false);
  // The identifiers exist so the gap can be reconciled by hand rather than
  // merely noticed.
  assert.equal(gap.json.reconciliation.approvalId, 'a');
  assert.equal(gap.json.reconciliation.receiptId, 'r');
});

test('the classification covers every holder ADR-012 scopes', () => {
  // A guard against the table going stale by omission rather than by error.
  const inconsistent = CLASSIFICATION.filter((row) => !row.consistent).map((row) => row.site);

  assert.deepEqual(inconsistent, ['agent.v3.js', 'kernel.js:pre', 'kernel.js:post']);
  assert.equal(CLASSIFICATION.filter((row) => row.position === 'pre').length, 3);
  assert.equal(CLASSIFICATION.filter((row) => row.position === 'post').length, 3);

  const adr = readSource('docs/adr/ADR-012-audit-evidence-and-admission.md');
  for (const row of CLASSIFICATION) {
    const file = row.site.split(':')[0];
    assert.ok(adr.includes(file), `ADR-012 must name ${file}`);
  }
  // The decision must still be open: an accepted ADR changes these tests too.
  assert.match(adr, /\*\*Draft — decision not taken\.\*\*/);
});
