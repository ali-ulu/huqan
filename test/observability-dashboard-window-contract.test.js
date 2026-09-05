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

test('observability dashboard time-window contract', async t => {
  await t.test('exposes bounded time-window choices in the observability view', () => {
    assert.match(dashboard, /id="obswindow"/);
    assert.match(dashboard, /value="3600000">Last hour/);
    assert.match(dashboard, /value="86400000" selected>Last 24 hours/);
    assert.match(dashboard, /value="604800000">Last 7 days/);
    assert.match(dashboard, /value="2678400000">Last 31 days/);
  });

  await t.test('uses the selected window for metrics and runs while keeping queue/alerts bounded', () => {
    assert.match(script, /const observabilityWindow = \(\) =>/);
    assert.match(script, /Number\.isSafeInteger\(value\) && value >= 1000/);
    assert.match(script, /get\(`\/api\/observability\/metrics\?windowMs=\$\{windowMs\}`\)/);
    assert.match(script, /async function loadRuns\(reset = true\)/);
    assert.match(script, /get\(`\/api\/observability\/runs\?limit=20&windowMs=\$\{windowMs\}\$\{cursorQuery\}`\)/);
    assert.match(script, /loadRuns\(true\)/);
    assert.match(script, /get\('\/api\/observability\/queue\?limit=20'\)/);
    assert.match(script, /get\('\/api\/observability\/alerts\?limit=20'\)/);
    assert.match(script, /byId\('obswindow'\)\?\.addEventListener\('change', loadAll\)/);
  });

  await t.test('keeps the workspace and selected label in the request status', () => {
    assert.match(script, /workspace-scoped · \$\{observabilityWindowLabel\(\)\}/);
    assert.match(script, /const query = new URLSearchParams\(\{ workspaceId: workspace\(\) \}\)/);
    assert.doesNotThrow(() => new vm.Script(script));
  });
});
