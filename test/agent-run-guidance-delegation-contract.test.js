'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Agent = require('../agent');
const guidance = require('../lib/agent-run-guidance');

const agentSource = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent-run-guidance.js'), 'utf8');

const state = overrides => ({
  status: 'running',
  objective: 'investigate',
  goal: 'understand the result',
  steps: [],
  progress: { stalledCount: 0 },
  selectedTools: ['ask'],
  plan: { policy: { signals: [] } },
  ...overrides,
});

test('Agent run-guidance helpers are one-line, cycle-free delegations', () => {
  assert.match(agentSource, /_extractAgentSummary\(result\) \{\n    return extractAgentSummary\(result\);\n  \}/);
  assert.match(agentSource, /_buildRunRecommendations\(state\) \{\n    return buildRunRecommendations\(state, this\.memory\);\n  \}/);
  assert.match(agentSource, /_suggestNextAction\(state\) \{\n    return suggestNextAction\(state\);\n  \}/);
  assert.match(agentSource, /_chooseFollowUp\(step, summary, state\) \{\n    return chooseFollowUp\(step, summary, state\);\n  \}/);
  assert.doesNotMatch(delegateSource, /require\(['"].*(?:agent|kernel|server)/);
  assert.doesNotMatch(delegateSource, /\bthis\./);
  assert.doesNotMatch(delegateSource, /\._(storage|memory|nodes|edges|db|stmts)/);
  assert.deepEqual(Object.keys(guidance), [
    'extractAgentSummary',
    'buildRunRecommendations',
    'suggestNextAction',
    'chooseFollowUp',
  ]);
});

test('summary extraction preserves fallback order, evidence and data identity', () => {
  const result = {
    data: { answer: 'answer', explanation: 'explanation', status: 'complete' },
    evidence: ['e-1'],
  };
  const summary = guidance.extractAgentSummary(result);
  assert.deepEqual(summary, {
    text: 'answer',
    status: 'complete',
    evidence: result.evidence,
    data: result.data,
  });
  assert.deepEqual(guidance.extractAgentSummary(null), { text: '', status: 'unknown', evidence: [] });
});

test('recommendations inject memory stats without mutating state or memory', () => {
  const runState = state({
    status: 'blocked',
    progress: { stalledCount: 2 },
    plan: { policy: { signals: ['recent-failure', 'tool-health-risk'] } },
    steps: [{ status: 'blocked', action: 'run' }],
  });
  const memory = { stats: { tools: { ask: { success: 2 }, shell: { blocked: 3, error: 1 }, dream: { error: 4 } } } };
  const stateSnapshot = JSON.parse(JSON.stringify(runState));
  const memorySnapshot = JSON.parse(JSON.stringify(memory));
  const result = guidance.buildRunRecommendations(runState, memory);

  assert.deepEqual(result.items, [
    'Continue with the permitted tool set only, and narrow the request.',
    'Restate the goal or add context before repeating the same tool.',
    'Do not repeat a tool signature that failed recently; fall back to ask or dream.',
    'Narrow the goal before retrying a weak tool path.',
  ]);
  assert.deepEqual(result.toolHealth, [
    { tool: 'shell', success: 0, blocked: 3, error: 1 },
    { tool: 'dream', success: 0, blocked: 0, error: 4 },
    { tool: 'ask', success: 2, blocked: 0, error: 0 },
  ]);
  assert.deepEqual(runState, stateSnapshot);
  assert.deepEqual(memory, memorySnapshot);
});

test('next-action and follow-up decisions preserve fail-closed ordering', () => {
  assert.deepEqual(guidance.suggestNextAction(state({
    status: 'blocked',
    steps: [{ status: 'blocked', action: 'run' }],
  })), {
    action: 'revise',
    tool: 'ask',
    reason: 'Blocked execution detected; refine the request and use only allowed tools.',
  });
  assert.deepEqual(guidance.suggestNextAction(state({
    objective: 'verify',
    steps: [{ action: 'ask', result: { ok: true } }],
  })), {
    action: 'verify',
    tool: 'verify',
    reason: 'Verification has not run yet for this objective.',
  });
  assert.deepEqual(guidance.chooseFollowUp(
    { action: 'ask' },
    { text: '', status: 'unknown' },
    state({ objective: 'verify' }),
  ), { action: 'dream', tool: 'dream', input: {} });
  assert.deepEqual(guidance.chooseFollowUp(
    { action: 'learn' },
    { text: 'learned', status: 'complete' },
    state(),
  ), { action: 'verify', tool: 'verify', input: 'understand the result' });
});

/**
 * "I have no answer" used to be decided by matching the Turkish display string
 * `Bilmiyorum`, so the day that string is translated every unanswered step
 * would read as answered and the run would continue instead of falling back to
 * dream — a silent wrong turn, not a crash. Read results carry `data.unknown`
 * for exactly this, and the decision follows the flag.
 *
 * The string stays a fallback for producers that hand back a bare answer with
 * no envelope to put a flag on, so both spellings of the contract are pinned
 * here: flag-first, string-still-honoured.
 */
test('unanswered follow-up decisions read the structural flag, not the display string', () => {
  const summary = (answer, unknown) => guidance.extractAgentSummary({
    data: unknown === undefined ? { answer } : { answer, unknown },
    evidence: [],
  });
  const dream = { action: 'dream', tool: 'dream', input: {} };

  for (const step of [{ action: 'ask' }, { action: 'compare' }]) {
    const decide = (s) => guidance.chooseFollowUp(step, s, state({ objective: 'investigate' }));

    // The flag decides even when the answer text is not the Turkish string.
    assert.deepEqual(decide(summary('I do not know', true)), dream, step.action);
    assert.equal(decide(summary('dog vs cat: shared animal', false)), null, step.action);

    // A producer with no flag still gets the legacy reading.
    assert.deepEqual(decide(summary('Bilmiyorum')), dream, step.action);
    assert.equal(decide(summary('dog vs cat: shared animal')), null, step.action);

    // An empty answer is unanswered regardless of either signal.
    assert.deepEqual(decide(summary('', false)), dream, step.action);
  }
});

test('Agent wrappers preserve the delegate result and AgentV3-compatible memory seam', () => {
  const memory = { stats: { tools: { ask: { success: 1 } } } };
  const context = { memory };
  const runState = state();
  assert.deepEqual(Agent.prototype._extractAgentSummary.call(context, { data: { summary: 'ok' } }), {
    text: 'ok',
    status: 'unknown',
    evidence: [],
    data: { summary: 'ok' },
  });
  assert.deepEqual(Agent.prototype._buildRunRecommendations.call(context, runState),
    guidance.buildRunRecommendations(runState, memory));
  assert.deepEqual(Agent.prototype._suggestNextAction.call(context, runState),
    guidance.suggestNextAction(runState));
  assert.deepEqual(Agent.prototype._chooseFollowUp.call(context,
    { action: 'verify' }, { text: 'ok', status: 'complete' }, runState), null);
});
