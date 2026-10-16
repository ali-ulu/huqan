'use strict';

/**
 * safePayload's redaction must key on words, not substrings.
 *
 * The rule was a substring regex, so any key merely *containing* one of the
 * sensitive strings was dropped: `monkey`, `hockey` and `keyboard` on `key`,
 * `texture` on `text`, `tokenizer` on `token`. Legitimate telemetry vanished
 * with no trace, which is a false positive in a module whose job is reporting
 * metrics accurately.
 *
 * The redaction itself must not weaken: compound keys like `apiKey`,
 * `access_token` and `userPrompt` are the realistic shapes of a leak.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { safePayload } = require('../lib/observability/helpers');

function keysOf(payload) {
  return Object.keys(safePayload(payload));
}

function payloadOf(keys) {
  return Object.fromEntries(keys.map((key) => [key, 1]));
}

const LEGITIMATE = ['monkey', 'hockey', 'keyboard', 'texture', 'tokenizer', 'contextWindow', 'latencyMs', 'runId', 'stepCount'];
const SENSITIVE = [
  'goal', 'prompt', 'input', 'output', 'text', 'content', 'secret', 'token', 'key', 'authorization',
  'apiKey', 'api_key', 'accessToken', 'access_token', 'userPrompt', 'promptText', 'secretValue', 'outputTokens',
];

test('keys that merely contain a sensitive word are kept', () => {
  assert.deepEqual(keysOf(payloadOf(LEGITIMATE)).sort(), [...LEGITIMATE].sort());
});

test('sensitive keys, bare and compound, are still dropped', () => {
  assert.deepEqual(keysOf(payloadOf(SENSITIVE)), []);
});

test('redaction is case-insensitive', () => {
  assert.deepEqual(keysOf({ GOAL: 1, Authorization: 1, ApiKey: 1, PROMPT: 1 }), []);
});

test('a mixed payload keeps exactly the safe half', () => {
  const payload = { latencyMs: 12, apiKey: 'sk-live-abc', monkey: 'business', userPrompt: 'hello' };

  assert.deepEqual(safePayload(payload), { latencyMs: 12, monkey: 'business' });
});

test('the other payload rules are unchanged', () => {
  assert.deepEqual(safePayload(null), {});
  assert.deepEqual(safePayload([1, 2]), {});
  assert.deepEqual(keysOf({ '1bad': 1, 'has-dash': 1, ok_key2: 1 }), ['ok_key2']);
  assert.deepEqual(safePayload({ list: [1, 'two', { deep: 1 }] }), { list: [1, 'two'] });
  assert.equal(safePayload({ note: 'x'.repeat(600) }).note.length, 512);
});
