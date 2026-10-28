'use strict';

// The `huqan-gate break-glass` operator surface (İP-2), driven as a real
// process so the exit-code contract and the argv parsing are exercised, not
// just the library underneath them.
//
// Exit codes: 0 on success, 1 on a refusal, 2 on an unknown verb, 4 when the
// operator is not at an interactive terminal. A script that branches on these
// must not read a refusal as success.
//
// `issue` and `lift` are operator decisions (İP-2): the same credential
// `terfi`/`onayla` carry. A spawned process has no terminal, so it is refused
// with exit 4 -- which is the point. The tests below confirm the refusal first,
// then drive the operator path through the in-process seam.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'bin', 'huqan-gate-hook.js');
const { runBreakGlassCommand } = require('../lib/gate-hook-break-glass');

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-break-glass-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
}

function run(directory, args) {
  const result = spawnSync(process.execPath, [HOOK, 'break-glass', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, HUQAN_BREAK_GLASS_DIR: directory },
  });
  let report = null;
  try { report = JSON.parse(result.stdout); } catch (_) { report = null; }
  return { status: result.status, report, stderr: result.stderr };
}

// The agent's actual surface: a guarded tool call. The agent's shell hands the
// hook a `Bash` invocation carrying `command`, and the hook answers with a
// decision. No `break-glass` subcommand is involved -- the command under test
// is the *argument*, which is exactly how an agent reaches the guard. Driven as
// a real process, so the block is the hook's own verdict, not a library call.
function runHookEvaluate(artifacts, command) {
  const payload = {
    invocationId: `bg-agent-${Math.random().toString(16).slice(2)}`,
    agentName: 'bg-agent',
    sessionId: 'bg-agent-session',
    toolName: 'shell',
    args: { command },
    cwd: ROOT,
    workspaceRoot: ROOT,
  };
  const result = spawnSync(process.execPath, [
    HOOK,
    '--profile', 'generic',
    '--workspace-root', ROOT,
    '--receipt-log', path.join(artifacts, 'receipts.jsonl'),
    '--memory-path', path.join(artifacts, 'memory.json'),
    '--db-path', path.join(artifacts, 'memory.db'),
  ], {
    cwd: ROOT,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      HUQAN_BREAK_GLASS_DIR: artifacts,
      HUQAN_EXTERNAL_GUARD_REQUIRE_IDENTITY: 'allow',
      HUQAN_EXTERNAL_GUARD_REQUIRE_SIGNED_IDENTITY: 'allow',
    },
  });
  const lines = String(result.stdout || '').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed.decision === 'string') return parsed;
    } catch (_) { /* not the verdict line */ }
  }
  return { decision: null, reason: null, stderr: result.stderr, status: result.status };
}

// The operator path, driven in-process. The operator credential lives at the
// composition root (bin/huqan-gate-hook.js) and reaches this AgentAction module
// as an `authorize(spec, act)` seam; the real root wires it to
// `requireOperatorPresence` (lib/cli-operator-presence.js). The happy path is
// exercised by standing in for that root: a terminal (isTTY) plus the operator
// typing the scope back, the same credential `terfi`/`onayla` use.
function operatorSeam(args, { answer } = {}) {
  const { requireOperatorPresence } = require('../lib/cli-operator-presence');
  return (spec, act) => requireOperatorPresence(spec, {
    operatorInput: { isTTY: true },
    operatorAsk: () => (answer === undefined ? (args.includes('--window') ? args[args.indexOf('--window') + 1] : 'default') : answer),
  }, act);
}

async function asOperator(directory, args, { answer } = {}) {
  const savedArgv = process.argv;
  const savedDir = process.env.HUQAN_BREAK_GLASS_DIR;
  const lines = [];
  let exitCode = null;
  process.argv = [process.execPath, HOOK, 'break-glass', ...args];
  process.env.HUQAN_BREAK_GLASS_DIR = directory;
  try {
    await runBreakGlassCommand({
      sink: { write: (line) => lines.push(line), setExitCode: (code) => { exitCode = code; } },
      authorize: operatorSeam(args, { answer }),
    });
  } finally {
    process.argv = savedArgv;
    if (savedDir === undefined) delete process.env.HUQAN_BREAK_GLASS_DIR;
    else process.env.HUQAN_BREAK_GLASS_DIR = savedDir;
  }
  let report = null;
  try { report = JSON.parse(lines.join('')); } catch (_) { report = null; }
  return { status: exitCode, report };
}

test('the operator issues a window and it prints', async t => {
  const directory = scratch(t);
  const issued = await asOperator(directory, ['issue', '--reason', '18:40 CI broken', '--actor', 'operator:cli', '--ttl-ms', '60000', '--max-uses', '3']);
  assert.equal(issued.status, 0, JSON.stringify(issued.report));
  assert.equal(issued.report.ok, true);
  assert.equal(issued.report.window.reason, '18:40 CI broken');
  assert.equal(issued.report.window.maxUses, 3);

  const status = run(directory, ['status']);
  assert.equal(status.status, 0);
  assert.equal(status.report.windows.length, 1);
  assert.equal(status.report.windows[0].active, true);
});

test('issue without a reason refuses with exit 1', t => {
  const directory = scratch(t);
  const refused = run(directory, ['issue', '--actor', 'operator:cli']);
  assert.equal(refused.status, 1);
  assert.equal(refused.report.error, 'BREAK_GLASS_ISSUE_FAILED');
  assert.match(refused.report.message, /needs a reason/);
});

