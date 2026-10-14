'use strict';

// P6 detection (ADR-016): local approvals and execution receipts joined
// against the authority ledger -- `huqan audit --authority` data comparison,
// the paged ledger reader, and the outcome receipt binding apply records.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { canonicalActionHash } = require('../lib/mcp-operator-capability');
const { createAuthorityState, openAuthorityState } = require('../lib/authority/state-store');
const { openLedgerStore } = require('../lib/authority/ledger-store');
const { createAuthorityService } = require('../lib/authority/authority-service');
const { createAuthorityServer } = require('../lib/authority/http-server');
const { createAuthorityClient, AuthorityError } = require('../lib/authority/authority-client');
const { parseAuthorityPin } = require('../lib/authority/authority-pin');
const { keyIdFor } = require('../lib/authority/decision-envelope');
const { buildAuthoritySection, expectedReceiptHash, stableStringify, sha256Hex } = require('../lib/cli-audit');
const { auditCommand } = require('../lib/cli-approval-commands');
const { apply } = require('../bin/huqan-authority');

const ARGS = Object.freeze({ text: 'detection probe' });
const WS = 'default';

function actionHash(approvalId, args = ARGS) {
  return canonicalActionHash({ tool: 'huqan.learn', workspaceId: WS, approvalId, arguments: args });
}

function rawRow(overrides = {}) {
  return {
    id: 'apr_1', tool: 'huqan.learn', input: JSON.stringify(ARGS),
    workspace_id: WS, status: 'approved', decision: 'approved',
    created_at: Date.now(), updated_at: Date.now(),
    context: { workspaceId: WS, args: { ...ARGS } },
    ...overrides,
  };
}

function stubStore(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  return {
    listDecidedToolApprovals: () => list,
    listUnresolvedToolApprovals: () => [],
  };
}

function ledgerOf(pairs) {
  // pairs: [{ type, body }] -> entries shaped like the service's ledger page.
  return pairs.map(({ type, body }, i) => ({ seq: i, type, at: new Date().toISOString(), body, receiptHash: `h${i}` }));
}

test('expectedReceiptHash prefers a carried hash and otherwise hashes canonically', () => {
  assert.equal(expectedReceiptHash({ receiptId: 'r', receiptHash: 'a'.repeat(64) }), 'a'.repeat(64));
  const receipt = { receiptId: 'r1', workspaceId: WS, b: 2, a: 1 };
  assert.equal(expectedReceiptHash(receipt), sha256Hex(stableStringify(receipt)));
  assert.equal(expectedReceiptHash({ receiptId: 'r1', receiptHash: 'nope' }), sha256Hex(stableStringify({ receiptId: 'r1', receiptHash: 'nope' })));
  assert.equal(expectedReceiptHash(null), null);
  assert.equal(expectedReceiptHash({}), null);
});

test('a clean authority view passes with no findings', () => {
  const receipt = { receiptId: 'r-1', workspaceId: WS };
  const row = rawRow({ context: { workspaceId: WS, args: { ...ARGS }, executionRefs: { receiptId: 'r-1' } } });
  const hash = actionHash('apr_1');
  const entries = ledgerOf([
    { type: 'approval.decided', body: { approvalId: 'apr_1', actionHash: hash, decision: 'approved' } },
    { type: 'approval.consumed', body: { approvalId: 'apr_1', actionHash: hash } },
    { type: 'approval.outcome', body: { approvalId: 'apr_1', status: 'executed', receiptId: 'r-1', receiptHash: expectedReceiptHash(receipt) } },
  ]);
  const section = buildAuthoritySection({ workspaceId: WS,
    getApprovalStore: () => stubStore(row),
    ledger: { mode: 'service', entries, corrupt: false, receipts: { 'r-1': receipt } } });
  assert.equal(section.status, 'pass');
  assert.deepEqual(section.evidence.findings, []);
});

