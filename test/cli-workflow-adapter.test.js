'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runCliArgv, CLI_EXIT_CODES } = require('../lib/cli-workflow-adapter');
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
