'use strict';

// Effect-boundary test across HUQAN's entry paths. The SAME real action -- a
// command that appends to a sentinel file -- goes through the huqan-gate CLI
// hook, the in-process external-action guard and the MCP gate (callTool). For
// each path: the effect does not happen on block/review, fails closed when the
// gate cannot decide, and the receipt the path produces names the real
// decision and action and stops verifying when a field is tampered with.
//
// Neither the CLI hook nor the guard executes anything: they return a decision
// the host honors. `honor()` below is that host and it is the only thing that
// runs the sentinel command, and only on `allow`. The MCP path does execute:
// its kernel handlers write the sentinel, so the handler is the effect.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { callTool } = require('../mcpServer');
const { evaluateExternalAction, recordExternalActionOutcome } = require('../lib/external-action-guard');
const { receiptHashVerifies } = require('../lib/external-action-receipt-outcome');
const { digestExternalActionValue } = require('../lib/external-action-receipt');
const { bindCall, bindingHolds } = require('../lib/mcp-call-binding');

const root = path.resolve(__dirname, '..');
const hook = path.join(root, 'bin', 'huqan-gate-hook.js');
const ALLOW_NODE = ['node'];

// Unattested calls block by default (#2505 C); test/external-action-identity
// owns that. Here identity is not the subject, so the CLI opts out as
// external-action-hook-cli.test.js does.
const PROJECTION_ENV = Object.freeze({
  ...process.env,
  HUQAN_EXTERNAL_GUARD_REQUIRE_IDENTITY: 'allow',
  HUQAN_EXTERNAL_GUARD_REQUIRE_SIGNED_IDENTITY: 'allow',
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cross-entry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sentinel = path.join(directory, 'sentinel.txt');
  const writer = path.join(directory, 'writer.js');
  fs.writeFileSync(writer, "require('fs').appendFileSync(process.argv[2], 'ran\\n')");
  const command = `node ${JSON.stringify(writer)} ${JSON.stringify(sentinel)}`;
  return { directory, sentinel, command, receiptLog: path.join(directory, 'receipts.jsonl') };
}

const effectCount = (sentinel) => (fs.existsSync(sentinel) ? fs.readFileSync(sentinel, 'utf8').split('\n').filter(Boolean).length : 0);

function payload(invocationId, command) {
  return { invocationId, agentName: 'future-agent-2035', sessionId: 'cross-entry', toolName: 'shell', args: { command }, cwd: root, workspaceRoot: root };
}

function runHook(f, input, extraArgs = [], rawInput) {
  return spawnSync(process.execPath, [
    hook, '--profile', 'generic', '--workspace-root', root,
    '--receipt-log', f.receiptLog,
    '--memory-path', path.join(f.directory, 'memory.json'),
    '--db-path', path.join(f.directory, 'memory.db'),
    ...extraArgs,
  ], { cwd: root, input: rawInput === undefined ? JSON.stringify(input) : rawInput, encoding: 'utf8', env: PROJECTION_ENV });
}

// The host: runs the action only when the gate said allow.
function honor(allowed, f) {
  if (allowed) spawnSync(f.command, { shell: true, cwd: root });
}

function readReceipts(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

// The real verifier is receiptHashVerifies (lib/external-action-receipt-outcome):
// it recomputes the canonical hash. Checks the receipt names the real decision
// and action, then that tampering with each identity field breaks it.
function assertReceiptRecords(receipt, { decision, invocationId, args }) {
  assert.equal(receiptHashVerifies(receipt), true, 'receipt must verify as written');
  assert.equal(receipt.decision, decision);
  assert.equal(receipt.admissionId, invocationId);
  assert.equal(receipt.metadata.toolName, 'shell');
  assert.equal(receipt.metadata.inputDigest, digestExternalActionValue(args), 'receipt must commit to the real args');
  assert.equal(receiptHashVerifies({ ...receipt, decision: decision === 'allow' ? 'block' : 'allow' }), false);
  assert.equal(receiptHashVerifies({ ...receipt, admissionId: 'someone-elses-action' }), false);
  assert.equal(receiptHashVerifies({ ...receipt, metadata: { ...receipt.metadata, inputDigest: '0'.repeat(64) } }), false);
  assert.equal(receiptHashVerifies({ ...receipt, receiptHash: '0'.repeat(64) }), false);
}

function guardEvaluate(input, options = {}) {
  const receipts = [];
  const result = evaluateExternalAction({ ...input, kind: 'shell', workspaceId: 'default' }, {
    receiptWriter: { append: (r) => receipts.push(r) }, requireIdentityCard: false, ...options,
  });
  return { result, receipts };
}

// ---- PATH 1: huqan-gate CLI hook -------------------------------------------

test('CLI: unlisted command => review, host never runs it, receipt records review and the real action', (t) => {
  const f = fixture(t);
  const input = payload('cli-review', f.command);
  const run = runHook(f, input);
  assert.equal(run.status, 3, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.equal(output.decision, 'review');
  honor(output.decision === 'allow', f);
  assert.equal(effectCount(f.sentinel), 0);
  const receipts = readReceipts(f.receiptLog);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].receiptId, output.receiptId);
  assert.equal(receipts[0].receiptKind, 'external_action_review_receipt');
  assertReceiptRecords(receipts[0], { decision: 'review', invocationId: 'cli-review', args: input.args });
});

test('CLI: denylisted command => block (exit 2), receipt is a rejection that verifies', (t) => {
  const f = fixture(t);
  const input = payload('cli-block', 'rm -rf /');
  const run = runHook(f, input);
  assert.equal(run.status, 2, run.stderr);
  assert.equal(JSON.parse(run.stdout).decision, 'block');
  const [receipt] = readReceipts(f.receiptLog);
  assert.equal(receipt.receiptKind, 'external_action_rejection_receipt');
  assertReceiptRecords(receipt, { decision: 'block', invocationId: 'cli-block', args: input.args });
});

test('CLI: policy-allowed command => allow, host runs it exactly once, receipt records allow', (t) => {
  const f = fixture(t);
  const policy = path.join(f.directory, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ allowedCommands: ALLOW_NODE }));
  const input = payload('cli-allow', f.command);
  const run = runHook(f, input, ['--policy', policy]);
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.equal(output.decision, 'allow');
  assert.equal(effectCount(f.sentinel), 0, 'the hook itself must not run the action');
  honor(output.decision === 'allow', f);
  assert.equal(effectCount(f.sentinel), 1);
  const [receipt] = readReceipts(f.receiptLog);
  assert.equal(receipt.receiptKind, 'external_action_admission_receipt');
  assertReceiptRecords(receipt, { decision: 'allow', invocationId: 'cli-allow', args: input.args });
});

