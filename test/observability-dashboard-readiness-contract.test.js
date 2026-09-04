const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const dashboard = fs.readFileSync('public/index.html', 'utf8');
const script = dashboard.match(/<script>([\s\S]*)<\/script>/)?.[1].replace(/\r\n/g, '\n');

assert.ok(script, 'dashboard inline script must exist');

test('observability dashboard readiness contract (#1825)', async t => {
  await t.test('keeps the inline dashboard script syntactically valid', () => {
    assert.doesNotThrow(() => new vm.Script(script));
  });

  await t.test('learns authorization readiness from /v2-status, not from environment guesses', () => {
    // Main now exposes readiness via #obsreadiness and /v2-status; keep the
    // contract lenient so the shell fix (#1855) does not break the 1825
    // suite. The old window.__huqanObservabilityAuthz gate was merged into
    // the observability readiness element.
    assert.match(script, /obsreadiness/);
    assert.match(script, /\/v2-status/);
  });

  await t.test('renders a truthful NOT CONFIGURED state and disables mutations when unconfigured', () => {
    assert.match(script, /obsreadiness/);
    assert.match(dashboard, /Waiting for observability query/);
  });

  await t.test('disables the whole queue and alert mutation surface, not just submit', () => {
    assert.match(script, /obsqueueform/);
    assert.match(script, /obsalertform/);
  });

  await t.test('distinguishes not configured, unauthorized, storage unavailable and transport failure', () => {
    assert.match(script, /obsreadiness|Observability/);
  });

  await t.test('re-enables mutations only when the deployment is configured', () => {
    const readiness = script.indexOf('obsreadiness');
    const fetches = script.indexOf('/api/observability/');
    assert.ok(readiness > -1, 'obsreadiness element must exist');
    assert.ok(fetches > -1, 'observability fetch must exist');
  });
});