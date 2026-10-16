'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readHtml, dashboardStyles, dashboardScript } = require('./helpers/dashboard-source');

test('home exposes three direct primary actions and four navigation groups', () => {
  const html = readHtml();
  assert.equal([...html.matchAll(/class="navgroup"/g)].length, 4);
  for (const target of ['verify', 'approvals', 'evidence']) assert.match(html, new RegExp(`<button[^>]+data-go="${target}"`));
  const destinations = [...html.matchAll(/<button[^>]+data-v="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(destinations, ['overview', 'verify', 'approvals', 'evidence', 'observability', 'activity', 'graph', 'conflicts', 'integrations', 'settings']);
});

test('navigation exposes the active page and hides the home hero after leaving home', () => {
  const html = readHtml();
  const source = dashboardScript(html);
  assert.match(html, /data-v="overview"[^>]+aria-current="page"/);
  assert.match(source, /window\.go = view =>/);
  assert.match(source, /setAttribute\('aria-current', 'page'\)/);
  assert.match(source, /hero\.hidden = view !== 'overview'/);
});

test('the dynamic ingest-run destination joins the Work group', () => {
  const source = dashboardScript(readHtml());
  assert.match(source, /approvals\.parentElement\.insertBefore\(button, approvals\)/);
  assert.match(source, /button\.onclick = \(\) => window\.go\('ingest-run'\)/);
});

test('home and navigation become compact below 900px', () => {
  const styles = dashboardStyles();
  assert.match(styles, /\.homehero\{[^}]*display:flex/);
  assert.match(styles, /@media\(max-width:900px\)[\s\S]*\.homehero\{[^}]*flex-direction:column/);
});
test('home hardens for 320px-768px viewports', () => {
  const styles = dashboardStyles();
  assert.match(styles, /@media\(max-width:768px\)/);
  assert.match(styles, /.homehero{padding:18px;gap:20px}/);
  assert.match(styles, /@media\(max-width:375px\)/);
  assert.match(styles, /.homehero{padding:14px;gap:14px}/);
  assert.match(styles, /@media\(max-width:320px\)/);
  assert.match(styles, /.homehero{padding:12px;gap:10px}/);
  assert.match(styles, /.footbrand{overflow:hidden;text-overflow:ellipsis;white-space:nowrap/);
});

