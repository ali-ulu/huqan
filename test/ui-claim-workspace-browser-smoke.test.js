'use strict';

// Browser smoke for the Claim Workspace UI (issue #785, AC-785-10).
//
// `test/ui-claim-workspace-readonly.test.js` compiles the browser script in a
// `vm` and asserts on its source shape. That proves the script parses and
// mentions the right routes; it cannot prove the page actually works. This test
// loads the real page in a real browser against a real server, drives it the
// way a user does, and fails on uncaught browser exceptions.
//
// Skips instead of failing when the runtime has no global WebSocket or the
// machine has no Chromium-family browser. See test/helpers/cdp-browser.js.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { launchBrowserSession, browserSmokeSkipReason } = require('./helpers/cdp-browser');
const { publicWorkflowManifest } = require('../lib/workflow-contract');

const TEST_API_KEY = 'test-ui-browser-secret';
const WAIT_TIMEOUT_MS = 15_000;

const skipReason = browserSmokeSkipReason();

// A smoke test that silently skips is worth nothing as evidence. CI sets
// HUQAN_REQUIRE_BROWSER_SMOKE so a missing browser fails the run instead of
// quietly removing the only proof that the UI works in a browser.
if (skipReason && process.env.HUQAN_REQUIRE_BROWSER_SMOKE === '1') {
  throw new Error(`browser smoke is required but cannot run: ${skipReason}`);
}

