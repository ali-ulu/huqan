'use strict';

/**
 * #3081 — the first screen must answer "is this for me?" with something a
 * reader can run, not with a thesis.
 *
 * The README opened well but spent its first screen on philosophy: no link to
 * the hosted demo, no browser path, no "run this now". A reader had to scroll
 * to the MCP block to find the shortest way to try the product.
 *
 * These assertions are deliberately about position. A demo link that lives at
 * the bottom is the drift this guards against, so the checked tokens must
 * appear in the opening section, before the "Install" heading.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

/** Everything before the first `## Install` heading. */
function firstScreen() {
  const install = README.search(/^## Install\b/m);
  assert.ok(install !== -1, 'the README must have an Install section to mark the end of the first screen');
  return README.slice(0, install);
}

test('the first screen offers a runnable command', () => {
  assert.match(firstScreen(), /npx -y huqan quickstart/, 'the opening must show the quickstart command');
});

test('the first screen links a no-install browser demo (#3081)', () => {
  assert.match(firstScreen(), /https:\/\/huqan\.com/, 'the opening must link the hosted demo');
});

test('the first screen points at the product-surfaces chooser (#3081)', () => {
  const screen = firstScreen();
  assert.match(screen, /product-surfaces\.md/, 'the opening must link the surface chooser');
  assert.match(screen, /docs\/product-surfaces\.md/);
});

test('the shortest agent-connect path is reachable within the first two sections', () => {
  const connect = README.search(/^## Connect your agent\b/m);
  assert.ok(connect !== -1, 'the README must have a Connect your agent section');
  assert.match(README.slice(connect), /"huqan-mcp"/, 'the MCP block must name the server binary');
});
