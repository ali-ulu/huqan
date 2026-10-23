'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CLI = require('../cli');
const { callTool } = require('../mcpServer');
const { runCliArgv } = CLI;
const {
  projectApprovalRecord,
  projectApprovalDecision,
  formatCliApprovalList,
  formatCliApprovalDecision,
} = require('../lib/mcp-approval-views');

// #3560: deciding an approval needs the operator at a terminal typing the
// approval id back; these tests stand in for that operator.
const operatorAt = (approvalId) => ({ operatorInput: { isTTY: true }, operatorAsk: () => approvalId });

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
    assert.deepEqual(cli.parse('approvals list'), {
      command: 'onaylar', args: { workspaceId: 'default' }, workflowId: 'approvals',
    });
    assert.deepEqual(cli.parse('approvals list --workspace team-a'), {
      command: 'onaylar', args: { workspaceId: 'team-a' }, workflowId: 'approvals',
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
      assert.match(listedOutput.join('\n'), /by unknown|by external-agent/);
      assert.match(listedOutput.join('\n'), /waiting (?:\d+s|\d+m|\d+h|\d+d|age unknown)/);
      assert.match(listedOutput.join('\n'), /cli approval workflow sentinel hayvandir/);
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

      const aliasListOutput = [];
      const aliasList = await runCliArgv(['--json', 'approvals', 'list'], { cli, stdout: value => aliasListOutput.push(value) });
      assert.equal(aliasList.exitCode, 0);
      assert.equal(JSON.parse(aliasListOutput[0]).data.approvals[0].id, queued.approval.id);

      const detailOutput = [];
      await runCliArgv(['--json', 'approvals', 'show', queued.approval.id], { cli, stdout: value => detailOutput.push(value) });
      assert.equal(JSON.parse(detailOutput[0]).data.approval.id, queued.approval.id);

      const approvedOutput = [];
      const approved = await runCliArgv(['onayla', queued.approval.id], { ...operatorAt(queued.approval.id), cli, stdout: value => approvedOutput.push(value) });
      assert.equal(approved.exitCode, 0);
      assert.match(approvedOutput.join('\n'), /The learned fact was written to canonical state/);
      assert.equal(cli.kernel.verify(text).data.status, 'verified');

      const decisionJsonOutput = [];
      await runCliArgv(['--json', 'onayla', queued.approval.id], { ...operatorAt(queued.approval.id), cli, stdout: value => decisionJsonOutput.push(value) });
      const decisionJson = JSON.parse(decisionJsonOutput[0]);
      assert.equal(decisionJson.data.idempotent, true);
      assert.equal(decisionJson.data.executed, false);
      assert.ok(Object.hasOwn(decisionJson.data, 'result'));
      assert.ok(Object.hasOwn(decisionJson.data, 'receipt'));

      const invalidOutput = [];
      const invalid = await runCliArgv(['onayla', queued.approval.id, 'maybe'], { ...operatorAt(queued.approval.id),
        cli,
        stderr: value => invalidOutput.push(value),
      });
      assert.equal(invalid.exitCode, 2);
      assert.match(invalidOutput.join('\n'), /Usage: onayla/);

      const duplicateOutput = [];
      const duplicate = await runCliArgv(['onayla', queued.approval.id], { ...operatorAt(queued.approval.id), cli, stdout: value => duplicateOutput.push(value) });
      assert.equal(duplicate.exitCode, 0);
      assert.match(duplicateOutput.join('\n'), /already approved/);

      const rejectedText = 'cli rejected approval workflow sentinel memelidir';
      const rejectedQueued = callTool(
        cli.kernel,
        { name: 'axiom.learn', arguments: { text: rejectedText } },
        cli._approvalRuntime()
      );
      const rejectedOutput = [];
      const rejected = await runCliArgv(['onayla', rejectedQueued.approval.id, 'rejected'], { ...operatorAt(rejectedQueued.approval.id),
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
      async () => cli.execute('onayla', { approvalId: 'missing', decision: 'approved' }, { throwOnError: true, ...operatorAt('missing') }),
      /APPROVAL_NOT_FOUND/
    );
  } finally {
    closeCli(cli);
  }
});