test('an approved row with no ledger consumption is reported, never silent', () => {
  const section = buildAuthoritySection({ workspaceId: WS,
    getApprovalStore: () => stubStore(rawRow()),
    ledger: { mode: 'service', entries: [], corrupt: false } });
  assert.equal(section.status, 'fail');
  assert.deepEqual(section.evidence.findings.map(f => f.code), ['EXECUTED_WITHOUT_AUTHORITY']);
});

test('a tampered local action is reported as a hash mismatch', () => {
  const ledgerHash = actionHash('apr_1', { text: 'original' });
  const row = rawRow({ context: { workspaceId: WS, args: { text: 'edited' } } });
  const entries = ledgerOf([
    { type: 'approval.decided', body: { approvalId: 'apr_1', actionHash: ledgerHash, decision: 'approved' } },
    { type: 'approval.consumed', body: { approvalId: 'apr_1', actionHash: ledgerHash } },
  ]);
  const section = buildAuthoritySection({ workspaceId: WS,
    getApprovalStore: () => stubStore(row),
    ledger: { mode: 'service', entries, corrupt: false } });
  assert.ok(section.evidence.findings.some(f => f.code === 'ACTION_HASH_MISMATCH'));
  assert.equal(section.status, 'fail');
});

test('a missing outcome and a forged receipt are both reported', () => {
  const hash = actionHash('apr_1');
  const base = [
    { type: 'approval.decided', body: { approvalId: 'apr_1', actionHash: hash, decision: 'approved' } },
    { type: 'approval.consumed', body: { approvalId: 'apr_1', actionHash: hash } },
  ];
  const row = rawRow({ context: { workspaceId: WS, args: { ...ARGS }, executionRefs: { receiptId: 'r-1' } } });
  const missing = buildAuthoritySection({ workspaceId: WS,
    getApprovalStore: () => stubStore(row),
    ledger: { mode: 'service', entries: ledgerOf(base), corrupt: false, receipts: {} } });
  assert.ok(missing.evidence.findings.some(f => f.code === 'OUTCOME_MISSING'));

  const forged = buildAuthoritySection({ workspaceId: WS,
    getApprovalStore: () => stubStore(row),
    ledger: { mode: 'service', entries: ledgerOf([...base,
      { type: 'approval.outcome', body: { approvalId: 'apr_1', status: 'executed', receiptId: 'r-1', receiptHash: 'b'.repeat(64) } }]), corrupt: false,
      receipts: { 'r-1': { receiptId: 'r-1', workspaceId: WS, other: 'real' } } } });
  assert.ok(forged.evidence.findings.some(f => f.code === 'RECEIPT_HASH_MISMATCH'));
});

test('ledger consumptions with no local row and a corrupt ledger are reported', () => {
  const hash = actionHash('ghost');
  const unknown = buildAuthoritySection({ workspaceId: WS,
    getApprovalStore: () => stubStore([]),
    ledger: { mode: 'service', entries: ledgerOf([{ type: 'approval.consumed', body: { approvalId: 'ghost', actionHash: hash } }]), corrupt: false } });
  assert.ok(unknown.evidence.findings.some(f => f.code === 'CONSUMED_UNKNOWN_LOCALLY'));

  const corrupt = buildAuthoritySection({ workspaceId: WS,
    getApprovalStore: () => stubStore([]),
    ledger: { mode: 'service', entries: [], corrupt: true } });
  assert.equal(corrupt.status, 'fail');
  assert.ok(corrupt.evidence.findings.some(f => f.code === 'LEDGER_CORRUPT'));
});

test('outside service mode detection degrades to an informational note', () => {
  for (const ledger of [{ mode: 'legacy', reason: 'no_pin', entries: [], corrupt: false },
    { mode: 'required_unavailable', reason: 'install_path_untrusted', entries: [], corrupt: false }]) {
    const section = buildAuthoritySection({ workspaceId: WS,
      getApprovalStore: () => stubStore(rawRow()), ledger });
    assert.equal(section.status, 'info');
    assert.deepEqual(section.evidence.findings, []);
  }
});

