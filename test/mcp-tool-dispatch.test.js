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
  'huqan.trust_receipt', 'huqan.trust_receipt_detail', 'huqan.status', 'huqan.audit',
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
// Regenerate only on purpose: UPDATE_MCP_DISPATCH_GOLDEN=1 node --test <this file>
const GOLDEN = {
  'huqan.learn': 'e0edb52a102cb075b64861d689bd7ffa09f64325846033e3bad379cda46eff7f',
  'huqan.ask': 'ad49c39a897ce936e3558e2cb3ee7d1af721dd380bbd92da3c913e11fa5df795',
  'huqan.verify': '7dda822caa950b13331909b07e7b26429ea8b0a95cbac0f36715afc72dbd212d',
  'huqan.plan': '318e9c5e41e5502e0c4d57cbe0e6ea959df862e44e4db143f5abefeda499bfd5',
  'huqan.agent': '8872f29b4272a8c0441668a788d88e04ebadf19afb0f3f0006dd07e0e268e280',
  'huqan.policy': '8a0f76759a9014b814077ea1bb109dc893d6b2be1c1196c8d174fef4b11a7f33',
  'huqan.approval_detail': 'dc906393ef1c7ce7e213f5d4e85a0f044b785876ea962cdb807256844e9189b5',
  'huqan.approvals': 'f31a675da052e5edf832f0a712974737f3e9ba68776c86b8a942e30c19ad3860',
  'huqan.reason': 'a3cfb1b72319c626258724fe87e1af8dd968614d9123835d2bf8041b896695b3',
  'huqan.compare': '93e037979e4fd8e61ed75fd4e01242081501b8f3fc4445c47005e5d2a72be761',
  'huqan.dream': '432937e74cf96220e0dac5caba33dac1991a943731740adefa621dc5fe45c48e',
  'huqan.fractal-learn': '4e6688a86934e7ce282c9fdd2937fdda68f590d2e34b287b6519c4485c5867f4',
  'huqan.self-evolve': '0b65d54a9dfb43c5dfc685399a8e21e66e230f3295ac6aa77cebd269e433090d',
  'huqan.advocate': 'aef0acf08df752d40c675646c9f2cb36bc40e94a4cbc949baedfbb7bceac7019',
  'huqan.web_research': '79af213587410e4b0a37b21734ef445177ee3c03f5a8f6fd4ad0b7921a3aa41c',
  'huqan.search': '926ca1f8f09e765e67c47f38f3617a40acb20eb51c0a44d4f3536fc5d55885b7',
  'huqan.trust_receipt': '66e019f308aecf021d7e7f3ec800b3a0c8c5ce9550ac273145cad180772e5d01',
  'huqan.trust_receipt_detail': '18f203a2cb598e106d30e89ad16a0d7b0bd0c8b33a34c94abb9d8172cda9e48e',
  'huqan.status': 'b309ccdcf8283be9ea88d858c4158d93933817c9ebd948006bbb9a3b59ac223a',
  'huqan.audit': '632975316f346e33239e2d02bebf60a5fc53753211030af3828af83ef7143d4d',
  'huqan.ingest_preview': 'c865da9cf3eaed67fa72e57f4f2ec765889a0e4a23c014f56c3f2a16241ed719',
  'huqan.ingest_status': '5eb079bc6a66e3237af883639d70d66c32a05c9458a1dae99636aee0f32dc2d3',
  'huqan.ingest_execute': 'e9cf3f549fc0f97eac1b4d6e1f49630f64fcdd135e5361ccd5a33d75a0fd046e',
  'huqan.emergency_stop': '7d5114510b49e68654c189636d00cfbdcf605a30063abff2d272c6b150f1fc9c',
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
