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
