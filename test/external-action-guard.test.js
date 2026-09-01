'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  evaluateExternalAction,
  recordExternalActionOutcome,
} = require('../lib/external-action-guard');
const {
  normalizeHookInvocation,
  projectHookDecision,
  createOpenCodeGuardPlugin,
  registerPiGuard,
} = require('../lib/external-action-adapter');

const workspaceRoot = path.resolve(__dirname, '..');

function invocation(overrides = {}) {
  return {
    invocationId: 'call-1',
    agentName: 'future-agent-2030',
    sessionId: 'session-1',
    toolName: 'Bash',
    args: { command: 'git status' },
    cwd: workspaceRoot,
    workspaceRoot,
    ...overrides,
  };
}

function memoryWriter() {
  const receipts = [];
  return { receipts, append(receipt) { receipts.push(receipt); } };
}

test('unknown future agent uses the brand-independent envelope and safe read is allowed', () => {
  const writer = memoryWriter();
  const result = evaluateExternalAction(invocation(), { receiptWriter: writer });
  assert.equal(result.decision, 'allow');
  assert.equal(result.canExecute, true);
  assert.equal(result.envelope.agent.name, 'future-agent-2030');
  assert.equal(result.receiptPersisted, true);
  assert.equal(writer.receipts.length, 1);
});

test('denylisted destructive command is blocked before execution', () => {
  const result = evaluateExternalAction(invocation({ args: { command: 'rm -rf /' } }));
  assert.equal(result.decision, 'block');
  assert.equal(result.canExecute, false);
  assert.equal(result.findings.some(finding => finding.gate === 'AB8' && finding.denylistMatch === 'rm_rf_root_or_home'), true);
});

test('security-sensitive Windows shutdown is blocked before execution', () => {
  const result = evaluateExternalAction(invocation({ args: { command: 'shutdown /s /t 0' } }));
  assert.equal(result.decision, 'block');
  assert.equal(result.canExecute, false);
});

test('unknown shell command is never silently allowed', () => {
  const result = evaluateExternalAction(invocation({ args: { command: 'custom-agent-tool --do-something' } }));
  assert.equal(result.decision, 'review');
  assert.equal(result.canExecute, false);
});

test('read-looking shell commands cannot smuggle filesystem side effects', () => {
  const cases = [
    ['git diff --output=C:/tmp/huqan-bypass', 'review'],
    ['git log --output C:/tmp/huqan-bypass', 'review'],
    ['git diff --ext-diff', 'review'],
    ['rg --pre malicious-helper pattern .', 'review'],
    ['find . -exec malicious-helper {} ;', 'review'],
    ['find . -delete', 'block'],
    ['git branch -D main', 'block'],
    ['git branch -m old new', 'review'],
    ['git remote add origin https://example.invalid/repo', 'review'],
    ['git remote set-url origin https://example.invalid/repo', 'review'],
  ];
  for (const [command, expected] of cases) {
    const result = evaluateExternalAction(invocation({ args: { command } }));
    assert.equal(result.decision, expected, command);
    assert.equal(result.canExecute, false, command);
  }
});

test('filesystem write outside workspace is blocked', () => {
  const result = evaluateExternalAction(invocation({
    toolName: 'Write',
    args: { file_path: path.resolve(workspaceRoot, '..', 'outside.txt'), content: 'x' },
  }));
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, 'external_action_path_outside_workspace');
});

test('filesystem read outside workspace is blocked before data can leave the host', () => {
  const result = evaluateExternalAction(invocation({
    toolName: 'read_file',
    kind: 'file_read',
    action: 'read',
    args: { path: path.resolve(workspaceRoot, '..', 'outside-secret.txt') },
  }), { receiptWriter: memoryWriter() });
  assert.equal(result.decision, 'block');
  assert.equal(result.canExecute, false);
  assert.equal(result.reason, 'external_action_path_outside_workspace');
});

