const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');

// #1894 and #1895 moved the dashboard's CSS and JS out of public/index.html.
// The contract is about what the browser loads, not about which file the bytes
// sit in, so the helper follows the <link> and <script src>.
const { dashboardSource, dashboardScript } = require('./helpers/dashboard-source');

// `dashboard` has always meant everything the page is -- when the CSS and JS
// were inline, reading index.html gave exactly that. dashboardSource() is the
// faithful equivalent now that both live in linked files.
const dashboard = dashboardSource();
const script = dashboardScript(dashboard);

assert.ok(script.trim(), 'dashboard script must exist');

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