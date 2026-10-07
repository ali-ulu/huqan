'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

// #2142 (#2123): dispatchMcpTool ran each MCP tool through a switch over the
// tool name that grows with every new tool. The per-tool handlers are now a
// table. The first block drives every tool through callTool with a recording
// kernel, agent and delegate modules, and pins each tool's collaborator calls
// and projected output to digests recorded on main, so any drift is caught.
//
// The gate is forced open and the delegates are stubbed so every tool reaches
// dispatch; both are wrapped before mcpServer.js loads, because it reads those
// exports when it is required.

// harness:start
const calls = [];
const snapshot = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const record = (label, value) => (...args) => {
  calls.push([label, ...snapshot(args)]);
  return typeof value === 'function' ? value(...args) : value;
};
function stubExport(modulePath, exportName, value) {
  const mod = require(modulePath);
  mod[exportName] = record(`${exportName}`, value);
}

const gateAdapter = require('../lib/mcp-gate-adapter');
const realEvaluateMcpGate = gateAdapter.evaluateMcpGate;
gateAdapter.evaluateMcpGate = (input, options) => ({
  ...realEvaluateMcpGate(input, options),
  decision: 'allow',
  allowed: true,
  canExecute: true,
  canDryRun: false,
  requiredReview: false,
});

stubExport('../lib/mcp/read-workflow-tools', 'executeMcpVerify', { ok: true, via: 'verify' });
stubExport('../lib/mcp/read-workflow-tools', 'executeMcpReadWorkflow', { ok: true, via: 'read-workflow' });
stubExport('../lib/ingest-workflow-preview', 'buildIngestWorkflowPreview', (args) => (args.fail
  ? { ok: false, code: 'PREVIEW_CODE', error: 'preview error' }
  : { ok: true, summary: 'preview', items: 2 }));
stubExport('../lib/mcp-ingest-status-tool', 'readIngestRunStatus', { ok: true, via: 'ingest-status' });
stubExport('../lib/mcp-ingest-execute-tool', 'buildMcpIngestExecuteResult', { ok: true, via: 'ingest-execute' });
stubExport('../lib/mcp/fractal-learn-tool', 'executeMcpFractalLearn', { ok: true, via: 'fractal-learn' });
stubExport('../lib/mcp/self-evolve-tool', 'executeMcpSelfEvolve', { ok: true, via: 'self-evolve' });
stubExport('../lib/mcp/approval-detail-tool', 'executeMcpApprovalDetail', { ok: true, via: 'approval-detail' });
const agent = {
  plan: record('agent.plan', { ok: true, via: 'plan' }),
  run: record('agent.run', async () => ({ ok: true, via: 'run' })),
  inspectToolPolicy: record('agent.inspectToolPolicy', { ok: true, via: 'policy' }),
  storage: { close: record('agent.storage.close', undefined) },
};
stubExport('../agentRuntime', 'createAgent', agent);

const {
  callTool,
  createMcpOperatorCapability,
  operatorCapabilityBinding,
} = require('../mcpServer');

const kernel = {
  learn: record('kernel.learn', { ok: true, via: 'learn' }),
  ask: record('kernel.ask', { ok: true, via: 'ask' }),
  reason: record('kernel.reason', { ok: true, via: 'reason' }),
  derive: record('kernel.derive', { ok: true, via: 'derive' }),
  prove: record('kernel.prove', { ok: true, via: 'prove' }),
  compare: record('kernel.compare', { ok: true, via: 'compare' }),
  dream: record('kernel.dream', { ok: true, via: 'dream' }),
  ok: record('kernel.ok', (type, data) => ({ ok: true, type, data })),
  fail: record('kernel.fail', (type, code, message) => ({ ok: false, type, error: { code, message } })),
};
const approvalStore = {
  listUnresolvedToolApprovals: record('store.listUnresolvedToolApprovals', [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]),
  countPendingToolApprovals: record('store.countPendingToolApprovals', 3),
  countUnresolvedToolApprovals: record('store.countUnresolvedToolApprovals', 2),
};

