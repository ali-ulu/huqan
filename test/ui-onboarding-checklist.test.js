'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { readHtml } = require('./helpers/dashboard-source');
const { listStaticAssetPaths, isStaticAssetPath } = require('../lib/http/static-assets');
const { listPublicRouteIds, isPublicRoute } = require('../lib/http/route-auth-policy');

const SCRIPT = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'onboarding-checklist.js'),
  'utf8',
);

const ELEMENT_IDS = [
  'onboard', 'onboardreopenwrap', 'onboardsteps', 'onboardprogress',
  'onboardskip', 'onboardreset', 'onboardreopen', 'homehero',
  'save', 'run', 'eload', 'sstatus', 'vstatus', 'estatus',
];

/**
 * The repository carries no browser or DOM dependency, so the checklist is
 * driven against a hand-built document that implements exactly the surface the
 * module touches. Every assertion below therefore exercises the real module --
 * its storage reads, its rendering, and its wrappers -- rather than matching
 * its source text.
 */
function makeNode(id = '') {
  const node = {
    id,
    className: '',
    hidden: false,
    disabled: false,
    type: '',
    dataset: {},
    children: [],
    listeners: {},
    onclick: null,
    attributes: {},
    append(...nodes) { this.children.push(...nodes); },
    after() { /* placement only; ordering is not what these tests assert */ },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(event, handler) { (this.listeners[event] ||= []).push(handler); },
  };
  // A browser drops every child when textContent is assigned. Modelling that
  // is what makes "the list re-renders" a real assertion instead of one that
  // silently counts stale rows from earlier renders.
  let text = '';
  Object.defineProperty(node, 'textContent', {
    get() { return text; },
    set(value) { text = String(value); node.children = []; },
    enumerable: true,
  });
  return node;
}

function makeHarness({ stored = null, throwOnStorage = false, outcomes = [] } = {}) {
  const nodes = new Map(ELEMENT_IDS.map(id => [id, makeNode(id)]));
  const store = new Map();
  if (stored !== null) store.set('huqan-onboarding', stored);

  const localStorage = {
    getItem(key) {
      if (throwOnStorage) throw new Error('storage disabled');
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      if (throwOnStorage) throw new Error('storage disabled');
      store.set(key, value);
    },
  };

  const navigated = [];
  const calls = [];
  const context = {
    document: {
      getElementById: id => nodes.get(id) || null,
      createElement: () => makeNode(),
    },
    window: {
      localStorage,
      go: view => navigated.push(view),
      save: async () => { calls.push('save'); },
      run: async () => { calls.push('run'); },
      loadReceipt: async () => { calls.push('loadReceipt'); },
    },
  };
  context.window.window = context.window;

  // The module captures each handler when it wraps the button, so an outcome
  // has to be installed before the script runs -- exactly as app.js defines
  // these handlers before the checklist script is loaded.
  for (const [handlerName, statusId, outcome] of outcomes) {
    context.window[handlerName] = async () => {
      calls.push(handlerName);
      nodes.get(statusId).className = `status ${outcome}`;
    };
  }

  vm.runInNewContext(SCRIPT, context);

  async function click(id) {
    const node = nodes.get(id);
    if (node.onclick) return node.onclick({});
    for (const handler of node.listeners.click || []) await handler({});
    return undefined;
  }

  const steps = () => nodes.get('onboardsteps').children;

  return {
    nodes, store, navigated, calls, click, steps,
    saved: () => JSON.parse(store.get('huqan-onboarding')),
    progressText: () => nodes.get('onboardprogress').textContent,
    visible: () => !nodes.get('onboard').hidden,
    reopenVisible: () => !nodes.get('onboardreopenwrap').hidden,
  };
}

