const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const dashboard = fs.readFileSync('public/index.html', 'utf8');
const script = dashboard.match(/<script>([\s\S]*)<\/script>/)?.[1];

assert.ok(script, 'dashboard inline script must exist');

test('observability dashboard accessibility and responsive contract', async t => {
  await t.test('labels the primary navigation and collapsed controls', () => {
    assert.match(dashboard, /<nav class="nav" aria-label="Primary navigation">/);
    const navButtons = [...dashboard.matchAll(/<button[^>]*data-v="([^"]+)"[^>]*>/g)];
    assert.equal(navButtons.length, 10);
    for (const [, view] of navButtons) assert.match(navButtons.find(match => match[1] === view)[0], /aria-label="[^"]+"/);
    assert.match(dashboard, /<input id="search" aria-label="Search receipts, claims, and sources"/);
    assert.match(dashboard, /<div class="avatar" aria-hidden="true">H<\/div>/);
  });

  await t.test('provides visible keyboard focus and disabled-state affordances', () => {
    assert.match(dashboard, /button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible\{outline:3px solid #0759ae;outline-offset:2px\}/);
    assert.match(dashboard, /\.nav button:focus-visible\{background:#eaf6ff;outline-offset:-2px\}/);
    assert.match(dashboard, /\.btn:disabled\{cursor:not-allowed;opacity:\.56;transform:none\}/);
    assert.match(dashboard, /--muted:#4f6680/);
    assert.match(dashboard, /@media\(prefers-reduced-motion:reduce\)/);
  });

  await t.test('keeps observability controls usable on narrow screens', () => {
    assert.match(dashboard, /@media\(max-width:600px\)/);
    assert.match(dashboard, /\.head\{flex-direction:column;align-items:stretch\}/);
    assert.match(dashboard, /\.activityfilters\{grid-template-columns:1fr\}/);
    assert.match(dashboard, /\.activityfilters>\.btn\{width:100%;min-height:40px\}/);
    assert.match(dashboard, /\.twocol\{grid-template-columns:1fr\}/);
    assert.match(dashboard, /\.toollegend\{grid-template-columns:1fr;width:100%\}/);
    assert.match(dashboard, /\.nav button\{min-height:52px\}/);
    assert.match(dashboard, /\.btn\{min-height:40px\}/);
    assert.match(dashboard, /\.footer\{grid-template-columns:72px 1fr;min-height:48px\}/);
  });

  await t.test('preserves scrollable content instead of clipping narrow dashboard views', () => {
    assert.match(dashboard, /\.main\{[^}]*overflow:hidden/);
    assert.match(dashboard, /\.view\{[^}]*overflow:auto/);
    assert.match(dashboard, /\.toollegend\{[^}]*overflow:auto/);
    assert.match(dashboard, /\.footmid\{gap:8px;overflow:auto;white-space:nowrap\}/);
  });

  await t.test('keeps the inline dashboard script syntactically valid', () => {
    assert.doesNotThrow(() => new vm.Script(script));
  });
});
