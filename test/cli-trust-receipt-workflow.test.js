'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CLI = require('../cli');
const { callTool } = require('../mcpServer');
const { listMaterializedReceiptEntries } = require('../lib/receipt/receipt-read-index');

// #3560: deciding an approval needs the operator at a terminal typing the
// approval id back; these tests stand in for that operator.
const operatorAt = (approvalId) => ({ operatorInput: { isTTY: true }, operatorAsk: () => approvalId });

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

test('CLI executes learn -> review -> approve -> verify -> original receipt with idempotent refs', async () => {
  await withCli(async cli => {
    const claim = 'cli reviewed receipt gap sentinel is verified';
    const queued = callTool(cli.kernel, { name: 'axiom.learn', arguments: { text: claim } }, cli._approvalRuntime());
    assert.equal(queued.approval.status, 'pending');

    const approvedOutput = [];
    const approved = await CLI.runCliArgv(['onayla', queued.approval.id, '--json'], { ...operatorAt(queued.approval.id),
      cli, stdout: value => approvedOutput.push(value),
    });
    const decision = JSON.parse(approvedOutput[0]);
    assert.equal(approved.exitCode, 0);
    assert.equal(cli.kernel.verify(claim).data.status, 'verified');

    const receipt = decision.data.receipt;
    assert.ok(receipt?.receiptId);
    assert.equal(decision.receiptId, receipt.receiptId);
    assert.ok(decision.data.refs.auditId);
    assert.ok(decision.data.refs.candidateId);
    assert.ok(decision.data.refs.provenanceId);

    const receiptOutput = [];
    const read = await CLI.runCliArgv(['receipt', receipt.receiptId, '--workspace', 'default', '--json'], {
      cli, stdout: value => receiptOutput.push(value),
    });
    assert.equal(read.exitCode, 0);
    assert.deepEqual(JSON.parse(receiptOutput[0]).data.receipt, receipt);

    const repeatOutput = [];
    await CLI.runCliArgv(['onayla', queued.approval.id, '--json'], { ...operatorAt(queued.approval.id),
      cli, stdout: value => repeatOutput.push(value),
    });
    const repeat = JSON.parse(repeatOutput[0]);
    assert.equal(repeat.data.idempotent, true);
    assert.deepEqual(repeat.data.receipt, receipt);
    assert.deepEqual(repeat.data.refs, decision.data.refs);
    assert.equal(listMaterializedReceiptEntries(cli.kernel.graph, { workspaceId: 'default' }).length, 1);
  });
});

// #3892: `receipt verify` reports the verdict on the chain the receipt sits
// in (workspace + family, genesis to recorded tip), never on the receipt alone.
test('CLI parses receipt verify and receipts verify', async () => {
  await withCli(async cli => {
    for (const line of ['receipt verify receipt-123 --workspace workspace-a', 'receipts verify receipt-123 --workspace workspace-a']) {
      assert.deepEqual(cli.parse(line), {
        command: 'receipt-verify', args: { receiptId: 'receipt-123', workspaceId: 'workspace-a' }, workflowId: 'trust-receipt-detail',
      });
    }
    // Reading a receipt is unchanged.
    assert.equal(cli.parse('receipt receipt-123').command, 'receipt');
  });
});

function distinctAdmission(tag) {
  const admission = approvedAdmission();
  return { ...admission, approvalId: `approval-cli-verify-${tag}`, provenance: { ...admission.provenance, provenanceId: `provenance-cli-verify-${tag}` } };
}

async function runVerify(cli, receiptId) {
  const stdout = [];
  const result = await CLI.runCliArgv(['receipt', 'verify', receiptId, '--workspace', 'default', '--json'], {
    cli, stdout: value => stdout.push(value), stderr: value => stdout.push(value),
  });
  return { exitCode: result.exitCode, envelope: JSON.parse(stdout[0]) };
}

test('receipt verify accepts a receipt whose chain is intact past the first link', async () => {
  await withCli(async cli => {
    cli.kernel.learn('cli verify first chained claim', distinctAdmission('a1'));
    const second = cli.kernel.learn('cli verify second chained claim', distinctAdmission('a2')).data.admission.receipt;
    const { exitCode, envelope } = await runVerify(cli, second.receiptId);
    assert.equal(exitCode, 0);
    assert.equal(envelope.data.verdict, 'valid');
    assert.equal(envelope.data.chain.valid, true);
    assert.ok(envelope.data.receiptHash);
    // The second receipt links to the first, not to genesis: a one-receipt
    // validation (#3881) would have called this chain broken.
    assert.notEqual(envelope.data.previousReceiptHash, 'genesis:v4-receipt-chain');
  });
});

test('receipt verify refuses a receipt whose predecessor was tampered with', async () => {
  await withCli(async cli => {
    const first = cli.kernel.learn('cli verify tamper first claim', distinctAdmission('t1')).data.admission.receipt;
    const second = cli.kernel.learn('cli verify tamper second claim', distinctAdmission('t2')).data.admission.receipt;
    const db = cli.kernel.graph._db;
    const row = db.prepare('SELECT canonical_payload FROM mutation_receipts WHERE receipt_id = ?').get(first.receiptId);
    assert.ok(row, 'the first receipt is committed to the durable chain');
    const payload = JSON.parse(row.canonical_payload);
    payload.status = payload.status === 'rejected' ? 'approved' : 'rejected';
    db.prepare('UPDATE mutation_receipts SET canonical_payload = ? WHERE receipt_id = ?').run(JSON.stringify(payload), first.receiptId);

    const { exitCode, envelope } = await runVerify(cli, second.receiptId);
    assert.notEqual(exitCode, 0);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.meta.verdict, 'invalid');
    assert.equal(envelope.error.meta.chain.valid, false);
    assert.equal(envelope.error.meta.chain.brokenAt, 0, 'the break is reported at the tampered first link');
  });
});

test('receipt verify reports an unknown receipt as not found', async () => {
  await withCli(async cli => {
    const { exitCode, envelope } = await runVerify(cli, 'receipt-does-not-exist');
    assert.notEqual(exitCode, 0);
    assert.equal(envelope.error.meta.verdict, 'not_found');
  });
});
