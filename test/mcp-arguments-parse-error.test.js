'use strict';

// #3499: an MCP `tools/call` whose `arguments` is a string that is not JSON is
// a parse error, distinct from a schema `INVALID_INPUT`. Before this it was
// parsed with `parseJsonObject(value, {})`, so a malformed call ran as if the
// model had supplied no arguments -- indistinguishable from a deliberate empty
// call. This pins the separation and the unchanged paths around it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { callTool } = require('../mcpServer');

function mockKernel() {
  return {
    ask() {
      return {
        ok: true,
        type: 'ask',
        data: { answer: 'mock answer', subject: 'x', unknown: false, alternatives: 0 },
        evidence: [],
        error: null,
        meta: { contractVersion: '1.0', backend: 'memory', paranoidMode: false },
      };
    },
    learn() {
      return {
        ok: true,
        type: 'learn',
        data: { learned: 1, skipped: 0, conflicts: [], alternatives: [] },
        evidence: [],
        error: null,
        meta: { contractVersion: '1.0', backend: 'memory', paranoidMode: false },
      };
    },
  };
}

test('a non-JSON arguments string is a parse error, not an empty call', () => {
  const result = callTool(mockKernel(), { name: 'huqan.ask', arguments: 'not-json' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ARGUMENTS_PARSE_ERROR');
  assert.equal(result.policy.decision, 'block');
  assert.equal(result.policy.reason, 'arguments_parse_error');
});

test('the parse error is distinct from the malformed-input block', () => {
  const parseError = callTool(mockKernel(), { name: 'huqan.ask', arguments: 'not-json' });
  const malformed = callTool(mockKernel(), null);
  assert.equal(parseError.policy.reason, 'arguments_parse_error');
  assert.equal(malformed.policy.reason, 'malformed_input_blocked');
  assert.equal(parseError.error.code, 'ARGUMENTS_PARSE_ERROR');
});

test('a JSON arguments string parses and runs', () => {
  const result = callTool(mockKernel(), {
    name: 'huqan.ask',
    arguments: JSON.stringify({ question: 'is this parsed?', workspaceId: 'w' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'allow');
});

test('an object arguments value is used unchanged', () => {
  const result = callTool(mockKernel(), { name: 'huqan.ask', arguments: { question: 'q', workspaceId: 'w' } });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'allow');
});

test('a missing arguments value is an empty call, not a parse error', () => {
  const result = callTool(mockKernel(), { name: 'huqan.ask' });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'allow');
});

test('a JSON string that is not an object falls back to empty, as before', () => {
  const arrayResult = callTool(mockKernel(), { name: 'huqan.ask', arguments: '[1,2,3]' });
  assert.equal(arrayResult.ok, true);
  assert.equal(arrayResult.verdict, 'allow');
  const scalarResult = callTool(mockKernel(), { name: 'huqan.ask', arguments: '42' });
  assert.equal(scalarResult.ok, true);
  assert.equal(scalarResult.verdict, 'allow');
});

test('a raw array or scalar arguments value is refused, not run as an empty call', () => {
  // #4525: parseJsonObject normalized a raw array/scalar to {}, so huqan.status
  // (closed schema, no declared parameters) ran as if the caller had supplied
  // nothing. A non-object raw value is now a parse error. A raw array/scalar is
  // valid JSON, so its refusal says "must be a JSON object", not "not valid
  // JSON" -- only a non-JSON string gets the parse-error wording.
  for (const raw of [[1, 2, 3], 42, true]) {
    const result = callTool(mockKernel(), { name: 'huqan.status', arguments: raw });
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.error.code, 'ARGUMENTS_PARSE_ERROR', JSON.stringify(raw));
    assert.match(result.error.message, /must be a JSON object/, JSON.stringify(raw));
  }
  const notJson = callTool(mockKernel(), { name: 'huqan.status', arguments: 'not-json' });
  assert.equal(notJson.ok, false);
  assert.equal(notJson.error.code, 'ARGUMENTS_PARSE_ERROR');
  assert.match(notJson.error.message, /not valid JSON/);
  // An omitted value stays an empty call; an object is used unchanged.
  assert.equal(callTool(mockKernel(), { name: 'huqan.status' }).ok, true);
  assert.equal(callTool(mockKernel(), { name: 'huqan.ask', arguments: {} }).ok, true);
});