test('CLI: gate cannot decide (corrupt policy / bad stdin / unwritable receipt log) => no allow, nothing runs', (t) => {
  const f = fixture(t);
  const corrupt = path.join(f.directory, 'corrupt.json');
  fs.writeFileSync(corrupt, '{nope');
  const input = payload('cli-failclosed', f.command);
  const cases = {
    corruptPolicy: runHook(f, input, ['--policy', corrupt]),
    badStdin: runHook(f, null, [], '{not json'),
  };
  fs.mkdirSync(path.join(f.directory, 'log-is-a-directory.jsonl'));
  cases.unwritableLog = runHook({ ...f, receiptLog: path.join(f.directory, 'log-is-a-directory.jsonl') }, input);
  for (const [name, run] of Object.entries(cases)) {
    assert.equal(run.status, 2, `${name}: ${run.stderr}`);
    const verdict = run.stdout.trim() ? JSON.parse(run.stdout).decision : 'none';
    assert.notEqual(verdict, 'allow', name);
    honor(verdict === 'allow', f);
  }
  assert.equal(JSON.parse(cases.unwritableLog.stdout).reason, 'external_action_receipt_persistence_failed');
  assert.equal(effectCount(f.sentinel), 0);
});

// ---- PATH 2: in-process external action guard ------------------------------

test('Guard: unlisted command => review, canExecute false, receipt records review and the real action', (t) => {
  const f = fixture(t);
  const input = payload('guard-review', f.command);
  const { result, receipts } = guardEvaluate(input);
  assert.equal(result.decision, 'review');
  assert.equal(result.canExecute, false);
  honor(result.canExecute, f);
  assert.equal(effectCount(f.sentinel), 0);
  assert.equal(receipts.length, 1);
  assert.equal(result.receipt.receiptId, receipts[0].receiptId);
  assertReceiptRecords(receipts[0], { decision: 'review', invocationId: 'guard-review', args: input.args });
});

