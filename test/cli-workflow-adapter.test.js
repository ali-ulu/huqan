'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runCliArgv, CLI_EXIT_CODES, cliEnvelope } = require('../lib/cli-workflow-adapter');
const { cliHelpText } = require('../lib/cli-help');
const { CLI_COMMAND_CAPABILITIES, WORKFLOW_CAPABILITIES } = require('../lib/workflow-contract');

function fakeCli({ parsed, gate = null, output = 'ok', error = null }) {
  return {
    parse: () => parsed,
    _evaluateCliGate: () => gate,
    _formatCliGateMessage: () => 'legacy gate text',
    execute: async () => {
      if (error) throw error;
      return output;
    },
  };
}

test('CLI help is generated from enabled command capabilities', () => {
  const help = cliHelpText();
  const enabled = new Set(WORKFLOW_CAPABILITIES.filter(item => item.availability.cli).map(item => item.workflowId));
  for (const item of CLI_COMMAND_CAPABILITIES) {
    assert.equal(enabled.has(item.workflowId), true, `${item.command} references an enabled CLI workflow`);
    assert.match(help, new RegExp(item.usage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('JSON mode emits a locale-independent completed envelope', async () => {
  const stdout = [];
  const result = await runCliArgv(['ask:', 'cat', 'nedir', '--json'], {
    cli: fakeCli({ parsed: { command: 'sor', args: 'cat nedir', workflowId: 'ask' }, output: 'Cevap: cat' }),
    stdout: value => stdout.push(value),
  });
  const envelope = JSON.parse(stdout[0]);
  assert.equal(result.exitCode, CLI_EXIT_CODES.completed);
  assert.equal(envelope.workflowId, 'ask');
  assert.equal(envelope.status, 'completed');
  assert.deepEqual(envelope.data, { output: 'Cevap: cat' });
  assert.deepEqual(Object.keys(envelope).sort(), [
    'approval', 'confidence', 'data', 'error', 'evidence', 'ok', 'receiptId',
    'status', 'trace', 'traceId', 'workflowId',
  ]);
});

test('bare JSON mode fails with a parseable invalid-input envelope', async () => {
  const stdout = [];
  const result = await runCliArgv(['--json'], { stdout: value => stdout.push(value) });
  assert.equal(result.exitCode, CLI_EXIT_CODES.invalid_input);
  assert.equal(JSON.parse(stdout[0]).error.code, 'INVALID_INPUT');
});

test('JSON review and block decisions keep the existing gate authoritative', async () => {
  for (const [decision, status] of [['review', 'review_required'], ['block', 'blocked']]) {
    const stdout = [];
    let executed = false;
    const cli = fakeCli({
      parsed: { command: 'öğret', args: 'cats are animals', workflowId: 'learn-review' },
      gate: { canExecute: false, decision, reason: 'policy' },
    });
    cli.execute = () => { executed = true; };
    const result = await runCliArgv(['--json', 'learn:', 'cats', 'are', 'animals'], { cli, stdout: value => stdout.push(value) });
    assert.equal(result.exitCode, CLI_EXIT_CODES[status]);
    assert.equal(JSON.parse(stdout[0]).status, status);
    assert.equal(executed, false);
  }
});

test('JSON mode distinguishes invalid, unsupported, partial, and failed outcomes', async () => {
  const cases = [
    { parsed: { command: 'anlamadım', args: '', workflowId: null }, expected: 2, status: 'failed' },
    { parsed: { command: 'mri', args: 'x', workflowId: null }, expected: 3, status: 'capability_not_available' },
    { parsed: { command: 'ajan', args: 'x', workflowId: 'agent-run' }, output: { ok: false, data: { status: 'partial' } }, expected: 7, status: 'partial' },
    { parsed: { command: 'sor', args: 'x', workflowId: 'ask' }, error: Object.assign(new Error('boom'), { code: 'BOOM' }), expected: 8, status: 'failed' },
  ];
  for (const item of cases) {
    const stdout = [];
    const result = await runCliArgv(['--json', 'command'], { cli: fakeCli(item), stdout: value => stdout.push(value) });
    assert.equal(result.exitCode, item.expected);
    assert.equal(JSON.parse(stdout[0]).status, item.status);
  }
});

test('JSON trace retains existing AgentV3 checkpoint and resume fields without inventing run IDs', () => {
  const output = cliEnvelope('agent-run', {
    ok: true,
    data: {
      status: 'paused', checkpointId: 'checkpoint-real', resumeToken: 'resume-real',
      resumed: true, resumedFrom: 'checkpoint-old', evidence: [{ type: 'test' }],
      nextAction: { action: 'approve', tool: 'huqan.learn' }, steps: [{ action: 'inspect' }],
    },
    evidence: [{ type: 'test' }],
  });
  assert.equal(output.trace.runId, null);
  assert.equal(output.trace.checkpointId, 'checkpoint-real');
  assert.equal(output.trace.resumeToken, 'resume-real');
  assert.equal(output.trace.resumed, true);
  assert.equal(output.trace.resumedFrom, 'checkpoint-old');
  assert.deepEqual(output.trace.nextAction, { action: 'approve', tool: 'huqan.learn' });
  assert.deepEqual(output.data.steps, [{ action: 'inspect' }]);
  assert.deepEqual(output.evidence, [{ type: 'test' }]);
});

test('ingest preview exposes a review-only manual source manifest in JSON', async () => {
  const stdout = [];
  let executed = false;
  const cli = fakeCli({ parsed: { command: 'must-not-parse' } });
  cli.execute = () => { executed = true; };
  const result = await runCliArgv([
    'ingest', 'preview', '--type', 'manual', '--ref', 'note-1',
    '--workspace', 'default', '--text', 'review me', '--json',
  ], { cli, stdout: value => stdout.push(value) });
  const envelope = JSON.parse(stdout[0]);

  assert.equal(executed, false);
  assert.equal(result.exitCode, CLI_EXIT_CODES.review_required);
  assert.equal(envelope.workflowId, 'ingest-preview');
  assert.equal(envelope.status, 'review_required');
  assert.equal(envelope.data.sourceManifest.workspaceId, 'default');
  assert.equal(envelope.data.sourceManifest.sourceType, 'manual');
  assert.equal(envelope.data.sourceManifest.sourceRef, 'note-1');
  assert.match(envelope.data.sourceManifest.sourceDigest, /^sha256:/);
  assert.deepEqual(envelope.data.progress, { completed: 0, total: 1, hasMore: false });
  assert.equal(envelope.data.review.required, true);
  assert.equal(envelope.data.review.canonicalWrite, false);
  assert.equal(envelope.trace.nextAction, 'submit_ingest_execute');
  assert.equal(envelope.trace.runId, null);
  assert.equal(envelope.trace.resumeToken, null);
});

test('ingest preview keeps plain output stable and external sources fail closed', async () => {
  const stdout = [];
  const stderr = [];
  const manualCli = fakeCli({ parsed: { command: 'must-not-parse' } });
  const manual = await runCliArgv([
    'ingest', 'preview', '--type', 'manual', '--ref', 'note-2', '--text', 'plain text',
  ], { cli: manualCli, stdout: value => stdout.push(value) });
  assert.equal(manual.exitCode, CLI_EXIT_CODES.review_required);
  assert.match(stdout[0], /^Ingest preview: review_required/m);
  assert.match(stdout[0], /^Progress: 0\/1$/m);
  assert.match(stdout[0], /^Next action: submit_ingest_execute$/m);

  let executed = false;
  const externalCli = fakeCli({ parsed: { command: 'must-not-parse' } });
  externalCli.execute = () => { executed = true; };
  const external = await runCliArgv(['ingest', 'preview', '--type', 'github', '--ref', 'repo', '--text', 'ignored'], {
    cli: externalCli,
    stderr: value => stderr.push(value),
  });
  assert.equal(executed, false);
  assert.equal(external.exitCode, CLI_EXIT_CODES.capability_not_available);
  assert.deepEqual(stderr, ['Ingest preview unavailable: CLI preview supports manual sources only.']);
});