describe('Claim Workspace browser smoke (#785 AC-10)', { skip: skipReason ?? false }, () => {
  let server;
  let browser;
  let tempDir;
  let base;
  let receiptId = '';

  // Read straight from the server so "nothing was written yet" is a claim about
  // canonical state, not about what the page happened to render.
  async function graphCounts() {
    const response = await fetch(`${base}/graph-data?workspaceId=default`, {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    assert.equal(response.status, 200, 'graph read failed');
    const data = await response.json();
    return { nodes: data.nodes?.length ?? -1, links: data.links?.length ?? -1 };
  }

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

  // Save & Connect disables itself for the duration of a connect. A click that
  // lands during that window is dropped by the browser and the page keeps the
  // session it already had, with nothing to say the click went nowhere. That is
  // what #1838 actually was: the re-authentication below fired while the
  // previous connect was still in flight, the key was never stored, and the
  // next test waited fifteen seconds on surfaces that were never going to
  // unlock. Wait for the button, then confirm the key landed, so the helper
  // fails where the cause is rather than one test later.
  async function authenticate(workspace = 'default') {
    await waitFor(`document.getElementById('save').disabled === false`, 'Save & Connect to accept a click');
    await browser.evaluate(`
      document.getElementById('key').value = ${JSON.stringify(TEST_API_KEY)};
      document.getElementById('workspace').value = ${JSON.stringify(workspace)};
      document.getElementById('save').click();
      true;
    `);
    await waitFor(
      `sessionStorage.getItem('huqan-api-key') === ${JSON.stringify(TEST_API_KEY)}`,
      'the session key to be stored, proving the click reached the handler',
    );
  }

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-ui-smoke-'));
    process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'memory.json');
    process.env.AXIOM_DB_PATH = path.join(tempDir, 'memory.db');
    process.env.AXIOM_BACKUP_DIR = path.join(tempDir, 'backups');
    process.env.AXIOM_KERNEL_VERSION = 'v2';
    process.env.AXIOM_DISABLE_AUTO_LISTEN = '1';
    process.env.AXIOM_API_KEY = TEST_API_KEY;

    server = require('../server');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
      server.startServer(0);
    });
    base = `http://127.0.0.1:${server.address().port}`;

    browser = await launchBrowserSession();
    await browser.navigate(`${base}/`);

    // Authenticate through the settings panel rather than seeding storage, so
    // the smoke exercises the same path a first-time user takes.
    await authenticate();
  });

  after(async () => {
    try {
      await browser?.close();
    } catch {
      // A browser that will not shut down cleanly is a teardown problem, not a
      // product failure; the assertions above already ran.
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
    delete process.env.AXIOM_API_KEY;
    // Windows keeps the SQLite handle briefly after close, so removal can hit
    // EPERM under load. Retry, then give up: a leftover temp directory must not
    // turn a passing suite red.
    try {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* best effort */ }
  });

  it('serves the page and reaches the capability manifest', async () => {
    const state = await waitFor(
      `document.getElementById('wstate').textContent === 'READY' && document.getElementById('wcontract').textContent`,
      'the capability manifest to load',
    );
    const expected = publicWorkflowManifest();
    assert.match(state, /^contract .+ · \d+ workflow$/);
    assert.ok(state.includes(`${expected.workflows.length} workflow`), `manifest size mismatch: ${state}`);
  });

  it('enables exactly the actions the server marks ui-available', async () => {
    await waitFor(`document.getElementById('wstate').textContent === 'READY'`, 'the manifest');
    const enabled = await browser.evaluate(
      `[...document.getElementById('action').options].filter(o => !o.disabled).map(o => o.value)`,
    );
    const expected = publicWorkflowManifest().workflows
      .filter(item => item.availability.ui)
      .map(item => item.workflowId);

    // The select only offers a subset of surfaces, so compare against the
    // intersection: every enabled option must be ui-available, and every
    // ui-available workflow the select offers must be enabled.
    const offered = await browser.evaluate(
      `[...document.getElementById('action').options].map(o => o.value)`,
    );
    assert.deepEqual(enabled, offered.filter(value => expected.includes(value)));
    assert.ok(enabled.length > 0, 'no action was enabled by the manifest');
  });

  it('opens each primary home action and exposes the active navigation page', async () => {
    for (const [label, view] of [['Verify a claim', 'verify'], ['Review decisions', 'approvals'], ['Inspect evidence', 'evidence']]) {
      await browser.evaluate(`document.querySelector('[data-v="overview"]').click(); true;`);
      await browser.evaluate(`document.querySelector('[data-go="${view}"]').click(); true;`);
      const state = await browser.evaluate(`({
        viewActive: document.getElementById('v-${view}').classList.contains('active'),
        current: document.querySelector('[data-v="${view}"]').getAttribute('aria-current'),
        heroHidden: document.getElementById('homehero').hidden,
      })`);
      assert.deepEqual(state, { viewActive: true, current: 'page', heroHidden: true }, label);
    }
    await browser.evaluate(`document.querySelector('[data-v="overview"]').click(); true;`);
    const programmatic = await browser.evaluate(`
      go('activity');
      ({
        viewActive: document.getElementById('v-activity').classList.contains('active'),
        current: document.querySelector('[data-v="activity"]').getAttribute('aria-current'),
        heroHidden: document.getElementById('homehero').hidden,
      })
    `);
    assert.deepEqual(programmatic, { viewActive: true, current: 'page', heroHidden: true });
    const ingestRun = await browser.evaluate(`
      document.querySelector('[data-v="ingest-run"]').click();
      ({
        viewActive: document.getElementById('v-ingest-run').classList.contains('active'),
        current: document.querySelector('[data-v="ingest-run"]').getAttribute('aria-current'),
        currentCount: document.querySelectorAll('.nav [aria-current="page"]').length,
      })
    `);
    assert.deepEqual(ingestRun, { viewActive: true, current: 'page', currentCount: 1 });
    await browser.evaluate(`go('overview'); true;`);
    const homeLayout = await browser.evaluate(`({
      heroParent: document.getElementById('homehero').parentElement.id,
      scrollable: document.getElementById('v-overview').scrollHeight >= document.getElementById('v-overview').clientHeight,
      overflowY: getComputedStyle(document.getElementById('v-overview')).overflowY,
    })`);
    assert.deepEqual(homeLayout, { heroParent: 'v-overview', scrollable: true, overflowY: 'auto' });
  });

  it('shows auth-required states instead of generic errors without a session key', async () => {
    // #1821/#1835 made the default workspace's graph readable without a key,
    // matching the public `/graph-data` backend contract. So "unauthenticated"
    // is no longer one uniform locked state: the graph reads, the approval
    // queue does not. Assert that split rather than a blanket LOCKED, which is
    // what went stale here and produced #1838.
    try {
      await browser.evaluate(`document.getElementById('clear').click(); true;`);
      await waitFor(
        `document.getElementById('sstatus').textContent === 'API key not set.'
          && document.getElementById('astate').textContent === 'LOCKED'
          && /Graph Data\\s*●\\s*(LIVE|EMPTY)/.test(document.getElementById('health').textContent)
          && /Approval Queue\\s*●\\s*LOCKED/.test(document.getElementById('health').textContent)`,
        'the unauthenticated default workspace to read its public graph while the approval queue stays locked',
      );

      // The public read is scoped to the default workspace, and that scope is
      // enforced by the server: unauthenticated `/graph-data` answers 200 for
      // `default` and 401 for anything else. #1835's client-side check only
      // spares the page a request it knows will fail, so deleting that check
      // leaves this assertion green — verified by mutation. What is pinned here
      // is therefore the observable boundary, not which layer produces it.
      await browser.evaluate(`
        document.getElementById('key').value = '';
        document.getElementById('workspace').value = 'not-the-default-workspace';
        document.getElementById('save').click();
        true;
      `);
      await waitFor(
        `/Graph Data\\s*●\\s*LOCKED/.test(document.getElementById('health').textContent)
          && /Approval Queue\\s*●\\s*LOCKED/.test(document.getElementById('health').textContent)`,
        'a non-default workspace to stay locked without a session key',
      );
    } finally {
      // Re-authenticate in `finally` so a failure above fails only this test.
      // Previously the click was unreachable after a timeout, and the next test
      // failed too — which is why #1838 read as a two-directional break.
      await authenticate();
    }
  });

  it('settles the connection and shows Graph Data and Approval Queue as live', async () => {
    await waitFor(
      `document.getElementById('sstatus').textContent === 'Connected.'
        && /^(LIVE|EMPTY)$/.test(document.getElementById('astate').textContent)
        && /Graph Data\\s*●\\s*(LIVE|EMPTY)/.test(document.getElementById('health').textContent)
        && /Approval Queue\\s*●\\s*(LIVE|EMPTY)/.test(document.getElementById('health').textContent)`,
      'the authenticated graph and approval surfaces to become live',
    );
    const health = await browser.evaluate(`document.getElementById('health').textContent`);
    assert.match(health, /Graph Data\s*●\s*(LIVE|EMPTY)/);
    assert.match(health, /Approval Queue\s*●\s*(LIVE|EMPTY)/);
    assert.equal(await browser.evaluate(`document.getElementById('securemeter').style.width`), '100%');
  });

  it('keeps header, health summary, and footer aligned to one aggregate status', async () => {
    const header = await browser.evaluate(`document.getElementById('sys').textContent`);
    const summary = await browser.evaluate(`document.getElementById('healthsum').textContent`);
    const footer = await browser.evaluate(`document.getElementById('footstatus').textContent`);
    assert.match(header, /^(HEALTHY|PARTIAL|DEGRADED|OFFLINE|CHECKING)$/);
    assert.match(summary, new RegExp(`^${header} \\u00b7 .+$`));
    assert.equal(footer, summary);

    await browser.evaluate(`document.getElementById('clear').click(); true;`);
    await waitFor(
      `document.getElementById('sys').textContent !== 'HEALTHY'
        && document.getElementById('healthsum').textContent.startsWith(document.getElementById('sys').textContent + ' · ')
        && document.getElementById('footstatus').textContent === document.getElementById('healthsum').textContent`,
      'the aggregate status to remain aligned after clearing the session key',
    );
    const unauthenticated = await browser.evaluate(`({
      header: document.getElementById('sys').textContent,
      summary: document.getElementById('healthsum').textContent,
      footer: document.getElementById('footstatus').textContent,
    })`);
    assert.notEqual(unauthenticated.header, 'HEALTHY');
    assert.equal(unauthenticated.footer, unauthenticated.summary);
    const ctaAfterClear = await browser.evaluate(`document.querySelector('#footcta button[type="button"]')?.textContent || ''`);
    assert.ok(['Open Settings', 'Retry', 'Open Surfaces', 'Refresh'].includes(ctaAfterClear), 'footer must expose a keyboard-accessible recovery action when the aggregate is not healthy, got: ' + ctaAfterClear);

    await browser.evaluate(`
      document.getElementById('key').value = ${JSON.stringify(TEST_API_KEY)};
      document.getElementById('workspace').value = 'default';
      document.getElementById('save').click();
      true;
    `);
    await waitFor(`document.getElementById('sstatus').textContent === 'Connected.'`, 'the session to reconnect');
  });

  // #1878: ingest-preview is the read half of the batch flow. Only the preview
  // runs here -- ingest-execute would queue a second candidate and change what
  // the approval cases below are looking at.
  it('previews a manual ingest through the panel fields', async () => {
    await waitFor(`document.getElementById('wstate').textContent === 'READY'`, 'the manifest');
    await browser.evaluate(`
      document.getElementById('action').value = 'ingest-preview';
      document.getElementById('action').onchange();
      document.getElementById('ingestsource').value = 'manual';
      document.getElementById('ingestsource').onchange();
      document.getElementById('ingestauthor').value = 'browser-smoke';
      document.getElementById('prompt').value = 'a note the operator wants queued';
      document.getElementById('run').click();
      true;
    `);

    await waitFor(
      `document.getElementById('run').disabled === false && document.getElementById('result').innerHTML.length > 0`,
      'the ingest preview to settle',
    );

    const fields = await browser.evaluate(`JSON.stringify({
      source: document.getElementById('ingestsourcefield').hidden,
      title: document.getElementById('ingesttitlefield').hidden,
      label: document.getElementById('promptlabel').textContent,
    })`);
    assert.deepEqual(JSON.parse(fields), { source: false, title: true, label: 'Note text' });

    const status = await browser.evaluate(`document.getElementById('vstatus').textContent`);
    const result = await browser.evaluate(`document.getElementById('result').textContent`);

    // A body the route rejects reports "failed: body.claim is not allowed.",
    // so a completed status with the source manifest in the envelope is what
    // separates a real round trip from a page that rendered an error.
    assert.match(status, /^ingest-preview: completed$/, `preview did not complete: ${status}`);
    assert.match(result, /submit_ingest_execute/, `no review handoff rendered: ${result.slice(0, 200)}`);
    assert.match(result, /"sourceDigest":/, `no source manifest rendered: ${result.slice(0, 200)}`);
  });

  it('runs a verify action against the canonical authenticated endpoint', async () => {
    await waitFor(`document.getElementById('wstate').textContent === 'READY'`, 'the manifest');
    await browser.evaluate(`
      document.getElementById('action').value = 'verify';
      document.getElementById('prompt').value = 'kedi bir bitkidir';
      document.getElementById('run').click();
      true;
    `);

    await waitFor(
      `document.getElementById('run').disabled === false && document.getElementById('vstatus').textContent !== 'Capability manifest ready.' && document.getElementById('result').innerHTML.length > 0`,
      'the verify action to settle',
    );

    const status = await browser.evaluate(`document.getElementById('vstatus').textContent`);
    const result = await browser.evaluate(`document.getElementById('result').textContent`);

    // These three assertions are what separate a real round trip from a page
    // that merely rendered something. An unauthenticated run reports
    // "failed: HTTP 401" with no trace tag and no envelope, so each one fails
    // closed rather than passing on any response at all.
    assert.match(status, /^verify: completed$/, `verify did not complete: ${status}`);
    assert.match(result, /trace [0-9a-f-]{36}/, `no server trace identifier rendered: ${result.slice(0, 200)}`);
    assert.match(result, /"ok":\s*true/, `no workflow envelope rendered: ${result.slice(0, 200)}`);
  });

  it('sends an unsupported claim to review without writing to canonical memory', async () => {
    const before = await graphCounts();

    await browser.evaluate(`document.getElementById('review').click(); true;`);
    const status = await waitFor(
      `(() => { const t = document.getElementById('vstatus').textContent; return t.includes(' · ') || t.startsWith('review failed') ? t : ''; })()`,
      'the review submission to settle',
    );

    assert.doesNotMatch(status, /^review failed/, `review submission failed: ${status}`);
    assert.match(status, /^pending · ingest-approval-/, `claim did not become a pending candidate: ${status}`);
    assert.deepEqual(await graphCounts(), before, 'a canonical write happened before any approval decision');
  });

  it('lists the pending candidate in Review Inbox', async () => {
    await browser.evaluate(`document.querySelector('.nav button[data-v="approvals"]').click(); true;`);
    await waitFor(`document.getElementById('astate').textContent === 'LIVE'`, 'the approval inbox to load');

    const pending = await browser.evaluate(`document.querySelectorAll('#alist [data-dec="approved"]').length`);
    assert.ok(pending > 0, 'Review Inbox rendered no pending candidate');
  });

  it('approves the candidate, which performs the canonical write and yields a receipt', async () => {
    const before = await graphCounts();

    await browser.evaluate(`document.querySelector('#alist [data-dec="approved"]').click(); true;`);
    await waitFor(
      `document.querySelectorAll('#alist [data-dec="approved"]').length === 0
        || document.getElementById('ahead').textContent.startsWith('failed')`,
      'the approval decision to settle',
    );

    const head = await browser.evaluate(`document.getElementById('ahead').textContent`);
    assert.doesNotMatch(head, /^failed/, `approval decision failed: ${head}`);

    const after = await graphCounts();
    assert.ok(after.nodes > before.nodes, `approval produced no canonical write (${before.nodes} -> ${after.nodes})`);

    receiptId = await browser.evaluate(`document.querySelector('#recent [data-receipt]')?.dataset.receipt || ''`);
    assert.match(receiptId, /^\S+$/, 'approval surfaced no Trust Receipt in the recent list');

    // The badge must report what the source said, not an integrity verdict the
    // page never computed. This is the defect the smoke was written against --
    // the list used to render a hardcoded `VERIFIED` for every entry, including
    // receipts the server returns with status "unknown".
    //
    // Asserted here rather than left to the fix's own diff: without it the
    // hardcoded badge can be restored and every other assertion still passes,
    // which was checked by putting it back and watching the suite stay green.
    const badge = await browser.evaluate(
      `document.querySelector('#recent [data-receipt]')?.querySelector('em')?.textContent || ''`,
    );
    assert.match(badge, /^\S+$/, `the receipt badge rendered nothing: ${JSON.stringify(badge)}`);
    assert.doesNotMatch(
      badge,
      /^VERIFIED$/,
      'the receipt badge asserts an integrity verdict the page never checked',
    );
  });

  it('returns the approved claim through memory search', async () => {
    await browser.evaluate(`
      document.querySelector('.nav button[data-v="verify"]').click();
      document.getElementById('action').value = 'memory-search';
      document.getElementById('prompt').value = 'kedi';
      document.getElementById('run').click();
      true;
    `);
    await waitFor(
      `document.getElementById('run').disabled === false && document.getElementById('vstatus').textContent !== 'Capability manifest ready.' && document.getElementById('result').innerHTML.length > 0`,
      'memory search to settle',
    );

    const status = await browser.evaluate(`document.getElementById('vstatus').textContent`);
    const result = await browser.evaluate(`document.getElementById('result').textContent`);

    assert.match(status, /^memory-search: completed$/, `memory search did not complete: ${status}`);
    assert.match(result, /"ok":\s*true/, `no workflow envelope rendered: ${result.slice(0, 200)}`);
  });

  it('opens the receipt from the result list and shows its provenance', async () => {
    assert.match(receiptId, /^\S+$/, 'no receipt was captured by the approval step');

    // AC-785-8: the handoff has to be reachable by clicking the receipt, not
    // only by pasting an identifier into the Evidence tab by hand.
    await browser.evaluate(`document.querySelector('#recent [data-receipt]').click(); true;`);
    await waitFor(
      `document.getElementById('estatus').textContent !== 'Loading evidence…'
        && document.getElementById('estatus').textContent.length > 0`,
      'the receipt read to settle',
    );

    const estatus = await browser.evaluate(`document.getElementById('estatus').textContent`);
    const raw = await browser.evaluate(`document.getElementById('raw').textContent`);

    assert.match(estatus, /^Receipt found\.$/, `receipt handoff failed: ${estatus}`);
    assert.match(raw, /"receiptId":/, `no receipt document rendered: ${raw.slice(0, 200)}`);
    assert.ok(raw.includes(receiptId), 'the opened receipt does not match the clicked identifier');
  });

  it('opens the receipt from the keyboard as well as the mouse', async () => {
    // The entry renders as role="button" with tabindex="0", so it promises
    // keyboard operation. A mouse-only handler would leave a keyboard user
    // focused on something that announces as a button and does nothing
    // (WCAG 2.1.1), and a .click()-driven assertion cannot see that.
    //
    // Target the approval receipt by id rather than by position: reading a
    // receipt pushes its own identifier onto the recent list, so by now the
    // first entry is no longer the one the approval produced.
    const selector = `#recent [data-receipt=${JSON.stringify(receiptId)}]`;
    await browser.evaluate(`
      document.getElementById('einput').value = '';
      document.getElementById('estatus').textContent = '';
      document.getElementById('raw').textContent = '';
      const node = document.querySelector(${JSON.stringify(selector)});
      node.focus();
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      true;
    `);
    await waitFor(
      `document.getElementById('estatus').textContent !== 'Loading evidence…'
        && document.getElementById('estatus').textContent.length > 0`,
      'the keyboard-triggered receipt read to settle',
    );

    const estatus = await browser.evaluate(`document.getElementById('estatus').textContent`);
    const raw = await browser.evaluate(`document.getElementById('raw').textContent`);
    assert.match(estatus, /^Receipt found\.$/, `keyboard receipt handoff failed: ${estatus}`);
    assert.ok(raw.includes(receiptId), 'the keyboard-opened receipt does not match the focused identifier');
  });

  // #1878: the receiptId mode now reads through the manifest's
  // trust-receipt-detail template rather than the unversioned workbench route.
  it('reads by id through the versioned detail route, in its error vocabulary', async () => {
    // This session produces no materialized receipt: the ingest approval hands
    // back a trust-ledger receipt the panel opens in targetId mode, and
    // readReceiptById reads only receipts materialized into the audit path.
    // Both routes answer 404 for such an id, before this change and after it,
    // so a successful read cannot be demonstrated here -- the round trip is
    // pinned against the real route in test/ui-receipt-detail-route.test.js.
    //
    // What a browser can still prove is which route the panel now talks to.
    // The versioned route answers a miss with the workflow envelope's
    // `error.code`, which the panel renders verbatim; the unversioned
    // workbench route carries no error object, so the same miss used to render
    // as `HTTP 404`. The distinction is the assertion.
    await browser.evaluate(`
      document.getElementById('estatus').textContent = '';
      document.getElementById('raw').textContent = '';
      document.getElementById('einput').value = 'receipt-that-does-not-exist';
      document.getElementById('emode').value = 'receiptId';
      document.getElementById('eload').click();
      true;
    `);
    await waitFor(
      `document.getElementById('estatus').textContent !== 'Loading evidence…'
        && document.getElementById('estatus').textContent.length > 0`,
      'the detail-route read to settle',
    );

    const estatus = await browser.evaluate(`document.getElementById('estatus').textContent`);
    assert.equal(estatus, 'failed: receipt_not_found', `not the versioned route's answer: ${estatus}`);
  });

  it('records no uncaught browser exception or console error across the session', () => {
    assert.deepEqual(browser.exceptions, [], `uncaught browser exceptions: ${browser.exceptions.join(' | ')}`);
    // AC-785-10 asks for a clean console, not merely the absence of a crash.
    // A workflow error the page caught and logged still means the workflow
    // broke, so the driver's console channel has to be asserted too.
    assert.deepEqual(browser.consoleErrors, [], `console errors: ${browser.consoleErrors.join(' | ')}`);
  });
});