const OPERATOR_TOOLS = new Set(['huqan.approvals', 'huqan.approval_detail']);
const READ_WORKFLOW_TOOLS = [
  'huqan.advocate', 'huqan.web_research', 'huqan.search',
  'huqan.trust_receipt', 'huqan.trust_receipt_detail', 'huqan.experience_read', 'huqan.experience_learn', 'huqan.memory_query', 'huqan.status', 'huqan.audit',
];
const CASES = [
  ['huqan.learn', { text: '  water\u0000 boils ', maxSentences: 3 }],
  ['huqan.learn', { text: 'x', skipConflicts: false }],
  ['huqan.ask', { question: ' what\u0007 is water ' }],
  ['huqan.verify', { claim: 'water is wet' }],
  ['huqan.plan', { goal: ' plan it ', maxSteps: 99 }],
  ['huqan.plan', { goal: 'plan it' }],
  ['huqan.agent', { goal: 'run it', maxSteps: 0 }],
  ['huqan.policy', { tool: 'shell', input: 'rm -rf', goal: 'clean up' }],
  ['huqan.policy', { tool: 'shell' }],
  ['huqan.approval_detail', { approvalId: 'a1', workspaceId: 'default' }],
  ['huqan.approvals', { limit: 500, workspaceId: 'w1' }],
  ['huqan.approvals', { limit: 2 }],
  ['huqan.reason', { subject: ' kedi\u0000 ' }],
  ['huqan.derive', { rules: [{ id: 'r1' }], facts: [{ predicate: 'CAUSES', from: 'a', to: 'b' }] }],
  ['huqan.prove', { rules: [{ id: 'r1' }], facts: [{ predicate: 'CAUSES', from: 'a', to: 'b' }], query: { predicate: 'CAUSES', from: 'a', to: 'b' } }],
  ['huqan.compare', { left: ' a ', right: 'b\u0007' }],
  ['huqan.dream', { depth: 500 }],
  ['huqan.dream', {}],
  ['huqan.fractal-learn', { text: 'fractal' }],
  ['huqan.self-evolve', { mode: 'observe' }],
  ...READ_WORKFLOW_TOOLS.map((name) => [name, { query: 'water' }]),
  ['huqan.ingest_preview', { source: 'notes' }],
  ['huqan.ingest_preview', { fail: true }],
  ['huqan.ingest_status', { runId: 'r1' }],
  ['huqan.ingest_execute', { source: 'notes' }],
  ['huqan.emergency_stop', { action: 'check', workspaceId: 'w1' }],
  ['huqan.emergency_stop', { action: 'stop', scope: 'workspace', workspaceId: 'w1', reason: 'halt it' }],
  ['huqan.emergency_stop', { action: 'lift', scope: 'workspace', workspaceId: 'w1', reason: 'resume it' }],
];

async function runCase(name, args) {
  calls.length = 0;
  const params = { name, arguments: args };
  const runtime = { approvalStore };
  if (OPERATOR_TOOLS.has(name)) {
    params.operatorCapability = createMcpOperatorCapability({ secret: 'test-operator', ...operatorCapabilityBinding(name, args) });
    runtime.operatorSecret = 'test-operator';
    runtime.operatorCapabilityNonces = new Map();
  }
  if (name === 'huqan.emergency_stop') {
    // Authorised like the other operator tools above; the ledger is injected
    // so no real stop directory is touched. stop/lift record fixed receipts so
    // the digest is deterministic.
    params.operatorCapability = createMcpOperatorCapability({ secret: 'test-operator', ...operatorCapabilityBinding(name, args) });
    runtime.operatorSecret = 'test-operator';
    runtime.operatorCapabilityNonces = new Map();
    runtime.emergencyStop = {
      check: record('emergencyStop.check', { stopped: false, scope: null, reason: null, record: null }),
      stop: record('emergencyStop.stop', (input) => ({
        ok: true,
        created: true,
        record: { scope: input.scope, workspaceId: input.workspaceId, agentId: input.agentId ?? null },
        receipt: { receiptHash: 'test-receipt' },
      })),
      lift: record('emergencyStop.lift', () => ({ ok: true, lifted: true, receipt: null })),
    };
  }
  try {
    const output = await callTool(kernel, params, runtime);
    return { calls: snapshot(calls), output: snapshot(output) };
  } catch (error) {
    return { calls: snapshot(calls), thrown: error.message };
  }
}

async function digestsByTool() {
  const byTool = {};
  for (const [name, args] of CASES) {
    (byTool[name] ||= []).push(await runCase(name, args));
  }
  return Object.fromEntries(Object.entries(byTool).map(([name, results]) => [
    name,
    crypto.createHash('sha256').update(JSON.stringify(results)).digest('hex'),
  ]));
}
// harness:end