test('an authority that cannot be reached is reported, not thrown', () => {
  const section = buildAuthoritySection({ workspaceId: WS,
    getApprovalStore: () => stubStore(rawRow()),
    ledger: { mode: 'service', entries: [], corrupt: false, error: 'AUTHORITY_UNAVAILABLE', receipts: {} } });
  assert.equal(section.status, 'fail');
  assert.ok(section.evidence.findings.some(f => f.code === 'AUTHORITY_UNAVAILABLE'));
});

test('without a local store there is nothing to join, and that is reported', () => {
  const section = buildAuthoritySection({ workspaceId: WS,
    getApprovalStore: () => null,
    ledger: { mode: 'service', entries: [], corrupt: false, receipts: {} } });
  assert.equal(section.status, 'pass');
  assert.equal(section.evidence.localRowsCompared, 0);
  const throwing = buildAuthoritySection({ workspaceId: WS,
    getApprovalStore: () => { throw new Error('store down'); },
    ledger: { mode: 'service', entries: [], corrupt: false, receipts: {} } });
  assert.equal(throwing.status, 'pass');
});

test('an executing row is hash-checked but owes no outcome yet', () => {
  const hash = actionHash('apr_1');
  const row = rawRow({ status: 'executing', decision: 'approved' });
  const section = buildAuthoritySection({ workspaceId: WS,
    getApprovalStore: () => stubStore(row),
    ledger: { mode: 'service', entries: ledgerOf([
      { type: 'approval.decided', body: { approvalId: 'apr_1', actionHash: hash, decision: 'approved' } },
      { type: 'approval.consumed', body: { approvalId: 'apr_1', actionHash: hash } },
    ]), corrupt: false, receipts: {} } });
  assert.ok(!section.evidence.findings.some(f => f.code === 'OUTCOME_MISSING'), JSON.stringify(section.evidence.findings));
  assert.ok(!section.evidence.findings.some(f => f.code === 'EXECUTED_WITHOUT_AUTHORITY'));
});

test('a swapped execution receipt is reported by id', () => {
  const hash = actionHash('apr_1');
  const row = rawRow({ context: { workspaceId: WS, args: { ...ARGS }, executionRefs: { receiptId: 'r-local' } } });
  const section = buildAuthoritySection({ workspaceId: WS,
    getApprovalStore: () => stubStore(row),
    ledger: { mode: 'service', entries: ledgerOf([
      { type: 'approval.decided', body: { approvalId: 'apr_1', actionHash: hash, decision: 'approved' } },
      { type: 'approval.consumed', body: { approvalId: 'apr_1', actionHash: hash } },
      { type: 'approval.outcome', body: { approvalId: 'apr_1', status: 'executed', receiptId: 'r-other' } },
    ]), corrupt: false, receipts: {} } });
  assert.ok(section.evidence.findings.some(f => f.code === 'RECEIPT_ID_MISMATCH'));
});

test('a truncated ledger view passes with an informational note when clean', () => {
  const section = buildAuthoritySection({ workspaceId: WS,
    getApprovalStore: () => stubStore([]),
    ledger: { mode: 'service', entries: [], corrupt: false, truncated: true, receipts: {} } });
  assert.equal(section.status, 'info');
  assert.equal(section.evidence.truncated, true);
});

test('a store that throws still yields a report, not an exception', () => {
  const section = buildAuthoritySection({ workspaceId: WS,
    getApprovalStore: () => ({ listDecidedToolApprovals: () => { throw new Error('down'); },
      listUnresolvedToolApprovals: () => [] }),
    ledger: { mode: 'service', entries: [], corrupt: false, receipts: {} } });
  assert.equal(section.status, 'pass');
});

