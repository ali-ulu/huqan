'use strict';

/**
 * The receipt-bound, reversible removal command (#3461).
 *
 * `MemoryLifecycle` (#3036) composed the six shipped memory modules but had no
 * production caller: the modules were exercised end-to-end only by
 * test/memory-lifecycle-composition.test.js. `memory-lifecycle` is that caller.
 * It drives the lifecycle's own `tombstone`/`supersede` through the kernel's
 * memory store and binds every accepted mutation to a chained receipt the
 * operator can verify.
 *
 * These tests use the real Kernel + MemoryStore + receipt chain -- no stubs --
 * so a change to any of the three surfaces shows up here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const CLI = require('../cli');
const Kernel = require('../kernel');
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');
const { createCliCommandHandlers } = require('../lib/cli-command-handlers');
const { parseCommand } = require('../lib/command-parser');

const HANDLERS = createCliCommandHandlers({ callMcpTool: () => null, createApprovalStoreFromKernel: () => null });

function makeCli() {
  return new CLI({ kernelInstance: new Kernel(isolatedKernelOptions('memory-lifecycle-cli')) });
}

function seed(cli, content = { fact: 'water is wet' }) {
  return cli.kernel.memory.store({ content, workspaceId: 'default' }).memory.memoryId;
}

function run(cli, input) {
  const parsed = parseCommand(input);
  assert.equal(parsed.command, 'memory-lifecycle', input);
  return HANDLERS['memory-lifecycle'](cli, parsed.args);
}

function status(cli, memoryId) {
  return cli.kernel.memory.get(memoryId, { workspaceId: 'default' }).memory.status;
}

test('tombstone is reversible, writes a receipt, and keeps the record', () => {
  const cli = makeCli();
  const id = seed(cli);
  const output = run(cli, `memory-lifecycle tombstone ${id} --reason duplicated fact`);
  assert.match(output, new RegExp(`${id} tombstoned \\(reversible; status deleted\\)\\. receipt mlr_tombstone_${id}`));
  assert.equal(status(cli, id), 'deleted');
  // The record survives a soft delete; a hard delete would lose it entirely.
  const found = cli.kernel.memory.findByKind('memory-record', { workspaceId: 'default', includeTombstoned: true });
  assert.deepEqual(found.memories.map((m) => m.memoryId), [id]);
});

test('supersede never overwrites: the old record survives and the chain links them', () => {
  const cli = makeCli();
  const id = seed(cli, { fact: 'v1' });
  const output = run(cli, `memory-lifecycle supersede ${id} --content {"fact":"v2"} --reason corrected`);
  assert.match(output, new RegExp(`${id} superseded by [0-9a-f]+\\. receipt mlr_supersede_${id}`));
  assert.equal(status(cli, id), 'superseded');
  const found = cli.kernel.memory.findByKind('memory-record', { workspaceId: 'default', includeTombstoned: true });
  const byId = Object.fromEntries(found.memories.map((m) => [m.memoryId, m]));
  assert.deepEqual(byId[id].content, { fact: 'v1' });
  const successor = found.memories.find((m) => m.memoryId !== id);
  assert.deepEqual(successor.content, { fact: 'v2' });
  assert.equal(successor.supersedesMemoryId, id);
});

test('the mutation receipts form one valid, tamper-evident chain', () => {
  const cli = makeCli();
  const store = cli.kernel.memory;
  const chain = require('../lib/receipt/receipt-chain');
  const crypto = require('../lib/receipt/cryptographic-verification-adapter');
  const { MemoryLifecycle } = require('../lib/memory-lifecycle');
  const lifecycle = new MemoryLifecycle(cli.kernel, {
    memoryStore: store,
    chain: { GENESIS_PREVIOUS_HASH: chain.GENESIS_PREVIOUS_HASH, appendReceiptToChain: chain.appendReceiptToChain, validateReceiptChain: chain.validateReceiptChain },
    crypto,
  });

  const id = seed(cli);
  const tombstoned = lifecycle.tombstone(id, { workspaceId: 'default', actor: 'operator:test', reason: 'one' });
  const superseded = lifecycle.supersede(id, { fact: 'v2' }, { workspaceId: 'default', actor: 'operator:test', reason: 'two' });
  assert.equal(tombstoned.ok, true);
  assert.equal(superseded.ok, true);

  const chained = [tombstoned.receipt.chainedReceipt, superseded.receipt.chainedReceipt];
  assert.equal(chain.validateReceiptChain(chained).valid, true);
  // The second receipt links to the first: tampering with the first breaks both.
  assert.equal(chained[1].previousReceiptHash, chained[0].receiptHash);
  const tampered = [{ ...chained[0], action: 'forged' }, chained[1]];
  assert.equal(chain.validateReceiptChain(tampered).valid, false);
});

test('a refusal mutates nothing and produces no receipt', () => {
  const cli = makeCli();
  const output = run(cli, 'memory-lifecycle tombstone nope --reason whatever');
  assert.match(output, /NOT_FOUND for nope/);
  assert.doesNotMatch(output, /receipt/);
  assert.equal(cli.kernel.memory.get('nope', { workspaceId: 'default' }).memory, undefined);
});

test('invalid invocations are refused before any mutation', () => {
  const cli = makeCli();
  const id = seed(cli);
  assert.match(run(cli, `memory-lifecycle tombstone ${id}`), /--reason <text> is required/);
  assert.match(run(cli, `memory-lifecycle supersede ${id} --reason x`), /--content <json> is required/);
  assert.match(run(cli, `memory-lifecycle supersede ${id} --content not-json --reason x`), /--content must be valid JSON/);
  assert.match(run(cli, `memory-lifecycle frobnicate ${id} --reason x`), /unknown action frobnicate/);
  assert.match(run(cli, 'memory-lifecycle tombstone --reason x'), /memoryId is required/);
  assert.equal(status(cli, id), 'active', 'no refused form may change the record');
});

test('the gate classifies the command as an allowed, audited local mutation', () => {
  const cli = makeCli();
  const gate = cli.evaluateCliGate('memory-lifecycle', { action: 'tombstone', memoryId: 'x', reason: 'r' });
  assert.notEqual(gate, null, 'a mutation-bearing command must be gated (F-004)');
  assert.equal(gate.decision, 'allow');
  assert.equal(gate.reason, 'cli_memory_lifecycle_reversible_removal');
  assert.equal(gate.canExecute, true);
});

test('an allowed mutation is audited with an attempted and a committed phase', () => {
  const cli = makeCli();
  const id = seed(cli);
  const before = (cli.kernel.graph._auditEvents || []).length;
  // Through `execute`, so the gate's `attempted` write is exercised too; the
  // handler alone only ever writes `committed`.
  cli.execute('memory-lifecycle', parseCommand(`memory-lifecycle tombstone ${id} --reason audited`).args);
  const events = (cli.kernel.graph._auditEvents || [])
    .slice(before)
    .filter((event) => event.targetType === 'cli_mutation' && event.targetId === 'memory-lifecycle');
  const phases = events.map((event) => event.details && event.details.phase);
  assert.ok(phases.includes('attempted'), 'the gate writes the attempted phase');
  assert.ok(phases.includes('committed'), 'the handler writes the committed phase');
  assert.ok(events.every((event) => event.eventType === 'DELETE'));
});
test('the parser exposes the action, memoryId and a multi-word reason', () => {
  const parsed = parseCommand('memory-lifecycle supersede abc --content {"a":1} --reason the value was corrected');
  assert.deepEqual(parsed.args, {
    action: 'supersede',
    memoryId: 'abc',
    content: '{"a":1}',
    workspaceId: '',
    reason: 'the value was corrected',
  });
  assert.equal(parseCommand('memory-lifecycle tombstone abc --reason r --workspace w1').args.workspaceId, 'w1');
});

test('the command is declared in the workflow contract and the help text', () => {
  const { WORKFLOW_CAPABILITIES, CLI_COMMAND_CAPABILITIES } = require('../lib/workflow-contract');
  const capability = WORKFLOW_CAPABILITIES.find((item) => item.workflowId === 'memory-lifecycle');
  assert.equal(capability.mutation, true);
  assert.equal(capability.availability.cli, true);
  assert.ok(CLI_COMMAND_CAPABILITIES.some((entry) => entry.command === 'memory-lifecycle'));
  assert.match(require('../lib/cli-help').cliHelpText(), /memory-lifecycle tombstone/);
});

test('the command is refused on the REST public API surface', () => {
  const { isUnsafePublicApiCommand } = require('../requestGuards');
  assert.equal(isUnsafePublicApiCommand('memory-lifecycle'), true);
});