test('issue with an out-of-range bound refuses with exit 1', t => {
  const directory = scratch(t);
  const refused = run(directory, ['issue', '--reason', 'x', '--actor', 'op', '--ttl-ms', '99999999']);
  assert.equal(refused.status, 1);
  assert.equal(refused.report.error, 'BREAK_GLASS_INVALID_BOUND');
});

test('the operator lifts a window and it reports the change', async t => {
  const directory = scratch(t);
  const issued = await asOperator(directory, ['issue', '--reason', 'hotfix', '--actor', 'operator:cli']);
  const windowId = issued.report.window.windowId;
  const lifted = await asOperator(directory, ['lift', '--window', windowId, '--actor', 'operator:cli']);
  assert.equal(lifted.status, 0);
  assert.equal(lifted.report.lifted, true);
  const status = run(directory, ['status']);
  assert.equal(status.report.windows[0].active, false);
  assert.equal(status.report.windows[0].inactiveReason, 'break_glass_window_lifted');
});

test('the operator must type the window id back to lift', async t => {
  const directory = scratch(t);
  const issued = await asOperator(directory, ['issue', '--reason', 'hotfix', '--actor', 'operator:cli']);
  const windowId = issued.report.window.windowId;
  const wrong = await asOperator(directory, ['lift', '--window', windowId, '--actor', 'operator:cli'], { answer: 'not-the-id' });
  assert.equal(wrong.status, 4);
  assert.equal(wrong.report.error, 'OPERATOR_AUTH_REQUIRED');
  assert.match(wrong.report.message, /operator_confirmation_mismatch/);
  // Nothing was lifted.
  assert.equal(run(directory, ['status']).report.windows[0].active, true);
});

test('lift without a window id refuses with exit 1', t => {
  const directory = scratch(t);
  const refused = run(directory, ['lift', '--actor', 'operator:cli']);
  assert.equal(refused.status, 1);
  assert.equal(refused.report.reason, 'break_glass_window_not_found');
});

test('an unknown verb exits 2', t => {
  const directory = scratch(t);
  const unknown = run(directory, ['wat']);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.report.error, 'UNKNOWN_BREAK_GLASS_COMMAND');
});

// İP-2: who may open a window. A spawned process has no terminal -- an agent's
// shell, a pipe and a heredoc all look like this -- so `issue` and `lift` are
// refused with exit 4 before the ledger is touched. This is the boundary the
// agent meets: it cannot open the window that would lift the gate holding it.
test('issue without an interactive terminal is refused with exit 4', t => {
  const directory = scratch(t);
  const refused = run(directory, ['issue', '--reason', 'hotfix', '--workspace-id', 'default']);
  assert.equal(refused.status, 4, JSON.stringify(refused.report));
  assert.equal(refused.report.error, 'OPERATOR_AUTH_REQUIRED');
  assert.match(refused.report.message, /operator_terminal_required/);
  // Nothing was written: the refusal is before the ledger.
  assert.equal(run(directory, ['status']).report.windows.length, 0);
});

test('lift without an interactive terminal is refused with exit 4', t => {
  const directory = scratch(t);
  const refused = run(directory, ['lift', '--window', 'some-window']);
  assert.equal(refused.status, 4, JSON.stringify(refused.report));
  assert.equal(refused.report.error, 'OPERATOR_AUTH_REQUIRED');
});

test('status is a read: no terminal needed, nothing changes', t => {
  const directory = scratch(t);
  const status = run(directory, ['status']);
  assert.equal(status.status, 0);
  assert.equal(status.report.ok, true);
  assert.deepEqual(status.report.windows, []);
});

// İP-2, the whole point stated as one test: only an operator may issue a
// window, and an agent cannot reach that path through its own hook -- neither
// as a guarded tool call nor by invoking the hook's verb directly.
//
// The agent's surface is the pre-execution guard: its shell asks the hook to
// decide a `Bash` call, and the hook answers `block` because `break-glass` is an
// operator-decision command. The direct path (the agent runs the hook binary
// itself, `node bin/huqan-gate-hook.js break-glass issue ...`) is the same
// process shape -- no terminal -- so the CLI refuses it with exit 4 before the
// ledger is touched. The operator path that *does* work is the `asOperator`
// case above; these two are the refusals, and together they say an agent cannot
// open the window that would lift the gate holding it.
test('an agent cannot issue a window through its own hook', t => {
  const directory = scratch(t);
  const artifacts = scratch(t);

  // (1) The agent's real surface: a guarded tool call whose command is
  // `break-glass issue`. The hook decides, and it blocks.
  for (const command of [
    'huqan-gate break-glass issue --reason "unblock me" --workspace-id default',
    'huqan-gate break-glass lift --window w --workspace-id default',
  ]) {
    const decided = runHookEvaluate(artifacts, command);
    assert.equal(decided.decision, 'block', `${command}: ${JSON.stringify(decided)}`);
    assert.equal(decided.reason, 'external_action_operator_decision_blocked', command);
  }

  // (2) The direct path: the agent runs the hook's own verb, bypassing the
  // guard. It has no interactive terminal, so it is refused, and the ledger
  // directory is left empty -- the refusal is before the write.
  const refused = run(directory, ['issue', '--reason', 'unblock me', '--workspace-id', 'default']);
  assert.equal(refused.status, 4, JSON.stringify(refused.report));
  assert.equal(refused.report.error, 'OPERATOR_AUTH_REQUIRED');
  assert.match(refused.report.message, /operator_terminal_required/);
  assert.deepEqual(fs.readdirSync(directory), [], 'the ledger must not be written');

  // Nothing is open, so there is nothing for the agent to have opened.
  assert.deepEqual(run(directory, ['status']).report.windows, []);
});
