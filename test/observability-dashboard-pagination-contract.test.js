const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const dashboard = fs.readFileSync('public/index.html', 'utf8');
const script = dashboard.match(/<script>([\s\S]*)<\/script>/)?.[1];

assert.ok(script, 'dashboard inline script must exist');

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
