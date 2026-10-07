'use strict';

// #3490 (R35 logMask): masking records what was masked -- which fields, by
// which rule -- without ever carrying the secret bytes.

const assert = require('node:assert/strict');
const test = require('node:test');

const { maskSecretsWithTrace } = require('../lib/secret-patterns');
const { redactSecretValuesWithTrace } = require('../lib/tool-call-gate-secrets');
const { projectApprovalRecord } = require('../lib/mcp-approval-views');

test('maskSecretsWithTrace reports types and counts, never secrets', () => {
  // Synthetic fixture composed at runtime (repo convention: no secret-like
  // literal in source; see .gitleaksignore and secret-patterns-conformance).
  const secret = ['sk', 'live', 'abcdefghij1234567890'].join('-');
  const { text, erased } = maskSecretsWithTrace(`key=${secret} key=${secret}`);
  assert.ok(!text.includes(secret));
  assert.deepEqual(erased, [{ type: 'api_key', count: 2 }]);
  const clean = maskSecretsWithTrace('nothing secret here');
  assert.equal(clean.text, 'nothing secret here');
  assert.deepEqual(clean.erased, []);
});

test('redactSecretValuesWithTrace names secret key paths', () => {
  const { redacted, erased } = redactSecretValuesWithTrace({
    tool: 'huqan.learn',
    args: { text: 'plain', api_key: ['super', 'secret', 'value'].join('') },
  });
  assert.equal(redacted.tool, 'huqan.learn');
  assert.equal(redacted.args.text, 'plain');
  assert.equal(redacted.args.api_key, '[REDACTED]');
  assert.deepEqual(erased, [{ path: 'args.api_key', rule: 'secret_key_name' }]);
  const joined = JSON.stringify(erased);
  assert.ok(!joined.includes('supersecretvalue'));
});

test('redactSecretValuesWithTrace covers arrays, nesting, cycles and scalars', () => {
  const nested = { list: [{ token: 'abc' }, 'plain'], count: 3, missing: null, flag: true };
  const { redacted, erased } = redactSecretValuesWithTrace(nested);
  assert.equal(redacted.list[1], 'plain');
  assert.equal(redacted.count, 3);
  assert.equal(redacted.missing, null);
  assert.deepEqual(erased, [{ path: 'list.0.token', rule: 'secret_key_name' }]);
  const cyclic = { name: 'x' };
  cyclic.self = cyclic;
  const circled = redactSecretValuesWithTrace(cyclic);
  assert.equal(circled.redacted.self, '[CIRCULAR]');
  assert.deepEqual(circled.erased, [{ path: 'self', rule: 'circular' }]);
  assert.deepEqual(redactSecretValuesWithTrace(42), { redacted: 42, erased: [] });
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0In0', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c'].join('.');
  const embedded = redactSecretValuesWithTrace({ note: `call with ${jwt} inside` });
  assert.ok(!embedded.redacted.note.includes(jwt));
  assert.equal(embedded.erased.length, 1);
  assert.equal(embedded.erased[0].rule, 'embedded_secret');
  assert.deepEqual(embedded.erased[0].types, [{ type: 'jwt', count: 1 }]);
});

test('whole secret-looking values are wiped with a whole_value trace', () => {
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0In0', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c'].join('.');
  const asWhole = redactSecretValuesWithTrace({ note: jwt });
  assert.equal(asWhole.redacted.note, '[REDACTED]');
  assert.deepEqual(asWhole.erased, [{ path: 'note', rule: 'whole_value' }]);
  const bearer = redactSecretValuesWithTrace({ note: 'Bearer abcdefghij1234567890' });
  assert.equal(bearer.redacted.note, '[REDACTED]');
  assert.deepEqual(bearer.erased, [{ path: 'note', rule: 'whole_value' }]);
  assert.ok(!JSON.stringify(bearer).includes('abcdefghij'));
});

test('the approval view carries the masking trace', () => {
  const fakePassword = ['hunter2', 'hunter'].join('');
  const view = projectApprovalRecord({
    id: 'a1',
    approvalKey: 'k1',
    tool: 'huqan.learn',
    input: JSON.stringify({ text: 'hello', password: fakePassword }),
    workspaceId: 'w',
    status: 'pending',
    context: { args: { text: 'hello', password: fakePassword } },
  });
  assert.ok(view);
  assert.equal(view.claim, 'hello');
  assert.ok(Array.isArray(view.masking.erased));
  assert.ok(view.masking.erased.length > 0);
  assert.ok(view.masking.erased.every((entry) => typeof entry.path === 'string' && typeof entry.rule === 'string'));
  assert.ok(!JSON.stringify(view.masking).includes(fakePassword));
  const clean = projectApprovalRecord({
    id: 'a2',
    tool: 'huqan.status',
    input: JSON.stringify({}),
    workspaceId: 'w',
    status: 'pending',
    context: { args: {} },
  });
  assert.deepEqual(clean.masking, { erased: [] });
});
