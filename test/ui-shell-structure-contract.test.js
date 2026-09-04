'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DASHBOARD = path.join(__dirname, '..', 'public', 'index.html');
const CONTAINER_TAGS = /<(\/?)(div|section|main)\b[^>]*>/g;

function readDashboard() {
  return fs.readFileSync(DASHBOARD, 'utf8');
}

function mainRegion(html) {
  const start = html.indexOf('<main');
  const end = html.indexOf('</main>');
  assert.ok(start !== -1, 'dashboard must declare a <main> region');
  assert.ok(end > start, 'dashboard must close its <main> region');
  return html.slice(start, end);
}

test('the <main> region closes every container it opens', () => {
  const region = mainRegion(readDashboard());

  let depth = 0;
  let lowest = 0;
  let lowestOffset = -1;
  let match;

  CONTAINER_TAGS.lastIndex = 0;
  while ((match = CONTAINER_TAGS.exec(region)) !== null) {
    if (match[2] === 'main') continue;
    if (match[1] === '/') {
      depth -= 1;
      if (depth < lowest) {
        lowest = depth;
        lowestOffset = match.index;
      }
    } else {
      depth += 1;
    }
  }

  assert.equal(
    lowest,
    0,
    `a stray closing tag unwinds past <main> near ${JSON.stringify(
      region.slice(Math.max(0, lowestOffset - 80), lowestOffset + 40),
    )}; the browser closes <main> early and every later view escapes the app shell`,
  );
  assert.equal(depth, 0, 'containers opened inside <main> must all be closed inside <main>');
});
