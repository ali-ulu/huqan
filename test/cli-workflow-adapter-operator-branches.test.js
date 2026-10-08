'use strict';

// The argv-only operator commands runCliArgv handles before the interactive
// parser (#2505 F stop/lift, #2591 integrity): the idempotent outcomes, the
// defaults, both output modes and the error split (a TypeError is invalid
// input, anything else propagates). A stub ledger keeps each outcome explicit.

const assert = require('node:assert/strict');
const test = require('node:test');

const { runCliArgv, CLI_EXIT_CODES } = require('../lib/cli-workflow-adapter');

const WEBHOOK_VARIABLES = [
  'HUQAN_NOTIFY_WEBHOOK_URL', 'HUQAN_NOTIFY_WEBHOOK_SECRET',
  'AXIOM_NOTIFY_WEBHOOK_URL', 'AXIOM_NOTIFY_WEBHOOK_SECRET',
];

function stubLedger(overrides = {}) {
  const calls = [];
  return {
    calls,
    check: () => ({ stopped: false }),
    stop: (input) => { calls.push(['stop', input]); return { created: false }; },
    lift: (input) => { calls.push(['lift', input]); return { lifted: false }; },
    verifyIntegrity: () => ({ ok: true, reason: null, details: null }),
    listIntegrityViolations: () => [],
    ...overrides,
  };
}

async function run(argv, ledger) {
  const out = [];
  const err = [];
  const result = await runCliArgv(argv, { stdout: (value) => out.push(value), stderr: (value) => err.push(value) }, { emergencyStop: ledger });
  return { result, out, err };
}

function withoutWebhook(t) {
  const saved = Object.fromEntries(WEBHOOK_VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of WEBHOOK_VARIABLES) delete process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}

test('a repeated stop reports already stopped, with the default workspace and the agent', async () => {
  const ledger = stubLedger();
  const { result, out } = await run(['stop', '--scope', 'agent', '--agent', 'a1'], ledger);
  assert.equal(result.exitCode, CLI_EXIT_CODES.completed);
  assert.deepEqual(out, ['Already stopped: agent default a1']);
  assert.equal(ledger.calls[0][1].workspaceId, 'default');
  assert.equal(ledger.calls[0][1].agentId, 'a1');
  assert.equal(ledger.calls[0][1].actor, 'operator:cli');
});

test('a lift with nothing stopped reports not stopped', async () => {
  const { result, out } = await run(['lift', '--scope', 'workspace', '--workspace', 'w'], stubLedger());
  assert.equal(result.exitCode, CLI_EXIT_CODES.completed);
  assert.deepEqual(out, ['Not stopped: workspace w']);
});

test('an invalid stop is an INVALID_INPUT envelope under --json', async () => {
  const ledger = stubLedger({ stop: () => { throw new TypeError('needs a scope'); } });
  const { result, out } = await run(['stop', '--json'], ledger);
  assert.equal(result.exitCode, CLI_EXIT_CODES.invalid_input);
  const envelope = JSON.parse(out[0]);
  assert.equal(envelope.error.code, 'INVALID_INPUT');
  assert.match(envelope.error.message, /needs a scope/);
});

test('a stop that fails for another reason propagates instead of passing as invalid input', async () => {
  const ledger = stubLedger({ stop: () => { throw new Error('disk full'); } });
  await assert.rejects(run(['stop', '--scope', 'workspace'], ledger), /disk full/);
});

test('integrity reports a clean ledger, and past violations on a verifying one', async () => {
  const clean = await run(['integrity'], stubLedger());
  assert.equal(clean.result.exitCode, CLI_EXIT_CODES.completed);
  assert.deepEqual(clean.out, ['Ledger verifies, no violations on record.']);

  const past = await run(['integrity'], stubLedger({ listIntegrityViolations: () => [{ seq: 1 }, { seq: 2 }] }));
  assert.deepEqual(past.out, ['Ledger verifies, 2 past violation(s) on record.']);
});

test('integrity names the ledger reason of a violation, falling back to the top-level reason', async () => {
  const detailed = await run(['integrity'], stubLedger({
    verifyIntegrity: () => ({ ok: false, reason: 'integrity_violation', details: { ledgerReason: 'hash_mismatch' } }),
    listIntegrityViolations: () => [{ seq: 3 }],
  }));
  assert.equal(detailed.result.exitCode, CLI_EXIT_CODES.completed);
  assert.deepEqual(detailed.out, ['INTEGRITY VIOLATION: hash_mismatch (1 recorded)']);

  const bare = await run(['integrity'], stubLedger({ verifyIntegrity: () => ({ ok: false, reason: 'integrity_violation' }) }));
  assert.deepEqual(bare.out, ['INTEGRITY VIOLATION: integrity_violation (0 recorded)']);
});

test('integrity --json returns the summary in a completed envelope', async () => {
  const { result, out } = await run(['integrity', '--json'], stubLedger({ listIntegrityViolations: () => [{ seq: 1 }] }));
  assert.equal(result.exitCode, CLI_EXIT_CODES.completed);
  const envelope = JSON.parse(out[0]);
  assert.equal(envelope.workflowId, result.workflowId);
  assert.equal(envelope.data.ok, true);
  assert.deepEqual(envelope.data.violations, [{ seq: 1 }]);
});

test('integrity --notify refuses to run without a webhook, in both output modes', async (t) => {
  withoutWebhook(t);
  const text = await run(['integrity', '--notify'], stubLedger());
  assert.equal(text.result.exitCode, CLI_EXIT_CODES.invalid_input);
  assert.match(text.err[0], /Refusing to notify silently/);

  const json = await run(['integrity', '--notify', '--json'], stubLedger());
  assert.equal(json.result.exitCode, CLI_EXIT_CODES.invalid_input);
  assert.equal(JSON.parse(json.out[0]).error.code, 'INVALID_INPUT');
});

test('integrity splits a TypeError from any other failure', async () => {
  const invalid = await run(['integrity'], stubLedger({ verifyIntegrity: () => { throw new TypeError('bad ledger'); } }));
  assert.equal(invalid.result.exitCode, CLI_EXIT_CODES.invalid_input);
  assert.deepEqual(invalid.err, ['bad ledger']);

  await assert.rejects(run(['integrity'], stubLedger({ verifyIntegrity: () => { throw new Error('io'); } })), /io/);
});