// Recorded on main, before the change. #2505 re-recorded fractal-learn,
// self-evolve and ingest_execute: those handlers pass the gate to the recorded
// delegate call, and the gate's risk level is now the taxonomy band of its
// score (review at 80: MEDIUM -> CRITICAL). That one field is the only
// difference; the other twenty digests are unchanged.
//
// #2505 B re-recorded the twelve tools whose dispatch output embeds the gate
// verdict: every verdict now carries its justification next to the decision.
// Decisions, reasons, findings and risk scores are pinned by
// test/mcp-gate-risk-characterization.test.js and did not move; only the
// added justification block moves these digests.
//
// #3483 re-recorded every tool: results now pass the output schema gate, which
// completes the envelope (type, data, evidence, error, meta.contractVersion,
// meta.backend, meta.paranoidMode) and withholds a result that still does not
// match its declared schema. The stubbed delegates below return bare
// `{ ok, via }` objects, so verify, fractal-learn and approval_detail are now
// recorded as OUTPUT_SCHEMA_VIOLATION; routing stays pinned by `calls`.
//
// Regenerate only on purpose: UPDATE_MCP_DISPATCH_GOLDEN=1 node --test <this file>
const GOLDEN = {
  'huqan.learn': 'e95aaa4ab178294d720a24fd1e734ee341749daf126b6105189d7fa3be7dc84d',
  'huqan.ask': '51e5ccef1883799552b93b1a794bc585ee6c8c19bb97dca2da1cb0174f4f9334',
  'huqan.verify': 'f352c49228222d6a140f03fdf01b7e5f8f57254b6f552129c1f39a3d5237d876',
  'huqan.plan': '62eaa5392e9bc38e3957433baad76cfa214ef599cc0a6f4d2025a10bb6a63e2f',
  'huqan.agent': 'a6436b8dba85f4bf798987f66de329edafffe37bef382ad6ed17ab8b8cc8d1ea',
  'huqan.policy': '94be10e6cc93f4362598bbb1b103c0d88f0c957cc4453e324a8d8b856a4501b8',
  'huqan.approval_detail': '2024ca5ac4e6d22ffd54c786a2a46dad7224d5e78e28cb1ff5a3bccbc8006066',
  'huqan.approvals': '36246f2e3f4bab4a5550d0860aa24f79713c2205af67929f34d9a6560743669e',
  'huqan.reason': '6b29ea944cc7f6fa3a416a85be31bab70ee15aa2f7a841b426935b6d51b86e73',
  'huqan.derive': '8da20077038bae54399650bb11b8587c5f5509be5f12fcf4f462d0afb8f6e8c4',
  'huqan.prove': '574fcd4f98459354e0ee2f16f9195ca2212cfc396ea4133fdb75e665271fb6e0',
  'huqan.compare': '84916ed87bb4e370153871c0016a92d334002ae06d32985dddb105798fbf14e2',
  'huqan.dream': 'ea7675960a6ed2f7b4d3ec4780797021dae11b6188db747c390359306ddbe78d',
  'huqan.fractal-learn': '9a66e9513c0b6f8e8639f2f48856614ed56a8415c6a2ea4b354cdbb1dad2f983',
  'huqan.self-evolve': 'b37a37720929382db5fd1d40b5ce4a91e023c605630c904b1b04af1bb7a8d315',
  'huqan.advocate': '0d115f295f1127b99b89aea747c278b3d11566043523207b62131431d615f1ab',
  'huqan.web_research': 'c10fecf56856aaf725c586dd7720d7cdf1bafc12baf0b146d7c87df4e59ec5ec',
  'huqan.search': '67792f5ec426ca6de2acffce02cdb0959a0d89b03ae2d1dcab55c26f81030eef',
  'huqan.trust_receipt': '74ebeb95494eea3ce7d9d9beb37d7a036457d5d6e8b9af63f0b9ce6b8e35e578',
  'huqan.trust_receipt_detail': '10d9393af0583fb71da6d842fd1c5d3d3644361b0d1eacdf608a76f66fea0d77',
  'huqan.experience_read': '32f93fa21e4d20d42a736a167377c7489a43fde2e0bfe3d354a7d00d4db07af2',
  'huqan.experience_learn': '252b01137eaa0ce4144eced360770c42957b6112fc05d44ec2868c0966accf29',
  'huqan.memory_query': 'd2f6e2771fcb60209d38ab0ad3c588075b1f3a5a61c83f41569507c66ce9cfec',
  'huqan.status': 'ebb3bf5c3003f598a7500105af1402169b512f97289d84e0148627918a85d059',
  'huqan.audit': 'c3411c502b394902a4aae1e9189bd50b2828c19ccd9bea3fbc11a302b6046fb7',
  'huqan.ingest_preview': '79dd3b2704f3c64bff04bf569245219bc895e9e44a69c31d5ea8af57fc6d43f3',
  'huqan.ingest_status': '79067c2c2a2088abd00c76af3203c6838a2d1c36ee46cdc7c5fd888318f39a10',
  'huqan.ingest_execute': 'f6b1548a6d4a9a8e6e75a601da401413b2bc4ceae6540544deec6605bfcd5814',
  'huqan.emergency_stop': 'c4bc4671419250903d9a4f197b782d8775a81cfa1669448e98486cd2e12dd892',
};

