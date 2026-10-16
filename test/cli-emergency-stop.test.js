'use strict';

// #3905: the emergency stop was enforced on MCP and HTTP but not on the CLI,
// so `huqan sor` / `huqan verify` kept answering from a stopped workspace.
// These tests pin CLI#execute to the same decision: the same ledger, the same
// EMERGENCY_STOPPED code, and no kernel read once the workspace is stopped.
//
// The kernels below are deliberately bare objects, not real Kernels: a command
// that reached the kernel would throw on the missing method, so a refusal
// also proves the read never happened. `gateResult: null` skips the mutation
// gate the same way in-process callers do; the stop is consulted before it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CLI = require('../cli');
const { createEmergencyStop } = require('../lib/emergency-stop');
const { EMERGENCY_STOPPED_CODE, COMMANDS_REACHABLE_UNDER_STOP, cliEmergencyStopRefusal, formatCliEmergencyStopRefusal } = require('../lib/cli-gate-evaluation');

function stopDir(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-3905-cli-stop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function stoppedLedger(t) {
  const ledger = createEmergencyStop({ directory: stopDir(t) });
  ledger.stop({ scope: 'workspace', workspaceId: 'default', reason: 'parity probe', actor: 'test' });
  return ledger;
}

// A CLI whose kernel counts every read: construction may touch it (Dream),
// but a refused command must leave every counter at zero.
function stoppedCli(t) {
  const touches = { ask: 0, verify: 0, learn: 0 };
  const kernel = {
    ask: () => { touches.ask += 1; return { data: { answer: 'must not answer' } }; },
    verify: () => { touches.verify += 1; return { data: {}, evidence: [] }; },
    learn: () => { touches.learn += 1; return { ok: true, data: {} }; },
  };
  const cli = new CLI({ kernelInstance: kernel, emergencyStop: stoppedLedger(t) });
  return { cli, touches };
}

test('a stopped workspace refuses CLI read commands with EMERGENCY_STOPPED', (t) => {
  const { cli, touches } = stoppedCli(t);
  for (const [command, args] of [['sor', 'kedi nedir'], ['verify', 'kedi hayvandir'], ['llm-sor', 'kedi nedir']]) {
    const output = cli.execute(command, args);
    assert.match(String(output), new RegExp(EMERGENCY_STOPPED_CODE), `${command} names the stop`);
  }
  assert.equal(touches.ask, 0, 'ask never reached the kernel');
  assert.equal(touches.verify, 0, 'verify never reached the kernel');
});

test('a stopped workspace refuses CLI mutations without queuing a review', (t) => {
  const { cli, touches } = stoppedCli(t);
  const output = cli.execute('öğret', 'kedi hayvandir');
  assert.match(String(output), new RegExp(EMERGENCY_STOPPED_CODE));
  assert.equal(touches.learn, 0, 'learn never reached the kernel');
  assert.doesNotMatch(String(output), /inceleme kuyruguna/, 'no learn review is queued as a side effect');
});

test('the stop refusal is a blocked JSON envelope under --json', (t) => {
  const { cli } = stoppedCli(t);
  const output = cli.execute('sor', 'kedi nedir', { json: true });
  assert.equal(output.ok, false);
  assert.equal(output.status, 'blocked');
  assert.equal(output.error.code, EMERGENCY_STOPPED_CODE);
});

test('the allowlisted commands stay reachable under a stop', (t) => {
  const { cli } = stoppedCli(t);
  for (const command of [...COMMANDS_REACHABLE_UNDER_STOP].filter((name) => ['yardım', 'selam', 'anlamadım'].includes(name))) {
    const output = cli.execute(command, '', { gateResult: null });
    assert.equal(typeof output, 'string', `${command} still answers`);
    assert.doesNotMatch(output, new RegExp(EMERGENCY_STOPPED_CODE), `${command} is not refused`);
  }
});

test('without a stop the CLI answers as before', (t) => {
  const ledger = createEmergencyStop({ directory: stopDir(t) });
  const cli = new CLI({
    kernelInstance: { ask: () => ({ data: { answer: 'Cevap: kedi' } }) },
    emergencyStop: ledger,
  });
  const output = cli.execute('sor', 'kedi nedir', { gateResult: null });
  assert.match(String(output), /kedi/);
  assert.doesNotMatch(String(output), new RegExp(EMERGENCY_STOPPED_CODE));
});

test('an agent-scoped stop does not block the unattributed CLI caller', (t) => {
  const ledger = createEmergencyStop({ directory: stopDir(t) });
  ledger.stop({ scope: 'agent', workspaceId: 'default', agentId: 'some-agent', reason: 'probe', actor: 'test' });
  const cli = new CLI({
    kernelInstance: { ask: () => ({ data: { answer: 'Cevap: kedi' } }) },
    emergencyStop: ledger,
  });
  const output = cli.execute('sor', 'kedi nedir', { gateResult: null });
  assert.doesNotMatch(String(output), new RegExp(EMERGENCY_STOPPED_CODE));
});

test('the gate tolerates a ledger that answers nothing', () => {
  assert.equal(cliEmergencyStopRefusal({ emergencyStop: { check: () => null }, command: 'sor' }), null);
});

test('the refusal carries a missing scope and reason as null', () => {
  const refusal = cliEmergencyStopRefusal({
    emergencyStop: { check: () => ({ stopped: true, scope: null, reason: null }) },
    command: 'sor',
  });
  assert.equal(refusal.code, EMERGENCY_STOPPED_CODE);
  assert.equal(refusal.scope, null);
  assert.equal(refusal.reason, null);
  const plain = formatCliEmergencyStopRefusal(refusal);
  assert.match(plain, /scope: workspace/);
  const json = formatCliEmergencyStopRefusal(refusal, { json: true });
  assert.equal(json.error.code, EMERGENCY_STOPPED_CODE);
});

test('the gate defaults hold without options or a command', (t) => {
  assert.equal(cliEmergencyStopRefusal(), null);
  const ledger = createEmergencyStop({ directory: stopDir(t) });
  assert.equal(cliEmergencyStopRefusal({ emergencyStop: ledger }), null);
});
