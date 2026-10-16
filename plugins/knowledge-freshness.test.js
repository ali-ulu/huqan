const test = require('node:test');
const assert = require('node:assert/strict');

const knowledgeFreshness = require('./knowledge-freshness');
const { isStaleTimestamp, edgeTimestamp, findStaleEdgesForQuestion } = knowledgeFreshness._test;
const Kernel = require('../kernel');

const TEST_BYPASS = Kernel.createAdmissionBypassOpts('test');

// graph.getEdges() returns cloned records (cloneEdgeRecord), so mutating
// what it returns is a no-op against stored state -- tests that need a
// genuinely stale edge (learn() always stamps "now") reach into the
// internal _edges array directly instead.
//
// Backdates the REAL graph.js edge fields (created_at/updated_at, snake_case)
// -- not createdAt/updatedAt, which never exist on an actual edge record
// (#1278). A helper using the wrong field names would mask exactly the bug
// this file exists to catch.
function backdateEdgesFrom(kernel, fromId, isoTimestamp) {
  for (const edge of kernel.graph._edges) {
    if (edge.from === fromId) {
      edge.created_at = isoTimestamp;
      edge.updated_at = isoTimestamp;
      edge.created = Date.parse(isoTimestamp);
    }
  }
}

test('knowledge-freshness: isStaleTimestamp is false for a missing/unparseable timestamp', () => {
  assert.equal(isStaleTimestamp('', 1000, Date.now()), false);
  assert.equal(isStaleTimestamp(undefined, 1000, Date.now()), false);
  assert.equal(isStaleTimestamp('not a date', 1000, Date.now()), false);
});

test('knowledge-freshness: isStaleTimestamp compares age against the threshold', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const recent = '2026-08-05T00:00:00Z'; // 1 day old
  const old = '2026-01-01T00:00:00Z'; // ~7 months old
  const staleAfterMs = 30 * 24 * 60 * 60 * 1000;
  assert.equal(isStaleTimestamp(recent, staleAfterMs, now), false);
  assert.equal(isStaleTimestamp(old, staleAfterMs, now), true);
});

test('knowledge-freshness: edgeTimestamp reads the real snake_case graph.js edge fields, not camelCase (#1278)', () => {
  const old = '2020-01-01T00:00:00.000Z';
  const realShape = { created_at: old, updated_at: old, created: Date.parse(old) };
  assert.equal(edgeTimestamp(realShape), Date.parse(old));

  // A never-real shape must not accidentally satisfy the function either.
  const camelOnly = { createdAt: old, updatedAt: old };
  assert.ok(Number.isNaN(edgeTimestamp(camelOnly)));

  // updated_at is preferred over created_at: a REAFFIRMED edge advances
  // updated_at but not created_at, and staleness should track the update.
  const reaffirmed = { created_at: '2019-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
  assert.equal(edgeTimestamp(reaffirmed), Date.parse('2026-01-01T00:00:00.000Z'));

  // Numeric `created` (epoch ms) is the fallback when no ISO field is set.
  const numericOnly = { created: 1577836800000 };
  assert.equal(edgeTimestamp(numericOnly), 1577836800000);
});

test('knowledge-freshness: findStaleEdgesForQuestion finds stale edges off a matched graph node', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  k.learn('köpek hayvandır', TEST_BYPASS);

  const now = Date.now();
  const veryOld = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago

  // Force the edge's timestamp back in time directly on the graph, since
  // learn() always stamps "now" -- this test needs a genuinely stale edge,
  // not a freshly created one.
  backdateEdgesFrom(k, 'köpek', veryOld);

  const staleEdges = findStaleEdgesForQuestion(k, 'köpek nedir');
  assert.ok(staleEdges.length > 0);
  assert.equal(staleEdges[0].from, 'köpek');
});

test('knowledge-freshness: findStaleEdgesForQuestion finds nothing for a freshly learned fact', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  k.learn('kedi hayvandır', TEST_BYPASS);
  const staleEdges = findStaleEdgesForQuestion(k, 'kedi nedir');
  assert.equal(staleEdges.length, 0);
});

test('knowledge-freshness: findStaleEdgesForQuestion finds nothing for an unknown subject', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  const staleEdges = findStaleEdgesForQuestion(k, 'uçan fil nedir');
  assert.equal(staleEdges.length, 0);
});

test('knowledge-freshness: end to end -- afterAsk appends a notice when beforeAsk found stale edges', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  k.plugins.register(knowledgeFreshness);
  k.learn('köpek hayvandır', TEST_BYPASS);

  const veryOld = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  backdateEdgesFrom(k, 'köpek', veryOld);

  const answer = k.ask('köpek nedir').data.answer;
  assert.ok(answer.includes('[freshness:'), `expected a freshness notice, got: ${answer}`);
  assert.ok(answer.includes('hayvan'), 'the underlying answer content must still be present');
});

test('knowledge-freshness: end to end -- no notice when nothing is stale', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  k.plugins.register(knowledgeFreshness);
  k.learn('kedi hayvandır', TEST_BYPASS);

  const answer = k.ask('kedi nedir').data.answer;
  assert.equal(answer.includes('[freshness:'), false);
});

test('knowledge-freshness: end to end -- "Bilmiyorum" is never annotated', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  k.plugins.register(knowledgeFreshness);
  const answer = k.ask('uçan fil nedir').data.answer;
  assert.equal(answer, 'Bilmiyorum');
});

test('knowledge-freshness: end to end -- a stale edge in another workspace is not attributed to the queried workspace (#1278)', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false, capabilities: { workspaceScoping: true } });
  k.plugins.register(knowledgeFreshness);
  k.learn('köpek hayvandır', { ...TEST_BYPASS, workspaceId: 'tenant-a' });
  k.learn('köpek hayvandır', { ...TEST_BYPASS, workspaceId: 'default' });

  const veryOld = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  for (const edge of k.graph._edges) {
    if (edge.from === 'köpek' && edge.workspaceId === 'tenant-a') {
      edge.created_at = veryOld;
      edge.updated_at = veryOld;
    }
  }

  // 'default' has a fresh edge only -- the stale tenant-a edge must not surface here.
  const answer = k.ask('köpek nedir', 'default').data.answer;
  assert.equal(answer.includes('[freshness:'), false);
});

test('knowledge-freshness: pendingStaleEdges is consumed once, not leaked into the next ask()', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  k.plugins.register(knowledgeFreshness);
  k.learn('köpek hayvandır', TEST_BYPASS);
  const veryOld = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  backdateEdgesFrom(k, 'köpek', veryOld);

  k.ask('köpek nedir'); // primes and consumes staleness for this question
  const second = k.ask('uçan fil nedir').data.answer; // unrelated question, nothing stale for it
  assert.equal(second, 'Bilmiyorum');
});