test('filesystem write inside workspace requires review', () => {
  const result = evaluateExternalAction(invocation({
    toolName: 'Write',
    args: { file_path: path.join(workspaceRoot, 'local.txt'), content: 'x' },
  }));
  assert.equal(result.decision, 'review');
  assert.equal(result.canExecute, false);
});

test('filesystem write through a workspace symlink cannot escape the workspace', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-guard-path-'));
  const root = path.join(directory, 'root');
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const link = path.join(root, 'escape');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    return t.skip(`symlink unavailable: ${error.code || error.message}`);
  }
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = evaluateExternalAction(invocation({
    toolName: 'Write',
    args: { file_path: path.join(link, 'outside.txt'), content: 'x' },
    cwd: root,
    workspaceRoot: root,
  }));
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, 'external_action_path_outside_workspace');
});

test('receipt persistence failure converts an allow into a fail-closed block', () => {
  const result = evaluateExternalAction(invocation(), { receiptWriter: { append() { throw new Error('disk unavailable'); } } });
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, 'external_action_receipt_persistence_failed');
  assert.equal(result.receiptPersisted, false);
  assert.match(result.receiptError, /disk unavailable/);
});

test('receipts contain digests, not raw secret or command arguments', () => {
  const result = evaluateExternalAction(invocation({
    args: { command: 'git status', apiKey: 'sk-super-secret-value-123456789' },
  }));
  const serialized = JSON.stringify(result.receipt);
  assert.doesNotMatch(serialized, /super-secret/);
  assert.doesNotMatch(serialized, /git status/);
  assert.match(result.receipt.metadata.inputDigest, /^[a-f0-9]{64}$/);
});

test('outcome receipt is separate from admission receipt and links to it', () => {
  const writer = memoryWriter();
  const input = invocation();
  const admission = evaluateExternalAction(input, { receiptWriter: writer });
  const outcome = recordExternalActionOutcome(input, admission.receipt, { status: 'success', output: 'secret output' }, { receiptWriter: writer });
  assert.equal(outcome.receipt.receiptKind, 'external_action_outcome_receipt');
  assert.equal(outcome.receipt.metadata.admissionReceiptId, admission.receipt.receiptId);
  assert.doesNotMatch(JSON.stringify(outcome.receipt), /secret output/);
  assert.equal(writer.receipts.length, 2);
});

test('Claude review projects to ask while Codex review fails closed to deny', () => {
  const review = evaluateExternalAction(invocation({ args: { command: 'custom-action' } }));
  const claude = projectHookDecision('claude-code', review);
  const codex = projectHookDecision('codex', review);
  assert.equal(claude.output.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(codex.output.hookSpecificOutput.permissionDecision, 'deny');
});

test('Claude and Codex native hook payloads normalize to the universal envelope input', () => {
  for (const profile of ['claude-code', 'codex']) {
    const normalized = normalizeHookInvocation(profile, {
      session_id: 's1', turn_id: 't1', tool_use_id: 'u1', tool_name: 'Bash',
      tool_input: { command: 'git status' }, cwd: workspaceRoot,
    });
    assert.equal(normalized.agentName, profile);
    assert.equal(normalized.toolName, 'Bash');
    assert.equal(normalized.invocationId, 'u1');
  }
});

test('OpenCode plugin throws before a reviewed tool executes', async () => {
  const plugin = createOpenCodeGuardPlugin();
  const hooks = await plugin({ directory: workspaceRoot });
  await assert.rejects(
    hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 's1', callID: 'c1' },
      { args: { command: 'custom-action' } },
    ),
    /HUQAN review/,
  );
});

test('Pi adapter returns block for reviewed calls', async () => {
  let handler;
  registerPiGuard({ on(event, callback) { if (event === 'tool_call') handler = callback; } }, { cwd: workspaceRoot, sessionId: 's1' });
  const decision = await handler({ toolName: 'bash', toolCallId: 'c1', input: { command: 'custom-action' } }, {});
  assert.equal(decision.block, true);
  assert.match(decision.reason, /HUQAN review/);
});
