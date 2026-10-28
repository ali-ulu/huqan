'use strict';

// Break-glass windows (İP-2): the four bounds, the one relaxation it may make,
// and what happens when HUQAN itself is not answering.
//
// Every assertion here runs against the real ledger on a temp directory and the
// real guard, not a mock verdict. The load-bearing claim -- a window may only
// turn a review into an allow, never a block -- is asserted on a deploy, a
// force-push and a destructive delete, which are blocks the guard reaches on
// its own rules.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBreakGlass, MAX_WINDOW_MS, MAX_USES, BREAK_GLASS_SCHEMA_VERSION } = require('../lib/break-glass');
const { applyBreakGlass } = require('../lib/break-glass-gate');
const { evaluateExternalAction } = require('../lib/external-action-guard');

const ROOT = path.resolve(__dirname, '..');

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-break-glass-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
}

/** A ledger whose clock the test drives, so expiry is deterministic. */
function fixedLedger(directory, clock) {
  return createBreakGlass({ directory, now: () => clock.value });
}

function decide(command, options = {}) {
  return evaluateExternalAction({
    invocationId: `bg-${Math.random().toString(16).slice(2)}`,
    agentName: 'break-glass-test',
    sessionId: 'session',
    toolName: 'Bash',
    args: { command },
    cwd: ROOT,
    workspaceRoot: ROOT,
  }, {
    receiptWriter: { append() {} },
    requireIdentityCard: false,
    requireSignedIdentityCard: false,
    ...options,
  });
}

test('a window requires a reason and an actor', t => {
  const ledger = fixedLedger(scratch(t), { value: '2026-10-27T18:40:00.000Z' });
  assert.throws(() => ledger.issue({ actor: 'operator:cli' }), /needs a reason/);
  assert.throws(() => ledger.issue({ reason: 'hotfix' }), /needs the operator/);
  // Whitespace is not a reason.
  assert.throws(() => ledger.issue({ actor: 'operator:cli', reason: '   ' }), /needs a reason/);
});

test('a window is bounded in time, uses and category', t => {
  const ledger = fixedLedger(scratch(t), { value: '2026-10-27T18:40:00.000Z' });
  assert.throws(() => ledger.issue({ actor: 'op', reason: 'x', ttlMs: MAX_WINDOW_MS + 1 }), /ttl must be an integer/);
  assert.throws(() => ledger.issue({ actor: 'op', reason: 'x', ttlMs: 0 }), /ttl must be an integer/);
  assert.throws(() => ledger.issue({ actor: 'op', reason: 'x', maxUses: MAX_USES + 1 }), /maxUses must be an integer/);
  assert.throws(() => ledger.issue({ actor: 'op', reason: 'x', maxUses: -1 }), /maxUses must be an integer/);

  const issued = ledger.issue({ actor: 'op', reason: 'hotfix', ttlMs: 60000, maxUses: 2, categories: ['TOOL_CHAIN_EXECUTION'] });
  assert.equal(issued.ok, true);
  assert.equal(issued.window.expiresAt, '2026-10-27T18:41:00.000Z');
  assert.equal(issued.window.maxUses, 2);
  assert.deepEqual(issued.window.categories, ['TOOL_CHAIN_EXECUTION']);
});

test('a window only ever relaxes a review, never a block', t => {
  const clock = { value: '2026-10-27T18:40:00.000Z' };
  const ledger = fixedLedger(scratch(t), clock);
  const { window } = ledger.issue({ actor: 'operator:cli', reason: '18:40 CI broken', ttlMs: 600000, maxUses: 10 });
  const breakGlass = { ledger, windowId: window.windowId, actor: 'operator:cli' };

  // A review becomes an allow, and the reason names the window.
  const reviewed = decide('npm test', { breakGlass });
  assert.equal(reviewed.decision, 'allow');
  assert.equal(reviewed.reason, 'external_action_break_glass_allowed');
  assert.equal(reviewed.findings.at(-1).gate, 'break-glass');
  assert.equal(reviewed.findings.at(-1).windowId, window.windowId);

  // A block stays a block: deploy, force-push, destructive delete.
  for (const command of ['npm publish', 'git push --force origin main', 'rm -rf /', 'git branch -D main']) {
    const blocked = decide(command, { breakGlass });
    assert.equal(blocked.decision, 'block', `${command} must stay blocked with a window open`);
  }
});

