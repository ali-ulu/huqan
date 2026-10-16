'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');

// #2130 (#2123): Agent#_executeStep ran each internal tool through a switch
// over step.tool that grows with every new tool. The per-tool calls are now a
// table. The first block pins, for every tool, the exact collaborator call
// (method, arguments, option defaults) and that its result is passed through,
// plus the unsupported-tool fallback, so any drift is caught.

// The unsupported-tool fallback sits behind the action firewall, which already
// reviews any tool it does not know. To pin the fallback itself, one test lets a
// step past the firewall; agent.js reads the export when it loads, so the wrapper
// goes in before it.
const firewall = require('../lib/agent-action-step-enforcement');
const enforceAgentActionStep = firewall.enforceAgentActionStep;
let bypassFirewall = false;
firewall.enforceAgentActionStep = (args) => {
  const out = enforceAgentActionStep(args);
  return bypassFirewall ? { firewallDecision: out.firewallDecision, result: null } : out;
};

const Agent = require('../agent');
const { INTERNAL_TOOLS } = require('../toolPolicy');

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-agent-tool-dispatch-')); });
after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

const STATE = { goal: 'the goal? ok?', objective: 'inspect' };

function harness({ withDream = true } = {}) {
  const calls = [];
  const returned = [];
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
    const value = { ok: true, type: name, data: { n: returned.length }, evidence: [] };
    returned.push(value);
    return value;
  };
  const kernel = {
    learn: record('kernel.learn'),
    ask: record('kernel.ask'),
    verify: record('kernel.verify'),
    reason: record('kernel.reason'),
    compare: record('kernel.compare'),
    dream: record('kernel.dream'),
    ok(type, data, evidence, meta) { return { ok: true, type, data, evidence, meta }; },
    fail(type, code, message, meta) { return { ok: false, type, data: null, evidence: [], error: { code, message }, meta }; },
  };
  const agent = new Agent({ kernel, dream: { dream: record('dream.dream') }, memoryPath: path.join(dir, 'agent.json') });
  if (!withDream) agent.dream = null;
  const run = (tool, input, opts = {}, action = tool) => agent._executeStep({ id: 's1', action, tool, input }, STATE, opts);
  return { calls, returned, run };
}

const CASES = [
  { tool: 'learn', input: 'water boils', opts: {}, call: ['kernel.learn', 'water boils', {}] },
  { tool: 'learn', input: 'water boils', opts: { learnOpts: { a: 1 } }, call: ['kernel.learn', 'water boils', { a: 1 }] },
  { tool: 'ask', input: 'what is water', opts: {}, call: ['kernel.ask', 'what is water', {}] },
  { tool: 'ask', input: 'what is water', opts: { askOpts: { q: 1 } }, call: ['kernel.ask', 'what is water', { q: 1 }] },
  { tool: 'verify', input: 'water is wet', opts: {}, call: ['kernel.verify', 'water is wet', {}] },
  { tool: 'verify', input: 'water is wet', opts: { verifyOpts: { v: 1 } }, call: ['kernel.verify', 'water is wet', { v: 1 }] },
  { tool: 'reason', input: 'why? is it?', opts: {}, call: ['kernel.reason', 'why is it', {}] },
  { tool: 'reason', input: '', opts: { reasonOpts: { r: 1 } }, call: ['kernel.reason', 'the goal ok', { r: 1 }] },
  { tool: 'compare', input: 'cats | dogs', opts: {}, call: ['kernel.compare', 'cats', 'dogs', {}] },
  { tool: 'compare', input: 'one two three four', opts: { compareOpts: { c: 1 } }, call: ['kernel.compare', 'one two', 'three four', { c: 1 }] },
  { tool: 'compare', input: '', opts: {}, call: ['kernel.compare', 'the goal?', 'ok?', {}] },
  { tool: 'dream', input: '', opts: {}, call: ['dream.dream', {}] },
  { tool: 'dream', input: '', opts: { dreamOpts: { d: 1 } }, call: ['dream.dream', { d: 1 }] },
  { tool: 'dream', input: '', opts: { dreamOpts: { d: 1 } }, withDream: false, call: ['kernel.dream', { d: 1 }] },
];

describe('Agent internal tool dispatch (unchanged)', () => {
  it('covers every internal tool', () => {
    assert.deepEqual([...new Set(CASES.map((c) => c.tool))].sort(), [...INTERNAL_TOOLS].sort());
  });

  for (const { tool, input, opts, call, withDream } of CASES) {
    it(`${tool} ${JSON.stringify(input)} ${JSON.stringify(opts)}${withDream === false ? ' without dream' : ''} calls ${call[0]}`, () => {
      const { calls, returned, run } = harness({ withDream });
      const report = run(tool, input, opts);
      assert.deepEqual(calls, [call]);
      assert.equal(report.status, 'done');
      assert.equal(report.result, returned[0]);
    });
  }

  it('an internal tool without a handler, including prototype names, is blocked as unsupported', () => {
    // Tool policy lower-cases names, so only lower-case prototype names reach dispatch.
    for (const tool of ['bogus', '__proto__', 'constructor']) {
      INTERNAL_TOOLS.add(tool);
      bypassFirewall = true;
      try {
        const { calls, run } = harness();
        const report = run(tool, 'x');
        assert.deepEqual(calls, [], tool);
        assert.equal(report.status, 'blocked', tool);
        assert.deepEqual(report.result, {
          ok: false,
          type: 'agent',
          data: null,
          evidence: [],
          error: { code: 'UNSUPPORTED_TOOL', message: `Unsupported tool: ${tool}` },
          meta: { blocked: true, allowedTools: [...INTERNAL_TOOLS] },
        }, tool);
      } finally {
        bypassFirewall = false;
        INTERNAL_TOOLS.delete(tool);
      }
    }
  });
});

describe('the internal tool handlers are a registry (#2130)', () => {
  it('agent.js no longer switches on the step tool', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.doesNotMatch(source, /switch\s*\(\s*step\.tool\s*\)/);
  });

  it('the architecture snapshot no longer sees a growing dispatch here', () => {
    const row = require('../scripts/architecture-snapshot').snapshot().find((item) => item.file === 'agent.js');
    assert.ok(row, 'the file is measured');
    assert.ok(!row.signals.some((signal) => signal.startsWith('OCP')), JSON.stringify(row.signals));
  });
});
