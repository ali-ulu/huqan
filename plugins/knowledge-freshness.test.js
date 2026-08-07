const test = require('node:test');
const assert = require('node:assert/strict');

const knowledgeFreshness = require('./knowledge-freshness');
const { isStaleTimestamp, findStaleEdgesForQuestion } = knowledgeFreshness._test;
const Kernel = require('../kernel');

const TEST_BYPASS = Kernel.createAdmissionBypassOpts('test');

// graph.getEdges() returns cloned records (cloneEdgeRecord), so mutating
// what it returns is a no-op against stored state -- tests that need a
// genuinely stale edge (learn() always stamps "now") reach into the
// internal _edges array directly instead.
function backdateEdgesFrom(kernel, fromId, isoTimestamp) {
  for (const edge of kernel.graph._edges) {
    if (edge.from === fromId) {
      edge.createdAt = isoTimestamp;
      edge.updatedAt = isoTimestamp;
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
