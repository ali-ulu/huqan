'use strict';

// #3550: the `terfi` operator command is the reflective loop's first real
// promotion caller. These tests drive the whole loop through the real CLI
// entry (cli.execute -> runPromoteCommand -> createReflectivePromotion),
// never the loop directly: proposal, canary, bound independent approval,
// promotion, observation and rollback, plus the learner self-approval and
// undeclared-widening refusals through that same caller.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CLI = require('../cli');
const Kernel = require('../kernel');
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');
const { parseCommand } = require('../lib/command-parser');
const { CLI_EXIT_CODES } = require('../lib/cli-workflow-adapter');

const T0 = Date.now() - 60 * 60 * 1000;
const MIN = 60 * 1000;
// #3552: the command vouches only for the OS session user as approver.
const OPERATOR = os.userInfo().username;
const SCOPE = Object.freeze({ tools: Object.freeze(['read']) });
const WIDER_SCOPE = Object.freeze({ tools: Object.freeze(['read', 'write']) });

function runs(count, { cost = 10, negatives = 0, from = 0 } = {}) {
  return Array.from({ length: count }, (_, i) => ({ occurredAt: T0 + (from + i) * MIN,
    learningEligibility: i < negatives ? 'negative_example' : 'positive_procedure',
    executionCost: cost, verificationCost: 1, canaryOverheadCost: 0, eventId: `e${from + i}`, runId: `r${from + i}` }));
}

function writeFiles(dir, { candidateScope = SCOPE, negatives = 0 } = {}) {
  const candidate = { kind: 'replace_text', version: 'v2', scope: candidateScope, params: { path: 'a', oldText: 'x', newText: 'y' } };
  const bound = { kind: 'replace_text', version: 'v1', scope: SCOPE, params: { path: 'a', oldText: 'w', newText: 'x' } };
  const trial = { candidateRuns: runs(12, { cost: 5 }), baselineWindowRuns: runs(12, { cost: 10 }), startAt: T0 };
  const observed = { currentEvents: runs(12, { cost: 5, negatives, from: 100 }) };
  const files = {};
  for (const [name, content] of Object.entries({ candidate, bound, trial, observed })) {
    files[name] = path.join(dir, `${name}.json`);
    fs.writeFileSync(files[name], JSON.stringify(content));
  }
  return files;
}

function makeCli() {
  return new CLI({ kernelInstance: new Kernel(isolatedKernelOptions('terfi-cli')) });
}

function closeCli(cli) {
  try { cli?.agent?.storage?.close?.(); } catch (_) {}
  try { cli?.approvalStore?.close?.(); } catch (_) {}
  try { cli?.kernel?.graph?.close?.(); } catch (_) {}
  try { cli?.kernel?.memory?.close?.(); } catch (_) {}
}

// #3560: an approval needs the operator at a terminal typing the candidate
// version back. These tests stand in for that operator; the presence tests
// below drive the refusals.
const AT_TERMINAL = Object.freeze({ operatorInput: { isTTY: true }, operatorAsk: () => 'v2' });