describe('MCP tool dispatch (unchanged)', () => {
  it('covers every dispatched MCP tool', () => {
    const { CANONICAL_MCP_TOOL_NAMES } = require('../lib/mcp-tool-names');
    const dispatched = [...CANONICAL_MCP_TOOL_NAMES].filter((name) => !['huqan.approve', 'huqan.agent_resume'].includes(name));
    assert.deepEqual([...new Set(CASES.map(([name]) => name))].sort(), dispatched.sort());
    assert.deepEqual(Object.keys(GOLDEN).sort(), dispatched.sort());
  });

  it('each tool reaches its own collaborator and the digests are deterministic', async () => {
    for (const [name, args] of CASES) {
      const result = await runCase(name, args);
      assert.equal(result.thrown, undefined, `${name} threw ${result.thrown}`);
      assert.ok(result.calls.length > 0, `${name} made no collaborator call`);
    }
    assert.deepEqual(await digestsByTool(), await digestsByTool());
  });

  let actual;
  for (const name of Object.keys(GOLDEN)) {
    it(`${name} is byte-identical to main`, async () => {
      actual ||= await digestsByTool();
      if (process.env.UPDATE_MCP_DISPATCH_GOLDEN === '1') GOLDEN[name] = actual[name];
      assert.equal(actual[name], GOLDEN[name]);
    });
  }

  it('an unknown or prototype-named tool still throws Unknown tool', async () => {
    for (const name of ['huqan.nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const result = await runCase(name, {});
      assert.equal(result.thrown, `Unknown tool: ${name}`, name);
    }
  });

  it('huqan.emergency_stop refuses an unknown action without touching the ledger', async () => {
    const args = { action: 'explode', scope: 'workspace', workspaceId: 'w1' };
    const params = {
      name: 'huqan.emergency_stop',
      arguments: args,
      operatorCapability: createMcpOperatorCapability({ secret: 'test-operator', ...operatorCapabilityBinding('huqan.emergency_stop', args) }),
    };
    const noLedger = new Proxy({}, { get: () => { throw new Error('ledger must not be touched'); } });
    const runtime = { approvalStore, operatorSecret: 'test-operator', operatorCapabilityNonces: new Map(), emergencyStop: noLedger };
    const output = await callTool(kernel, params, runtime);
    assert.equal(output.ok, false);
    assert.equal(output.error.code, 'INVALID_ACTION');
    assert.equal(output.workflowId, 'emergency-stop');
  });
});

describe('the MCP tool handlers are a registry (#2142)', () => {  it('mcpServer.js no longer has a case per tool', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'mcpServer.js'), 'utf8');
    assert.doesNotMatch(source, /case 'huqan\.ask'/);
  });

  it('the architecture snapshot no longer sees a growing dispatch here', () => {
    const row = require('../scripts/architecture-snapshot').snapshot().find((item) => item.file === 'mcpServer.js');
    assert.ok(row, 'the file is measured');
    assert.ok(!row.signals.some((signal) => signal.startsWith('OCP')), JSON.stringify(row.signals));
  });
});

// Re-records GOLDEN after an intended dispatch-output change. The digests pin
// collaborator calls and projected output byte-for-byte, so decisions,
// reasons, findings and risk scores must be verified unchanged elsewhere
// (test/mcp-gate-risk-characterization.test.js) before re-recording.
it('re-record dispatch GOLDEN digests (UPDATE_MCP_DISPATCH_GOLDEN=1 only)', async () => {
  if (process.env.UPDATE_MCP_DISPATCH_GOLDEN !== '1') return;
  const actual = await digestsByTool();
  const sourcePath = __filename;
  let source = fs.readFileSync(sourcePath, 'utf8');
  for (const [name, digest] of Object.entries(actual)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`('${escaped}': ')[0-9a-f]{64}'`);
    if (!pattern.test(source)) throw new Error(`GOLDEN has no entry to re-record for ${name}`);
    source = source.replace(pattern, `$1${digest}'`);
  }
  fs.writeFileSync(sourcePath, source);
});