test('Guard: denylisted command => block, receipt verifies and records block', (t) => {
  const f = fixture(t);
  const input = payload('guard-block', 'rm -rf /');
  const { result, receipts } = guardEvaluate(input);
  assert.equal(result.decision, 'block');
  assert.equal(result.canExecute, false);
  assertReceiptRecords(receipts[0], { decision: 'block', invocationId: 'guard-block', args: input.args });
  assert.equal(effectCount(f.sentinel), 0);
});

test('Guard: allowed command => host runs it exactly once; outcome receipt links to the admission and verifies', (t) => {
  const f = fixture(t);
  const input = payload('guard-allow', f.command);
  const { result, receipts } = guardEvaluate(input, { allowedCommands: ALLOW_NODE });
  assert.equal(result.decision, 'allow');
  assert.equal(effectCount(f.sentinel), 0);
  honor(result.canExecute, f);
  assert.equal(effectCount(f.sentinel), 1);
  assertReceiptRecords(receipts[0], { decision: 'allow', invocationId: 'guard-allow', args: input.args });

  const outcome = recordExternalActionOutcome(
    { ...input, kind: 'shell', workspaceId: 'default' }, result.receipt,
    { status: 'success', output: 'ran' },
    { receiptWriter: { append: (r) => receipts.push(r) }, requireIdentityCard: false },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.receipt.receiptKind, 'external_action_outcome_receipt');
  assert.equal(outcome.receipt.admissionId, 'guard-allow');
  assert.equal(outcome.receipt.metadata.admissionReceiptId, result.receipt.receiptId);
  assert.equal(outcome.receipt.metadata.admissionReceiptHash, result.receipt.receiptHash);
  assert.equal(receiptHashVerifies(outcome.receipt), true);
  assert.equal(receiptHashVerifies({ ...outcome.receipt, metadata: { ...outcome.receipt.metadata, admissionReceiptId: 'other' } }), false);
});

test('Guard: receipt cannot be persisted / envelope malformed => block, nothing runs', (t) => {
  const f = fixture(t);
  const failing = guardEvaluate(payload('guard-nolog', f.command), {
    allowedCommands: ALLOW_NODE,
    receiptWriter: { append() { throw new Error('disk unavailable'); } },
  }).result;
  assert.equal(failing.decision, 'block');
  assert.equal(failing.reason, 'external_action_receipt_persistence_failed');
  assert.equal(failing.receiptPersisted, false);
  assert.equal(failing.canExecute, false);

  const malformed = evaluateExternalAction(null, { receiptWriter: { append() {} }, requireIdentityCard: false });
  assert.equal(malformed.decision, 'block');
  assert.equal(malformed.canExecute, false);
  honor(failing.canExecute || malformed.canExecute, f);
  assert.equal(effectCount(f.sentinel), 0);
});

// ---- PATH 3: MCP gate through callTool -------------------------------------
// The MCP surface has no shell tool, so the "real action" is the kernel
// handler behind the tool. The handler appends to the sentinel; reaching it is
// the effect. MCP produces no sealed receipt for a refusal (receiptId is null
// by design); what binds the decision to the action is the call binding.

function sentinelKernel(f, extra = {}) {
  const done = (type, data) => ({ ok: true, type, data, evidence: [], error: null, meta: {} });
  const touch = () => fs.appendFileSync(f.sentinel, 'ran\n');
  return {
    ...extra,
    learn(text) { touch(); return done('learn', { learned: 1, text }); },
    ask(question) { touch(); return done('ask', { answer: 'a', subject: question, unknown: false, alternatives: 0 }); },
    ok: done,
    fail: (type, code, message) => ({ ok: false, type, data: null, evidence: [], error: { code, message }, meta: {} }),
  };
}

function approvalStore() {
  const rows = new Map();
  return {
    rows,
    saveToolApproval(r) { rows.set(r.id, r); return r; },
    getToolApprovalById: (id) => rows.get(id) || null,
    listUnresolvedToolApprovals: () => [...rows.values()],
    countUnresolvedToolApprovals: () => rows.size,
  };
}

