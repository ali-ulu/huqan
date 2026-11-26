const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeToolArgsForStorage, executeReadOnlyDryRun } = require('../mcpServer');
const { finalizeMcpToolResult } = require('../lib/mcp/tool-result-finalizer');

test('sanitizeToolArgsForStorage redacts secret-looking values before they reach the approval store', () => {
  const clean = sanitizeToolArgsForStorage('axiom.agent', {
    goal: 'plan something',
    apiKey: 'sk-abcdefghijklmnop',
  });

  assert.equal(clean.goal, 'plan something');
  assert.equal(clean.apiKey, '[REDACTED]');
});

test('sanitizeToolArgsForStorage leaves non-secret args untouched', () => {
  const clean = sanitizeToolArgsForStorage('axiom.agent', {
    goal: 'plan something',
    maxSteps: 3,
    dryRun: true,
  });

  assert.deepEqual(clean, { goal: 'plan something', maxSteps: 3, dryRun: true });
});

test('sanitizeToolArgsForStorage keeps the axiom.learn allowlist unchanged (text is knowledge content, not scrubbed)', () => {
  const clean = sanitizeToolArgsForStorage('axiom.learn', {
    text: 'kedi hayvandir',
    apiKey: 'sk-abcdefghijklmnop',
    skipConflicts: true,
  });

  assert.deepEqual(clean, { text: 'kedi hayvandir', skipConflicts: true });
  assert.equal('apiKey' in clean, false, 'axiom.learn allowlist already excludes unexpected fields');
});

test('executeReadOnlyDryRun scrubs secrets from the raw-args echo for unmapped tools', () => {
  const result = executeReadOnlyDryRun(null, 'axiom.compare', {
    left: 'kedi',
    right: 'kopek',
    token: 'tok_live_abcdefgh',
  });

  assert.equal(result.dryRun, true);
  // Called with the legacy spelling above; the dry-run echoes the canonical
  // name it resolved to. The redaction assertion below is what this test is
  // actually for, and it is unaffected by the rename.
  assert.equal(result.tool, 'huqan.compare');
  assert.equal(result.args.left, 'kedi');
  assert.equal(result.args.token, '[REDACTED]');
});

test('finalizeMcpToolResult scrubs a bare string result the conformance gate passes through', () => {
  // A JWT built from parts, so no committed fixture looks like a credential.
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'test-fixture' })).toString('base64url');
  const jwt = `${header}.${payload}.${'x'.repeat(32)}`;

  // A tool with no advertised output schema is the path where the gate hands a
  // non-object result back untouched instead of refusing it, so AB7 is the only
  // thing left between the handler's string and the client.
  const embedded = finalizeMcpToolResult({}, 'huqan.no-schema', `the value is ${jwt}`);
  assert.equal(typeof embedded, 'string');
  assert.equal(embedded.includes(jwt), false);
  assert.match(embedded, /^the value is /);

  const whole = finalizeMcpToolResult({}, 'huqan.no-schema', 'sk-abcdefghijklmnop');
  assert.equal(whole, '[REDACTED]');
});
