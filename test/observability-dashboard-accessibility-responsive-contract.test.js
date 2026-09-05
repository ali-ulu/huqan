const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');

const { readHtml, dashboardStyles, dashboardScript } = require('./helpers/dashboard-source');

// Markup assertions read the HTML; CSS assertions read every stylesheet the page
// applies. #1894 moved the dashboard's CSS into public/css/app.css, so matching
// rules against the HTML string alone turned this contract red while the page
// itself was unchanged. Where the bytes live is not part of the contract.
const markup = readHtml();
const dashboard = [markup, dashboardStyles(markup)].join('\n');
const script = dashboardScript(markup);

assert.ok(script.trim(), 'dashboard script must exist');

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

  await t.test('keeps the dashboard script syntactically valid', () => {
    assert.doesNotThrow(() => new vm.Script(script));
  });
});
