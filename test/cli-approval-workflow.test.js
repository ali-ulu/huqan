'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CLI = require('../cli');
const { callTool } = require('../mcpServer');
const { runCliArgv } = CLI;
const { projectApprovalRecord } = require('../lib/mcp-approval-views');

function withTempAxiomEnv(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cli-approval-'));
  const saved = {
    AXIOM_MEMORY_PATH: process.env.AXIOM_MEMORY_PATH,
    AXIOM_DB_PATH: process.env.AXIOM_DB_PATH,
  };
  process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'memory.json');
  process.env.AXIOM_DB_PATH = path.join(tempDir, 'memory.db');
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function withTempAxiomEnvAsync(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cli-approval-'));
  const saved = {
    AXIOM_MEMORY_PATH: process.env.AXIOM_MEMORY_PATH,
    AXIOM_DB_PATH: process.env.AXIOM_DB_PATH,
  };
  process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'memory.json');
  process.env.AXIOM_DB_PATH = path.join(tempDir, 'memory.db');
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function closeCli(cli) {
  try { cli?.agent?.storage?.close?.(); } catch (_) {}
  try { cli?.approvalStore?.close?.(); } catch (_) {}
  try { cli?.kernel?.graph?.close?.(); } catch (_) {}
  try { cli?.kernel?.memory?.close?.(); } catch (_) {}
}

test('CLI parses approval queue and explicit approval commands', () => {
  const cli = new CLI({ kernel: { noLoad: true, loadPlugins: false } });
  try {
    assert.deepEqual(cli.parse('onaylar'), { command: 'onaylar', args: '', workflowId: 'approvals' });
    assert.deepEqual(cli.parse('approvals show approval-123'), {
      command: 'onaylar', args: { approvalId: 'approval-123' }, workflowId: 'approvals',
    });
    assert.deepEqual(cli.parse('onayla approval-123 rejected'), {
      command: 'onayla', args: { approvalId: 'approval-123', decision: 'rejected', invalidDecision: false }, workflowId: 'approval-decision',
    });
    assert.deepEqual(cli.parse('approve approval-123'), {
      command: 'onayla', args: { approvalId: 'approval-123', decision: 'approved', invalidDecision: false }, workflowId: 'approval-decision',
    });
    assert.deepEqual(cli.parse('onayla approval-123 maybe'), {
      command: 'onayla', args: { approvalId: 'approval-123', decision: 'maybe', invalidDecision: true }, workflowId: 'approval-decision',
    });
  } finally {
    closeCli(cli);
  }
});

test('approval projection is stable and redacts secret-bearing context', () => {
  const projected = projectApprovalRecord({
    id: 'approval-real', tool: 'huqan.learn', status: 'pending', input: '{}',
    context: { source: 'mcp', provenance: { token: 'secret-sentinel' }, args: { text: 'safe claim' } },
    policy: { reason: 'review', apiKey: 'another-secret' },
  });
  assert.equal(projected.id, 'approval-real');
  assert.equal(projected.claim, 'safe claim');
  assert.equal(projected.provenance.token, '[REDACTED]');
  assert.equal(projected.policy.apiKey, '[REDACTED]');
  assert.equal(JSON.stringify(projected).includes('secret-sentinel'), false);
});

test('CLI uses the same env-backed persistence paths as MCP', () => {
  withTempAxiomEnv(() => {
    const kernel = CLI.createKernel({ noLoad: true, loadPlugins: false });
    try {
      assert.deepEqual(kernel.getPersistenceDescriptor(), {
        memoryPath: process.env.AXIOM_MEMORY_PATH,
        dbPath: process.env.AXIOM_DB_PATH,
      });
    } finally {
      try { kernel?.graph?.close?.(); } catch (_) {}
      try { kernel?.memory?.close?.(); } catch (_) {}
    }
  });
});

