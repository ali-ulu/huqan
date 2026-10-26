'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// #4292: the trust-network mesh placed nodes at eight fixed positions and drew
// one line to the centre, so the picture did not follow the graph it claimed to
// show. The replacement layout is a pure function of the graph-data payload,
// which is what makes it testable here: the same nodes and links must produce
// the same coordinates, no matter what order the surface published them in.
//
// What a user sees -- zoom, pan, the node detail panel, the honest empty state
// -- lives in DOM that this file cannot exercise; that is covered by
// test/ui-graph-view-browser-smoke.test.js against a real browser.
//
// The layout is lifted out of the minified dashboard script by slicing between
// two literal markers, the same way test/ui-conflict-triage-contract.test.js
// lifts the triage helpers. Either marker moving fails loudly rather than
// silently testing nothing.
const { dashboardScript } = require('./helpers/dashboard-source');

const script = dashboardScript();

function region(from, to) {
  const start = script.indexOf(from);
  assert.notEqual(start, -1, `dashboard script no longer contains ${JSON.stringify(from)}`);
  const end = script.indexOf(to, start);
  assert.notEqual(end, -1, `dashboard script no longer contains ${JSON.stringify(to)} after ${JSON.stringify(from)}`);
  return script.slice(start, end);
}

const sandbox = vm.runInNewContext([
  region('const LAYOUT_MAX_NODES=', 'function renderGraph()'),
  '({graphLayout,LAYOUT_MAX_NODES,LAYOUT_ITERATIONS,LAYOUT_PAD})',
].join('\n'), {});

const { graphLayout, LAYOUT_MAX_NODES, LAYOUT_ITERATIONS, LAYOUT_PAD } = sandbox;

// The layout runs inside a vm realm, so its objects do not share this realm's
// prototypes; comparing the JSON projection compares the values in question.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function node(id) {
  return { id, label: `label-${id}`, confidence: 0.5 };
}

/** A small connected graph, ids deliberately not in sorted order. */
function fixture() {
  return {
    nodes: [node('c'), node('a'), node('b'), node('d')],
    links: [
      { source: 'a', target: 'b', relation: 'is_a' },
      { source: 'b', target: 'c', relation: 'is_a' },
      { source: 'c', target: 'd', relation: 'is_a' },
    ],
  };
}

test('graphLayout is deterministic: identical input yields identical coordinates', () => {
  const { nodes, links } = fixture();
  const first = plain(graphLayout(nodes, links));
  const second = plain(graphLayout(nodes, links));
  assert.deepEqual(first, second);
});

test('graphLayout ignores the order nodes and links arrive in', () => {
  const { nodes, links } = fixture();
  const straight = plain(graphLayout(nodes, links));
  const shuffledNodes = [nodes[2], nodes[0], nodes[3], nodes[1]];
  const shuffledLinks = [links[2], links[0], links[1]];
  const shuffled = plain(graphLayout(shuffledNodes, shuffledLinks));
  assert.deepEqual(straight, shuffled);
});

test('graphLayout places every supplied node exactly once', () => {
  const { nodes, links } = fixture();
  const out = plain(graphLayout(nodes, links));
  assert.deepEqual(Object.keys(out).sort(), ['a', 'b', 'c', 'd']);
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.equal(typeof out[id].x, 'number');
    assert.equal(typeof out[id].y, 'number');
  }
});

test('graphLayout keeps every coordinate finite and inside the padded frame', () => {
  const { nodes, links } = fixture();
  const out = plain(graphLayout(nodes, links));
  for (const [id, point] of Object.entries(out)) {
    assert.ok(Number.isFinite(point.x), `${id} x is finite`);
    assert.ok(Number.isFinite(point.y), `${id} y is finite`);
    assert.ok(point.x >= LAYOUT_PAD && point.x <= 100 - LAYOUT_PAD, `${id} x in frame`);
    assert.ok(point.y >= LAYOUT_PAD && point.y <= 100 - LAYOUT_PAD, `${id} y in frame`);
  }
});

test('graphLayout returns no coordinates for an empty graph', () => {
  assert.deepEqual(plain(graphLayout([], [])), {});
  assert.deepEqual(plain(graphLayout(undefined, undefined)), {});
});

test('graphLayout centres a lone node', () => {
  assert.deepEqual(plain(graphLayout([node('only')], [])), { only: { x: 50, y: 50 } });
});

test('graphLayout never invents a node from a dangling link or a self-loop', () => {
  const nodes = [node('a'), node('b')];
  const links = [
    { source: 'a', target: 'ghost', relation: 'is_a' },
    { source: 'a', target: 'a', relation: 'self' },
    { source: 'b', target: 'b', relation: 'self' },
  ];
  const out = plain(graphLayout(nodes, links));
  assert.deepEqual(Object.keys(out).sort(), ['a', 'b']);
});

test('graphLayout drops duplicate edges without changing the result', () => {
  const nodes = [node('a'), node('b'), node('c')];
  const once = plain(graphLayout(nodes, [{ source: 'a', target: 'b', relation: 'is_a' }]));
  const twice = plain(graphLayout(nodes, [
    { source: 'a', target: 'b', relation: 'is_a' },
    { source: 'b', target: 'a', relation: 'is_a' },
  ]));
  assert.deepEqual(once, twice);
});

test('graphLayout bounds the work at LAYOUT_MAX_NODES', () => {
  const nodes = Array.from({ length: LAYOUT_MAX_NODES + 20 }, (_, i) => node(`n${String(i).padStart(3, '0')}`));
  const out = plain(graphLayout(nodes, []));
  assert.equal(Object.keys(out).length, LAYOUT_MAX_NODES);
  // The cap keeps the lowest ids, which is the stable order the layout sorted by.
  assert.ok(Object.hasOwn(out, 'n000'));
  assert.ok(Object.hasOwn(out, `n${String(LAYOUT_MAX_NODES - 1).padStart(3, '0')}`));
  assert.ok(!Object.hasOwn(out, `n${String(LAYOUT_MAX_NODES).padStart(3, '0')}`));
});

test('graphLayout does not mutate the graph-data payload it is given', () => {
  const { nodes, links } = fixture();
  const nodesBefore = plain(nodes);
  const linksBefore = plain(links);
  graphLayout(nodes, links);
  assert.deepEqual(plain(nodes), nodesBefore);
  assert.deepEqual(plain(links), linksBefore);
});

test('graphLayout stays bounded: the iteration budget is a fixed constant', () => {
  assert.equal(typeof LAYOUT_ITERATIONS, 'number');
  assert.ok(LAYOUT_ITERATIONS > 0 && LAYOUT_ITERATIONS <= 200, 'iteration budget stays small');
});

test('the layout is seeded without randomness, so a run is reproducible', () => {
  const layoutRegion = region('const LAYOUT_MAX_NODES=', 'function renderGraph()');
  assert.ok(!/Math\.random/.test(layoutRegion), 'the layout must not use Math.random');
  assert.ok(!/\bDate\.now\b/.test(layoutRegion), 'the layout must not read the clock');
});

test('mesh() keeps its name and signature: the triage contract slices on it', () => {
  assert.ok(script.includes('function mesh(){'), 'mesh() must keep its zero-argument signature');
  assert.ok(script.includes('function graphLayout('), 'graphLayout() must be present');
});
