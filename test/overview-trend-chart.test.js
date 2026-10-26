'use strict';

// #4298. The overview trend chart runs in the browser, so these checks load
// public/js/app-overview-trend.js into a vm context with a minimal DOM.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-overview-trend.js'), 'utf8');
const DAY_MS = 86400000;

function loadChart(fetchImpl) {
  const nodes = new Map(['trend-svg', 'trend-status', 'trend-empty', 'trend-summary']
    .map(id => [id, { id, textContent: '', innerHTML: '', hidden: true }]));
  const context = {
    window: {},
    document: {
      documentElement: { lang: 'en' },
      getElementById: id => nodes.get(id) || null,
      addEventListener() {},
    },
    T: (key, fallback) => fallback,
    headers: () => ({}),
    fetch: fetchImpl,
    Intl, Date, URLSearchParams, Math, Number, String, Array, Map, Boolean, Error,
  };
  context.window = context;
  vm.runInNewContext(SOURCE, context);
  return { chart: context.HuqanOverviewTrend, nodes };
}

test('an empty activity list shows the empty state instead of throwing', () => {
  const { chart, nodes } = loadChart();
  chart.renderTrendChart([]);
  assert.equal(nodes.get('trend-status').textContent, 'No data available');
  assert.equal(nodes.get('trend-empty').hidden, false);
});

test('auto-approved allow actions are plotted and kept beside the status nodes', () => {
  const { chart, nodes } = loadChart();
  chart.renderTrendChart([{ createdAt: new Date().toISOString(), status: 'allow', payload: { metadata: { autoApproved: true } } }]);
  assert.match(nodes.get('trend-svg').innerHTML, /^<svg/);
  assert.equal(nodes.get('trend-status').textContent, '7-day trend · 1 actions');
  assert.match(nodes.get('trend-summary').textContent, /1 passed/);
});

test('pagination stops at the first page that reaches past the seven-day window', async () => {
  let calls = 0;
  const page = createdAt => ({ ok: true, json: async () => ({ ok: true, items: [{ createdAt, status: 'allow' }], hasMore: true, nextCursor: 'next' }) });
  const { chart } = loadChart(async () => {
    calls += 1;
    return page(new Date(Date.now() - (calls === 1 ? 0 : 8 * DAY_MS)).toISOString());
  });
  await chart.loadTrend();
  assert.equal(calls, 2);
});

test('an older load that fails last cannot clear a newer chart', async () => {
  let failFirst;
  const { chart, nodes } = loadChart(() => {
    if (!failFirst) return new Promise((_, reject) => { failFirst = () => reject(new Error('stale')); });
    return Promise.resolve({ ok: true, json: async () => ({ ok: true, items: [{ createdAt: new Date().toISOString(), status: 'allow' }], hasMore: false }) });
  });
  const older = chart.loadTrend();
  await chart.loadTrend();
  failFirst();
  await older;
  assert.match(nodes.get('trend-svg').innerHTML, /^<svg/);
});

test('an empty result after a failure shows the empty text, not the failure text', () => {
  const { chart, nodes } = loadChart();
  nodes.get('trend-empty').textContent = 'Trend data unavailable';
  chart.renderTrendChart([]);
  assert.equal(nodes.get('trend-empty').textContent, 'No activity in the last 7 days.');
});
