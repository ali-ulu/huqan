'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Graph = require('../graph');

const root = path.resolve(__dirname, '..');
const hook = path.join(root, 'bin', 'huqan-gate-hook.js');
const adapterRoot = path.join(root, 'adapters', 'external-action');

function runHook(profile, payload, directory) {
  const receiptLog = path.join(directory, 'receipts.jsonl');
  const memoryPath = path.join(directory, 'memory.json');
  const dbPath = path.join(directory, 'memory.db');
  return {
    receiptLog,
    memoryPath,
    dbPath,
    process: spawnSync(process.execPath, [
      hook,
      '--profile', profile,
      '--workspace-root', root,
      '--receipt-log', receiptLog,
      '--memory-path', memoryPath,
      '--db-path', dbPath,
    ], {
      cwd: root,
      input: JSON.stringify(payload),
      encoding: 'utf8',
    }),
  };
}

function genericPayload(command) {
  return {
    invocationId: `cli-${Date.now()}`,
    agentName: 'future-agent-2035',
    sessionId: 'cli-session',
    toolName: 'shell',
    args: { command },
    cwd: root,
    workspaceRoot: root,
  };
}

test('generic hook allows a bounded read command and persists its receipt', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const run = runHook('generic', genericPayload('git status'), directory);
  assert.equal(run.process.status, 0, run.process.stderr);
  const output = JSON.parse(run.process.stdout);
  assert.equal(output.decision, 'allow');
  const receipts = fs.readFileSync(run.receiptLog, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].decision, 'allow');

  const graph = new Graph({ memoryPath: run.memoryPath, dbPath: run.dbPath, useSQLite: true });
  try {
    if (graph.getStats().backend === 'sqlite') {
      const events = graph.getAuditEvents({ workspaceId: 'default' });
      assert.equal(events.some(event => event.auditId === receipts[0].receiptId), true);
    }
  } finally {
    graph.close();
  }
});

test('generic hook blocks an unknown executable before a host can run it', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sentinel = path.join(directory, 'must-not-exist.txt');
  const command = `${process.execPath} -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')"`;
  const run = runHook('generic', genericPayload(command), directory);
  assert.equal(run.process.status, 3, run.process.stderr);
  assert.equal(JSON.parse(run.process.stdout).decision, 'review');
  assert.equal(fs.existsSync(sentinel), false);
});