test('#3560 deciding an approval without the operator at a terminal is refused and decides nothing', async () => {
  await withTempAxiomEnvAsync(async () => {
    const cli = new CLI({
      kernel: { memoryPath: process.env.AXIOM_MEMORY_PATH, dbPath: process.env.AXIOM_DB_PATH, loadPlugins: false },
    });
    try {
      const text = 'cli operator presence sentinel hayvandir';
      const queued = callTool(cli.kernel, { name: 'huqan.learn', arguments: { text } }, cli._approvalRuntime());
      const id = queued.approval.id;

      // A pipe, an agent's shell or a heredoc: no terminal, so exit 4 before anything runs.
      const noTerminal = [];
      const refused = await runCliArgv(['onayla', id], { cli, stdout: v => noTerminal.push(v), stderr: v => noTerminal.push(v) });
      assert.equal(refused.exitCode, 4);
      assert.match(noTerminal.join('\n'), /operator_terminal_required/);

      // At a terminal, but the operator typed something else.
      const mismatch = [];
      const wrong = await runCliArgv(['onayla', id], {
        cli, operatorInput: { isTTY: true }, operatorAsk: () => 'not-the-id',
        stdout: v => mismatch.push(v), stderr: v => mismatch.push(v),
      });
      assert.equal(wrong.exitCode, 4);
      assert.match(mismatch.join('\n'), /operator_confirmation_mismatch/);

      // The REPL path (no throwOnError) reports the refusal as text.
      const replOutput = await cli.execute('onayla', { approvalId: id, decision: 'rejected' }, { operatorInput: { isTTY: false } });
      assert.match(String(replOutput), /operator_terminal_required/);

      assert.notEqual(cli.kernel.verify(text).data.status, 'verified', 'no refusal decided the approval');

      const approved = await runCliArgv(['onayla', id], { ...operatorAt(id), cli, stdout: () => {} });
      assert.equal(approved.exitCode, 0);
      assert.equal(cli.kernel.verify(text).data.status, 'verified');
    } finally {
      closeCli(cli);
    }
  });
});

test('approval queue text formats every age band and safe requester/claim fallback', () => {
  const realNow = Date.now;
  const now = 2_000_000_000_000;
  Date.now = () => now;
  try {
    const output = formatCliApprovalList({
      pendingCount: 6,
      approvals: [
        {
          id: 'queue-seconds',
          tool: 'huqan.learn',
          createdAt: now - 45_000,
          context: {
            args: { text: 'claim with\nmultiple words' },
            provenance: { sourceType: 'agent', actor: 'agent-queue-7' },
          },
        },
        { id: 'queue-minutes', tool: 'huqan.review', createdAt: now - 10 * 60_000, reason: 'needs review' },
        { id: 'queue-hours', tool: 'huqan.scan', createdAt: now - 2 * 60 * 60_000, reason: 'older review' },
        { id: 'queue-days', tool: 'huqan.audit', createdAt: now - 3 * 24 * 60 * 60_000 },
        { id: 'queue-unknown', tool: '', createdAt: 'not-a-timestamp' },
        { id: 'queue-future', tool: 'huqan.future', createdAt: now + 30_000, reason: 'future timestamp' },
      ],
    }, {});

    assert.match(output, /queue-seconds \| huqan\.learn \| by agent-queue-7 \| claim with multiple words \| waiting 45s/);
    assert.match(output, /queue-minutes \| huqan\.review \| by unknown \| needs review \| waiting 10m/);
    assert.match(output, /queue-hours \| huqan\.scan \| by unknown \| older review \| waiting 2h/);
    assert.match(output, /queue-days \| huqan\.audit \| by unknown \| huqan\.audit \| waiting 3d/);
    assert.match(output, /queue-unknown \|  \| by unknown \| approval request \| waiting age unknown/);
    assert.match(output, /queue-future \| huqan\.future \| by unknown \| future timestamp \| waiting 0s/);
  } finally {
    Date.now = realNow;
  }
});