test('an unhashable local action skips the hash check without failing', () => {
  const hash = actionHash('apr_1');
  const row = rawRow({ tool: '', context: { workspaceId: WS, args: { ...ARGS } } });
  const section = buildAuthoritySection({ workspaceId: WS,
    getApprovalStore: () => stubStore(row),
    ledger: { mode: 'service', entries: ledgerOf([
      { type: 'approval.decided', body: { approvalId: 'apr_1', actionHash: hash, decision: 'approved' } },
      { type: 'approval.consumed', body: { approvalId: 'apr_1', actionHash: hash } },
      { type: 'approval.outcome', body: { approvalId: 'apr_1', status: 'executed', receiptId: 'r-1', receiptHash: null } },
    ]), corrupt: false, receipts: {} } });
  assert.ok(!section.evidence.findings.some(f => f.code === 'ACTION_HASH_MISMATCH'));
});

test('runCliAudit with --authority and no provider degrades inside the report', () => {
  const report = require('../lib/cli-audit').runCliAudit(
    { contractVersion: 't', graph: { getStats: () => ({}), countAuditEvents: () => 0 } },
    '--authority', { json: true });
  assert.equal(report.data.articles.authority_detection.status, 'info');
});

test('malformed ledger entries are skipped, never trusted', () => {
  const section = buildAuthoritySection({ workspaceId: WS,
    getApprovalStore: () => stubStore([]),
    ledger: { mode: 'service', entries: [{ seq: 0 }, { seq: 1, type: 'approval.consumed', body: null },
      { seq: 2, type: 'approval.consumed', body: { approvalId: 42 } }], corrupt: false, receipts: {} } });
  assert.deepEqual(section.evidence.findings, []);
});

test('stableStringify orders keys and handles arrays', () => {
  const { stableStringify: stable } = require('../lib/cli-audit');
  assert.equal(stable([3, 1]), '[3,1]');
  assert.equal(stable({ b: 1, a: [2] }), '{"a":[2],"b":1}');
});
test('cancelled rows need no authority outcome entry', () => {
  const hash = actionHash('apr_1');
  const row = rawRow({ status: 'cancelled', decision: 'approved' });
  const section = buildAuthoritySection({ workspaceId: WS,
    getApprovalStore: () => stubStore(row),
    ledger: { mode: 'service', entries: ledgerOf([
      { type: 'approval.decided', body: { approvalId: 'apr_1', actionHash: hash, decision: 'approved' } },
      { type: 'approval.consumed', body: { approvalId: 'apr_1', actionHash: hash } },
    ]), corrupt: false } });
  assert.ok(!section.evidence.findings.some(f => f.code === 'OUTCOME_MISSING'), JSON.stringify(section.evidence.findings));
});

async function liveClient(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-detect-'));
  const created = createAuthorityState({ dir: path.join(dir, 'state') });
  const state = openAuthorityState({ dir: path.join(dir, 'state') });
  const ledger = openLedgerStore({ file: path.join(dir, 'ledger.jsonl') });
  const server = createAuthorityServer({ service: createAuthorityService({ ledger, state }), signingKey: state.signingKey });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); resolve(); })));
  const pin = parseAuthorityPin(JSON.stringify({ v: 'huqan.authority.pin.v1', port: server.address().port,
    keyId: keyIdFor(created.signingPublicKeyPem), signingKey: created.signingPublicKeyPem, sealingKey: created.sealingPublicKeyPem })).pin;
  const { createAuthorityClient: create } = require('../lib/authority/authority-client');
  return create({ pin });
}

test('ledgerEntries pages the ledger and rejects bad cursors', async (t) => {
  const client = await liveClient(t);
  const empty = await client.ledgerEntries({ fromSeq: 0, limit: 5 });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.entries, []);
  assert.ok(!empty.body.corrupt);
  const capped = await client.ledgerEntries({ fromSeq: 0, limit: 99999 });
  assert.equal(capped.status, 200);
  for (const bad of [{ fromSeq: -1 }, { fromSeq: 'x' }, { limit: 0 }, { limit: 'many' }]) {
    assert.throws(() => client.ledgerEntries(bad), err => err instanceof AuthorityError, JSON.stringify(bad));
  }
});

