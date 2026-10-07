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
// #3488 re-recorded the tools whose output embeds the gate: the gate now
// carries `binding` ({ tool, argsDigest }), the call it decided about. No
// decision, reason or routing moved.
//
// Regenerate only on purpose: UPDATE_MCP_DISPATCH_GOLDEN=1 node --test <this file>
const GOLDEN = {
  'huqan.learn': 'e0edb52a102cb075b64861d689bd7ffa09f64325846033e3bad379cda46eff7f',
  'huqan.ask': 'ad49c39a897ce936e3558e2cb3ee7d1af721dd380bbd92da3c913e11fa5df795',
  'huqan.verify': '484accad2fcd1106a3090fc666da3a70e4ebad96a8d9f8862064a64fc24ec757',
  'huqan.plan': '318e9c5e41e5502e0c4d57cbe0e6ea959df862e44e4db143f5abefeda499bfd5',
  'huqan.agent': '8872f29b4272a8c0441668a788d88e04ebadf19afb0f3f0006dd07e0e268e280',
  'huqan.policy': '8a0f76759a9014b814077ea1bb109dc893d6b2be1c1196c8d174fef4b11a7f33',
  'huqan.approval_detail': '1ce1b685c78069c79f61608525f75161730c5ed40c8de31cb38d7d75cb3d205e',
  'huqan.approvals': 'f31a675da052e5edf832f0a712974737f3e9ba68776c86b8a942e30c19ad3860',
  'huqan.reason': 'a3cfb1b72319c626258724fe87e1af8dd968614d9123835d2bf8041b896695b3',
  'huqan.derive': 'e29cc04fa5401ba14e2514d582e85e78679af0df0e38f018c1c27ad1a84e0f7c',
  'huqan.prove': '4a94acdea1121cde545efe719488fa22dc7fb5fea162861c7f7d1675eb7d9ce3',
  'huqan.compare': '93e037979e4fd8e61ed75fd4e01242081501b8f3fc4445c47005e5d2a72be761',
  'huqan.dream': '432937e74cf96220e0dac5caba33dac1991a943731740adefa621dc5fe45c48e',
  'huqan.fractal-learn': '5ff5d0d6c399742e862b766799ca3dabfb0101b5177764674bf4c1f7a306011d',
  'huqan.self-evolve': '39d5d3b122cb20258cf173986fe76a6c2dd809e76fb4609296fca7e100daca25',
  'huqan.advocate': '841bab034317bfa72741f58b63f7ca41709c7ffbb6a62e031f1c80743e3daa2f',
  'huqan.web_research': '252ea84a371ad64c427ba856fdbf9b79327a3e9bb2b2e0362483b5ae8be15f3f',
  'huqan.search': '24b698f7d4e3cf36fc3858d1d921634ea54ab15dcab0fd5d341cb1a32019d1ac',
  'huqan.trust_receipt': 'c5a6635284b4abc4c746fd4c4b1aefd40110312cddfc9fd96c494b5c8fa6fcf1',
  'huqan.trust_receipt_detail': 'eb9731b7f740fdd41711eef8931d97390e152c0706f7f043eeb82528b21034f3',
  'huqan.experience_read': '482e5526d502cfb8096f1a13f76b92bc285a251cba2b9267fee1a46f45dbb66a',
  'huqan.experience_learn': 'b87d084e995d213107a2782fac9ee800dd19ab0a03ca59570ab24fb44158ee10',
  'huqan.memory_query': '6e7c187a1f0089d2807aff04f5bee754890bd08a88f97e8e5ec5cb444b8904f8',
  'huqan.status': '267885d283c065eed63ac3e2c2b75e77059cf6698f44020c67175ca6417752a9',
  'huqan.audit': '53398b050bb0371e90209647dd8f394b047beae7b438000410cad80561098297',
  'huqan.ingest_preview': 'c865da9cf3eaed67fa72e57f4f2ec765889a0e4a23c014f56c3f2a16241ed719',
  'huqan.ingest_status': '5eb079bc6a66e3237af883639d70d66c32a05c9458a1dae99636aee0f32dc2d3',
  'huqan.ingest_execute': 'bfa9c496d55255e2acce019b3c420f8cfebb15b65f0561fa02ce776018f599f3',
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
