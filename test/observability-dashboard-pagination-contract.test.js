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

test('observability dashboard run pagination contract', async t => {
  await t.test('exposes a bounded, disabled-until-needed Next control', () => {
    assert.match(dashboard, /id="obsrunsnext" type="button" disabled>Next/);
    assert.match(dashboard, /id="obsrunsmeta"[^>]*>workspace-scoped · first page/);
    assert.match(script, /byId\('obsrunsnext'\)\.disabled = !data\.hasMore/);
    assert.match(script, /byId\('obsrunsmeta'\)\.textContent = `\$\{items\.length\} rows · \$\{data\.hasMore \? 'next page available' : 'bounded page'\}`/);
  });

  await t.test('loads the next cursor page with the selected workspace window', () => {
    assert.match(script, /async function loadRuns\(reset = true\)/);
    assert.match(script, /const cursor = reset \? '' : observabilityRuns\.nextCursor/);
    assert.match(script, /if \(!reset && !cursor\) return observabilityRuns/);
    assert.match(script, /cursor \? `&cursor=\$\{encodeURIComponent\(cursor\)\}` : ''/);
    assert.match(script, /get\(`\/api\/observability\/runs\?limit=20&windowMs=\$\{windowMs\}\$\{cursorQuery\}`\)/);
    assert.match(script, /byId\('obsrunsnext'\)\?\.addEventListener\('click', \(\) => loadRuns\(false\)/);
  });

  await t.test('appends only bounded response pages and disables Next at the end', () => {
    assert.match(script, /observabilityRuns\.items = reset \? \(page\.items \|\| \[\]\) : \[\.\.\.observabilityRuns\.items, \.\.\.\(page\.items \|\| \[\]\)\]/);
    assert.match(script, /observabilityRuns\.hasMore = Boolean\(page\.hasMore && observabilityRuns\.nextCursor\)/);
    assert.match(script, /renderRuns\(\{ \.\.\.page, items: observabilityRuns\.items, hasMore: observabilityRuns\.hasMore \}\)/);
    assert.match(script, /const observabilityRuns = \{ items: \[\], nextCursor: null, hasMore: false \}/);
    assert.doesNotThrow(() => new vm.Script(script));
  });
});
