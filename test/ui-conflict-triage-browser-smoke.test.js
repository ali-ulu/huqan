'use strict';

// Browser smoke for conflict triage (issue #1929).
//
// The Conflicts view used to dump every derived signal into one list. What a
// user sees now -- a bounded page, severity/type filters, and distinct empty,
// loading and error states -- lives in DOM the source-level contract test
// (test/ui-conflict-triage-contract.test.js) cannot exercise, so this drives
// the real page in a real browser.
//
// The first case runs against the real server and the real /graph-data
// response. The later cases replace `window.fetch` for that one path so the
// page receives graph payloads this test controls: the states being asserted
// are frontend states, and reaching them through kernel writes would make the
// assertions depend on ingest semantics that have nothing to do with #1929.
// Graph/conflict API semantics are untouched either way -- the stub answers
// with the same response shape lib/server-graph-data.js publishes.
//
// Skips instead of failing when the runtime has no global WebSocket or the
// machine has no Chromium-family browser. See test/helpers/cdp-browser.js.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { launchBrowserSession, browserSmokeSkipReason } = require('./helpers/cdp-browser');

const WAIT_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 10;

const skipReason = browserSmokeSkipReason();

if (skipReason && process.env.HUQAN_REQUIRE_BROWSER_SMOKE === '1') {
  throw new Error(`browser smoke is required but cannot run: ${skipReason}`);
}

