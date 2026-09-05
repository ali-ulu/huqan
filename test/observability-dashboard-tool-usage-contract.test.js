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

function node() {
  return {
    textContent: '',
    innerHTML: '',
    attributes: {},
    style: {
      values: {},
      setProperty(name, value) {
        this.values[name] = value;
      },
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
}

function loadToolUsageRenderer() {
  const start = script.indexOf('  function renderToolUsage');
  const end = script.indexOf('\n\n  function renderMetrics', start);
  assert.ok(start >= 0 && end > start, 'tool usage renderer source must be present');
  const elements = {
    obstooldonut: node(),
    obstoollegend: node(),
    obstooltotal: node(),
    obstoolmeta: node(),
  };
  elements.obstoolmeta.textContent = 'workspace-scoped · Last 24 hours';
  const context = {
    byId: id => elements[id],
    escape: value => String(value),
  };
  vm.runInNewContext(`${script.slice(start, end)}\nthis.renderToolUsage = renderToolUsage;`, context);
  return { renderToolUsage: context.renderToolUsage, elements };
}

test('observability dashboard Tool Usage Mix contract', async t => {
  await t.test('shows an explicit empty state when no tool calls exist', () => {
    const { renderToolUsage, elements } = loadToolUsageRenderer();
    renderToolUsage({ toolUsage: [], toolCallCount: 0 });
    assert.equal(elements.obstooltotal.textContent, '0');
    assert.equal(elements.obstooldonut.attributes['aria-label'], 'No tool calls yet');
    assert.match(elements.obstoollegend.innerHTML, /No tool calls yet/);
  });

  await t.test('renders a single tool as a complete 100 percent breakdown', () => {
    const { renderToolUsage, elements } = loadToolUsageRenderer();
    renderToolUsage({ toolUsage: [{ name: 'verify', count: 3 }], toolCallCount: 3 });
    assert.equal(elements.obstooltotal.textContent, '3');
    assert.match(elements.obstooldonut.style.values['--tool-gradient'], /0\.00% 100\.00%/);
    assert.equal(elements.obstooldonut.attributes['aria-label'], 'Tool usage distribution: 3 calls');
    assert.match(elements.obstoollegend.innerHTML, /verify/);
    assert.match(elements.obstoollegend.innerHTML, /100%/);
  });

  await t.test('aggregates repeated names and renders multiple tools without duplicate legend rows', () => {
    const { renderToolUsage, elements } = loadToolUsageRenderer();
    renderToolUsage({
      toolUsage: [
        { name: 'verify', count: 2 },
        { name: 'memorySearch', count: 1 },
        { name: 'verify', count: 1 },
      ],
      toolCallCount: 4,
    });
    assert.equal(elements.obstooltotal.textContent, '4');
    assert.equal((elements.obstoollegend.innerHTML.match(/<b>verify<\/b>/g) || []).length, 1);
    assert.match(elements.obstoollegend.innerHTML, /memorySearch/);
    assert.doesNotMatch(elements.obstoollegend.innerHTML, /Unattributed/);
    assert.doesNotMatch(elements.obstooldonut.attributes['aria-label'], /incomplete/);
  });

  await t.test('preserves the reported total and marks an incomplete breakdown', () => {
    const { renderToolUsage, elements } = loadToolUsageRenderer();
    renderToolUsage({ toolUsage: [{ name: 'verify', count: 2 }], toolCallCount: 5 });
    assert.equal(elements.obstooltotal.textContent, '5');
    assert.match(elements.obstoollegend.innerHTML, /Unattributed/);
    assert.match(elements.obstooldonut.attributes['aria-label'], /breakdown incomplete/);
    assert.match(elements.obstoolmeta.textContent, /total mismatch/);
    assert.match(elements.obstoollegend.innerHTML, /40%/);
    assert.match(elements.obstoollegend.innerHTML, /60%/);
  });

  await t.test('does not invent a breakdown when the total exists but tool details are absent', () => {
    const { renderToolUsage, elements } = loadToolUsageRenderer();
    renderToolUsage({ toolUsage: [], toolCallCount: 2 });
    assert.equal(elements.obstooltotal.textContent, '2');
    assert.equal(elements.obstooldonut.attributes['aria-label'], 'Tool usage breakdown unavailable: 2 calls');
    assert.match(elements.obstoollegend.innerHTML, /Tool usage breakdown unavailable/);
    assert.match(elements.obstoolmeta.textContent, /total mismatch/);
  });

  await t.test('keeps the inline dashboard script syntactically valid', () => {
    assert.doesNotThrow(() => new vm.Script(script));
  });
});
