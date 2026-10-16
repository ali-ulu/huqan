'use strict';

/**
 * Paranoid mode must stop the request, not just the learning.
 *
 * kernel-learn-from-llm refuses under paranoidMode with "outbound LLM calls and
 * automatic learning are blocked". But the plugin called adapter.ask(...)
 * first and only reached learnFromLLM once that promise resolved -- so the
 * user's unanswered question had already left the machine, and only the
 * *learning* was blocked. For a privacy switch, that is the whole point missed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const LLMAdapter = require('../llmAdapter');
const plugin = require('../plugins/llm-memory-plugin');

function makeKernel(paranoidMode) {
  const calls = { learnFromLLM: 0 };
  return {
    calls,
    paranoidMode,
    learnFromLLM: () => { calls.learnFromLLM += 1; return { ok: true }; },
    graph: { getStats: () => ({ nodes: 0, edges: 0 }) },
  };
}

function stubAdapter() {
  const asked = [];
  const original = LLMAdapter.prototype.ask;
  LLMAdapter.prototype.ask = async function stubbedAsk(prompt) {
    asked.push(prompt);
    return { ok: true, data: { text: 'some answer' } };
  };
  return { asked, restore: () => { LLMAdapter.prototype.ask = original; } };
}

const UNANSWERED = { question: 'Sirketin 2026 gelir hedefi nedir?', answer: 'Bilmiyorum', unknown: true };

test('paranoid mode sends nothing outbound', async () => {
  const stub = stubAdapter();
  try {
    const kernel = makeKernel(true);
    plugin.init(kernel);

    plugin.afterAsk(kernel, { ...UNANSWERED });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(stub.asked, [], 'the question must not leave the machine');
    assert.equal(kernel.calls.learnFromLLM, 0);
  } finally {
    stub.restore();
  }
});

test('paranoid mode still returns the payload untouched', () => {
  const stub = stubAdapter();
  try {
    const kernel = makeKernel(true);
    plugin.init(kernel);

    const data = { ...UNANSWERED };
    assert.equal(plugin.afterAsk(kernel, data), data);
  } finally {
    stub.restore();
  }
});

test('without paranoid mode the question is still asked and learned', async () => {
  const stub = stubAdapter();
  try {
    const kernel = makeKernel(false);
    plugin.init(kernel);

    plugin.afterAsk(kernel, { ...UNANSWERED });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(stub.asked, [UNANSWERED.question]);
    assert.equal(kernel.calls.learnFromLLM, 1);
  } finally {
    stub.restore();
  }
});

test('an answered question is never sent, paranoid or not', async () => {
  const stub = stubAdapter();
  try {
    const kernel = makeKernel(false);
    plugin.init(kernel);

    plugin.afterAsk(kernel, { question: 'kedi nedir?', answer: 'bir hayvan', unknown: false });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(stub.asked, []);
  } finally {
    stub.restore();
  }
});

test('the adapter itself refuses under paranoid mode', async () => {
  const adapter = new LLMAdapter({ paranoidMode: true, fetchImpl: () => { throw new Error('the network must not be touched'); } });

  const result = await adapter.ask('gizli soru');

  assert.equal(result.ok, false);
  assert.match(result.error, /paranoid mode/i);
});

test('the adapter reads the PARANOID environment switch', async () => {
  const previous = process.env.PARANOID;
  process.env.PARANOID = '1';
  try {
    const adapter = new LLMAdapter({ fetchImpl: () => { throw new Error('the network must not be touched'); } });

    const result = await adapter.ask('gizli soru');

    assert.equal(result.ok, false);
    assert.match(result.error, /paranoid mode/i);
  } finally {
    if (previous === undefined) delete process.env.PARANOID;
    else process.env.PARANOID = previous;
  }
});