test('Codex and Claude projections fail closed before destructive execution', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const payload = {
    session_id: 'native-session',
    tool_use_id: 'native-call',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /' },
    cwd: root,
  };
  const codex = runHook('codex', payload, directory);
  assert.equal(codex.process.status, 0, codex.process.stderr);
  assert.equal(JSON.parse(codex.process.stdout).hookSpecificOutput.permissionDecision, 'deny');

  payload.tool_use_id = 'native-call-2';
  const claude = runHook('claude-code', payload, directory);
  assert.equal(claude.process.status, 0, claude.process.stderr);
  assert.equal(JSON.parse(claude.process.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('shipped adapter templates bind every supported host to HUQAN before execution', () => {
  const claude = JSON.parse(fs.readFileSync(path.join(adapterRoot, 'claude-code-hooks.json'), 'utf8'));
  const codex = JSON.parse(fs.readFileSync(path.join(adapterRoot, 'codex-hooks.json'), 'utf8'));
  assert.match(claude.hooks.PreToolUse[0].hooks[0].command, /huqan-gate --profile claude-code/);
  assert.match(codex.hooks.PreToolUse[0].hooks[0].command, /huqan-gate --profile codex/);
  assert.match(codex.hooks.PreToolUse[0].hooks[0].commandWindows, /huqan-gate\.cmd --profile codex/);

  const openCode = fs.readFileSync(path.join(adapterRoot, 'opencode-plugin.mjs'), 'utf8');
  const pi = fs.readFileSync(path.join(adapterRoot, 'pi-extension.js'), 'utf8');
  const hermes = fs.readFileSync(path.join(adapterRoot, 'hermes', '__init__.py'), 'utf8');
  const manifest = fs.readFileSync(path.join(adapterRoot, 'hermes', 'plugin.yaml'), 'utf8');
  assert.match(openCode, /createOpenCodeGuardPlugin/);
  assert.match(pi, /registerPiGuard/);
  assert.match(hermes, /ctx\.register_hook\("pre_tool_call", guard_tool_call\)/);
  assert.match(hermes, /shell=False/);
  assert.match(manifest, /name: huqan-external-action-guard/);
});

// --- Faz C (#1769): identity card + identity log query over the CLI --------

function identityCardFile(directory) {
  const target = path.join(directory, 'card.json');
  fs.writeFileSync(target, JSON.stringify({
    schemaVersion: 'huqan.agent-identity-card.v1',
    agentId: 'future-agent-2035',
    agentName: 'future-agent-2035',
    ownerActorId: 'actor:ali',
    workspaceId: 'default',
    capabilities: ['shell'],
    issuedAt: '2026-01-01T00:00:00.000Z',
  }));
  return target;
}

function runHookWithCard(payload, directory, extraArgs = []) {
  const receiptLog = path.join(directory, 'receipts.jsonl');
  return {
    receiptLog,
    process: spawnSync(process.execPath, [
      hook,
      '--profile', 'generic',
      '--workspace-root', root,
      '--receipt-log', receiptLog,
      '--memory-path', path.join(directory, 'memory.json'),
      '--db-path', path.join(directory, 'memory.db'),
      ...extraArgs,
    ], { cwd: root, input: JSON.stringify(payload), encoding: 'utf8' }),
  };
}

test('the hook attaches an identity card and reports it in the decision output', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-identity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const run = runHookWithCard(genericPayload('git status'), directory, [
    '--identity-card', identityCardFile(directory),
  ]);
  assert.equal(run.process.status, 0, run.process.stderr);
  const output = JSON.parse(run.process.stdout);
  assert.equal(output.decision, 'allow');
  assert.equal(output.identityRef, 'agent:default:future-agent-2035');
  assert.equal(output.identityAttested, true);

  const receipt = JSON.parse(fs.readFileSync(run.receiptLog, 'utf8').trim().split(/\r?\n/)[0]);
  assert.equal(receipt.metadata.identity.ownerActorId, 'actor:ali');
  assert.equal(receipt.metadata.identity.attested, true);
});

test('--require-identity fails closed when no card is supplied', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-identity-req-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const run = runHookWithCard(genericPayload('git status'), directory, ['--require-identity']);
  assert.equal(run.process.status, 2, run.process.stderr);
  assert.equal(JSON.parse(run.process.stdout).decision, 'block');
});

test('--identity-log lists every action recorded for one identity', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-identity-log-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const card = identityCardFile(directory);
  const first = runHookWithCard(genericPayload('git status'), directory, ['--identity-card', card]);
  assert.equal(first.process.status, 0, first.process.stderr);
  const second = runHookWithCard(genericPayload('git diff'), directory, ['--identity-card', card]);
  assert.equal(second.process.status, 0, second.process.stderr);

  const query = spawnSync(process.execPath, [
    hook,
    '--identity-log', 'agent:default:future-agent-2035',
    '--receipt-log', first.receiptLog,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(query.status, 0, query.stderr);
  const result = JSON.parse(query.stdout);
  assert.equal(result.matched, 2);
  assert.equal(result.summary.attested, 2);
  assert.ok(result.actions.every(action => action.identity.ownerActorId === 'actor:ali'));
});

test('--graduated-autonomy exposes the enforced T1 score and tier in CLI output', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-autonomy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const run = runHookWithCard(genericPayload('git status'), directory, ['--graduated-autonomy']);
  assert.equal(run.process.status, 0, run.process.stderr);
  const output = JSON.parse(run.process.stdout);
  assert.equal(output.autonomyTier, 'T1');
  assert.equal(output.autonomyScore, 0);
  const receipt = JSON.parse(fs.readFileSync(run.receiptLog, 'utf8').trim());
  assert.equal(receipt.metadata.autonomy.schemaVersion, 'huqan.graduated-autonomy.v1');
  assert.equal(receipt.metadata.autonomy.requiredTier, 'T1');
});
