'use strict';

/**
 * The load-bearing source facts behind
 * `docs/task-packs/p1d-audit-family-independence.md`.
 *
 * That document's verdicts are only as good as the source claims under them,
 * and a measurement written down once decays quietly: someone adds a second
 * audit write to kernel.js, or gives AgentV3 a route to the kernel chokepoint,
 * and the document keeps asserting a shape that is no longer there.
 *
 * These tests do not re-run the measurement. They pin the four claims the
 * verdicts actually rest on, so that changing the shape of the audit family
 * fails here and forces the document to be revisited rather than trusted.
 *
 * They are read-only source assertions. Nothing here routes anything, and the
 * admission ledger in test/mutation-admission-boundary.contract.test.js is
 * deliberately untouched by this file.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.join(__dirname, '..');

function readSource(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function countMatches(source, pattern) {
  return (source.match(pattern) || []).length;
}

/**
 * Source with comments removed.
 *
 * Counting calls in raw text is wrong here, and not hypothetically: `agent.v3.js`
 * documents its bypass in prose that names `kernel._appendAuditEvent()` --
 * parentheses included -- so a naive scan reads the explanation of a bypass as
 * evidence that the bypass does not exist. Only executable text may count.
 */
function readCode(relPath) {
  return readSource(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** A direct write to the sink, as opposed to a call to kernel's private wrapper. */
const DIRECT_SINK_CALL = /(?<!_)\bappendAuditEvent\s*\(/g;

test('claim 1: kernel.js reaches the audit sink exactly once', () => {
  const source = readCode('kernel.js');

  // The scan counts one sink call in kernel.js. Verdict 1 leans on that one
  // call being a chokepoint rather than one write among many, so if a second
  // direct `graph.appendAuditEvent(` appears, the chokepoint claim is wrong.
  assert.equal(
    countMatches(source, /\bgraph\.appendAuditEvent\s*\(/g),
    1,
    'a second direct sink call in kernel.js would break the chokepoint claim',
  );

  // ...and it lives inside the private wrapper, not at a business call site.
  assert.match(
    source,
    /_appendAuditEvent\(event, provenance = null, workspaceId = 'default'\) \{[\s\S]{0,400}?graph\.appendAuditEvent\(/,
    'the sole sink call must sit inside _appendAuditEvent',
  );
});

test('claim 1: the kernel chokepoint governs eight call sites', () => {
  const source = readCode('kernel.js');

  // The count is pinned rather than bounded: this is what makes routing
  // _appendAuditEvent a high-coverage change, and a drop would mean a call
  // site left the chokepoint for somewhere else.
  const callSites = countMatches(source, /this\._appendAuditEvent\s*\(/g);
  assert.equal(callSites, 8, 'kernel audit call sites reaching the chokepoint');
});

test('claim 1: kernel.v2 adds no second audit path', () => {
  const source = readCode('kernel.v2.js');

  // KernelV2 is a facade. If it grew its own audit write, the kernel family
  // would have two entries and verdict 1's arithmetic would change.
  assert.equal(countMatches(source, DIRECT_SINK_CALL), 0, 'kernel.v2.js must hold no audit sink call');
});

test('claim 1: the three other holders bypass the kernel chokepoint', () => {
  // Each writes to the graph directly. This is what makes them independent
  // entries rather than call sites of the chokepoint -- the fact verdict 1
  // ("no single entry") is built on.
  for (const relPath of [
    'agent.v3.js',
    'lib/cli-mutation-audit.js',
    'lib/mcp-ingest-execute-tool.js',
  ]) {
    const source = readCode(relPath);
    assert.ok(
      countMatches(source, DIRECT_SINK_CALL) > 0,
      `${relPath} is expected to write to the sink directly`,
    );
    assert.equal(
      countMatches(source, /\b_appendAuditEvent\s*\(/g),
      0,
      `${relPath} must not reach the kernel chokepoint, or the measurement is stale`,
    );
  }
});

test('claim 2: every unrouted audit holder swallows a failed write', () => {
  // Verdict 2 (REFUSAL_VISIBILITY_UNRESOLVED) is the reason the kernel
  // chokepoint is not routed in the same unit as the measurement. It rests on
  // the family-wide property that an audit write failure never escalates --
  // which collides with a refusal needing to be visible.
  assert.match(
    readSource('kernel.js'),
    /catch \(error\) \{\s*console\.error\('\[Kernel\] Audit log error:'[\s\S]{0,120}?return null;/,
    'kernel._appendAuditEvent must still swallow and return null',
  );
  assert.match(
    readSource('agent.v3.js'),
    /_recordBudgetAuditEvent[\s\S]{0,900}?catch \(_\) \{/,
    'AgentV3 must still swallow its audit failure',
  );
  assert.match(
    readSource('lib/cli-mutation-audit.js'),
    /return \{ auditRecorded: false, event: null, errorCode: AUDIT_WRITE_FAILED \};/,
    'the CLI writer must still report failure by return value rather than throwing',
  );
});

test('claim 2: the one routed audit caller does the opposite', () => {
  // The collision is only a collision because the routed writer throws. If it
  // ever stopped throwing, verdict 2 would need rewriting rather than merely
  // resolving.
  const { createIngestApprovalAuditWriter } = require('../lib/workbench/ingest-approval-audit-writer.js');
  const record = createIngestApprovalAuditWriter({
    graph: { appendAuditEvent: () => { throw new Error('sink must be unreachable'); } },
    admission: { admit: () => ({ admitted: false, reason: 'identity.invalid_claim' }) },
    hashResult: () => '',
  });

  assert.throws(
    () => record({ id: 'a', context: { snapshot: { workspaceId: 'default' } } }, { decision: 'approved' }),
    (error) => error.code === 'MUTATION_ADMISSION_REFUSED',
  );
});

test('claim 3: MCP and HTTP drive the same approval owner', () => {
  // Verdict 3 says the MCP audit write is a duplicate of a routed write rather
  // than a distinct one. The shared owner is what makes it a duplicate: both
  // transports call decideIngestApproval and differ only in the recordAudit
  // port they inject.
  const owner = 'workbench/ingest-approval-action';
  assert.match(readSource('lib/mcp-ingest-execute-tool.js'), new RegExp(`require\\('\\./${owner}'\\)`));
  assert.match(readSource('server.js'), new RegExp(`require\\('\\./lib/${owner}'\\)`));

  // server.js injects the routed writer; the MCP surface injects its own.
  assert.match(readSource('server.js'), /recordIngestApprovalAudit = createIngestApprovalAuditWriter\(\{/);
  assert.match(readSource('lib/mcp-ingest-execute-tool.js'), /recordAudit:[\s\S]{0,120}?recordMcpIngestApprovalAudit\(kernel/);
  assert.equal(
    countMatches(readCode('lib/mcp-ingest-execute-tool.js'), /createIngestApprovalAuditWriter/g),
    0,
    'once MCP injects the routed writer this assertion should be inverted, not deleted',
  );
});

test('claim 3: the duplicate writes the same event as the routed writer', () => {
  // If the two events differed in substance, the MCP call would be a distinct
  // write and verdict 3 would be wrong. They differ in exactly one respect --
  // workspace defaulting -- which the document states.
  const mcp = readSource('lib/mcp-ingest-execute-tool.js');
  const routed = readSource('lib/workbench/ingest-approval-audit-writer.js');

  for (const marker of [
    /eventType: receipt\.decision === 'approved' \? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED'/,
    /targetType: 'ingest_approval'/,
    /executionGuarantee: 'bounded_action_outcome'/,
    /snapshotHash: snapshot\.snapshotHash \|\| ''/,
  ]) {
    assert.match(mcp, marker, 'the MCP duplicate must still write this field');
    assert.match(routed, marker, 'the routed writer must still write this field');
  }

  // The one recorded difference: the routed writer resolves the workspace in
  // the open, the duplicate passes it through for the sink to coerce.
  assert.match(routed, /const workspaceId = snapshot\.workspaceId \|\| DEFAULT_WORKSPACE;/);
  assert.match(mcp, /\{ workspaceId: snapshot\.workspaceId \}/);
});
