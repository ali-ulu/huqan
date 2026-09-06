'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { readHtml } = require('./helpers/dashboard-source');
const { validateWorkflowHttpRequest } = require('../lib/http/workflow-request-validation');
const { publicWorkflowManifest } = require('../lib/workflow-contract');

const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'learn-review.js'), 'utf8');

function functionSource(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const open = script.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < script.length; index += 1) {
    if (script[index] === '{') depth += 1;
    if (script[index] === '}') depth -= 1;
    if (depth === 0) return script.slice(start, index + 1);
  }
  throw new Error(`${name} is not balanced`);
}

test('manifest exposes learn-review to the UI only on its review-gated route', () => {
  const item = publicWorkflowManifest().workflows.find(entry => entry.workflowId === 'learn-review');
  assert.ok(item);
  assert.equal(item.route, '/api/v2/workflows/learn');
  assert.equal(item.method, 'POST');
  assert.equal(item.mutation, true);
  assert.equal(item.approvalRequired, true);
  assert.equal(item.availability.ui, true);
});

test('panel offers the learn form and its optional provenance source fields', () => {
  const html = readHtml();
  assert.match(html, /<option value="learn-review">Learn \(review required\)<\/option>/);
  for (const id of ['learnsourcefield', 'learnreffield', 'learntitlefield']) {
    assert.match(html, new RegExp(`id="${id}" hidden`));
  }
  assert.match(html, /<script src="\/js\/learn-review\.js"><\/script>/);
});

test('leaving learn-review restores the generic review action when a prompt exists', () => {
  const elements = {
    action: { value: 'learn-review' },
    learnsourcefield: {}, learnreffield: {}, learntitlefield: {},
    promptlabel: {}, prompt: {}, run: {}, review: { disabled: false },
  };
  const toggle = vm.runInNewContext(`(${functionSource('toggleLearnReviewFields')})`, {
    $: id => elements[id],
    state: { lastPrompt: 'previous successful query' },
    isLearnReviewSelected: () => elements.action.value === 'learn-review',
  });

  toggle();
  assert.equal(elements.review.disabled, true);
  elements.action.value = 'verify';
  toggle();
  assert.equal(elements.review.disabled, false);
});

test('learn form builds the exact bounded request schema and omits blank source fields', () => {
  const elements = {
    learnsource: { value: 'document' },
    learnref: { value: 'doc:42' },
    learntitle: { value: 'Architecture note' },
  };
  const context = { state: { ws: 'workspace-a' }, $: id => elements[id] };
  const build = vm.runInNewContext(`(${functionSource('learnReviewBody')})`, context);
  const body = build('cats are animals');
  assert.deepEqual({ ...body }, {
    workspaceId: 'workspace-a', text: 'cats are animals', sourceType: 'document',
    sourceRef: 'doc:42', sourceTitle: 'Architecture note',
  });
  assert.equal(validateWorkflowHttpRequest('learn-review', body), null);

  for (const field of Object.values(elements)) field.value = '';
  const minimal = build('cats are animals');
  assert.deepEqual({ ...minimal }, { workspaceId: 'workspace-a', text: 'cats are animals' });
  assert.equal(validateWorkflowHttpRequest('learn-review', minimal), null);
});

test('pending projection says learned zero and never presents the proposal as canonical', () => {
  const elements = { result: { innerHTML: '' } };
  let statusText = '';
  const render = vm.runInNewContext(`(${functionSource('renderPendingLearn')})`, {
    $: id => elements[id],
    esc: value => String(value ?? ''),
    status: value => { statusText = value; },
  });
  render({
    status: 'review_required',
    data: { learned: 0, approvalId: 'approval-1', candidateId: 'candidate-1' },
    approval: { id: 'approval-1', persisted: true },
  });

  assert.match(statusText, /^pending human approval/);
  assert.match(elements.result.innerHTML, /learned 0/);
  assert.match(elements.result.innerHTML, /not canonical until a human approves/);
  assert.doesNotMatch(elements.result.innerHTML, />completed</i);
  assert.doesNotMatch(elements.result.innerHTML, />learned</i);
});

test('submission accepts only a persisted review-required response with no canonical learn', () => {
  assert.match(script, /d\.status === 'review_required'/);
  assert.match(script, /d\.data\?\.learned === 0/);
  assert.match(script, /d\.approval\?\.persisted === true/);
  assert.match(script, /addEventListener\('click', submitLearnReview, true\)/);
});
