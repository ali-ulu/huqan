'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const dashboard = fs.readFileSync('public/index.html', 'utf8');

test('observability dashboard applies workspace and time filters to every read surface', () => {
  assert.match(dashboard, /queryFor\(\{ limit: '20'/);
  assert.match(dashboard, /api\/v1\/observability\/metrics/);
  assert.match(dashboard, /api\/v1\/observability\/runs/);
  assert.match(dashboard, /api\/v1\/observability\/queue/);
  assert.match(dashboard, /api\/v1\/observability\/alerts/);
  assert.match(dashboard, /api\/v1\/observability\/stream/);
  assert.match(dashboard, /windowMs: String\(selectedWindow\(\)\)/);
});

test('observability dashboard bounds run pages and SSE event deduplication', () => {
  assert.match(dashboard, /obsrunnext/);
  assert.match(dashboard, /dashboardState\.runCursor/);
  assert.match(dashboard, /dashboardState\.seenEvents\.has\(eventKey\)/);
  assert.match(dashboard, /dashboardState\.seenEvents\.size > 500/);
});

test('observability dashboard exposes reconnect, stale and accessible live states', () => {
  assert.match(dashboard, /Math\.min\(30000, 1000 \* \(2 \*\*/);
  assert.match(dashboard, /Son başarılı veri/);
  assert.match(dashboard, /aria-live/);
  assert.match(dashboard, /setAttribute\('tabindex', '-1'\)/);
});

test('tool usage hides inconsistent totals instead of drawing a false ratio', () => {
  assert.match(dashboard, /summed !== total/);
  assert.match(dashboard, /Grafik gizlendi/);
  assert.match(dashboard, /Toplam çağrı var ancak araç dağılımı eksik/);
});
