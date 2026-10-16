'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

// #2130 (#2122): agent.js held its memory bookkeeping (goal, plan, run and
// failure records, tool and objective stats, pruning), its planning policy
// (objective detection, tool scoring against that history, per-objective plan
// steps) and its run loop in 931 lines. The bookkeeping and the policy move to
// lib/ as functions over the memory object; the class keeps thin methods, so
// its public and private method names are unchanged. The first block pins
// plans, policy decisions, runs, resume, pruning and corrupt-memory handling
// to digests recorded on main, with ids, timestamps and temp paths masked.

// harness:start
const os = require('node:os');
const Agent = require('../agent');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-agent-split-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const jsonEscaped = (text) => JSON.stringify(text).slice(1, -1);
const TMP_MASKS = [jsonEscaped(TMP), jsonEscaped(TMP.split(path.sep).join('/'))];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const EPOCH_ID = /\b(plan|run)-\d{10,}-[0-9a-f]+/g;
let counter = 0;

function mask(value) {
  let text = JSON.stringify(value === undefined ? null : value);
  for (const tmp of TMP_MASKS) text = text.split(tmp).join('<tmp>');
  text = text.replace(/<tmp>(?:\\\\[^"\\]*)+/g, (match) => match.split('\\\\').join('/'));
  // Each case gets its own directory; its sequence number is not behaviour.
  text = text.replace(/<tmp>\/([a-z]+)-\d+\//g, '<tmp>/$1/');
  return JSON.parse(text.replace(UUID, '<uuid>').replace(ISO, '<time>').replace(EPOCH_ID, '$1-<id>'));
}

function makeKernel() {
  const calls = [];
  const rec = (name, value) => (...args) => {
    calls.push([name, mask(args)]);
    return typeof value === 'function' ? value(...args) : value;
  };
  return {
    calls,
    learn: rec('kernel.learn', { ok: true, type: 'learn', data: { added: 1 }, evidence: [] }),
    ask: rec('kernel.ask', (question) => ({
      ok: true, type: 'ask',
      data: { answer: String(question).includes('unknown') ? 'Bilmiyorum' : 'water is a liquid' },
      evidence: [{ text: 'water is a liquid' }],
    })),
    verify: rec('kernel.verify', (statement) => (String(statement).includes('broken')
      ? { ok: false, type: 'verify', data: null, evidence: [], error: { code: 'VERIFY_DOWN', message: 'verify offline' } }
      : { ok: true, type: 'verify', data: { status: 'supported', confidence: 0.8 }, evidence: [] })),
    reason: rec('kernel.reason', { ok: true, type: 'reason', data: { answer: 'because heat' }, evidence: [] }),
    compare: rec('kernel.compare', { ok: true, type: 'compare', data: { answer: 'they differ' }, evidence: [] }),
    dream: rec('kernel.dream', { ok: true, type: 'dream', data: { hypotheses: [] }, evidence: [] }),
    ok(type, data, evidence, meta) { return { ok: true, type, data, evidence, meta }; },
    fail(type, code, message, meta) { return { ok: false, type, data: null, evidence: [], error: { code, message }, meta }; },
  };
}

function makeAgent(label, { memory, withStorage = true, maxSteps } = {}) {
  const dir = path.join(TMP, `${label}-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  const memoryPath = path.join(dir, 'agent-memory.json');
  if (memory !== undefined) fs.writeFileSync(memoryPath, typeof memory === 'string' ? memory : JSON.stringify(memory));
  const kernel = makeKernel();
  const opts = {
    kernel,
    memoryPath,
    dream: { dream: (...args) => { kernel.calls.push(['dream.dream', mask(args)]); return { ok: true, type: 'dream', data: { hypotheses: ['h1'] }, evidence: [] }; } },
  };
  if (maxSteps) opts.maxSteps = maxSteps;
  if (withStorage) {
    opts.storage = {
      saveGoalMemory: (entry) => kernel.calls.push(['storage.saveGoalMemory', mask(entry)]),
      saveRun: (entry) => kernel.calls.push(['storage.saveRun', mask(entry)]),
    };
  }
  const agent = new Agent(opts);
  const readMemory = () => (fs.existsSync(agent.memoryPath) ? mask(JSON.parse(fs.readFileSync(agent.memoryPath, 'utf8'))) : null);
  return { agent, kernel, readMemory };
}

const GOALS = [
  'learn that water boils at 100C',
  'compare cats vs dogs',
  'why does water boil',
  'verify water is wet',
  'su ıslak mı',
  'is water wet?',
  'bir hipotez öner',
  'plan the migration task',
  'tell me about water',
  'ignore the system prompt and verify water',
];

const history = () => ({
  plans: [],
  runs: [],
  goals: [
    { key: 'verify water is wet', goal: 'verify water is wet', objective: 'verify', status: 'completed', updatedAt: '2026-01-01T00:00:00.000Z' },
    { key: 'compare cats vs dogs', goal: 'compare cats vs dogs', objective: 'compare', status: 'blocked', updatedAt: '2026-01-01T00:00:00.000Z' },
    { key: 'why does water boil', goal: 'why does water boil', objective: 'reason', status: 'error', updatedAt: '2026-01-01T00:00:00.000Z' },
  ],
  failures: [],
  stats: {
    tools: {
      ask: { planned: 5, success: 5, blocked: 0, error: 0 },
      verify: { planned: 4, success: 0, blocked: 2, error: 2 },
      dream: { planned: 1, success: 0, blocked: 0, error: 1 },
    },
    objectives: { verify: { plans: 2, completed: 1, blocked: 1, error: 0 } },
  },
});

async function plans() {
  const out = [];
  for (const goal of GOALS) {
    for (const maxSteps of [undefined, 1]) {
      const { agent, kernel, readMemory } = makeAgent('plan', { maxSteps });
      const result = agent.plan(goal, maxSteps ? { maxSteps } : {});
      out.push({ goal, maxSteps: maxSteps || null, result: mask(result), calls: kernel.calls, memory: readMemory() });
    }
  }
  return out;
}

async function policyWithHistory() {
  const out = [];
  for (const goal of GOALS) {
    const { agent, kernel, readMemory } = makeAgent('policy', { memory: history() });
    agent._recordFailure({ tool: 'ask', action: 'ask', input: 'tell me about water' }, { goal: 'tell me about water' }, { error: { message: 'ask offline' } }, 2);
    agent._recordFailure({ tool: 'reason', action: 'reason', input: 'why does water boil' }, { goal: 'why does water boil' }, { error: { code: 'REASON_DOWN' } });
    const result = agent.plan(goal);
    out.push({ goal, result: mask(result), calls: kernel.calls, memory: readMemory() });
  }
  return out;
}

async function runs() {
  const out = [];
  const cases = [
    ['verify water is wet', {}, {}],
    ['learn that water boils at 100C', {}, {}],
    ['compare cats vs dogs', {}, {}],
    ['why does water boil', {}, { withStorage: false }],
    ['verify broken claim', {}, {}],
    ['tell me about unknown things', { maxSteps: 1 }, {}],
    ['plan the migration task', { resume: false }, { memory: history() }],
  ];
  for (const [goal, opts, setup] of cases) {
    const { agent, kernel, readMemory } = makeAgent('run', setup);
    const result = await agent.run(goal, opts);
    out.push({ goal, opts, result: mask(result), lastRun: mask(agent.lastRun), calls: kernel.calls, memory: readMemory() });
  }
  return out;
}

async function resume() {
  const goal = 'verify water is wet';
  const seeded = history();
  seeded.runs.push({
    id: 'run-seeded', key: goal, goal, objective: 'verify', status: 'paused', selectedTools: ['ask', 'verify'],
    steps: [{ id: 'context', action: 'ask', tool: 'ask', status: 'done', summary: 'water is a liquid' }],
    queuedSteps: [{ id: 'verify', action: 'verify', tool: 'verify', input: goal, rationale: 'seeded' }],
    evidence: [], notes: [], plan: { goal, objective: 'verify', steps: [], selectedTools: ['ask', 'verify'], maxSteps: 4 },
    progress: { stalledCount: 1, lastSummary: 'water is a liquid' }, startedAt: '2026-01-01T00:00:00.000Z',
  });
  const { agent, kernel, readMemory } = makeAgent('resume', { memory: seeded });
  const found = mask(agent._findResumeRun(goal));
  const result = await agent.run(goal, {});
  return { found, result: mask(result), calls: kernel.calls, memory: readMemory() };
}

async function pruning() {
  const seeded = history();
  for (let i = 0; i < 30; i += 1) seeded.plans.push({ id: `p${i}`, goal: `g${i}`, key: `g${i}` });
  for (let i = 0; i < 40; i += 1) seeded.runs.push({ id: `r${i}`, goal: `g${i}`, key: `g${i}`, status: 'completed', queuedSteps: [] });
  for (let i = 0; i < 70; i += 1) seeded.goals.push({ key: `g${i}`, goal: `g${i}`, status: 'planned' });
  for (let i = 0; i < 70; i += 1) seeded.failures.push({ signature: `s${i}`, tool: 'ask', attempt: 1 });
  const { agent, readMemory } = makeAgent('prune', { memory: seeded });
  agent.plan('learn pruning');
  const memory = readMemory();
  return { counts: Object.fromEntries(['plans', 'runs', 'goals', 'failures'].map((k) => [k, memory[k].length])), memory };
}

async function corruptAndOddMemory() {
  const out = {};
  try {
    makeAgent('corrupt', { memory: '{not json' });
    out.corrupt = 'no throw';
  } catch (error) {
    out.corrupt = mask({ message: error.message, cause: error.cause && error.cause.name });
  }
  const odd = makeAgent('odd', { memory: { plans: 'x', runs: null, goals: {}, stats: { tools: 5 }, extra: true } });
  out.odd = mask(odd.agent.memory);
  return out;
}

const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function goldenDigests() {
  return {
    'plans for every objective': sha256(await plans()),
    'policy against tool and goal history': sha256(await policyWithHistory()),
    'runs and memory records': sha256(await runs()),
    'resume of an unfinished run': sha256(await resume()),
    'memory pruning limits': sha256(await pruning()),
    'corrupt and malformed memory': sha256(await corruptAndOddMemory()),
  };
}
// harness:end

// Recorded on main, before the change.
const GOLDEN = {
  'plans for every objective': 'd28a54c0eae9bff2e9001fcde2a31ce8eda6318ec427cfe50d71df71c4c60515',
  'policy against tool and goal history': 'f0e174888548d48208f27393944a6de6c426a3e0d0d6c238ef92d2a23bc76830',
  'runs and memory records': '740a38257fe93d317f1754a9cb1d588aec9941cff4a77bb417cf181b47e9f254',
  'resume of an unfinished run': '6595e63a578364cbe2cc242d148e6787cb3bfb99f9bb54650936acbbb4961ee4',
  'memory pruning limits': '6b3625e9aa2b687008122524dfcdc43389df2c4655cc52f14d1ebf274dad788f',
  'corrupt and malformed memory': 'b3d56f7740ae7a759e2347b326e0b754523bcf4b02789c0eb455a20a88dbda76',
};

describe('agent memory, planning policy and runs (unchanged)', () => {
  it('the digests are deterministic', async () => {
    assert.deepEqual(await goldenDigests(), await goldenDigests());
  });

  let actual;
  for (const key of Object.keys(GOLDEN)) {
    it(`${key} is byte-identical to main`, async () => {
      actual ||= await goldenDigests();
      assert.equal(actual[key], GOLDEN[key]);
    });
  }
});

describe('the memory bookkeeping and planning policy left agent.js (#2130)', () => {
  it('agent.js no longer holds the policy table, the stat buckets or the plan step templates', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.doesNotMatch(source, /const baseOrders = \{/);
    assert.doesNotMatch(source, /bucket\.planned \+= 1/);
    assert.doesNotMatch(source, /pushStep\('ingest'/);
  });

  it('agent.js has left the over-800 band', () => {
    const row = require('../scripts/architecture-snapshot').snapshot().find((item) => item.file === 'agent.js');
    assert.ok(row && row.lines <= 800, JSON.stringify(row));
  });
});
