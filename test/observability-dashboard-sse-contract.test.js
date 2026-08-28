const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const dashboard = fs.readFileSync('public/index.html', 'utf8');
const script = dashboard.match(/<script>([\s\S]*)<\/script>/)?.[1].replace(/\r\n/g, '\n');

assert.ok(script, 'dashboard inline script must exist');

function loadStreamHelpers() {
  const start = script.indexOf('const STREAM_BASE_RECONNECT_DELAY_MS');
  const end = script.indexOf('\n\n  function renderToolUsage', start);
  assert.ok(start >= 0 && end > start, 'stream helper source must be present');
  const context = {};
  vm.runInNewContext(`${script.slice(start, end)}\nthis.exports = { streamEventKey, rememberStreamEvent, streamSeenEvents, STREAM_MAX_SEEN_EVENTS };`, context);
  return context.exports;
}

test('observability dashboard SSE contract', async t => {
  await t.test('exposes accessible live status and bounded reconnect policy', () => {
    assert.match(dashboard, /id="obsstatus"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(script, /STREAM_BASE_RECONNECT_DELAY_MS = 1000/);
    assert.match(script, /STREAM_MAX_RECONNECT_DELAY_MS = 15000/);
    assert.match(script, /Math\.min\(STREAM_BASE_RECONNECT_DELAY_MS \* \(2 \*\* Math\.min\(streamState\.retryAttempt, 4\)\), STREAM_MAX_RECONNECT_DELAY_MS\)/);
    assert.match(script, /setTimeout\(\(\) => \{ streamState\.timer = null; open\(\); \}, delay\)/);
    assert.match(script, /stream closed by server/);
    assert.match(script, /Reconnecting live stream in/);
  });

  await t.test('uses explicit close state and aborts pending reconnects', () => {
    assert.match(script, /const streamState = \{ closed: false, retryAttempt: 0, controller: null, timer: null, close: null \}/);
    assert.match(script, /streamState\.closed = true/);
    assert.match(script, /if \(streamState\.timer\) clearTimeout\(streamState\.timer\)/);
    assert.match(script, /if \(streamState\.controller\) streamState\.controller\.abort\(\)/);
    assert.match(script, /if \(streamState\.closed \|\| controller\.signal\.aborted\) return/);
  });

  await t.test('deduplicates by event identity and bounds client memory', () => {
    const { streamEventKey, rememberStreamEvent, streamSeenEvents, STREAM_MAX_SEEN_EVENTS } = loadStreamHelpers();
    assert.equal(streamEventKey({ eventId: 'evt-1', eventType: 'run_finished' }), 'evt-1');
    assert.equal(rememberStreamEvent({ eventId: 'evt-1', eventType: 'run_finished' }), true);
    assert.equal(rememberStreamEvent({ eventId: 'evt-1', eventType: 'run_finished' }), false);
    assert.equal(rememberStreamEvent({ eventType: 'step_finished', createdAt: '2026-08-25T00:00:00.000Z', runId: 'run-1', status: 'completed', tool: 'verify' }), true);
    for (let i = 0; i < STREAM_MAX_SEEN_EVENTS + 20; i += 1) {
      assert.equal(rememberStreamEvent({ eventId: `evt-${i + 2}` }), true);
    }
    assert.ok(streamSeenEvents.order.length <= STREAM_MAX_SEEN_EVENTS);
    assert.equal(streamSeenEvents.ids.size, streamSeenEvents.order.length);
  });

  await t.test('refreshes observability only for newly accepted events', () => {
    assert.match(script, /if \(event\.eventType && appendEvent\(event\)\) \{/);
    assert.match(script, /streamState\.retryAttempt = 0/);
    assert.match(script, /loadAll\(\);/);
    assert.match(script, /buffer\.split\('\\\\n\\\\n'\)/);
  });

  await t.test('keeps the inline dashboard script syntactically valid', () => {
    assert.doesNotThrow(() => new vm.Script(script));
  });
});

// This contract intentionally uses the real inline helper source and never opens
// a network connection; browser delivery is covered by the existing smoke suite.
// Third-party external delivery is intentionally outside this slice.