describe('conflict triage browser smoke (#1929)', { skip: skipReason ?? false }, () => {
  let server;
  let browser;
  let tempDir;
  let base;

  async function waitFor(expression, description) {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    let last;
    while (Date.now() < deadline) {
      last = await browser.evaluate(expression);
      if (last) return last;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${description} (last value: ${JSON.stringify(last)})`);
  }

  const text = id => browser.evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const rowCount = () => browser.evaluate(`document.querySelectorAll('#clist [data-conflict-row]').length`);
  const rowSeverities = () => browser.evaluate(
    `JSON.stringify([...document.querySelectorAll('#clist [data-conflict-row]')].map(el => el.dataset.conflictRow))`,
  );

  /** Sets a filter <select> the way a user would, then fires its change handler. */
  async function selectFilter(id, value) {
    // Wrapped in an IIFE: every evaluate() shares one page global scope, so a
    // bare `const` would collide with the previous call's declaration.
    await browser.evaluate(`
      (() => {
        const el = document.getElementById(${JSON.stringify(id)});
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change'));
        return true;
      })()
    `);
  }

  /**
   * Installs the /graph-data stub. `window.__graphStub` selects what the next
   * fetch of that path answers with; every other request still hits the server.
   */
  async function installStub() {
    await browser.evaluate(`
      (() => {
        if (window.__realFetch) return true;
        window.__realFetch = window.fetch.bind(window);
        window.__graphStub = null;
        window.fetch = (input, init) => {
          const url = String(typeof input === 'string' ? input : (input && input.url) || '');
          const stub = window.__graphStub;
          if (stub && url.split('?')[0].endsWith('/graph-data')) {
            if (stub.mode === 'hang') return new Promise(() => {});
            const status = stub.mode === 'error' ? 500 : 200;
            const body = stub.mode === 'error' ? '{}' : JSON.stringify(stub.payload);
            return Promise.resolve(new Response(body, { status, headers: { 'Content-Type': 'application/json' } }));
          }
          return window.__realFetch(input, init);
        };
        return true;
      })()
    `);
  }

  /** Applies a stub mode and reloads the conflict view through the real loadGraph(). */
  async function serveGraph(stub) {
    await browser.evaluate(`window.__graphStub = ${JSON.stringify(stub)}; true;`);
    await browser.evaluate(`document.getElementById('crefresh').click(); true;`);
  }

  /**
   * A graph with a known signal census: 3 conflicting-type nodes and 3
   * negation nodes (high), 8 low-confidence nodes (medium), 8 stale nodes
   * (low) -- 22 signals, comfortably more than one page.
   */
  function graphFixture() {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const stale = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const nodes = [];
    const links = [];
    // The low-severity nodes come first and the high-severity ones are spread
    // through the tail on purpose: if the page simply echoed graph order, the
    // ordering assertion below would pass without any triage happening.
    for (let i = 0; i < 8; i += 1) {
      nodes.push({ id: `stale-${i}`, label: `Stale claim ${i}`, confidence: 0.9, last_seen: stale });
      if (i < 3) {
        nodes.push({ id: `multi-${i}`, label: `Ambiguous type ${i}`, confidence: 0.9, last_seen: recent });
        // Turkish relation names, so the stub also exercises rel()'s diacritic folding.
        links.push({ source: `multi-${i}`, target: `kind-a-${i}`, relation: 'tür' });
        links.push({ source: `multi-${i}`, target: `kind-b-${i}`, relation: 'tür' });
      }
      nodes.push({ id: `low-${i}`, label: `Weak claim ${i}`, confidence: 0.1, last_seen: recent });
      if (i < 3) {
        nodes.push({ id: `neg-${i}`, label: `Contradicted claim ${i}`, confidence: 0.9, last_seen: recent });
        links.push({ source: `neg-${i}`, target: `fact-a-${i}`, relation: 'değil' });
        links.push({ source: `neg-${i}`, target: `fact-b-${i}`, relation: 'ilişki' });
      }
    }
    return { nodes, links };
  }

  const TOTAL = 22;
  const HIGH = 6;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-conflict-smoke-'));
    process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'memory.json');
    process.env.AXIOM_DB_PATH = path.join(tempDir, 'memory.db');
    process.env.AXIOM_BACKUP_DIR = path.join(tempDir, 'backups');
    process.env.AXIOM_KERNEL_VERSION = 'v2';
    process.env.AXIOM_DISABLE_AUTO_LISTEN = '1';

    server = require('../server');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
      server.startServer(0);
    });
    base = `http://127.0.0.1:${server.address().port}`;

    browser = await launchBrowserSession();
    await browser.navigate(`${base}/`);
    await waitFor(
      `!/CHECKING/.test(document.getElementById('meshbadgestate').textContent)`,
      'the graph surface to settle after first load',
    );
    await browser.evaluate(`document.querySelector('.nav button[data-v="conflicts"]').click(); true;`);
  });

  after(async () => {
    try {
      await browser?.close();
    } catch {
      // Teardown noise, not a product failure: the assertions already ran.
    }
    server?.closeAllConnections?.();
    server?.closeIdleConnections?.();
    server?.closeHuqan?.();
    if (server) await new Promise(resolve => server.close(() => resolve()));
    delete process.env.AXIOM_MEMORY_PATH;
    delete process.env.AXIOM_DB_PATH;
    delete process.env.AXIOM_BACKUP_DIR;
    delete process.env.AXIOM_KERNEL_VERSION;
    delete process.env.AXIOM_DISABLE_AUTO_LISTEN;
    try {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* best effort */ }
  });

  it('reports a clean empty state against the real, empty graph', async () => {
    // No stub yet: this is the real /graph-data response for a fresh workspace.
    // An empty graph is not the same as a graph with nothing to flag, and the
    // view has to say which one it is.
    assert.equal(await text('cstatus'), 'No graph data in this workspace yet, so there is nothing to triage.');
    assert.equal(await rowCount(), 0);
    assert.match(await text('clist'), /No graph data in this workspace yet\./);
    assert.equal(await browser.evaluate(`Boolean(document.querySelector('#clist [data-go="verify"]'))`), true,
      'an empty graph must point at the action that fills it');
    assert.equal(await browser.evaluate(`document.getElementById('cmore').hidden`), true,
      'an empty result set must not offer more rows');
  });

  it('bounds a large result set to one page and offers an explicit path to the rest', async () => {
    await installStub();
    await serveGraph({ mode: 'ok', payload: graphFixture() });
    await waitFor(`document.querySelectorAll('#clist [data-conflict-row]').length === ${PAGE_SIZE}`,
      'the first page of signals to render');

    assert.equal(await text('csummary'), `${TOTAL} signal · ${HIGH} high priority`);
    assert.equal(await text('clistmeta'), `showing ${PAGE_SIZE} of ${TOTAL}`);
    assert.equal(await text('cstatus'), `Showing ${PAGE_SIZE} of ${TOTAL} signals, highest severity first.`);
    assert.equal(await browser.evaluate(`document.getElementById('cmore').hidden`), false);
    assert.match(await text('cmore'), /Show 10 more \(12 remaining\)/);

    await browser.evaluate(`document.getElementById('cmore').click(); true;`);
    assert.equal(await rowCount(), 20);
    assert.equal(await browser.evaluate(`document.getElementById('cless').hidden`), false);

    await browser.evaluate(`document.getElementById('cmore').click(); true;`);
    assert.equal(await rowCount(), TOTAL, 'the full set must be reachable');
    assert.equal(await browser.evaluate(`document.getElementById('cmore').hidden`), true);

    await browser.evaluate(`document.getElementById('cless').click(); true;`);
    assert.equal(await rowCount(), PAGE_SIZE, 'collapsing must return to a single page');
  });

  it('shows the worst signals first', async () => {
    const severities = JSON.parse(await rowSeverities());
    assert.equal(severities.length, PAGE_SIZE);
    assert.deepEqual(severities.slice(0, HIGH), Array(HIGH).fill('high'),
      'every high-priority signal must be on the first page');
    assert.ok(severities.every(s => s !== 'low'),
      'informational signals must not outrank the ones that need review');
  });

  it('filters by severity, by type, and by both at once', async () => {
    await selectFilter('cseverity', 'high');
    assert.deepEqual(JSON.parse(await rowSeverities()), Array(HIGH).fill('high'));
    assert.equal(await text('clistmeta'), `showing ${HIGH} of ${HIGH} filtered · ${TOTAL} total`);
    assert.equal(await browser.evaluate(`document.getElementById('cclear').disabled`), false);

    await selectFilter('ctype', 'negation');
    assert.equal(await rowCount(), 3);
    assert.equal(await browser.evaluate(
      `JSON.stringify([...new Set([...document.querySelectorAll('#clist [data-conflict-type]')].map(el => el.dataset.conflictType))])`,
    ), '["negation"]');

    // A severity and a type that cannot co-occur must produce an explicit
    // empty state, not a silent fallback to the whole set.
    await selectFilter('ctype', 'stale');
    assert.equal(await rowCount(), 0);
    assert.equal(await text('cstatus'), 'No signals match the selected filters.');
    assert.match(await text('clist'), /No signals match the selected filters\./);

    // The empty state's own recovery action has to work.
    await browser.evaluate(`document.querySelector('#clist [data-action="conflicts-clear"]').click(); true;`);
    assert.equal(await rowCount(), PAGE_SIZE);
    assert.equal(await text('clistmeta'), `showing ${PAGE_SIZE} of ${TOTAL}`);
    assert.equal(await browser.evaluate(`document.getElementById('cclear').disabled`), true);
  });

  it('lets the severity summary act as a filter and unset itself', async () => {
    await browser.evaluate(`document.querySelector('#ctriage [data-conflict-severity="medium"]').click(); true;`);
    assert.deepEqual(JSON.parse(await rowSeverities()), Array(8).fill('medium'));
    assert.equal(await browser.evaluate(
      `document.querySelector('#ctriage [data-conflict-severity="medium"]').getAttribute('aria-pressed')`,
    ), 'true');

    await browser.evaluate(`document.querySelector('#ctriage [data-conflict-severity="medium"]').click(); true;`);
    assert.equal(await rowCount(), PAGE_SIZE);
    assert.equal(await browser.evaluate(
      `document.querySelector('#ctriage [data-conflict-severity="medium"]').getAttribute('aria-pressed')`,
    ), 'false');
  });

  it('names the loading state instead of showing a stale verdict', async () => {
    await browser.evaluate(`window.__graphStub = { mode: 'hang' }; document.getElementById('refresh').click(); true;`);
    await waitFor(`/^Conflict triage is checking\\./.test(document.getElementById('cstatus').textContent)`,
      'the conflict view to report that it is loading');
    assert.equal(await rowCount(), 0, 'a pending refresh must not keep showing the previous result set');
  });

  it('names the error state and offers a retry', async () => {
    await serveGraph({ mode: 'error' });
    await waitFor(`/^Conflict triage is error\\./.test(document.getElementById('cstatus').textContent)`,
      'the conflict view to report the failed request');
    assert.equal(await rowCount(), 0);
    assert.match(await text('clist'), /Conflict triage is error\./);
    assert.equal(await browser.evaluate(`Boolean(document.querySelector('#clist [data-action="refresh"]'))`), true,
      'a failed graph surface must offer a retry');
    assert.equal(await text('ccount'), '—', 'an unreachable surface must not report a signal count');
  });

  it('returns to the empty state when the graph comes back with no signals', async () => {
    // A graph that has data but nothing worth flagging: distinct from both the
    // error state above and the no-graph-at-all state the first case covers.
    await serveGraph({ mode: 'ok', payload: { nodes: [{ id: 'clean', label: 'Healthy claim', confidence: 0.9 }], links: [] } });
    await waitFor(
      `document.getElementById('cstatus').textContent === 'No conflict signals in current graph data.'`,
      'the conflict view to recover after the error',
    );
    assert.equal(await rowCount(), 0);
    assert.equal(await text('ccount'), '0');
  });
});
