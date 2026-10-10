'use strict';

// End-to-end USER session test: drive the real HUQAN MCP server the way a user
// would, across a session, and assert what the gate does before and after the
// AURA loop learns. Unlike a unit test, this runs the live server, the live
// plugin hooks and the live error-prevention store, in order, on one kernel.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.HUQAN_STATE_ROOT = process.env.HUQAN_STATE_ROOT
  || fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-aura-user-'));

const Kernel = require('../kernel');
const { createServer } = require('../mcpServer');
const auraSignalPack = require('../lib/aura-signal-pack');
const { runAuraLoop } = require('../scripts/aura-loop');

test('USER SESSION: a live MCP session is hardened by the loop', async () => {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: true });
  const server = createServer({ kernel, approvalStore: null });
  const risky = auraSignalPack.loadSignalPack()
    .cases.find((entry) => entry.case_id === 'M-CASE-001').scenario_texts[0];

  let id = 0;
  const ask = (question) => {
    id += 1;
    const res = server.handleRequest({
      jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'huqan.ask', arguments: { question } },
    }).result;
    return { isError: res.isError === true, text: res.content && res.content[0] ? res.content[0].text : '' };
  };

  // 1. A benign question is served.
  const benignBefore = ask('what is a cat');
  assert.equal(benignBefore.isError, false, 'a benign question should be served');

  // 2. The AURA-risky question is refused by the live gate.
  const riskyCall = ask(risky);
  assert.equal(riskyCall.isError, true);
  assert.match(riskyCall.text, /requires review/);

  // 3. The loop learns from that blind spot, through the canary trial.
  const loop = await runAuraLoop({ memory: kernel.memory, workspaceId: 'default' });
  assert.equal(loop.report[4].detail.huqan.canary.trialStatus, 'passed');
  assert.equal(loop.report[4].detail.huqan.canary.admission, true);
  assert.equal(loop.report[4].detail.huqan.rule.status, 'active');
  assert.equal(loop.report[4].detail.loopClosed, true);

  // 4. The same benign question now escalates: the learned rule reached the
  //    live server, not only the SDK preflight.
  const benignAfter = ask('what is a cat');
  assert.equal(benignAfter.isError, true, 'the learned rule should now refuse the same call');
  assert.match(benignAfter.text, /requires review/);

  // 5. The deterministic tripwire backs AURA's probabilistic verdict.
  assert.equal(loop.canary.tripwire.decision, 'block');
  assert.equal(loop.canary.tripwire.receiptCarriesMarker, false);
});