test('decision projection preserves response attestation, falls back to stored evidence, then null', () => {
  const responseEvidence = { source: 'authority-response' };
  const storedEvidence = { source: 'approval-context' };
  const direct = projectApprovalDecision({
    ok: true,
    data: {
      approval: { id: 'approval-direct', context: { decisionAttestation: storedEvidence } },
      decisionAttestation: responseEvidence,
    },
  });
  assert.deepEqual(direct.data.decisionAttestation, responseEvidence);

  const stored = projectApprovalDecision({
    ok: true,
    data: { approval: { id: 'approval-stored', context: { decisionAttestation: storedEvidence } } },
  });
  assert.deepEqual(stored.data.decisionAttestation, storedEvidence);

  const absent = projectApprovalDecision({
    ok: true,
    data: { approval: { id: 'approval-without-attestation', context: {} } },
  });
  assert.equal(absent.data.decisionAttestation, null);
});

test('approval queue formatter covers empty, detail, and JSON response paths', () => {
  assert.equal(formatCliApprovalList({ pendingCount: 0, approvals: [] }, {}), 'No pending approvals.');
  const emptyJson = formatCliApprovalList({ pendingCount: 0, unresolvedCount: 0, approvals: [] }, {}, true);
  assert.equal(emptyJson.data.pendingCount, 0);
  assert.equal(emptyJson.data.unresolvedCount, 0);
  assert.deepEqual(emptyJson.data.approvals, []);

  assert.throws(
    () => formatCliApprovalList({ approvals: [] }, { approvalId: 'missing-id' }),
    /Approval not found: missing-id/,
  );
  const record = {
    id: 'queue-detail',
    tool: 'huqan.learn',
    createdAt: 1000,
    context: { args: { text: 'detail claim' } },
  };
  const detailJson = formatCliApprovalList({ approvals: [record] }, { approvalId: 'queue-detail' }, true);
  assert.equal(detailJson.data.approval.id, 'queue-detail');
  assert.equal(detailJson.data.approval.claim, 'detail claim');
  const detailText = formatCliApprovalList({ approvals: [record] }, { approvalId: 'queue-detail' });
  assert.match(detailText, /"id": "queue-detail"/);
});

test('decision formatter covers JSON, idempotent, rejected, and fallback-id paths', () => {
  const idempotent = formatCliApprovalDecision({
    data: { idempotent: true, decision: 'approved', approval: { id: 'already-approved' } },
  }, 'fallback');
  assert.equal(idempotent, 'Approval already approved: already-approved.');

  const rejected = formatCliApprovalDecision({
    data: { decision: 'rejected', approval: { id: 'rejected-id' } },
  }, 'fallback');
  assert.equal(rejected, 'Approval rejected: rejected-id.');

  const fallback = formatCliApprovalDecision({ data: {} }, 'fallback-id');
  assert.equal(fallback, 'Approval applied: fallback-id. The learned fact was written to canonical state.');

  const json = formatCliApprovalDecision({
    data: { decision: 'approved', approval: { id: 'json-id', context: {} } },
  }, 'fallback', true);
  assert.equal(json.data.decision, 'approved');
  assert.equal(json.data.approval.id, 'json-id');
});

test('approval age and evidence projection handle zero timestamps and missing records', () => {
  const realNow = Date.now;
  Date.now = () => 2_000_000_000_000;
  try {
    const output = formatCliApprovalList({
      approvals: [
        { id: 'zero-age', tool: 'huqan.learn', createdAt: 0 },
        { id: 'negative-age', tool: 'huqan.learn', createdAt: -1 },
      ],
    }, {});
    assert.match(output, /zero-age .* waiting age unknown/);
    assert.match(output, /negative-age .* waiting age unknown/);
  } finally {
    Date.now = realNow;
  }
  assert.equal(projectApprovalDecision(null).data.approval, null);
  assert.equal(projectApprovalDecision({ data: { approval: null, result: null } }).data.decisionAttestation, null);
});
