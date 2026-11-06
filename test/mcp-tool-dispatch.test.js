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
stubExport('../lib/ingest-workflow-preview', 'buildIngestWorkflowPreview', (args) => (args.idempotencyKey === 'fail'
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
// Each read tool's args conform to its declared inputSchema: dispatch now
// refuses a parameter the tool did not announce, so a case arg outside the
// schema would never reach the (stubbed) collaborator.
const READ_WORKFLOW_ARGS = {
  'huqan.advocate': { workspaceId: 'default', claim: 'water is wet' },
  'huqan.web_research': { query: 'water' },
  'huqan.search': { query: 'water' },
  'huqan.trust_receipt': { workspaceId: 'default' },
  'huqan.trust_receipt_detail': { workspaceId: 'default', receiptId: 'r1' },
  'huqan.experience_read': { runId: 'r1', workspaceId: 'default' },
  'huqan.experience_learn': { runId: 'r1', workspaceId: 'default' },
  'huqan.memory_query': { workspaceId: 'default', text: 'water' },
  'huqan.status': {},
  'huqan.audit': { workspaceId: 'default' },
};
const CASES = [
  ['huqan.learn', { text: '  water\u0000 boils ', maxSentences: 3 }],
  ['huqan.learn', { text: 'x', skipConflicts: false }],
  ['huqan.ask', { question: ' what\u0007 is water ' }],
  ['huqan.verify', { statement: 'water is wet' }],
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
  ['huqan.fractal-learn', {}],
  ['huqan.self-evolve', {}],
  ...Object.entries(READ_WORKFLOW_ARGS).map(([name, args]) => [name, args]),
  ['huqan.ingest_preview', { sourceType: 'manual', text: 'notes' }],
  ['huqan.ingest_preview', { sourceType: 'manual', idempotencyKey: 'fail' }],
  ['huqan.ingest_status', { runId: 'r1' }],
  ['huqan.ingest_execute', { sourceType: 'manual', text: 'notes' }],
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
// #3488 re-recorded the tools whose output embeds a queued approval: its
// policy now carries `reviewedBinding` ({ tool, argsDigest, inputIsArgs }),
// the arguments the reviewer is shown. No decision, reason or routing moved.
//
// Regenerate only on purpose: UPDATE_MCP_DISPATCH_GOLDEN=1 node --test <this file>
const GOLDEN = {
  'huqan.learn': 'e95aaa4ab178294d720a24fd1e734ee341749daf126b6105189d7fa3be7dc84d',
  'huqan.ask': '51e5ccef1883799552b93b1a794bc585ee6c8c19bb97dca2da1cb0174f4f9334',
  'huqan.verify': '8d506c8e22ea4833070b2549c00b075e5e4ccb0d8930cadb25e86735f70c62e8',
  'huqan.plan': '62eaa5392e9bc38e3957433baad76cfa214ef599cc0a6f4d2025a10bb6a63e2f',
  'huqan.agent': 'a6436b8dba85f4bf798987f66de329edafffe37bef382ad6ed17ab8b8cc8d1ea',
  'huqan.policy': '94be10e6cc93f4362598bbb1b103c0d88f0c957cc4453e324a8d8b856a4501b8',
  'huqan.approval_detail': '8e24ada584883b98f50bb87b98296eb09320522452f1f92a8bd31c459a971b17',
  'huqan.approvals': '36246f2e3f4bab4a5550d0860aa24f79713c2205af67929f34d9a6560743669e',
  'huqan.reason': '6b29ea944cc7f6fa3a416a85be31bab70ee15aa2f7a841b426935b6d51b86e73',
  'huqan.derive': '8da20077038bae54399650bb11b8587c5f5509be5f12fcf4f462d0afb8f6e8c4',
  'huqan.prove': '574fcd4f98459354e0ee2f16f9195ca2212cfc396ea4133fdb75e665271fb6e0',
  'huqan.compare': '84916ed87bb4e370153871c0016a92d334002ae06d32985dddb105798fbf14e2',
  'huqan.dream': 'ea7675960a6ed2f7b4d3ec4780797021dae11b6188db747c390359306ddbe78d',
  'huqan.fractal-learn': '4cedf829c0afa32d23a0744a409afc846811c905a5e4b8a30bc3eaf51d5835a8',
  'huqan.self-evolve': '5859912e6994c70f1f63001d081dacb46d036e352cd20a9dd2d59f07306786ef',
  'huqan.advocate': '7e5df7deda32a53ac51390264488660868e99f0a7e2e5341f8ae6530879dbea2',
  'huqan.web_research': '9b7858a2d174dae17c21c2ddb55a5ae424208c98c595ac54169cf9ebc3274614',
  'huqan.search': '501db7b7e6e084d12735e40a2ae0f1951e2794a1af551961f9f68c80799d7f5c',
  'huqan.trust_receipt': 'b9ea9c31371d0b9082363d8d9732e60e57ad6f9c4d97ca5fb5ed964eeabe8841',
  'huqan.trust_receipt_detail': '3ee6f02e1e302a9ee9ccb4dcf51de8ec71952b71b22fecc5176523fa3fd556c0',
  'huqan.experience_read': 'bf5377130436f8c22a30fd5c78b720a76aa65bbed7f6709411b337fb12dbf865',
  'huqan.experience_learn': '0e7268a0a313e8ccd2cefcac24712382da479d6c342baedc7673cf0e4a136b41',
  'huqan.memory_query': '1e2203cbb6fb1b8b13c1fb1e890a42fb75fc35c9d7162e62bc3d6d0e5c9c8faf',
  'huqan.status': '9b7bd9464ef4950506becbbe9c028d900a8d1a56c5863119e882e9ae0ec08572',
  'huqan.audit': 'e456f1e796c01a0b9b3f6734572badafcb1a43d86fa51f3f2b162bde0b4afd99',
  'huqan.ingest_preview': '9665185f63d07be2132144551cea47d6589ed3161ddced364e6cf9552c568a9d',
  'huqan.ingest_status': '79067c2c2a2088abd00c76af3203c6838a2d1c36ee46cdc7c5fd888318f39a10',
  'huqan.ingest_execute': 'b2722beaeae6ec938e11dd06cb66b71b8368c31416e196cfd9db7b18b02544dd',
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

  it('a parameter the tool did not announce is refused with INVALID_INPUT (#inputSchema)', async () => {
    // huqan.status declares { type:'object', properties:{}, additionalProperties:false }
    // in tools/list, so any argument at all is outside its contract. The gate
    // still decides, but no handler runs: data stays null and nothing is queued.
    const result = await runCase('huqan.status', { verbose: true });
    assert.equal(result.thrown, undefined);
    const output = result.output;
    assert.equal(output.ok, false);
    assert.equal(output.error.code, 'INVALID_INPUT');
    assert.match(output.error.message, /arguments\.verbose is not allowed by the tool's input schema/);
    assert.equal(output.data, null);
    assert.ok(!result.calls.some(([label]) => label.startsWith('kernel.')), 'no collaborator ran');
  });

  it('a schema-conforming call still passes the input gate', async () => {
    const result = await runCase('huqan.audit', { workspaceId: 'default' });
    assert.equal(result.thrown, undefined);
    // The harness stubs collaborators, so the handler's own outcome is not the
    // point here: a conforming call must not be refused as INVALID_INPUT.
    assert.notEqual(result.output?.error?.code, 'INVALID_INPUT', JSON.stringify(result.output));
  });

  it('a tool whose schema allows the keys accepts them, and an unknown name still throws', async () => {
    const allowed = await runCase('huqan.status', {});
    assert.notEqual(allowed.output?.error?.code, 'INVALID_INPUT');
    const unknown = await runCase('huqan.nope', { anything: true });
    assert.equal(unknown.thrown, 'Unknown tool: huqan.nope');
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

  it('an authorized operator call still cannot smuggle an undeclared key (#4525)', async () => {
    // huqan.approve's schema closes over approvalId/decision/reason/workspaceId.
    // A valid capability bound to the same arguments is not enough: the extra
    // key is refused before the handler runs, so nothing is decided.
    const args = { approvalId: 'a1', workspaceId: 'w1', decision: 'approved', smuggled: 'x' };
    const params = {
      name: 'huqan.approve',
      arguments: args,
      operatorCapability: createMcpOperatorCapability({ secret: 'test-operator', ...operatorCapabilityBinding('huqan.approve', args) }),
    };
    const runtime = { approvalStore, operatorSecret: 'test-operator', operatorCapabilityNonces: new Map() };
    const output = await callTool(kernel, params, runtime);
    assert.equal(output.ok, false);
    assert.equal(output.error.code, 'INVALID_INPUT');
    assert.match(output.error.message, /arguments\.smuggled is not allowed by the tool's input schema/);
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