test('CLI lists and resolves the same persisted MCP approval without a bypass', async () => {
  await withTempAxiomEnvAsync(async () => {
    const cli = new CLI({
      kernel: {
        memoryPath: process.env.AXIOM_MEMORY_PATH,
        dbPath: process.env.AXIOM_DB_PATH,
        loadPlugins: false,
      },
    });
    try {
      const text = 'cli approval workflow sentinel hayvandir';
      const queued = callTool(cli.kernel, { name: 'axiom.learn', arguments: { text } }, cli._approvalRuntime());
      assert.equal(queued.ok, false);
      assert.equal(queued.approval.status, 'pending');

      const listedOutput = [];
      const listed = await runCliArgv(['onaylar'], { cli, stdout: value => listedOutput.push(value) });
      assert.equal(listed.exitCode, 0);
      assert.match(listedOutput.join('\n'), new RegExp(queued.approval.id));
      // The approval above was queued through the legacy `axiom.learn` spelling and
      // the row persists that string, but the listing is a writer, so per RFC-001 it
      // renders the canonical name. That the legacy row stays *executable* is what
      // the `onayla` assertions below prove.
      assert.match(listedOutput.join('\n'), /huqan\.learn/);

      const jsonListOutput = [];
      const jsonList = await runCliArgv(['--json', 'onaylar'], { cli, stdout: value => jsonListOutput.push(value) });
      const jsonListBody = JSON.parse(jsonListOutput[0]);
      assert.equal(jsonList.exitCode, 0);
      assert.equal(jsonListBody.data.approvals[0].id, queued.approval.id);
      assert.equal(jsonListBody.data.approvals[0].context.source, 'mcp');
      assert.ok(Object.hasOwn(jsonListBody.data.approvals[0], 'provenance'));
      assert.ok(Object.hasOwn(jsonListBody.data.approvals[0], 'policy'));

      const detailOutput = [];
      await runCliArgv(['--json', 'approvals', 'show', queued.approval.id], { cli, stdout: value => detailOutput.push(value) });
      assert.equal(JSON.parse(detailOutput[0]).data.approval.id, queued.approval.id);

      const approvedOutput = [];
      const approved = await runCliArgv(['onayla', queued.approval.id], { cli, stdout: value => approvedOutput.push(value) });
      assert.equal(approved.exitCode, 0);
      assert.match(approvedOutput.join('\n'), /The learned fact was written to canonical state/);
      assert.equal(cli.kernel.verify(text).data.status, 'verified');

      const decisionJsonOutput = [];
      await runCliArgv(['--json', 'onayla', queued.approval.id], { cli, stdout: value => decisionJsonOutput.push(value) });
      const decisionJson = JSON.parse(decisionJsonOutput[0]);
      assert.equal(decisionJson.data.idempotent, true);
      assert.equal(decisionJson.data.executed, false);
      assert.ok(Object.hasOwn(decisionJson.data, 'result'));
      assert.ok(Object.hasOwn(decisionJson.data, 'receipt'));

      const invalidOutput = [];
      const invalid = await runCliArgv(['onayla', queued.approval.id, 'maybe'], {
        cli,
        stderr: value => invalidOutput.push(value),
      });
      assert.equal(invalid.exitCode, 2);
      assert.match(invalidOutput.join('\n'), /Usage: onayla/);

      const duplicateOutput = [];
      const duplicate = await runCliArgv(['onayla', queued.approval.id], { cli, stdout: value => duplicateOutput.push(value) });
      assert.equal(duplicate.exitCode, 0);
      assert.match(duplicateOutput.join('\n'), /already approved/);

      const rejectedText = 'cli rejected approval workflow sentinel memelidir';
      const rejectedQueued = callTool(
        cli.kernel,
        { name: 'axiom.learn', arguments: { text: rejectedText } },
        cli._approvalRuntime()
      );
      const rejectedOutput = [];
      const rejected = await runCliArgv(['onayla', rejectedQueued.approval.id, 'rejected'], {
        cli,
        stdout: value => rejectedOutput.push(value),
      });
      assert.equal(rejected.exitCode, 0);
      assert.match(rejectedOutput.join('\n'), /Approval rejected/);
      assert.notEqual(cli.kernel.verify(rejectedText).data.status, 'verified');
    } finally {
      closeCli(cli);
    }
  });
});

test('CLI approval errors are non-successful in one-shot mode', async () => {
  const cli = new CLI({ kernel: { noLoad: true, loadPlugins: false } });
  try {
    await assert.rejects(
      async () => cli.execute('onayla', { approvalId: 'missing', decision: 'approved' }, { throwOnError: true }),
      /APPROVAL_NOT_FOUND/
    );
  } finally {
    closeCli(cli);
  }
});