async function terfi(cli, dir, files, extra = '', presence = AT_TERMINAL) {
  const parsed = parseCommand(`terfi --aday ${files.candidate} --bagli ${files.bound} --deneme ${files.trial} --gozlem ${files.observed} --capability cap ${extra}`, cli.kernel);
  return cli.execute('terfi', parsed.args, { json: true, ...presence });
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-terfi-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('#3550 the operator command drives propose, canary, approval, promote and observe end to end', () => withTempDir(async (dir) => {
  const cli = makeCli();
  try {
    const files = writeFiles(dir);
    const result = JSON.parse(await terfi(cli, dir, files, `--onaylayan ${OPERATOR} --karar approved`));
    const byStep = Object.fromEntries(result.steps.map((s) => [s.step, s]));
    assert.equal(byStep.proposed.ok, true);
    assert.equal(byStep.canary.state, 'canary_passed');
    assert.equal(byStep.promoted.ok, true);
    assert.equal(byStep.observed.ok, true);
    assert.equal(byStep.observed.driftDetected, false);
    assert.ok(!byStep.rolled_back, 'no drift means no rollback move');
    assert.equal(result.ok, true);
    assert.equal(result.moved, true);
  } finally {
    closeCli(cli);
  }
}));

test('#3550 drift observed through the caller rolls back on the operator rollback decision', () => withTempDir(async (dir) => {
  const cli = makeCli();
  try {
    const files = writeFiles(dir, { negatives: 6 });
    const result = JSON.parse(await terfi(cli, dir, files, `--onaylayan ${OPERATOR} --karar approved --geri-alma approved`));
    const byStep = Object.fromEntries(result.steps.map((s) => [s.step, s]));
    assert.equal(byStep.promoted.ok, true);
    assert.equal(byStep.observed.driftDetected, true);
    assert.equal(byStep.rolled_back.ok, true);
  } finally {
    closeCli(cli);
  }
}));

test('#3550 a learner approver is refused by the loop even through the real caller', () => withTempDir(async (dir) => {
  const cli = makeCli();
  try {
    const files = writeFiles(dir);
    const result = JSON.parse(await terfi(cli, dir, files, `--onaylayan ${OPERATOR} --ogreniciler ${OPERATOR} --karar approved`));
    const byStep = Object.fromEntries(result.steps.map((s) => [s.step, s]));
    assert.equal(byStep.proposed.ok, true);
    assert.equal(byStep.canary.state, 'canary_passed');
    assert.equal(byStep.promoted.ok, false);
    assert.equal(byStep.promoted.code, 'self_authorization_refused');
    assert.equal(result.ok, false, 'a refused promotion is not reported as success');
    assert.equal(result.moved, false);
  } finally {
    closeCli(cli);
  }
}));

test('#3552 an approver other than the session user is refused before any record exists', () => withTempDir(async (dir) => {
  const cli = makeCli();
  try {
    const files = writeFiles(dir);
    await assert.rejects(() => terfi(cli, dir, files, `--onaylayan ${OPERATOR}-impostor --karar approved`), /unverified_approver/);
  } finally {
    closeCli(cli);
  }
}));

test('#3552 the session resolver vouches for nobody when the session user is unknown', () => {
  const { sessionPrincipalResolver } = require('../lib/cli-promote');
  assert.equal(sessionPrincipalResolver('')('').ok, false);
  assert.equal(sessionPrincipalResolver('')('anyone').ok, false);
  assert.equal(sessionPrincipalResolver('op')('op').ok, true);
  assert.equal(sessionPrincipalResolver('op')('OP').ok, false);
});

test('#3550 an undeclared widening is refused through the caller before any canary', () => withTempDir(async (dir) => {
  const cli = makeCli();
  try {
    const files = writeFiles(dir, { candidateScope: WIDER_SCOPE });
    const result = JSON.parse(await terfi(cli, dir, files, `--onaylayan ${OPERATOR} --karar approved`));
    const byStep = Object.fromEntries(result.steps.map((s) => [s.step, s]));
    assert.equal(byStep.proposed.ok, false);
    assert.equal(byStep.proposed.code, 'authority_declaration_mismatch');
    assert.ok(!byStep.canary, 'a refused proposal never reaches canary');
  } finally {
    closeCli(cli);
  }
}));

test('#3550 missing flags and unreadable files fail with usage, not a silent refusal', () => withTempDir(async (dir) => {
  const cli = makeCli();
  try {
    assert.throws(() => cli.execute('terfi', parseCommand('terfi --capability cap', cli.kernel).args), /Usage: terfi/);
    assert.throws(() => cli.execute('terfi', parseCommand(`terfi --aday ${path.join(dir, 'missing.json')} --bagli x --deneme x --gozlem x --onaylayan op --karar approved --capability cap`, cli.kernel).args), /cannot read aday file/);
  } finally {
    closeCli(cli);
  }
}));

test('#3550 a refused promotion is never committed as a mutation', () => withTempDir(async (dir) => {
  const cli = makeCli();
  const committed = [];
  cli._commitCliMutation = (...callArgs) => { committed.push(callArgs); return ''; };
  try {
    const files = writeFiles(dir);
    JSON.parse(await terfi(cli, dir, files, `--onaylayan ${OPERATOR} --ogreniciler ${OPERATOR} --karar approved`));
    assert.equal(committed.length, 0);
    JSON.parse(await terfi(cli, dir, files, `--onaylayan ${OPERATOR} --karar approved`));
    assert.equal(committed.length, 1, 'a real promotion is committed exactly once');
  } finally {
    closeCli(cli);
  }
}));

test('#3550 null or empty run files are input errors before the loop starts', () => withTempDir(async (dir) => {
  const cli = makeCli();
  try {
    const files = writeFiles(dir);
    fs.writeFileSync(files.trial, 'null');
    await assert.rejects(() => terfi(cli, dir, files, `--onaylayan ${OPERATOR} --karar approved`), /deneme file must be a JSON object/);
    const fresh = writeFiles(dir);
    fs.writeFileSync(fresh.observed, JSON.stringify({ currentEvents: [] }));
    await assert.rejects(() => terfi(cli, dir, fresh, `--onaylayan ${OPERATOR} --karar approved`), /gozlem currentEvents must be a non-empty array/);
    fs.writeFileSync(fresh.observed, JSON.stringify({ currentEvents: [null] }));
    await assert.rejects(() => terfi(cli, dir, fresh, `--onaylayan ${OPERATOR} --karar approved`), /gozlem currentEvents/);
  } finally {
    closeCli(cli);
  }
}));

test('#3550 a flag whose operand is another flag is rejected, not consumed', () => withTempDir(async (dir) => {
  const cli = makeCli();
  try {
    const files = writeFiles(dir);
    await assert.rejects(() => terfi(cli, dir, files, `--onaylayan ${OPERATOR} --karar approved --workspace --json`), /--workspace needs a value/);
    await assert.rejects(() => terfi(cli, dir, files, `--onaylayan ${OPERATOR} --karar`), /--karar needs a value/);
  } finally {
    closeCli(cli);
  }
}));

test('#3560 the proposer cannot approve even when --ogreniciler leaves it out', () => withTempDir(async (dir) => {
  const cli = makeCli();
  try {
    const files = writeFiles(dir);
    const result = JSON.parse(await terfi(cli, dir, files, `--onaylayan ${OPERATOR} --onerici ${OPERATOR} --ogreniciler someone-else --karar approved`));
    const byStep = Object.fromEntries(result.steps.map((s) => [s.step, s]));
    assert.equal(byStep.promoted.ok, false);
    assert.equal(byStep.promoted.code, 'self_authorization_refused');
  } finally {
    closeCli(cli);
  }
}));

test('#3560 an approval without an interactive terminal is refused before anything runs', () => withTempDir(async (dir) => {
  const cli = makeCli();
  const committed = [];
  cli._commitCliMutation = (...callArgs) => { committed.push(callArgs); return ''; };
  try {
    const files = writeFiles(dir);
    // No presence override: the test runner's own stdin is not a terminal.
    await assert.rejects(() => terfi(cli, dir, files, `--onaylayan ${OPERATOR} --karar approved`, {}),
      (error) => error.code === 'OPERATOR_AUTH_REQUIRED' && /operator_terminal_required/.test(error.message));
    await assert.rejects(() => terfi(cli, dir, files, `--onaylayan ${OPERATOR} --karar rejected --geri-alma approved`, { operatorInput: { isTTY: false } }),
      /operator_terminal_required/);
    assert.equal(committed.length, 0);
  } finally {
    closeCli(cli);
  }
}));

test('#3560 the operator must type the candidate version back', () => withTempDir(async (dir) => {
  const cli = makeCli();
  try {
    const files = writeFiles(dir);
    const asked = [];
    const wrong = { operatorInput: { isTTY: true }, operatorAsk: (question) => { asked.push(question); return 'y'; } };
    await assert.rejects(() => terfi(cli, dir, files, `--onaylayan ${OPERATOR} --karar approved`, wrong), /operator_confirmation_mismatch/);
    assert.match(asked[0], /\(v2\)/);
  } finally {
    closeCli(cli);
  }
}));

test('#3560 declining needs no terminal: nothing is approved', () => withTempDir(async (dir) => {
  const cli = makeCli();
  try {
    const files = writeFiles(dir);
    const result = JSON.parse(await terfi(cli, dir, files, `--onaylayan ${OPERATOR} --karar rejected`, {}));
    const byStep = Object.fromEntries(result.steps.map((s) => [s.step, s]));
    assert.equal(byStep.promoted.code, 'promotion_declined_by_operator');
  } finally {
    closeCli(cli);
  }
}));

test('#3560 the real argv entry maps a terminal-less approval to the unauthorized exit', () => withTempDir(async (dir) => {
  const cli = makeCli();
  try {
    const files = writeFiles(dir);
    const out = [];
    const argv = ['terfi', '--aday', files.candidate, '--bagli', files.bound, '--deneme', files.trial, '--gozlem', files.observed,
      '--capability', 'cap', '--onaylayan', OPERATOR, '--karar', 'approved'];
    const result = await CLI.runCliArgv(argv, { cli, stdout: (line) => out.push(line), stderr: (line) => out.push(line) });
    assert.equal(result.exitCode, CLI_EXIT_CODES.unauthorized);
    assert.match(out.join('\n'), /operator_terminal_required/);
  } finally {
    closeCli(cli);
  }
}));

function fakeReadline() {
  const { EventEmitter } = require('node:events');
  const rl = new EventEmitter();
  rl.question = (prompt, callback) => { rl.pending = callback; };
  return rl;
}

test('#3560 stdin closing before an answer declines the approval instead of hanging', async () => {
  const { askOnce, confirmOperatorPresence } = require('../lib/cli-promote');
  const closed = fakeReadline();
  const asked = askOnce(closed, 'version? ');
  closed.emit('close');
  assert.equal(await asked, '');

  const answered = fakeReadline();
  const reply = askOnce(answered, 'version? ');
  answered.pending('v2');
  assert.equal(await reply, 'v2');
  assert.equal(answered.listenerCount('close'), 0, 'an answered question leaves no close listener behind');

  // The empty answer EOF yields is a declined approval, never a pass.
  const atEof = await confirmOperatorPresence('v2', { input: { isTTY: true }, ask: () => '' });
  assert.equal(atEof.ok, false);
  assert.equal(atEof.code, 'operator_confirmation_mismatch');
});
