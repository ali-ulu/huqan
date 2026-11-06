'use strict';

// #4525: dispatch used to route every call through two shared modules, so their
// edge branches were exercised incidentally. The inputSchema enforcement now
// parses arguments inline and refuses an undeclared key before the capability
// is verified, which stopped exercising `lib/json-object.js` and
// `lib/mcp/operator-authorization.js` through that path. These pin the real
// behaviour of those shared edges directly, so the coverage ratchet stays green
// for a change that genuinely reduced the paths reaching them.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseJsonObject } = require('../lib/json-object');
const {
  operatorCapabilityBinding,
  operatorCapabilityAuthorized,
} = require('../lib/mcp/operator-authorization');

test('parseJsonObject passes a record through, parses a JSON record, and falls back otherwise', () => {
  const record = { a: 1 };
  assert.equal(parseJsonObject(record), record, 'a record is returned as-is');
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 }, 'a JSON record parses');
  assert.equal(parseJsonObject([1, 2, 3], 'fb'), 'fb', 'a raw array is not a record');
  assert.equal(parseJsonObject(42, 'fb'), 'fb', 'a raw scalar is not a record');
  assert.equal(parseJsonObject('[1,2,3]', 'fb'), 'fb', 'a JSON array is not a record');
  assert.equal(parseJsonObject('42', 'fb'), 'fb', 'a JSON scalar is not a record');
  assert.equal(parseJsonObject('not-json', 'fb'), 'fb', 'unparseable input falls back');
  assert.deepEqual(parseJsonObject(null), {}, 'a missing value is an empty record');
});

test('operatorCapabilityBinding defaults the per-tool scope keys', () => {
  assert.equal(operatorCapabilityBinding('huqan.approve', {}).approvalId, '', 'approve binds an empty approvalId when absent');
  assert.equal(operatorCapabilityBinding('huqan.agent_resume', {}).runId, '', 'agent_resume binds an empty runId when absent');
  assert.equal(operatorCapabilityBinding('huqan.agent_resume', { checkpointId: 'c1' }).runId, 'c1', 'agent_resume falls back to checkpointId');
  assert.equal(operatorCapabilityBinding('huqan.approvals', {}).approvalId, null, 'a non-approval tool binds no approvalId');
});

test('operatorCapabilityAuthorized refuses the static-token seam on a missing or wrong credential', () => {
  const args = {};
  assert.equal(operatorCapabilityAuthorized({ operatorToken: 'right' }, 'huqan.approve', args, undefined, 'right'), true, 'the exact token is authorized');
  assert.equal(operatorCapabilityAuthorized({ operatorToken: 'right' }, 'huqan.approve', args, undefined, 'wrong'), false, 'a wrong token is refused');
  assert.equal(operatorCapabilityAuthorized({ operatorToken: 'right' }, 'huqan.approve', args, undefined, ''), false, 'an empty presented token is refused');
  assert.equal(operatorCapabilityAuthorized({ operatorToken: 'right' }, 'huqan.approve', args, undefined, undefined), false, 'a non-string presented token is refused');
  assert.equal(operatorCapabilityAuthorized({ operatorToken: '' }, 'huqan.approve', args, undefined, 'x'), false, 'an empty configured token authorizes nobody');
  assert.equal(operatorCapabilityAuthorized({}, 'huqan.approve', args, undefined, 'x'), false, 'no configured credential authorizes nobody');
});
