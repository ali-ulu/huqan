'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const hook = path.join(root, 'bin', 'huqan-gate-hook.js');
const { ACTION_CATEGORIES } = require('../lib/action-risk-classifier');
const { normalizeExternalActionEnvelope } = require('../lib/external-action-envelope');

// #4099 (follow-up to #4074): the caller writes `kind` as well as `command`.
// The command's shape used to be graded only when kind was `shell`, so a
// deployment command carried under `file_read` was graded READ_ONLY -- the one
// rule that can ALLOW. These tests run the real path: stdin payload ->
// normalisation -> gate decision.
const ENV = Object.freeze({
  ...process.env,
  HUQAN_EXTERNAL_GUARD_REQUIRE_IDENTITY: 'allow',
  HUQAN_EXTERNAL_GUARD_REQUIRE_SIGNED_IDENTITY: 'allow',
});

function runHook(payload, directory) {
  const child = spawnSync(process.execPath, [
    hook,
    '--profile', 'generic',
    '--workspace-root', root,
    '--receipt-log', path.join(directory, 'receipts.jsonl'),
    '--memory-path', path.join(directory, 'memory.json'),
    '--db-path', path.join(directory, 'memory.db'),
  ], { cwd: root, input: JSON.stringify(payload), encoding: 'utf8', env: ENV });
  return JSON.parse(child.stdout);
}

function payload(toolName, kind, command) {
  return {
    invocationId: `f4099-${kind}-${command}`,
    agentName: 'future-agent-2035',
    sessionId: 'f4099-session',
    toolName,
    kind,
    args: { command },
    cwd: root,
    workspaceRoot: root,
  };
}

const CASES = [
  ['kubectl apply -f prod.yaml', ACTION_CATEGORIES.DEPLOYMENT],
  ['terraform apply -auto-approve', ACTION_CATEGORIES.DEPLOYMENT],
  ['helm upgrade app ./chart', ACTION_CATEGORIES.DEPLOYMENT],
  ['gh pr merge 12', ACTION_CATEGORIES.DEPLOYMENT],
  ['chmod 777 /etc/passwd', ACTION_CATEGORIES.PERMISSION_CHANGE],
  ['cp evil /etc/sudoers', ACTION_CATEGORIES.FILESYSTEM_WRITE],
  ['cat a; echo b', ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION],
];
const KINDS = [['read', 'file_read'], ['fetch', 'network'], ['remember', 'memory']];

test('normalisation keeps the command under a non-shell kind', () => {
  const envelope = normalizeExternalActionEnvelope(payload('read', 'file_read', 'kubectl apply -f prod.yaml'), {});
  assert.equal(envelope.kind, 'file_read');
  assert.equal(envelope.command, 'kubectl apply -f prod.yaml');
});

test('a command-shaped deployment/permission/write under a non-shell kind is graded by its shape', () => {
  for (const [toolName, kind] of KINDS) {
    for (const [command, expected] of CASES) {
      const envelope = normalizeExternalActionEnvelope(payload(toolName, kind, command), {});
      // A memory write already carries a rule at least as strict as a plain
      // filesystem write, so the stricter kind keeps the action.
      const want = kind === 'memory' && expected === ACTION_CATEGORIES.FILESYSTEM_WRITE
        ? ACTION_CATEGORIES.MEMORY_WRITE
        : expected;
      assert.equal(envelope.riskCategory, want, `${kind}: ${command}`);
    }
  }
});

test('the gate does not ALLOW a command carried under a non-shell kind', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4099-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [toolName, kind] of KINDS) {
    for (const [command] of CASES) {
      const decision = runHook(payload(toolName, kind, command), directory);
      assert.notEqual(decision.decision, 'allow', `${kind}: ${command} was allowed`);
    }
  }
});

test('a plain read with no command is still READ_ONLY', () => {
  const envelope = normalizeExternalActionEnvelope({ ...payload('read', 'file_read', ''), args: {} }, {});
  assert.equal(envelope.riskCategory, ACTION_CATEGORIES.READ_ONLY);
});

test('a harmless command under file_read stays READ_ONLY', () => {
  const envelope = normalizeExternalActionEnvelope(payload('read', 'file_read', 'ls -la'), {});
  assert.equal(envelope.riskCategory, ACTION_CATEGORIES.READ_ONLY);
});

test('shell keeps its safe-command and allowlist downgrade', () => {
  const safe = normalizeExternalActionEnvelope(payload('shell', 'shell', 'git status'), {});
  assert.equal(safe.riskCategory, ACTION_CATEGORIES.READ_ONLY);
  const listed = normalizeExternalActionEnvelope(payload('shell', 'shell', 'npm test'), { allowedCommands: ['npm test'] });
  assert.equal(listed.riskCategory, ACTION_CATEGORIES.READ_ONLY);
});

test('an allowlisted command does not downgrade a non-shell kind', () => {
  const envelope = normalizeExternalActionEnvelope(payload('fetch', 'network', 'npm test'), { allowedCommands: ['npm test'] });
  assert.equal(envelope.riskCategory, ACTION_CATEGORIES.NETWORK_CALL);
});
