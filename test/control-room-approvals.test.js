'use strict';

// Control Room approvals: plain-language cards, one approval record behind
// every count, deduplicated system errors, and no developer notes or key
// fields on the main screen.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { describeApproval, agentName } = require('../public/control-room/js/control-room-approvals');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const learnRow = {
  id: 'approval-1',
  tool: 'huqan.learn',
  input: JSON.stringify({ text: 'Raw input text', provenance: { actor: 'claude-code' } }),
  reason: 'mutating_requires_review',
  createdAt: Date.now(),
  policy: { gate: { reason: 'mutating_requires_review' } },
  context: {
    args: { text: 'Raw input text', provenance: { actor: 'claude-code' } },
    candidate: { claim: 'Deploys go out on Fridays.', provenance: { actor: 'claude-code' } },
    provenance: { actor: 'claude-code' },
  },
};

test('an approval card reads as a sentence about the agent and what it wants', () => {
  const d = describeApproval(learnRow);
  assert.equal(d.sentence, 'Claude Code wants to save to memory: “Deploys go out on Fridays.”');
  assert.equal(d.title, 'Remember: Deploys go out on Fridays.');
  assert.equal(d.agent, 'Claude Code');
  assert.equal(d.evidence, 1);
  assert.equal(d.policyId, 'mutating_requires_review');
  assert.match(d.policyText, /waits for a person/);
  assert.doesNotMatch(d.sentence, /[{}"]input|huqan\.learn/, 'no raw JSON or tool id in the sentence');
});

test('unknown tools and agents still read as plain language', () => {
  const d = describeApproval({ tool: 'acme.thing', input: '{}', context: { agentId: 'research-crew' } });
  assert.equal(d.sentence, 'research-crew wants to run an action that needs a person.');
  assert.equal(d.policyText, 'Policy requires a person for this action.');
  assert.equal(agentName('codex'), 'Codex');
  assert.equal(agentName(''), 'An agent');
});

test('approve and reject use an in-page dialog, never window.prompt', () => {
  const approvals = read('public/control-room/js/control-room-approvals.js');
  const html = read('public/control-room/index.html');
  assert.doesNotMatch(approvals, /window\.prompt|\bprompt\(/);
  assert.match(html, /id="decide-dialog"[^>]*role="dialog"/);
  assert.match(html, /id="dd-reason"/);
  // Raw request JSON appears only inside the Details drawer.
  assert.match(approvals, /<details class="raw">/);
  assert.match(approvals, /\$\('#drawer pre'\)\.textContent = JSON\.stringify/);
});

test('decisions go through a one-use operator grant', () => {
  const data = read('public/control-room/js/control-room-data.js');
  assert.match(data, /\/api\/v2\/operator\/capabilities/);
  assert.match(data, /'x-huqan-operator-capability': String\(capability/);
  assert.doesNotMatch(data, /sessionStorage\.setItem\([^)]*operator/i, 'the operator key is never stored');
  assert.doesNotMatch(data, /localStorage\.setItem\([^)]*operator/i, 'the operator key is never stored');
});

test('the main screen carries no key fields and no developer notes', () => {
  const html = read('public/control-room/index.html');
  const overview = html.slice(html.indexOf('data-view="overview"'), html.indexOf('data-view="activity"'));
  assert.doesNotMatch(overview, /<input/, 'no input on the Overview');
  for (const note of [/does not yet expose/i, /no agent registry/i, /Three live outcomes/i, /authenticated activity read/i, /live receipt endpoint/i]) {
    assert.doesNotMatch(html, note);
  }
  assert.match(html, /id="setup-line"/);
  assert.match(html, /id="first-run"[^>]*hidden/, 'setup steps stay folded under the one-line summary');
});

test('First run "Connect" only opens the key form when the server asks for a key', () => {
  const overview = read('public/control-room/js/control-room-overview.js');
  const listener = overview.slice(overview.indexOf("$('#first-run-connect')?.addEventListener"));
  assert.match(listener.slice(0, 400), /Data\.authRequired\(\) !== true/);
});

function loadDataLayer(fetchImpl) {
  const events = [];
  const window = {
    dispatchEvent: (e) => events.push(e),
  };
  const context = vm.createContext({
    window,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: fetchImpl || (async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: { code: 'X_DOWN', message: 'down' } }) })),
    URLSearchParams,
  });
  vm.runInContext(read('public/control-room/js/control-room-data.js'), context);
  return { Data: window.HuqanControlRoomData, events };
}

test('a repeating failure is one Errors row with a count', async () => {
  const { Data } = loadDataLayer();
  await Data.getJson('/api/observability/events?limit=1');
  await Data.getJson('/api/observability/events?limit=2');
  await Data.getJson('/api/observability/events?cursor=a');
  await Data.getJson('/api/workbench/activity');
  const errors = Data.systemErrors();
  assert.equal(errors.length, 2);
  const obs = errors.find((e) => e.path === '/api/observability/events');
  assert.equal(obs.count, 3);
  assert.equal(obs.code, 'X_DOWN');
});

test('the waiting count has one source: the approval queue', async () => {
  const { Data, events } = loadDataLayer();
  const overview = read('public/control-room/js/control-room-overview.js');
  assert.match(overview, /review: openReviewCount/, 'the "Waiting for review" bucket is the open queue');
  assert.match(overview, /huqan:approvals-changed/);
  assert.equal(Data.approvalQueue().approvals.length, 0);
  assert.ok(Array.isArray(events));
});

test('a refused grant reports needsOperator exactly when no key went out', async () => {
  const { Data } = loadDataLayer(async () => ({
    ok: false,
    status: 403,
    json: async () => ({ ok: false, error: { code: 'OPERATOR_AUTH_REQUIRED', message: 'needed' } }),
  }));
  const withoutKey = await Data.decideApproval('approval-1', 'approved', '');
  assert.equal(withoutKey.ok, false);
  assert.equal(withoutKey.needsOperator, true, 'the decision can be retried with a key');

  const withKey = await Data.decideApproval('approval-1', 'approved', '', { operatorKey: 'typed-key' });
  assert.equal(withKey.ok, false);
  assert.equal(withKey.needsOperator, false, 'a refused key is not retried through the key field');
});

test('the automatic-approval fallback dialog offers the key field again', () => {
  const approvals = read('public/control-room/js/control-room-approvals.js');
  assert.match(approvals, /forceKey = false/);
  assert.match(approvals, /askKey = forceKey \|\| purpose === 'enable-auto' \|\| !grant\.autoActive/);
  assert.match(approvals, /forceKey: result\.needsOperator === true/, 'the failed auto attempt passes decideApproval needsOperator through');
});
