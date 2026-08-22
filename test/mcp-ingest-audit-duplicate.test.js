'use strict';

/**
 * Evidence that the MCP ingest audit duplicate is gone and nothing else moved.
 *
 * `docs/task-packs/p1d-audit-family-independence.md` verdict 3 said the MCP
 * ingest audit write was not a distinct write at all: HTTP and MCP drive the
 * same approval owner through an injected `recordAudit` port, and MCP was
 * injecting its own copy of the writer `server.js` had already routed.
 *
 * A change like that is easy to *assert* has preserved behaviour. These tests
 * exist because asserting it is not the same as showing it, so each one proves
 * a specific claim from source or by execution:
 *
 *   1. MCP now injects the routed writer;
 *   2. the inline writer is gone, not merely unused;
 *   3. the event payload is field-for-field what it was;
 *   4. the workspace fallback resolves to the same value it resolved to;
 *   5. the audit-failure -> AUDIT_EVIDENCE_MISSING relationship is unchanged;
 *   6. the admission ledger moves the way a deletion moves it, not the way a
 *      routing moves it.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { decideMcpIngestApproval } = require('../lib/mcp-ingest-execute-tool.js');
const { recordAuditEvidence, auditOrGap } = require('../lib/workbench/ingest-approval-audit.js');
const { absent, createMutationAdmission } = require('../lib/mutation-admission.js');
const { createIngestApprovalAuditWriter } = require('../lib/workbench/ingest-approval-audit-writer.js');
const { sha256 } = require('../lib/ingest.js');

const REPO_ROOT = path.join(__dirname, '..');
const MCP_TOOL = 'lib/mcp-ingest-execute-tool.js';

function readSource(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

// --- 1 & 2: the writer actually changed hands -------------------------------

test('1: the MCP surface builds the routed writer', () => {
  const source = readSource(MCP_TOOL);

  assert.match(source, /require\('\.\/workbench\/ingest-approval-audit-writer'\)/);
  assert.match(source, /createIngestApprovalAuditWriter\(\{/);
  // Built with the same three dependencies server.js builds it with. The
  // admission seam is the one that matters: it is what MCP was missing.
  // Since #1009 the seam cannot be constructed without declaring whether it
  // enforces identity, so what is pinned here is the declaration, not a bare call.
  assert.match(source, /admission: createMutationAdmission\(\{\s*\n\s*identityEvaluator: absent\(/);
  assert.match(source, /hashResult: sha256/);
  assert.match(source, /recordAudit: runtime\.recordIngestApprovalAudit \|\| defaultIngestApprovalAuditWriter\(kernel(?:, runtime\.trustEvidenceLedger \|\| null)?\)/);
});

test('2: the inline duplicate is deleted, not merely bypassed', () => {
  const source = readSource(MCP_TOOL);

  // A writer left in place but no longer wired would still be a second
  // implementation for someone to reach for later, and the sink-call ledger
  // would not move. It has to be gone.
  assert.equal(source.includes('recordMcpIngestApprovalAudit'), false);
  assert.equal(
    (source.match(/\.appendAuditEvent\s*\(/g) || []).length,
    0,
    'the MCP surface must hold no direct audit sink call',
  );
});

test('2: the injection point still exists for tests and callers', () => {
  // The change must not remove the seam's own override -- runtime.recordIngestApprovalAudit
  // is how this path is testable at all, and how a caller supplies a different
  // writer. Only the *default* changed.
  assert.match(readSource(MCP_TOOL), /runtime\.recordIngestApprovalAudit \|\|/);
});

// --- 3 & 4: the write itself is unchanged -----------------------------------

const APPROVAL = Object.freeze({
  id: 'approval-77',
  context: { snapshot: { workspaceId: 'ws-a', snapshotHash: 'snap-77' } },
});
const RECEIPT = Object.freeze({ decision: 'approved', actionOutcome: 'applied', receiptId: 'r-1' });
const RESULT = Object.freeze({ evidence: ['e1'] });

function captureWrite(approval, receipt, result) {
  const writes = [];
  const graph = {
    appendAuditEvent(event, opts) { writes.push({ event, opts }); return { auditId: 'audit-x' }; },
  };
  const record = createIngestApprovalAuditWriter({
    graph, admission: createMutationAdmission({ identityEvaluator: absent('test seam: this case exercises admission, not identity enforcement') }), hashResult: sha256,
  });
  record(approval, receipt, result);
  return writes[0];
}

/**
 * The event the deleted inline writer produced, reproduced here from the
 * source it was deleted from.
 *
 * This is the only honest way to compare against something that no longer
 * exists: state its output explicitly, so that "the payload is preserved" is a
 * comparison rather than a memory. Kept deliberately literal.
 */