test('apply records the executed receipt binding in the outcome', async () => {
  const receipt = { receiptId: 'r-9', workspaceId: WS };
  let recorded = null;
  const envelope = { payload: { decision: 'approved', actionHash: actionHash('apr_9'), workspaceId: WS } };
  const deps = {
    resolveMode: () => ({ mode: 'service', boundary: 'os-service', pin: {} }),
    createClient: () => ({
      getDecision: async () => ({ status: 200, body: { envelope } }),
      consume: async () => ({ status: 200, body: { consumption: { seq: 3 } } }),
      recordOutcome: async (id, outcome) => { recorded = { id, outcome }; return { status: 200, body: {} }; },
    }),
    openRuntime: () => ({
      preflight: () => ({ ok: true }),
      approve: async () => ({ ok: true, data: { executed: true, receipt } }),
      close: () => {},
    }),
    loadConsumeKey: () => 'k'.repeat(32),
  };
  const outcome = await apply('apr_9', {}, deps);
  assert.equal(outcome.code, 0);
  assert.equal(recorded.id, 'apr_9');
  assert.equal(recorded.outcome.receiptId, 'r-9');
  assert.equal(recorded.outcome.receiptHash, expectedReceiptHash(receipt));
});

function stubKernel() {
  return { contractVersion: 'test', graph: { getStats: () => ({}), countAuditEvents: () => 0 } };
}

test('audit --authority joins the ledger through the injected provider', async () => {
  const cli = { kernel: stubKernel(),
    approvalRuntime: () => ({ approvalStore: null }),
    authorityLedger: async () => ({ mode: 'service', entries: [], corrupt: false }) };
  const report = await auditCommand(cli, '--authority', { json: true });
  assert.equal(report.status, 'completed');
  assert.equal(report.data.articles.authority_detection.status, 'pass');
  assert.equal(report.data.articles.authority_detection.evidence.mode, 'service');
});

test('audit --authority without a provider degrades instead of throwing', async () => {
  const cli = { kernel: stubKernel(), approvalRuntime: () => ({ approvalStore: null }) };
  const report = await auditCommand(cli, '--authority', { json: true });
  assert.equal(report.data.articles.authority_detection.status, 'info');
});


test('an operational approval has no local row by design and is checked only for its outcome (#3892)', () => {
  const hash = 'c'.repeat(64);
  const registered = { type: 'approval.registered', body: { approvalId: 'ops-1', tool: 'huqan.emergency_stop', workspaceId: WS, actionHash: hash } };
  const consumed = { type: 'approval.consumed', body: { approvalId: 'ops-1', actionHash: hash } };
  const section = (pairs) => buildAuthoritySection({ workspaceId: WS, getApprovalStore: () => stubStore([]),
    ledger: { mode: 'service', entries: ledgerOf(pairs), corrupt: false } }).evidence.findings;

  assert.deepEqual(section([registered, consumed,
    { type: 'approval.outcome', body: { approvalId: 'ops-1', status: 'executed', receiptId: 'ops-1', receiptHash: null } }]), []);
  assert.deepEqual(section([registered, consumed]).map(f => f.code), ['OUTCOME_MISSING']);
  const ghost = { type: 'approval.registered', body: { ...registered.body, approvalId: 'ops-2', tool: 'huqan.learn' } };
  assert.deepEqual(section([ghost, { type: 'approval.consumed', body: { approvalId: 'ops-2', actionHash: hash } }]).map(f => f.code),
    ['CONSUMED_UNKNOWN_LOCALLY'], 'an ops- id alone does not exempt a non-operational tool');
});

