'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  recordLegacyAliasUse,
  legacyAliasUsage,
  resetLegacyAliasUsage,
} = require('../lib/legacy-alias-usage');
const {
  canonicalMcpToolName,
  withMcpToolDeprecationSurface,
} = require('../lib/mcp-tool-names');
const { readCompatibleEnvironmentVariable } = require('../lib/environment-compat');

test.beforeEach(() => resetLegacyAliasUsage());

test('a legacy tools/call is counted once, not once per helper call', () => {
  // The reason this counter is not inside canonicalMcpToolName: the request
  // path calls that pure helper eight or more times for a single tools/call
  // (lib/mcp/response-builders.js alone accounts for most of them). Counting
  // there would measure helper invocations and the number would be useless as
  // a migration denominator.
  canonicalMcpToolName('axiom.learn');
  canonicalMcpToolName('axiom.learn');
  canonicalMcpToolName('axiom.learn');
  assert.equal(legacyAliasUsage().total, 0, 'resolution alone must not count');

  withMcpToolDeprecationSurface({ ok: true }, 'axiom.learn');
  assert.equal(legacyAliasUsage().total, 1);
});

test('a canonical call is not counted', () => {
  withMcpToolDeprecationSurface({ ok: true }, 'huqan.learn');
  const usage = legacyAliasUsage();
  assert.equal(usage.total, 0);
  // Spread: the breakdowns are null-prototype on purpose, so a legacy name
  // spelled __proto__ lands as an ordinary key instead of reaching
  // Object.prototype.
  assert.deepEqual({ ...usage.byKind }, {});
  assert.deepEqual({ ...usage.byName }, {});
});

test('counts break down by surface and by name', () => {
  withMcpToolDeprecationSurface({ ok: true }, 'axiom.learn');
  withMcpToolDeprecationSurface({ ok: true }, 'axiom.learn');
  withMcpToolDeprecationSurface({ ok: true }, 'axiom.ask');
  recordLegacyAliasUse('environment', 'AXIOM_DB_PATH');

  const usage = legacyAliasUsage();
  assert.equal(usage.total, 4);
  assert.deepEqual({ ...usage.byKind }, { mcp_tool: 3, environment: 1 });
  assert.equal(usage.byName['axiom.learn'], 2);
  assert.equal(usage.byName['axiom.ask'], 1);
  assert.equal(usage.byName.AXIOM_DB_PATH, 1);
});

test('an AXIOM_ variable counts only when it actually supplied the value', () => {
  readCompatibleEnvironmentVariable('DB_PATH', { AXIOM_DB_PATH: '/legacy' });
  assert.equal(legacyAliasUsage().byKind.environment, 1);

  resetLegacyAliasUsage();
  readCompatibleEnvironmentVariable('DB_PATH', { HUQAN_DB_PATH: '/canonical' });
  assert.equal(legacyAliasUsage().total, 0, 'the canonical name is not a migration event');

  resetLegacyAliasUsage();
  // Both set to the same value: the canonical one wins and nothing is counted.
  // That deployment has already migrated and kept a spare, so counting it would
  // report migration pressure that does not exist.
  readCompatibleEnvironmentVariable('DB_PATH', { HUQAN_DB_PATH: '/x', AXIOM_DB_PATH: '/x' });
  assert.equal(legacyAliasUsage().total, 0);
});

test('an absent variable is not a legacy use', () => {
  readCompatibleEnvironmentVariable('DB_PATH', {});
  assert.equal(legacyAliasUsage().total, 0);
});

test('the conflicting-configuration error still fails closed and counts nothing', () => {
  // HUQAN_ENV_CONFLICT must keep throwing; a metric that changed the decision
  // it measures would be a worse bug than the one it is measuring.
  assert.throws(
    () => readCompatibleEnvironmentVariable('DB_PATH', { HUQAN_DB_PATH: '/a', AXIOM_DB_PATH: '/b' }),
    (error) => error.code === 'HUQAN_ENV_CONFLICT',
  );
  assert.equal(legacyAliasUsage().total, 0);
});

test('recording never throws on malformed input', () => {
  // Called from the request path, so it must be total.
  for (const bad of [undefined, null, 0, {}, [], '']) {
    assert.doesNotThrow(() => recordLegacyAliasUse('mcp_tool', bad));
    assert.doesNotThrow(() => recordLegacyAliasUse(bad, 'axiom.learn'));
  }
  assert.equal(legacyAliasUsage().total, 0);
});

test('the deprecation surface still behaves exactly as before', () => {
  // The counter is additive: a legacy caller must observe the same result plus
  // meta.deprecation, and nothing else may change.
  const result = withMcpToolDeprecationSurface({ ok: true, value: 1 }, 'axiom.learn');
  assert.equal(result.ok, true);
  assert.equal(result.value, 1);
  assert.equal(result.meta.deprecation.deprecated, true);
  assert.equal(result.meta.deprecation.canonicalName, 'huqan.learn');

  assert.equal(withMcpToolDeprecationSurface('scalar', 'axiom.learn'), 'scalar');
});