test('every use of a window is recorded and bounded', t => {
  const clock = { value: '2026-10-27T18:40:00.000Z' };
  const ledger = fixedLedger(scratch(t), clock);
  const { window } = ledger.issue({ actor: 'operator:cli', reason: 'hotfix', ttlMs: 600000, maxUses: 2 });
  const breakGlass = { ledger, windowId: window.windowId, actor: 'operator:cli' };

  assert.equal(decide('npm test', { breakGlass }).decision, 'allow');
  assert.equal(decide('npm run lint', { breakGlass }).decision, 'allow');
  // The third use is beyond maxUses: the window is spent, the call goes back to
  // review rather than running.
  assert.equal(decide('npm run build', { breakGlass }).decision, 'review');

  const state = ledger.windowState(window.windowId);
  assert.equal(state.uses, 2);
  assert.equal(state.remainingUses, 0);
  // Two consume entries, each naming the window -- the audit trail, not a footnote.
  const entries = fs.readFileSync(path.join(ledger.directory, 'ledger.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entries.filter((entry) => entry.action === 'consume').length, 2);
});

test('an expired window grants nothing', t => {
  const clock = { value: '2026-10-27T18:40:00.000Z' };
  const ledger = fixedLedger(scratch(t), clock);
  const { window } = ledger.issue({ actor: 'operator:cli', reason: 'hotfix', ttlMs: 60000, maxUses: 5 });
  const breakGlass = { ledger, windowId: window.windowId, actor: 'operator:cli' };

  assert.equal(decide('npm test', { breakGlass }).decision, 'allow');
  clock.value = '2026-10-27T18:41:01.000Z'; // one second past expiry
  assert.equal(decide('npm test', { breakGlass }).decision, 'review');
  const decision = ledger.check({ windowId: window.windowId, workspaceId: 'default' });
  assert.equal(decision.active, false);
  assert.equal(decision.refusal, 'break_glass_window_expired');
});

test('a window is bound to its workspace and category', t => {
  const clock = { value: '2026-10-27T18:40:00.000Z' };
  const ledger = fixedLedger(scratch(t), clock);
  const { window } = ledger.issue({
    workspaceId: 'team-a', actor: 'operator:cli', reason: 'hotfix', ttlMs: 600000, maxUses: 5,
    categories: ['TOOL_CHAIN_EXECUTION'],
  });
  assert.equal(ledger.check({ windowId: window.windowId, workspaceId: 'team-b' }).refusal, 'break_glass_workspace_mismatch');
  assert.equal(ledger.check({ windowId: window.windowId, workspaceId: 'team-a', category: 'DEPLOYMENT' }).refusal, 'break_glass_category_not_permitted');
  assert.equal(ledger.check({ windowId: window.windowId, workspaceId: 'team-a', category: 'TOOL_CHAIN_EXECUTION' }).active, true);
  // A category-less call cannot prove it is inside the scope, so it is refused
  // rather than allowed by omission (#code-review).
  assert.equal(ledger.check({ windowId: window.windowId, workspaceId: 'team-a' }).refusal, 'break_glass_category_not_permitted');
});

test('status() reports a category-scoped window as active, not masked by the scope check', t => {
  // `status()` calls `check()` without a category; after the category fix that
  // refused every category-scoped window, so the operator saw a live window as
  // inactive and could skip `lift` while it still turned reviews into allows.
  const clock = { value: '2026-10-27T18:40:00.000Z' };
  const ledger = fixedLedger(scratch(t), clock);
  ledger.issue({
    actor: 'operator:cli', reason: 'hotfix', ttlMs: 600000, maxUses: 5,
    categories: ['TOOL_CHAIN_EXECUTION'],
  });
  const [entry] = ledger.status().windows;
  assert.equal(entry.active, true);
  assert.equal(entry.inactiveReason, null);
});

test('a non-object JSON line is corrupt, not a TypeError out of verifyIntegrity', t => {
  // `JSON.parse('null')` returns null; pushed as an entry it made
  // `verifyEntries` read `entry.__unreadable` on null and throw. That escaped
  // `verifyIntegrity`/`status`/`consume` instead of failing closed.
  const clock = { value: '2026-10-27T18:40:00.000Z' };
  const directory = scratch(t);
  const ledger = fixedLedger(directory, clock);
  ledger.issue({ actor: 'operator:cli', reason: 'hotfix', ttlMs: 600000, maxUses: 5 });
  fs.appendFileSync(path.join(directory, 'ledger.jsonl'), 'null\n', 'utf8');

  const integrity = ledger.verifyIntegrity();
  assert.equal(integrity.ok, false);
  assert.equal(integrity.reason, 'ledger_unreadable_or_corrupt');
  const status = ledger.status();
  assert.equal(status.ok, false);
  assert.equal(status.reason, 'break_glass_integrity_violation');
  const consumed = ledger.consume({ windowId: 'nope' });
  assert.equal(consumed.ok, false);
});

test('a second issue for one window in the ledger is rejected, not replayed', t => {
  // `issue()` refuses a duplicate id, but nothing stopped a hand-appended
  // second `issue` -- which `windowState` replayed as a re-issue, widening an
  // open window. `verifyEntries` must reject the shape `issue()` cannot make.
  const { computeEntryHash } = require('../lib/emergency-stop-chain');
  const directory = scratch(t);
  const clock = { value: '2026-10-27T18:40:00.000Z' };
  const ledger = fixedLedger(directory, clock);
  const { window, ledgerEntry } = ledger.issue({ actor: 'operator:cli', reason: 'hotfix', ttlMs: 60000, maxUses: 1 });

  const secondPayload = {
    action: 'issue', windowId: window.windowId, workspaceId: window.workspaceId, agentId: null,
    actor: 'operator:cli', operatorIdentity: null, reason: 'extend the window',
    issuedAt: clock.value, expiresAt: '2026-10-27T19:40:00.000Z', maxUses: 50, categories: [],
  };
  const second = { seq: 1, prevHash: ledgerEntry.hash, hash: computeEntryHash(secondPayload, ledgerEntry.hash), ...secondPayload };
  fs.appendFileSync(path.join(directory, 'ledger.jsonl'), `${JSON.stringify(second)}\n`, 'utf8');

  const integrity = ledger.verifyIntegrity();
  assert.equal(integrity.ok, false);
  assert.equal(integrity.reason, 'ledger_duplicate_issue');
  assert.equal(ledger.windowState(window.windowId), null, 'a chain with a duplicate issue grants no window');
  assert.equal(decide('npm test', { breakGlass: { ledger, windowId: window.windowId } }).decision, 'review');
});

test('concurrent consumes stay within maxUses and leave a verifiable chain', async t => {
  // The hook runs as a separate process per tool call, so two calls can consume
  // at once. Without a lock around read-check-append they would both read the
  // same last entry, append the same `seq`/`prevHash`, and corrupt the chain.
  const { spawn } = require('node:child_process');
  const directory = scratch(t);
  const clock = { value: '2026-10-27T18:40:00.000Z' };
  const ledger = fixedLedger(directory, clock);
  const { window } = ledger.issue({ actor: 'operator:cli', reason: 'hotfix', ttlMs: 600000, maxUses: 3 });

  const modulePath = path.join(ROOT, 'lib', 'break-glass.js');
  const worker = 'const { createBreakGlass } = require(process.argv[1]);'
    + "const ledger = createBreakGlass({ directory: process.argv[2], now: () => '2026-10-27T18:40:10.000Z' });"
    + "const out = ledger.consume({ windowId: process.argv[3], workspaceId: 'default' });"
    + 'process.stdout.write(String(out.consumed));';
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', worker, modulePath, directory, window.windowId], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', () => resolve(out.trim()));
  });
  const results = await Promise.all(Array.from({ length: 8 }, run));
  const consumed = results.filter((value) => value === 'true').length;

  const integrity = ledger.verifyIntegrity();
  assert.equal(integrity.ok, true, `chain corrupted: ${integrity.reason}`);
  const state = ledger.windowState(window.windowId);
  assert.ok(state.uses <= 3, `consumed ${state.uses} of 3 allowed uses`);
  assert.equal(state.uses, consumed, 'the recorded uses match the calls that reported success');
  const entries = fs.readFileSync(path.join(directory, 'ledger.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entries.filter((entry) => entry.action === 'consume').length, state.uses);
});

test('a lifted window grants nothing, and lifting twice records once', t => {
  const clock = { value: '2026-10-27T18:40:00.000Z' };
  const ledger = fixedLedger(scratch(t), clock);
  const { window } = ledger.issue({ actor: 'operator:cli', reason: 'hotfix', ttlMs: 600000, maxUses: 5 });
  const first = ledger.lift({ windowId: window.windowId, actor: 'operator:cli' });
  assert.equal(first.lifted, true);
  const second = ledger.lift({ windowId: window.windowId, actor: 'operator:cli' });
  assert.equal(second.lifted, false);
  assert.equal(decide('npm test', { breakGlass: { ledger, windowId: window.windowId } }).decision, 'review');
});

test('a tampered ledger grants nothing and refuses new writes', t => {
  const clock = { value: '2026-10-27T18:40:00.000Z' };
  const directory = scratch(t);
  const ledger = fixedLedger(directory, clock);
  const { window } = ledger.issue({ actor: 'operator:cli', reason: 'hotfix', ttlMs: 600000, maxUses: 5 });

  // Rewrite the ledger with a forged entry: the chain no longer verifies.
  const file = path.join(directory, 'ledger.jsonl');
  const entries = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  entries[0].reason = 'forged reason';
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

  const integrity = ledger.verifyIntegrity();
  assert.equal(integrity.ok, false);
  // Fail-closed: no window resolves, and issuing onto a broken chain refuses.
  assert.equal(ledger.windowState(window.windowId), null);
  assert.equal(decide('npm test', { breakGlass: { ledger, windowId: window.windowId } }).decision, 'review');
  const refused = ledger.issue({ actor: 'operator:cli', reason: 'another' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'break_glass_integrity_violation');
});

test('an id no operator issued does not resolve', t => {
  const ledger = fixedLedger(scratch(t), { value: '2026-10-27T18:40:00.000Z' });
  const decision = ledger.check({ windowId: 'made-up-id', workspaceId: 'default' });
  assert.equal(decision.active, false);
  assert.equal(decision.refusal, 'break_glass_window_not_found');
  assert.equal(decide('npm test', { breakGlass: { ledger, windowId: 'made-up-id' } }).decision, 'review');
});

test('the gate reports a refusal when no window is configured', () => {
  // The pure seam: a review with no break-glass option is left exactly as it was.
  const result = applyBreakGlass({ decision: 'review', envelope: { workspaceId: 'default' } });
  assert.equal(result.decision, 'review');
  assert.equal(result.applied, false);
  assert.equal(result.refusal, 'break_glass_not_configured');
  // And a block is never even considered.
  assert.equal(applyBreakGlass({ decision: 'block', envelope: {}, breakGlass: { ledger: {}, windowId: 'x' } }).applied, false);
});

test('18:40 CI broken: the window unblocks the fix path and nothing else', t => {
  // The scenario the task names, end to end over the real guard and ledger.
  // The 18:40 hotfix needs `npm test`, `npm run lint` and `git commit` to run
  // without a prompt; it does not need -- and must not get -- a deploy or a
  // force-push.
  const clock = { value: '2026-10-27T18:40:00.000Z' };
  const ledger = fixedLedger(scratch(t), clock);
  const { window } = ledger.issue({
    workspaceId: 'default',
    reason: '18:40 CI is red; unblock the hotfix path for 30 minutes',
    actor: 'operator:cli',
    ttlMs: 30 * 60 * 1000,
    maxUses: 20,
  });
  const breakGlass = { ledger, windowId: window.windowId, actor: 'operator:cli' };

  // The fix path is unblocked.
  for (const command of ['npm test', 'npm run lint', 'git commit -m hotfix', 'npm run build']) {
    assert.equal(decide(command, { breakGlass }).decision, 'allow', `${command} should run under the window`);
  }
  // The release path is not.
  for (const command of ['npm publish', 'git push --force origin main', 'git push origin main']) {
    assert.equal(decide(command, { breakGlass }).decision, 'block', `${command} must stay blocked`);
  }
  // The window records every use and can be lifted when the incident closes.
  const status = ledger.status();
  assert.equal(status.windows[0].uses, 4);
  assert.equal(ledger.lift({ windowId: window.windowId, actor: 'operator:cli' }).lifted, true);
  assert.equal(decide('npm test', { breakGlass }).decision, 'review');
});

test('if HUQAN is down, the window grants nothing and the guard fails closed', t => {
  // The documented crash behaviour. A window is state inside HUQAN; when no
  // process reads it, nothing is granted. A ledger whose directory has been
  // removed models "the store is not there": every read is inactive, not an
  // exception, and the guard's own fail-closed exit handles the process case.
  const directory = scratch(t);
  const clock = { value: '2026-10-27T18:40:00.000Z' };
  const ledger = fixedLedger(directory, clock);
  const { window } = ledger.issue({ actor: 'operator:cli', reason: 'hotfix', ttlMs: 600000, maxUses: 5 });
  fs.rmSync(directory, { recursive: true, force: true });

  const decision = ledger.check({ windowId: window.windowId, workspaceId: 'default' });
  assert.equal(decision.active, false);
  assert.equal(decide('npm test', { breakGlass: { ledger, windowId: window.windowId } }).decision, 'review');
});

test('the ledger schema version is recorded so a reader can tell the format', t => {
  const ledger = fixedLedger(scratch(t), { value: '2026-10-27T18:40:00.000Z' });
  const { ledgerEntry } = ledger.issue({ actor: 'operator:cli', reason: 'hotfix' });
  assert.equal(typeof BREAK_GLASS_SCHEMA_VERSION, 'string');
  assert.equal(ledgerEntry.action, 'issue');
  assert.equal(typeof ledgerEntry.hash, 'string');
  assert.equal(ledgerEntry.prevHash, null);
});

// İP-2, the load-bearing question: can the agent open its own window? It must
// not. The answer has two halves, and both are asserted here.
//
//   1. The hook refuses the operator verb. An agent's shell is the input to the
//      hook, and `break-glass issue` is an operator decision there, so the agent
//      meets a *block*, not a review it might approve.
//   2. The CLI refuses without an operator terminal. Even reached directly, the
//      verb needs the operator at a terminal, so a pipe or a heredoc (what an
//      agent's shell is) is refused before the ledger is written.
//
// Neither half alone is enough: (1) is the surface the agent meets, (2) is the
// backstop if it finds another way to the binary.
test('the hook blocks an agent that runs break-glass issue through its own shell', () => {
  const commands = [
    'huqan-gate break-glass issue --reason "unblock me" --workspace-id default',
    'node bin/huqan-gate-hook.js break-glass issue --reason x',
    'npx huqan-gate break-glass issue --reason x',
    'huqan break-glass issue --reason x',
    'bash -c "huqan-gate break-glass lift --window w"',
  ];
  for (const command of commands) {
    const result = decide(command);
    assert.equal(result.decision, 'block', `${command} must be blocked, got ${result.decision}`);
    assert.equal(result.reason, 'external_action_operator_decision_blocked', command);
  }
});

test('the hook leaves the read path and the hook flag alone', () => {
  // The hook only ever *reads* a window: `evaluate --break-glass <id>` is the
  // agent's own call and stays ordinary. So do the read-only management verbs.
  for (const command of [
    'huqan-gate evaluate --break-glass w1 --event x',
    'huqan-gate status',
    'huqan-gate overview',
    'huqan-gate agents',
    'git status',
  ]) {
    assert.notEqual(decide(command).reason, 'external_action_operator_decision_blocked', command);
  }
});

// İP-2, the second self-lift: the guard's own management verbs. `uninstall`
// removes the guard, `install` rewrites its wiring and `policy` rewrites the
// file it enforces. Left at the ordinary review, a break-glass window -- which
// promotes a review to an allow -- would let the agent approve its own guard
// removal. They are operator-only, so the hook blocks them and a window can
// never reach them.
test('the hook blocks the guard-management verbs an agent must not run', () => {
  for (const command of [
    'huqan-gate uninstall --profile claude-code',
    'huqan-gate install --profile claude-code',
    'huqan-gate policy apply permissive',
    'npx huqan-gate uninstall --profile codex',
  ]) {
    assert.equal(decide(command).decision, 'block', command);
    assert.equal(decide(command).reason, 'external_action_operator_decision_blocked', command);
  }
});

test('a break-glass window cannot promote the guard-management block to an allow', t => {
  // The window only ever relaxes a *review*; a block is untouched, so even with
  // a live, in-scope window the removal stays refused.
  const directory = scratch(t);
  const clock = { value: '2026-10-27T18:40:00.000Z' };
  const ledger = fixedLedger(directory, clock);
  const { window } = ledger.issue({ workspaceId: 'default', actor: 'operator:cli', reason: 'hotfix', ttlMs: 600000, maxUses: 5 });
  const withWindow = { breakGlass: { ledger, windowId: window.windowId, actor: 'agent' } };
  assert.equal(decide('huqan-gate uninstall --profile claude-code', withWindow).decision, 'block');
  assert.equal(decide('huqan-gate policy apply permissive', withWindow).decision, 'block');
});

test('the CLI refuses issue without an operator terminal, before the ledger', async t => {
  const directory = scratch(t);
  const { runBreakGlassCommand } = require('../lib/gate-hook-break-glass');
  const savedArgv = process.argv;
  const savedDir = process.env.HUQAN_BREAK_GLASS_DIR;
  const lines = [];
  let exitCode = null;
  process.argv = [process.execPath, 'huqan-gate-hook.js', 'break-glass', 'issue', '--reason', 'hotfix', '--workspace-id', 'default'];
  process.env.HUQAN_BREAK_GLASS_DIR = directory;
  try {
    // No operatorInput override: the test runner's own stdin is not a TTY.
    await runBreakGlassCommand({
      sink: { write: (line) => lines.push(line), setExitCode: (code) => { exitCode = code; } },
    });
  } finally {
    process.argv = savedArgv;
    if (savedDir === undefined) delete process.env.HUQAN_BREAK_GLASS_DIR;
    else process.env.HUQAN_BREAK_GLASS_DIR = savedDir;
  }
  const report = JSON.parse(lines.join(''));
  assert.equal(exitCode, 4, JSON.stringify(report));
  assert.equal(report.error, 'OPERATOR_AUTH_REQUIRED');
  // The refusal is before the ledger: nothing was written.
  const { createBreakGlass } = require('../lib/break-glass');
  assert.equal(createBreakGlass({ directory }).status().windows.length, 0);
});
