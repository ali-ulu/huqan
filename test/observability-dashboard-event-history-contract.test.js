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

test('observability dashboard event history contract', async t => {
  await t.test('exposes bounded filters, status and disabled-until-needed Next control', () => {
    assert.match(dashboard, /id="obseventtype"/);
    assert.match(dashboard, /id="obseventrun"[^>]*maxlength="128"/);
    assert.match(dashboard, /id="obseventapply" type="button">Filter/);
    assert.match(dashboard, /id="obseventnext" type="button" disabled>Next/);
    assert.match(dashboard, /id="obseventstatus"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(dashboard, /id="obseventmeta"[^>]*>workspace-scoped · first page/);
    assert.match(dashboard, /id="obseventhistory"/);
  });

  await t.test('requests the selected bounded window, filters and URL-encoded cursor through the shared workspace get helper', () => {
    assert.match(script, /const observabilityEvents = \{ items: \[\], nextCursor: null, hasMore: false, eventType: '', runId: '' \}/);
    assert.match(script, /async function loadEventHistory\(reset = true\)/);
    assert.match(script, /const query = new URLSearchParams\(\{ limit: '20', windowMs: String\(observabilityWindow\(\)\) \}\)/);
    assert.match(script, /if \(cursor\) query\.set\('cursor', cursor\)/);
    assert.match(script, /query\.set\('eventType', observabilityEvents\.eventType\)/);
    assert.match(script, /query\.set\('runId', observabilityEvents\.runId\)/);
    assert.match(script, /get\(`\/api\/observability\/events\?\$\{query\.toString\(\)\}`\)/);
    assert.match(script, /const get = async \(path\) =>/);
    assert.match(script, /workspaceId=\$\{encodeURIComponent\(workspace\(\)\)\}/);
  });

  await t.test('appends only bounded response pages and resets filters/window on refresh', () => {
    assert.match(script, /observabilityEvents\.items = reset \? \(page\.items \|\| \[\]\) : \[\.\.\.observabilityEvents\.items, \.\.\.\(page\.items \|\| \[\]\)\]/);
    assert.match(script, /observabilityEvents\.hasMore = Boolean\(page\.hasMore && observabilityEvents\.nextCursor\)/);
    assert.match(script, /renderEventHistory\(\{ \.\.\.page, items: observabilityEvents\.items, hasMore: observabilityEvents\.hasMore \}\)/);
    assert.match(script, /byId\('obseventapply'\)\?\.addEventListener\('click', \(\) => loadEventHistory\(true\)/);
    assert.match(script, /byId\('obseventnext'\)\?\.addEventListener\('click', \(\) => loadEventHistory\(false\)/);
    assert.match(script, /const \[metrics, , , queue, alerts\] = await Promise\.all\(/);
    assert.match(script, /loadEventHistory\(true\)/);
  });

  await t.test('renders only redacted event summary fields and disables Next at the final page', () => {
    const start = script.indexOf('  function renderEventHistory');
    const end = script.indexOf('\n  async function loadEventHistory', start);
    assert.ok(start >= 0 && end > start, 'event history renderer source must be present');
    const renderer = script.slice(start, end);
    assert.match(renderer, /event\.eventType/);
    assert.match(renderer, /event\.status/);
    assert.match(renderer, /event\.runId/);
    assert.match(renderer, /event\.tool/);
    assert.doesNotMatch(renderer, /event\.payload/);
    assert.match(script, /byId\('obseventnext'\)\.disabled = !data\.hasMore/);
    assert.match(script, /Event history could not be loaded/);
    assert.match(script, /No matching events in this window/);
  });

  await t.test('keeps the inline dashboard script syntactically valid', () => {
    assert.doesNotThrow(() => new vm.Script(script));
  });
});