function eventTheDeletedWriterProduced(approval, receipt, result) {
  const snapshot = approval.context?.snapshot || {};
  return {
    event: {
      eventType: receipt.decision === 'approved' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
      targetType: 'ingest_approval',
      targetId: approval.id,
      details: {
        receipt,
        snapshotHash: snapshot.snapshotHash || '',
        pluginResultRef: result ? sha256(result) : '',
        actionOutcome: receipt.actionOutcome || '',
        executionGuarantee: 'bounded_action_outcome',
      },
    },
    opts: { workspaceId: snapshot.workspaceId },
  };
}

test('3: the routed writer emits the deleted writer\'s event, field for field', () => {
  const actual = captureWrite(APPROVAL, RECEIPT, RESULT);
  const expected = eventTheDeletedWriterProduced(APPROVAL, RECEIPT, RESULT);

  assert.deepEqual(actual.event, expected.event);
  assert.deepEqual(actual.opts, expected.opts);
});

test('3: the rejected decision derives the same event type', () => {
  const receipt = { decision: 'rejected', actionOutcome: 'blocked' };
  assert.equal(
    captureWrite(APPROVAL, receipt, null).event.eventType,
    eventTheDeletedWriterProduced(APPROVAL, receipt, null).event.eventType,
  );
  // And the unhashed-result case stays an empty string rather than a hash of null.
  assert.equal(captureWrite(APPROVAL, receipt, null).event.details.pluginResultRef, '');
});

test('4: a missing workspace stores the same value it stored before', () => {
  // This is the one place the two writers genuinely differ, so it is the one
  // place the claim "same behaviour" has to be proved rather than asserted.
  //
  // The deleted writer passed `{ workspaceId: undefined }` down and let the
  // sink decide; the routed writer resolves it to 'default' in the open. The
  // behaviour is preserved only if the sink's decision was the same value --
  // so the sink's own normalizer is what settles it.
  const { normalizeAuditEvent } = require('../lib/audit-log.js');
  const bare = { id: 'approval-78', context: { snapshot: { snapshotHash: 'h' } } };

  const asStoredBefore = normalizeAuditEvent(
    eventTheDeletedWriterProduced(bare, RECEIPT, null).event,
    { workspaceId: undefined },
  );
  const asStoredNow = normalizeAuditEvent(
    captureWrite(bare, RECEIPT, null).event,
    captureWrite(bare, RECEIPT, null).opts,
  );

  assert.equal(asStoredBefore.workspaceId, 'default');
  assert.equal(asStoredNow.workspaceId, 'default');
  assert.equal(asStoredNow.workspaceId, asStoredBefore.workspaceId);

  // The difference that remains is where the decision is taken, which is the
  // point of routing it: the writer now names the workspace it admitted under.
  assert.deepEqual(captureWrite(bare, RECEIPT, null).opts, { workspaceId: 'default' });
});

// --- 5: the failure relationship ---------------------------------------------

test('5: a refused audit write becomes AUDIT_EVIDENCE_MISSING, as a failed one did', () => {
  // The routed writer throws where the inline one did not, so this is the
  // behavioural question the change actually raises. It is answered by
  // machinery this unit does not modify.
  const refusing = createIngestApprovalAuditWriter({
    graph: { appendAuditEvent: () => { throw new Error('sink must be unreachable'); } },
    admission: { admit: () => ({ admitted: false, reason: 'identity.invalid_claim' }) },
    hashResult: sha256,
  });

  const refused = recordAuditEvidence(refusing, APPROVAL, RECEIPT, null);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'audit_append_failed');

  // An ordinary write failure produced exactly this reason before the change,
  // so a refusal is not given a new meaning -- it joins the existing one.
  const failing = () => { throw new Error('sink down'); };
  assert.equal(recordAuditEvidence(failing, APPROVAL, RECEIPT, null).reason, 'audit_append_failed');

  const { gap } = auditOrGap(refusing, {
    approval: APPROVAL, receipt: RECEIPT, result: null, committed: true, message: 'm',
  });
  assert.equal(gap.status, 409);
  assert.equal(gap.json.error.code, 'AUDIT_EVIDENCE_MISSING');
  assert.equal(gap.json.reconciliation.retry, false);
});