test('the ledger provider reads the newest window and stores receipts, not read wrappers', async () => {
  const { fetchAuthorityLedger } = require('../lib/mcp/authority-ledger-provider');
  const asked = [];
  const client = {
    ledgerHead: async () => ({ status: 200, body: { seq: 24_999 } }),
    ledgerEntries: async ({ fromSeq, limit }) => {
      asked.push(fromSeq);
      const entries = Array.from({ length: Math.min(limit, 25_000 - fromSeq) }, (_, i) => ({ seq: fromSeq + i, type: 'note', body: {} }));
      if (fromSeq === 15_000) entries[0] = { seq: 15_000, type: 'approval.outcome', body: { approvalId: 'a', receiptId: 'r-1' } };
      if (fromSeq === 15_500) entries[0] = { seq: 15_500, type: 'approval.outcome', body: { approvalId: 'b', receiptId: 'r-gone' } };
      return { status: 200, body: { entries, corrupt: false } };
    },
  };
  const receipt = { receiptId: 'r-1', workspaceId: WS };
  const fetched = await fetchAuthorityLedger({ resolveReceipts: true }, {
    resolveMode: () => ({ mode: 'service', pin: {} }), createClient: () => client,
    readReceipt: (_graph, id) => (id === 'r-1' ? { ok: true, status: 'found', receiptId: id, receipt }
      : { ok: false, status: 'not_found', receiptId: id }),
  });
  assert.equal(asked[0], 15_000, 'the window ends at the head, not at the genesis');
  assert.equal(fetched.entries.at(-1).seq, 24_999);
  assert.equal(fetched.truncated, true);
  assert.deepEqual(fetched.receipts['r-1'], receipt);
  assert.equal(fetched.receipts['r-gone'], null);
});

test('a consumption outside a cut window is counted, not reported as a bypass', () => {
  const hash = actionHash('old');
  const section = buildAuthoritySection({ workspaceId: WS, getApprovalStore: () => stubStore([]),
    ledger: { mode: 'service', truncated: true, corrupt: false,
      entries: ledgerOf([{ type: 'approval.consumed', body: { approvalId: 'old', actionHash: hash } }]) } });
  assert.deepEqual(section.evidence.findings, []);
  assert.equal(section.evidence.outsideWindow, 1);
  assert.equal(section.status, 'info');
});

test('a ledger read that fails part way, or without a head, is reported as unavailable, not compared', async () => {
  const { fetchAuthorityLedger } = require('../lib/mcp/authority-ledger-provider');
  const deps = (client) => ({ resolveMode: () => ({ mode: 'service', pin: {} }), createClient: () => client });
  const page = (fromSeq) => Array.from({ length: 500 }, (_, i) => ({ seq: fromSeq + i, type: 'note', body: {} }));
  const partial = await fetchAuthorityLedger({}, deps({
    ledgerHead: async () => ({ status: 200, body: { seq: 1_999 } }),
    ledgerEntries: async ({ fromSeq }) => (fromSeq === 0 ? { status: 200, body: { entries: page(0) } } : { status: 503, body: { code: 'BUSY' } }),
  }));
  assert.equal(partial.error, 'AUTHORITY_UNAVAILABLE');
  assert.equal(partial.truncated, true);
  const headless = await fetchAuthorityLedger({}, deps({
    ledgerHead: async () => ({ status: 503, body: {} }),
    ledgerEntries: async () => assert.fail('no page is read without a head'),
  }));
  assert.equal(headless.error, 'AUTHORITY_UNAVAILABLE');
  const section = buildAuthoritySection({ workspaceId: WS, getApprovalStore: () => stubStore(rawRow()), ledger: partial });
  assert.deepEqual(section.evidence.findings.map(f => f.code), ['AUTHORITY_UNAVAILABLE']);
});

test('with a cut ledger window only rows older than the window are out of view; newer ones are still a bypass', () => {
  const windowStart = Date.parse('2026-10-14T12:00:00.000Z');
  const entries = [{ seq: 15_000, type: 'note', at: new Date(windowStart).toISOString(), body: {} }];
  const section = (updatedAt) => buildAuthoritySection({ workspaceId: WS,
    getApprovalStore: () => stubStore(rawRow({ updated_at: updatedAt })),
    ledger: { mode: 'service', truncated: true, corrupt: false, entries } }).evidence;
  const old = section(windowStart - 1);
  assert.deepEqual(old.findings, []);
  assert.equal(old.outsideWindow, 1);
  assert.deepEqual(section(windowStart + 1).findings.map(f => f.code), ['EXECUTED_WITHOUT_AUTHORITY']);
});