test('MCP: mutating tool => review, handler never runs, approval binds the exact tool and args', (t) => {
  const f = fixture(t);
  const store = approvalStore();
  const result = callTool(sentinelKernel(f), { name: 'huqan.learn', arguments: { text: 'sentinel-claim' } }, { approvalStore: store });
  assert.equal(result.ok, false);
  assert.equal(result.gate.decision, 'review');
  assert.equal(result.gate.canExecute, false);
  assert.equal(result.receiptId, null, 'a refusal must not claim a committed receipt');
  assert.equal(effectCount(f.sentinel), 0);
  const [row] = [...store.rows.values()];
  assert.equal(row.tool, 'huqan.learn');
  assert.equal(row.context.args.text, 'sentinel-claim');
  const binding = row.policy.reviewedBinding;
  assert.equal(bindingHolds(binding, 'huqan.learn', row.context.args), true);
  assert.equal(bindingHolds(binding, 'huqan.learn', { ...row.context.args, text: 'tampered' }), false);
  assert.equal(bindingHolds(binding, 'huqan.ask', row.context.args), false);
  assert.equal(binding.argsDigest, bindCall('huqan.learn', row.context.args).argsDigest);
});

test('MCP: read-only tool => allow, handler runs exactly once', (t) => {
  const f = fixture(t);
  const result = callTool(sentinelKernel(f), { name: 'huqan.ask', arguments: { question: 'what is the sentinel' } }, {});
  assert.equal(result.ok, true);
  assert.equal(result.toolVerdict.verdict, 'allow');
  assert.equal(result.toolVerdict.tool, 'huqan.ask');
  assert.equal(effectCount(f.sentinel), 1);
});

test('MCP: unknown tool and malformed tool name => block, handler never runs', (t) => {
  const f = fixture(t);
  for (const name of ['huqan.not_a_tool', ' huqan.ask ']) {
    const result = callTool(sentinelKernel(f), { name, arguments: { question: 'q' } }, {});
    assert.equal(result.ok, false, name);
    assert.equal(result.gate.decision, 'block', name);
    assert.equal(result.gate.canExecute, false, name);
  }
  assert.equal(effectCount(f.sentinel), 0);
});

test('MCP: review that cannot be persisted, and a gate evaluation that throws => fail closed, handler never runs', (t) => {
  const f = fixture(t);
  const unpersisted = callTool(sentinelKernel(f), { name: 'huqan.learn', arguments: { text: 'sentinel-claim' } }, { approvalStore: null });
  assert.equal(unpersisted.ok, false);
  assert.equal(unpersisted.error.code, 'REVIEW_NOT_PERSISTED');

  const throwing = sentinelKernel(f, { plugins: { collectEvidence() { throw new Error('gate exploded'); } } });
  assert.throws(() => callTool(throwing, { name: 'huqan.ask', arguments: { question: 'q' } }, {}), /gate exploded/);
  assert.equal(effectCount(f.sentinel), 0);
});

// ---- Cross-path: one action, one identity ----------------------------------

test('CROSS: the CLI hook and the guard decide the same way and commit to the same action identity', (t) => {
  const f = fixture(t);
  const policy = path.join(f.directory, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ allowedCommands: ALLOW_NODE }));
  for (const [label, listed] of [['unlisted', false], ['listed', true]]) {
    const input = payload(`cross-${label}`, f.command);
    const cli = runHook(f, input, listed ? ['--policy', policy] : []);
    const guard = guardEvaluate(input, listed ? { allowedCommands: ALLOW_NODE } : {});
    const cliDecision = JSON.parse(cli.stdout).decision;
    assert.equal(cliDecision, guard.result.decision, label);
    assert.equal(cliDecision, listed ? 'allow' : 'review', label);
    const cliReceipt = readReceipts(f.receiptLog).find(r => r.admissionId === input.invocationId);
    assert.equal(cliReceipt.metadata.inputDigest, guard.receipts[0].metadata.inputDigest, label);
    assert.equal(cliReceipt.metadata.inputDigest, digestExternalActionValue(input.args), label);
  }
  assert.equal(effectCount(f.sentinel), 0, 'neither path executes anything itself');
});
