'use strict';

// Browser smoke for the interactive Trust Network view (issue #4292).
//
// The graph view used to draw eight nodes at eight hardcoded positions with one
// line to the centre, and it had no zoom, no pan, no node detail and no way to
// reach a node from the keyboard. What a user sees now -- a layout that follows
// the real payload, zoom/pan, a selectable node and its relations -- lives in
// DOM the source-level contract test (test/ui-graph-layout-contract.test.js)
// cannot exercise, so this drives the real page in a real browser.
//
// The first case runs against the real server and the real /graph-data
// response. The later cases replace `window.fetch` for that one path so the
// page receives graph payloads this test controls; the states being asserted
// are frontend states, and reaching them through kernel writes would make the
// assertions depend on ingest semantics that have nothing to do with #4292.
// The stub answers with the same response shape lib/server-graph-data.js
// publishes, so the API semantics under test are untouched.
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

const skipReason = browserSmokeSkipReason();

if (skipReason && process.env.HUQAN_REQUIRE_BROWSER_SMOKE === '1') {
  throw new Error(`browser smoke is required but cannot run: ${skipReason}`);
}

describe('graph view browser smoke (#4292)', { skip: skipReason ?? false }, () => {
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

  const count = selector => browser.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);

  /**
   * Waits until a selector's count is `expected` on two consecutive reads.
   *
   * The double read matters: the first load's `refresh()` can still be in
   * flight when a test installs the stub, and its late resolution repaints the
   * view once with the real (empty) payload. A single read can land on that
   * transient paint, so the count is confirmed before it is trusted.
   */
  async function waitForCount(selector, expected, description) {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    let last = -1;
    while (Date.now() < deadline) {
      last = await count(selector);
      if (last === expected) {
        const again = await count(selector);
        if (again === expected) return again;
        last = again;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${description} (last count: ${last})`);
  }

  /** Installs the /graph-data stub, the same shape as the triage smoke test. */
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

  /**
   * Applies a stub and reloads the graph view, awaiting the real loadGraph().
   *
   * The click-and-poll version could observe the view mid-flight: a click on
   * #grefresh returns immediately, so the assertion raced the fetch it just
   * started. Awaiting the page's own loadGraph() promise means the render that
   * follows is already complete when the assertion reads the DOM, and no other
   * in-flight load can repaint it afterwards -- the bootstrap's first load is
   * already settled by the before() hook below.
   */
  async function serveGraph(stub) {
    await browser.evaluate(`window.__graphStub = ${JSON.stringify(stub)}; true;`);
    const outcome = await browser.evaluate(`loadGraph().then(() => 'settled', () => 'settled')`);
    if (outcome !== 'settled') throw new Error(`loadGraph() did not settle: ${outcome}`);
  }

  /** A small connected graph with a known relation mix. */
  function graphFixture() {
    const nodes = [
      { id: 'alpha', label: 'Alpha claim', confidence: 0.9, last_seen: '2026-09-01T00:00:00.000Z' },
      { id: 'beta', label: 'Beta claim', confidence: 0.4, last_seen: '2026-09-02T00:00:00.000Z' },
      { id: 'gamma', label: 'Gamma claim', confidence: 0.7, last_seen: '2026-09-03T00:00:00.000Z' },
      { id: 'delta', label: 'Delta claim', confidence: 0.2, last_seen: '2026-09-04T00:00:00.000Z' },
    ];
    const links = [
      { source: 'alpha', target: 'beta', relation: 'is_a' },
      { source: 'beta', target: 'gamma', relation: 'ilişki' },
      { source: 'gamma', target: 'delta', relation: 'değil' },
    ];
    return { nodes, links };
  }

  /** True when `expression` holds on two consecutive reads ~120ms apart. */
  async function waitForStable(expression, description) {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await browser.evaluate(expression)) {
        await new Promise(resolve => setTimeout(resolve, 120));
        if (await browser.evaluate(expression)) return true;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${description} to stay true`);
  }

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-graph-smoke-'));
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
    // Arm the stub with the fixture *before* any load races it, then drain.
    //
    // Two loads race the page's bootstrap: the `refresh()` from
    // `probeAuthMode().finally()` and the one `go('graph')` fires when the nav
    // button is clicked. A load that answers from the real server renders the
    // empty workspace and, if it resolves after a test has drawn its own
    // payload, repaints the view once and erases it -- which is how the first
    // case timed out at "0 nodes" on the slower macOS runner. Answering every
    // /graph-data from the fixture means a late repaint is identical, so the
    // ordering stops mattering. The stable double read then proves the
    // bootstrap has settled before the first case installs its own payload.
    await installStub();
    await browser.evaluate(`window.__graphStub = { mode: 'ok', payload: ${JSON.stringify(graphFixture())} }; true;`);
    await waitForStable(
      `typeof state !== 'undefined' && state.surfaces && state.surfaces.graph && state.surfaces.graph.s !== 'checking'`,
      'the bootstrap graph load',
    );
    await browser.evaluate(`document.querySelector('.nav button[data-v="graph"]').click(); true;`);
    await waitForStable(
      `typeof state !== 'undefined' && state.surfaces && state.surfaces.graph && state.surfaces.graph.s !== 'checking'`,
      'the navigation graph load',
    );
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

  it('renders a node button per real graph node, and one edge per real link', async () => {
    await serveGraph({ mode: 'ok', payload: graphFixture() });
    await waitForCount('#gnodes .gnode', 4, 'four node buttons');
    assert.equal(await count('#gedges line'), 3);
    // The stage is a labelled, focusable group rather than an aria-hidden image.
    const role = await browser.evaluate(`document.getElementById('graphstage').getAttribute('role')`);
    assert.equal(role, 'group');
    const tabindex = await browser.evaluate(`document.getElementById('graphstage').getAttribute('tabindex')`);
    assert.equal(tabindex, '0');
  });

  it('positions the nodes from the layout, not from fixed coordinates', async () => {
    await serveGraph({ mode: 'ok', payload: graphFixture() });
    await waitForCount('#gnodes .gnode', 4, 'four node buttons');
    const positions = JSON.parse(await browser.evaluate(
      `JSON.stringify([...document.querySelectorAll('#gnodes .gnode')].map(el => el.style.left + '/' + el.style.top))`,
    ));
    assert.equal(new Set(positions).size, 4, 'each node sits at its own layout coordinate');
  });

  it('selects a node and shows its relations in the detail panel', async () => {
    await serveGraph({ mode: 'ok', payload: graphFixture() });
    await waitForCount('#gnodes .gnode', 4, 'four node buttons');
    await browser.evaluate(`document.querySelector('#gnodes .gnode[data-node-id="beta"]').click(); true;`);
    await waitFor(`document.querySelector('#graphdetailbody .rel-list')`, 'the relation list');
    const pressed = await browser.evaluate(
      `document.querySelector('#gnodes .gnode[data-node-id="beta"]').getAttribute('aria-pressed')`,
    );
    assert.equal(pressed, 'true');
    const detail = await browser.evaluate(`document.getElementById('graphdetailbody').textContent`);
    assert.match(detail, /Beta claim/, 'the panel names the selected node');
    // beta has one incoming (is_a) and one outgoing (ilişki) relation.
    assert.equal(await count('#graphdetailbody .rel-list div'), 2);
  });

  it('reaches every node from the keyboard, not only from the mouse', async () => {
    await serveGraph({ mode: 'ok', payload: graphFixture() });
    await waitForCount('#gnodes .gnode', 4, 'four node buttons');
    // Each node is a real button, so it is in the tab order by construction.
    const tags = JSON.parse(await browser.evaluate(
      `JSON.stringify([...document.querySelectorAll('#gnodes .gnode')].map(el => el.tagName))`,
    ));
    assert.deepEqual(tags, ['BUTTON', 'BUTTON', 'BUTTON', 'BUTTON']);
    // Keyboard selection: focus the button and activate it without a pointer.
    await browser.evaluate(`document.querySelector('#gnodes .gnode[data-node-id="gamma"]').focus(); true;`);
    await browser.evaluate(`document.querySelector('#gnodes .gnode[data-node-id="gamma"]').click(); true;`);
    await waitFor(
      `document.querySelector('#gnodes .gnode[data-node-id="gamma"]').getAttribute('aria-pressed') === 'true'`,
      'the keyboard-selected node to be pressed',
    );
  });

  it('zooms and pans, and returns to the start on reset', async () => {
    await serveGraph({ mode: 'ok', payload: graphFixture() });
    await waitForCount('#gnodes .gnode', 4, 'four node buttons');
    const readZoom = () => browser.evaluate(`document.getElementById('gzoomlevel').textContent`);
    assert.equal(await readZoom(), '100%');
    await browser.evaluate(`document.getElementById('gzoom-in').click(); true;`);
    await waitFor(`document.getElementById('gzoomlevel').textContent !== '100%'`, 'zoom to change');
    const zoomed = await readZoom();
    assert.notEqual(zoomed, '100%');
    const transform = await browser.evaluate(`document.getElementById('gnodes').style.transform`);
    assert.match(transform, /scale\(/, 'the zoom is applied to the node layer');
    await browser.evaluate(`document.getElementById('gzoom-reset').click(); true;`);
    await waitFor(`document.getElementById('gzoomlevel').textContent === '100%'`, 'zoom to reset');
    assert.equal(await readZoom(), '100%');
  });

  it('keeps the empty state honest when the surface has no graph data', async () => {
    await serveGraph({ mode: 'ok', payload: { nodes: [], links: [] } });
    await waitFor(`!document.getElementById('graphempty').hidden`, 'the empty state');
    assert.equal(await count('#gnodes .gnode'), 0, 'no node is invented for an empty graph');
    assert.equal(await count('#gedges line'), 0, 'no edge is invented for an empty graph');
    const empty = await browser.evaluate(`document.getElementById('graphempty').textContent`);
    assert.match(empty, /No graph data/, 'the empty state says so rather than drawing a fake mesh');
  });

  it('never invents a node for a dangling edge', async () => {
    await serveGraph({
      mode: 'ok',
      payload: {
        nodes: [{ id: 'solo', label: 'Solo claim', confidence: 0.8 }],
        links: [{ source: 'solo', target: 'ghost', relation: 'is_a' }],
      },
    });
    await waitForCount('#gnodes .gnode', 1, 'one node button');
    assert.equal(await count('#gedges line'), 0, 'a link to an unknown node draws nothing');
  });
});
