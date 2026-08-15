'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CLI = require('../cli');
const { callTool } = require('../mcpServer');
const { listMaterializedReceiptEntries } = require('../lib/receipt/receipt-read-index');

async function withCli(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cli-receipt-'));
  const saved = { AXIOM_MEMORY_PATH: process.env.AXIOM_MEMORY_PATH, AXIOM_DB_PATH: process.env.AXIOM_DB_PATH };
  process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'memory.json');
  process.env.AXIOM_DB_PATH = path.join(tempDir, 'memory.db');
  const cli = new CLI({ kernel: { memoryPath: process.env.AXIOM_MEMORY_PATH, dbPath: process.env.AXIOM_DB_PATH, loadPlugins: false } });
  try {
    return await fn(cli);
  } finally {
    try { cli.agent?.storage?.close?.(); } catch (_) {}
    try { cli.approvalStore?.close?.(); } catch (_) {}
    try { cli.kernel?.graph?.close?.(); } catch (_) {}
    try { cli.kernel?.memory?.close?.(); } catch (_) {}
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function approvedAdmission(workspaceId = 'default') {
  return {
    workspaceId,
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: 'approval-cli-receipt-seed',
    provenance: {
      provenanceId: 'provenance-cli-receipt-seed', sourceType: 'test', sourceRef: 'test:cli-receipt',
      actor: 'cli-test', workspaceId, timestamp: '2026-08-15T00:00:00.000Z', trustPolicyVersion: '1.0.0',
    },
  };
}

test('CLI parses an exact receipt id and workspace', async () => {
  await withCli(async cli => {
    assert.deepEqual(cli.parse('receipt receipt-123 --workspace workspace-a'), {
      command: 'receipt', args: { receiptId: 'receipt-123', workspaceId: 'workspace-a' }, workflowId: 'trust-receipt-detail',
    });
  });
});

test('CLI reads the original materialized Trust Receipt without synthesizing one', async () => {
  await withCli(async cli => {
    const learned = cli.kernel.learn('cli receipt materialized claim', approvedAdmission());
    const receipt = learned.data.admission.receipt;
    const stdout = [];
    const result = await CLI.runCliArgv(['receipt', receipt.receiptId, '--workspace', 'default', '--json'], {
      cli, stdout: value => stdout.push(value),
    });
    const envelope = JSON.parse(stdout[0]);
    assert.equal(result.exitCode, 0);
    assert.equal(envelope.workflowId, 'trust-receipt-detail');
    assert.equal(envelope.receiptId, receipt.receiptId);
    assert.deepEqual(envelope.data.receipt, receipt);
  });
});

test('learn review -> approve -> verify reports the real receipt seam or its exact absence', async () => {
  await withCli(async cli => {
    const claim = 'cli reviewed receipt gap sentinel is verified';
    const queued = callTool(cli.kernel, { name: 'axiom.learn', arguments: { text: claim } }, cli._approvalRuntime());
    assert.equal(queued.approval.status, 'pending');

    const approvedOutput = [];
    const approved = await CLI.runCliArgv(['onayla', queued.approval.id, '--json'], {
      cli, stdout: value => approvedOutput.push(value),
    });
    const decision = JSON.parse(approvedOutput[0]);
    assert.equal(approved.exitCode, 0);
    assert.equal(cli.kernel.verify(claim).data.status, 'verified');

    const receipt = decision.data.receipt;
    if (receipt?.receiptId) {
      const receiptOutput = [];
      const read = await CLI.runCliArgv(['receipt', receipt.receiptId, '--workspace', 'default', '--json'], {
        cli, stdout: value => receiptOutput.push(value),
      });
      assert.equal(read.exitCode, 0);
      assert.deepEqual(JSON.parse(receiptOutput[0]).data.receipt, receipt);
      return;
    }

    assert.equal(receipt, null, 'approval projection must not invent a receipt');
    const before = listMaterializedReceiptEntries(cli.kernel.graph, { workspaceId: 'default' }).length;
    const unavailableOutput = [];
    const unavailable = await CLI.runCliArgv(['receipt', queued.approval.id, '--workspace', 'default', '--json'], {
      cli, stdout: value => unavailableOutput.push(value),
    });
    const unavailableEnvelope = JSON.parse(unavailableOutput[0]);
    assert.equal(unavailable.exitCode, 8);
    assert.equal(unavailableEnvelope.status, 'failed');
    assert.match(unavailableEnvelope.error.message, /NOT_FOUND/);
    assert.equal(listMaterializedReceiptEntries(cli.kernel.graph, { workspaceId: 'default' }).length, before);
  });
});
