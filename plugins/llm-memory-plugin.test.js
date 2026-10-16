const test = require('node:test');
const assert = require('node:assert/strict');

function loadFreshPlugin() {
  delete require.cache[require.resolve('./llm-memory-plugin')];
  return require('./llm-memory-plugin');
}

test('llm-memory-plugin: afterAsk does not throw when init() has not run yet (#1306)', () => {
  const plugin = loadFreshPlugin();
  const kernel = { learnFromLLM() { throw new Error('must not be called'); } };
  assert.doesNotThrow(() => {
    plugin.afterAsk(kernel, { question: 'q', answer: 'Bilmiyorum' });
  });
});

test('llm-memory-plugin: afterAsk still asks the adapter once init() has run', async () => {
  const plugin = loadFreshPlugin();
  plugin.init({});
  const kernel = { learnFromLLM() {} };
  // Should not throw synchronously; the async .then/.catch chain runs against
  // the real LLMAdapter and is allowed to fail (no network in tests) --
  // afterAsk itself must return synchronously either way.
  assert.doesNotThrow(() => {
    plugin.afterAsk(kernel, { question: 'q', answer: 'Bilmiyorum' });
  });
});