test('5: the MCP surface reports that gap without retry, end to end', async () => {
  // The full path, not a unit of it: a refusing writer injected through the
  // same port, driven through decideMcpIngestApproval.
  // A real snapshot, built by the same function the ingest path builds it with.
  // A hand-written one fails integrity verification long before the audit write,
  // which would make this test pass for the wrong reason.
  const { buildIngestApprovalSnapshot } = require('../lib/ingest.js');
  // No workspace override: this ingest surface binds the canonical `default`
  // workspace only and refuses anything else with INGEST_WORKSPACE_UNSUPPORTED,
  // which is why the workspace fallback measured above is the one that matters
  // in production here.
  const snapshot = buildIngestApprovalSnapshot({ sourceType: 'manual', text: 'audit refusal path' });
  assert.equal(snapshot.ok, true, 'the fixture snapshot must be a real one');

  const approvalRecord = {
    id: APPROVAL.id, tool: 'http.ingest', status: 'pending', decision: null,
    context: { snapshot }, args: {},
  };
  const store = {
    claimToolApprovalWithLease: () => ({ approval: approvalRecord, claimed: true }),
    renewToolApprovalLease: () => true,
    getToolApprovalById: () => approvalRecord,
    failToolApproval: () => {},
    finalizeToolApprovalWithReceipt: () => ({
      finalized: true, approval: { ...approvalRecord, status: 'rejected', decision: 'rejected' },
    }),
  };

  const failures = [];
  const outcome = await decideMcpIngestApproval({
    kernel: { graph: {} },
    approvalStore: store,
    approvalId: APPROVAL.id,
    decision: 'rejected',
    runtime: {
      recordIngestApprovalAudit: () => { throw new Error('refused'); },
      ensureRuntime: () => {},
    },
    fail: (code, message, extra) => { failures.push({ code, message, extra }); return { ok: false, code, extra }; },
  });

  assert.equal(outcome.ok, false);
  assert.equal(failures.length, 1);

  // Not AUDIT_EVIDENCE_MISSING -- and this test asserts what the code does
  // rather than what the change was hoped to achieve.
  //
  // `auditEvidenceGap` returns `{ status, json: { error } }`; `apiError`
  // returns `{ status, error }`; `approvalFailure` reads `response.error`,
  // which the gap shape does not have. So the reconciliation code is flattened
  // to the generic one on this surface. Over HTTP it survives, because
  // server.js writes `outcome.json` as the 409 body.
  //
  // Pinned deliberately: the discrepancy is pre-existing (see the test below,
  // which measures it against the pre-change behaviour) and out of scope for a
  // duplicate deletion, but a silent assertion of the *intended* code would
  // have hidden it.
  assert.equal(failures[0].code, 'APPROVAL_EXECUTION_FAILED');

  // What does hold, and is the part that matters for safety: the caller is
  // told not to retry, so an approved ingest is not re-run into a duplicate
  // write on the strength of a missing audit line.
  assert.equal(failures[0].extra.retrySafe, false);
});

test('5: an admission refusal is reported exactly as a write failure was', () => {
  // The proof that the relationship is *unchanged* rather than merely defined:
  // the old inline writer could not be refused, but it could fail, and a
  // failure took this same route. If a refusal and a failure produce the same
  // bounded reason, then routing this caller added no new outcome for any
  // caller downstream to handle.
  const refused = recordAuditEvidence(
    createIngestApprovalAuditWriter({
      graph: { appendAuditEvent: () => { throw new Error('unreachable'); } },
      admission: { admit: () => ({ admitted: false, reason: 'identity.invalid_claim' }) },
      hashResult: sha256,
    }),
    APPROVAL, RECEIPT, null,
  );
  const failed = recordAuditEvidence(() => { throw new Error('sink down'); }, APPROVAL, RECEIPT, null);

  assert.deepEqual(refused, failed);

  // A third outcome that predates the change and still behaves the same: a
  // write that returns without an auditId is the same gap as a throw.
  assert.equal(
    recordAuditEvidence(() => ({}), APPROVAL, RECEIPT, null).reason,
    'audit_reference_missing',
  );
});

// --- 6: what the ledger does -------------------------------------------------

test('6: this is a deletion, so the total falls rather than shifting', () => {
  // Every routing step so far moved a call from UNROUTED to ROUTED and left
  // the total at 45. This one does not, and the difference is the finding:
  // the call was a duplicate of an already-routed write, so removing it
  // removes a sink call outright.
  //
  // Pinned here as well as in the ledger so that the *shape* of the change is
  // recorded next to its reasoning, and a later reader does not read the
  // dropped total as an accounting slip.
  const ledger = readSource('test/mutation-admission-boundary.contract.test.js');

  // Scoped to the ledger object rather than the whole file: the surrounding
  // prose names this module deliberately, to explain why the total fell. Only
  // a *baseline entry* would mean the sink call is still there.
  const unroutedLedger = ledger.slice(
    ledger.indexOf('const UNROUTED_SINK_CALLS'),
    ledger.indexOf('const ROUTED_SINK_CALLS'),
  );
  assert.ok(unroutedLedger.length > 0);
  assert.equal(unroutedLedger.includes(MCP_TOOL), false, 'the MCP surface must leave the unrouted ledger');
  assert.match(ledger, /assert\.equal\(unrouted, 22,/);
  // K2 (#328): a later routing step delegated the background edge commit to
  // lib/background-provenance.js as a *new* ledgered entry -- routed rose
  // 24->26 and the total 46->48. DEL then added one routed audit append inside
  // its Graph.runMutationOnce transition callback, producing 27/49. This is
  // the opposite of a deletion, which is exactly why this test pins the routed
  // and total numbers and not the difference between them: each shape has its
  // own finding.
  assert.match(ledger, /assert\.equal\(routed, 27,/);
  assert.match(ledger, /assert\.equal\(unrouted \+ routed, 49,/);
});