test('the dashboard ships the checklist markup and loads its script', () => {
  const html = readHtml();
  assert.match(html, /<script src="\/js\/onboarding-checklist\.js"><\/script>/);
  assert.match(html, /id="onboard"[^>]*hidden/);
  for (const id of ['onboardsteps', 'onboardprogress', 'onboardskip', 'onboardreset', 'onboardreopen']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} must exist in the dashboard`);
  }
});

test('the checklist script is served and reachable without an API key', () => {
  assert.ok(
    listStaticAssetPaths().includes('/js/onboarding-checklist.js'),
    'the script must be a served asset, not only a file on disk',
  );
  assert.equal(isStaticAssetPath('/js/onboarding-checklist.js'), true);
  assert.ok(
    listPublicRouteIds().includes('dashboard-onboarding-script'),
    'the public dashboard cannot load a script the auth policy withholds',
  );
  assert.equal(isPublicRoute('/js/onboarding-checklist.js', 'GET'), true);
});

test('first run shows every step with the first one queued and nothing completed', () => {
  const harness = makeHarness();

  assert.equal(harness.visible(), true);
  assert.equal(harness.reopenVisible(), false);
  assert.equal(harness.progressText(), '0 of 3 done');

  const states = harness.steps().map(step => step.dataset.state);
  assert.deepEqual(states, ['next', 'todo', 'todo']);
  assert.deepEqual(harness.steps().map(step => step.dataset.step), ['session', 'read', 'evidence']);
});

test('a step advances the user to the view that completes it', async () => {
  const harness = makeHarness();
  const [session, read, evidence] = harness.steps();

  for (const step of [session, read, evidence]) {
    const button = step.children[step.children.length - 1];
    for (const handler of button.listeners.click || []) handler({});
  }

  assert.deepEqual(harness.navigated, ['settings', 'verify', 'evidence']);
});

test('an action that fails leaves its step open', async () => {
  const harness = makeHarness({ outcomes: [['run', 'vstatus', 'bad']] });

  await harness.click('run');

  assert.deepEqual(harness.calls, ['run'], 'the real handler still runs');
  assert.equal(harness.progressText(), '0 of 3 done');
  assert.equal(harness.steps()[1].dataset.state, 'todo');
  assert.equal(harness.store.has('huqan-onboarding'), false);
});

test('an action that succeeds completes its step and still runs the original handler', async () => {
  const harness = makeHarness({ outcomes: [['run', 'vstatus', 'good']] });
  assert.equal(
    typeof harness.nodes.get('run').onclick,
    'function',
    'app.js binds run via onclick, so the wrapper must replace it',
  );

  await harness.click('run');

  assert.deepEqual(harness.calls, ['run']);
  assert.equal(harness.progressText(), '1 of 3 done');
  assert.equal(harness.steps()[1].dataset.state, 'done');
});

test('completing every step from real successes hides the card and offers a reopen', async () => {
  const harness = makeHarness({
    outcomes: [
      ['save', 'sstatus', 'good'],
      ['run', 'vstatus', 'good'],
      ['loadReceipt', 'estatus', 'good'],
    ],
  });

  await harness.click('save');
  await harness.click('run');
  await harness.click('eload');

  assert.equal(harness.progressText(), '3 of 3 done');
  assert.equal(harness.visible(), false, 'the checklist disappears once it is complete');
  assert.equal(harness.reopenVisible(), true, 'a completed checklist stays reopenable');
  assert.deepEqual(harness.saved().done, ['session', 'read', 'evidence']);
});

test('reopening a completed checklist shows it again without losing progress', async () => {
  const harness = makeHarness({
    stored: JSON.stringify({ version: 1, done: ['session', 'read', 'evidence'], dismissed: false }),
  });
  assert.equal(harness.visible(), false);

  await harness.click('onboardreopen');

  assert.equal(harness.visible(), true);
  assert.equal(harness.reopenVisible(), false);
  assert.equal(harness.progressText(), '3 of 3 done');
  assert.deepEqual(harness.steps().map(step => step.dataset.state), ['done', 'done', 'done']);
});

test('reset clears progress and starts the checklist over', async () => {
  const harness = makeHarness({
    stored: JSON.stringify({ version: 1, done: ['session', 'read'], dismissed: false }),
  });
  assert.equal(harness.progressText(), '2 of 3 done');

  await harness.click('onboardreset');

  assert.equal(harness.progressText(), '0 of 3 done');
  assert.equal(harness.visible(), true);
  assert.deepEqual(harness.saved().done, []);
  assert.equal(harness.saved().dismissed, false);
  assert.deepEqual(harness.steps().map(step => step.dataset.state), ['next', 'todo', 'todo']);
});

test('skip hides the checklist and a returning user is not blocked by it', async () => {
  const harness = makeHarness();
  await harness.click('onboardskip');

  assert.equal(harness.visible(), false);
  assert.equal(harness.reopenVisible(), true);
  assert.equal(harness.saved().dismissed, true);

  const returning = makeHarness({ stored: harness.store.get('huqan-onboarding') });
  assert.equal(returning.visible(), false, 'a skipped checklist stays closed on the next visit');
  assert.equal(returning.reopenVisible(), true);
});

test('stored progress records step ids only, never session material', async () => {
  const harness = makeHarness({ outcomes: [['save', 'sstatus', 'good']] });
  await harness.click('save');

  const raw = harness.store.get('huqan-onboarding');
  assert.deepEqual(Object.keys(harness.saved()).sort(), ['dismissed', 'done', 'version']);
  assert.deepEqual(harness.saved().done, ['session']);
  for (const forbidden of ['key', 'Bearer', 'workspace', 'token', 'receipt']) {
    assert.doesNotMatch(raw, new RegExp(forbidden, 'i'), `progress must not carry ${forbidden}`);
  }
});

test('corrupt or hostile stored progress degrades to a clean first run', () => {
  for (const stored of ['not json', 'null', '"a string"', '{"done":"session"}', '[]']) {
    const harness = makeHarness({ stored });
    assert.equal(harness.progressText(), '0 of 3 done', `stored ${stored} must not be trusted`);
    assert.equal(harness.visible(), true);
  }

  const forged = makeHarness({ stored: JSON.stringify({ done: ['session', 'admin', '__proto__'] }) });
  assert.equal(forged.progressText(), '1 of 3 done', 'unknown step ids are discarded');
  assert.deepEqual(forged.steps().map(step => step.dataset.state), ['done', 'next', 'todo']);
});

test('a browser that refuses storage still renders a usable checklist', async () => {
  const harness = makeHarness({ throwOnStorage: true });

  assert.equal(harness.visible(), true);
  assert.equal(harness.progressText(), '0 of 3 done');
  await assert.doesNotReject(() => harness.click('onboardskip'));
});
