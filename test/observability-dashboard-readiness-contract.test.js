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
    assert.match(script, /window\.__huqanObservabilityAuthz=d\.observability&&typeof d\.observability\.configured==='boolean'\?d\.observability\.configured:null/);
  });

  await t.test('renders a truthful NOT CONFIGURED state and disables mutations when unconfigured', () => {
    assert.match(script, /if \(window\.__huqanObservabilityAuthz === false\) \{/);
    assert.match(script, /setMutationControls\(false\)/);
    assert.match(script, /Observability is NOT CONFIGURED on this deployment: the operator must set OBSERVABILITY_AUTHZ_POLICY\./);
  });

  await t.test('disables the whole queue and alert mutation surface, not just submit', () => {
    assert.match(script, /for \(const formId of \['obsqueueform', 'obsalertform'\]\) \{/);
    assert.match(script, /form\.querySelectorAll\('input, select, button'\)\.forEach\(element => \{ element\.disabled = !enabled; \}\)/);
  });

  await t.test('distinguishes not configured, unauthorized, storage unavailable and transport failure', () => {
    assert.match(script, /authorization is unavailable/);
    assert.match(script, /Observability is unauthorized for this session/);
    assert.match(script, /Observability storage is unavailable on this deployment\./);
    assert.match(script, /Observability could not be loaded: \$\{error\.message\}/);
  });

  await t.test('re-enables mutations only when the deployment is configured', () => {
    // setMutationControls(true) must run after the readiness gate, before the
    // data loads, so an authorized configured deployment keeps its controls.
    const gate = script.indexOf('window.__huqanObservabilityAuthz === false');
    const enable = script.indexOf('setMutationControls(true)');
    const fetches = script.indexOf("get(`/api/observability/metrics");
    assert.ok(gate > -1 && enable > gate && fetches > enable, 'gate -> enable -> fetch order must hold');
  });
});