'use strict';

// Pins every envelope the default workflow tools return, and every call they
// make into the capability runner, byte for byte (#2133). The file split in
// that issue moves this code; nothing observable may move with it.
//
// Regenerate only on purpose: UPDATE_WORKFLOW_TOOLS_FIXTURE=1 node --test <this file>

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createWorkflowTools } = require('../workflow-tools');

const FIXTURE = path.join(__dirname, 'fixtures', 'workflow-tools-envelopes.json');
const UNDEFINED = '__undefined__';

// JSON drops undefined-valued keys; a split that starts emitting `opts: undefined`
// must still show up as a difference.
function snapshot(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => (item === undefined ? UNDEFINED : item)));
}

const CONTEXT = {
  action: 'Context-Action',
  sourceType: 'Context-Source',
  question: 'context question',
  text: 'context text',
  title: 'context title',
  rationale: 'context rationale',
  decidedBy: 'context decider',
  date: '2026-01-01',
  links: ['context-link'],
  alternatives: ['context-alt'],
  sessionId: 'context-session',
  goal: 'context goal',
  hypothesis: 'context hypothesis',
  result: 'context result',
  observation: 'context observation',
  runs: [{ id: 'context-run' }],
  observations: ['context-observation'],
  name: 'context-capability',
  input: { from: 'context' },
  subject: 'context subject',
  workspaceId: 'context-workspace',
  baseConfidence: 0.4,
  type: 'blog',
  opts: { from: 'context' },
};

const INPUTS = {
  verifyClaim: [{ statement: 'kedi hayvandir', opts: { strict: true } }, 'plain claim'],
  findContradictions: [{ subject: 'kedi', workspaceId: 'tenant-a' }, 'plain subject'],
  rankEvidence: [
    { baseConfidence: 0.8, evidence: [{ type: 'blog', confidence: 0.8 }, { kind: 'peer_reviewed' }] },
    { evidence: { type: 'peer_reviewed', confidence: 0.3 } },
  ],
  repoMemory: [{ sourceType: 'Markdown', path: 'README.md', opts: { workspace: 'input' } }, 'plain repo'],
  companyBrain: [{
    action: 'Ingest',
    question: 'why',
    text: 'decision text',
    sourceType: 'Decision',
    title: 't',
    rationale: 'r',
    decidedBy: 'd',
    date: '2026-02-02',
    links: ['l'],
    alternatives: ['a'],
    sessionId: 's',
    opts: { workspace: 'input' },
  }, 'plain company'],
  discoveryEngine: [{ goal: 'g', hypothesis: 'h', text: 't', opts: { workspace: 'input' } }, 'plain discovery'],
  experimentPlanner: [{ goal: 'g', hypothesis: 'h', text: 't', opts: { workspace: 'input' } }, 'plain experiment'],
  resultAnalyzer: [{ result: 'r', observation: 'o', text: 't', opts: { workspace: 'input' } }, 'plain analysis'],
  replicationChecker: [{ runs: [{ id: 1 }], observations: ['o'], text: 't', opts: { workspace: 'input' } }, 'plain replication'],
  runCapability: [{ name: 'demo', input: { a: 1 }, opts: { approve: true } }, 'plain run'],
  getGraphStats: [{}],
};

function recordingKernel(outcome) {
  const calls = [];
  const run = async (name, request, opts) => {
    calls.push(snapshot({ name, request, opts }));
    if (outcome === 'throws') throw Object.assign(new Error('runner failed'), { code: 'RUNNER_DOWN' });
    if (outcome === 'unavailable') return { ok: false, error: { message: `Unknown capability: ${name}` } };
    if (outcome === 'failed') return { ok: false, error: { code: 'CAP_FAILED', message: 'capability refused' } };
    if (outcome === 'bare') return { bare: name };
    return { ok: true, data: { capability: name, echoed: request }, evidence: [{ kind: 'direct_edge', text: name }], confidence: 0.77 };
  };
  const kernel = {
    verify: (statement, opts) => ({ ok: true, data: { status: 'verified', confidence: 0.88, opts }, evidence: [{ kind: 'direct_edge', text: statement }] }),
    detectContradictions: (subject, workspaceId) => [{ type: 'negation', description: `${subject}@${workspaceId}`, confidence: 0.66 }, { reason: 'bare' }],
    graph: { getStats: () => ({ nodes: 1, edges: 2 }) },
    getCapability: name => ({ name, riskLevel: 'low' }),
  };
  if (outcome === 'plugins') {
    kernel.plugins = { runCapability: run };
  } else {
    kernel.runCapability = run;
  }
  return { kernel, calls };
}

const KERNELS = ['ok', 'plugins', 'bare', 'unavailable', 'failed', 'throws', 'none'];

async function observe() {
  const observed = {};
  for (const outcome of KERNELS) {
    const { kernel, calls } = outcome === 'none' ? { kernel: {}, calls: [] } : recordingKernel(outcome);
    const tools = createWorkflowTools(kernel, { runCapabilityPolicy: request => request.name !== 'context-capability' });
    for (const tool of tools) {
      for (const [index, input] of INPUTS[tool.name].entries()) {
        for (const [contextName, context] of [['empty', {}], ['full', CONTEXT]]) {
          calls.length = 0;
          let envelope;
          try {
            envelope = await tool.run(context, input);
          } catch (error) {
            envelope = { threw: error.message };
          }
          observed[`${outcome}/${tool.name}/${index}/${contextName}`] = snapshot({ envelope, calls });
        }
      }
    }
  }
  return observed;
}

function surface() {
  return snapshot(createWorkflowTools({}).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
}

test('workflow tool envelopes and runner calls match the recorded characterisation', async () => {
  const actual = { surface: surface(), runs: await observe() };

  if (process.env.UPDATE_WORKFLOW_TOOLS_FIXTURE === '1') {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    // One scenario per line keeps a real behaviour change reviewable as a one-line diff.
    const runs = Object.entries(actual.runs).map(([key, run]) => `    ${JSON.stringify(key)}: ${JSON.stringify(run)}`);
    fs.writeFileSync(FIXTURE, `{\n  "surface": ${JSON.stringify(actual.surface)},\n  "runs": {\n${runs.join(',\n')}\n  }\n}\n`);
  }

  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(actual.surface, expected.surface);
  assert.deepEqual(Object.keys(actual.runs), Object.keys(expected.runs));
  for (const key of Object.keys(expected.runs)) {
    assert.deepEqual(actual.runs[key], expected.runs[key], key);
  }
});
