const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const dashboard = fs.readFileSync('public/index.html', 'utf8');
const script = dashboard.match(/<script>([\s\S]*)<\/script>/)?.[1];

assert.ok(script, 'dashboard inline script must exist');

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
