'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MCP_MAX_TEXT,
  MCP_MAX_SHORT,
  sanitizeMcpString,
  boundedMcpInteger,
  sanitizeMcpApprovalDecision,
  sanitizeToolArgsForStorage,
} = require('../lib/mcp-input-sanitizers');

test('sanitizeMcpString strips control characters, trims, and enforces the bound', () => {
  assert.equal(sanitizeMcpString('  hello \x00\x07world\t'), 'hello world');
  assert.equal(sanitizeMcpString('a'.repeat(MCP_MAX_TEXT + 50), MCP_MAX_TEXT).length, MCP_MAX_TEXT);
  assert.equal(sanitizeMcpString(42), '');
  assert.equal(sanitizeMcpString(null), '');
  assert.equal(sanitizeMcpString(undefined, MCP_MAX_SHORT).length, 0);
  // \x7F (DEL) and C0 escapes go; normal \n survives because it is valid content.
  assert.equal(sanitizeMcpString('ok\x1F!\x7F'), 'ok!');
  assert.equal(sanitizeMcpString('line\nbreak'), 'line\nbreak');
});

test('boundedMcpInteger clamps and falls back', () => {
  assert.equal(boundedMcpInteger(50, 10, 1, 100), 50);
  assert.equal(boundedMcpInteger(500, 10, 1, 100), 100);
  assert.equal(boundedMcpInteger(-5, 10, 1, 100), 1);
  assert.equal(boundedMcpInteger('50', 10, 1, 100), 10);
  assert.equal(boundedMcpInteger(1.5, 10, 1, 100), 10);
  assert.equal(boundedMcpInteger(undefined, 42, 1, 100), 42);
});

test('an unrecognized approval decision fails closed instead of approving', () => {
  // #615 regression: 'banana' used to collapse to the privileged branch.
  assert.equal(sanitizeMcpApprovalDecision('banana'), null);
  assert.equal(sanitizeMcpApprovalDecision(''), null);
  assert.equal(sanitizeMcpApprovalDecision('   '), null);
  assert.equal(sanitizeMcpApprovalDecision('approved '), 'approved');
  assert.equal(sanitizeMcpApprovalDecision('  APPROVE'), 'approved');
  assert.equal(sanitizeMcpApprovalDecision('Reject'), 'rejected');
  assert.equal(sanitizeMcpApprovalDecision('rejected'), 'rejected');
});

test('huqan.learn argument sanitization keeps knowledge content and drops untyped fields', () => {
  const args = {
    text: '  knowledge \x00 text  ',
    skipConflicts: false,
    maxSentences: 3,
    workspaceId: '  ws-a  ',
    nestedObject: { evil: true },
    nestedArray: ['x'],
  };
  const clean = sanitizeToolArgsForStorage('huqan.learn', args);
  assert.equal(clean.text, 'knowledge  text');
  assert.equal(clean.skipConflicts, false);
  assert.equal(clean.maxSentences, 3);
  assert.equal(clean.workspaceId, 'ws-a');
  assert.equal(clean.nestedObject, undefined);
  assert.equal(clean.nestedArray, undefined);
});

test('the legacy axiom.learn alias gets exactly the same argument handling', () => {
  const args = { text: 't', skipConflicts: true, workspaceId: 'ws' };
  assert.deepEqual(sanitizeToolArgsForStorage('axiom.learn', args), sanitizeToolArgsForStorage('huqan.learn', args));
});

test('huqan.learn provenance is allowlisted: known string fields survive, the rest is dropped', () => {
  const clean = sanitizeToolArgsForStorage('huqan.learn', {
    text: 't',
    provenance: {
      provenanceId: 'prov-1',
      actor: 'octocat',
      confidence: 0.9,
      injected: 'nope',
    },
  });
  assert.equal(clean.provenance.provenanceId, 'prov-1');
  assert.equal(clean.provenance.actor, 'octocat');
  assert.equal(clean.provenance.confidence, 0.9);
  assert.equal(clean.provenance.injected, undefined);
});

test('non-learn tools keep primitives, sanitize strings, and drop reference types', () => {
  const clean = sanitizeToolArgsForStorage('huqan.status', {
    name: '  x \x07 ',
    count: 7,
    flag: true,
    nothing: null,
    blob: { nope: 1 },
  });
  assert.equal(clean.name, 'x');
  assert.equal(clean.count, 7);
  assert.equal(clean.flag, true);
  assert.equal(clean.nothing, null);
  assert.equal(clean.blob, undefined);
});
