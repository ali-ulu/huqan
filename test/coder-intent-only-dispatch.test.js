'use strict';

// #3310 B4 §11: an intent-only learned dispatch names the target but not the
// text. The text comes from candidate params and stays bound to the sealed
// source hashes; every other shape is refused before the target changes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { applyDerivation } = require('../lib/coder/apply-derivation');
const { openCoderJournal } = require('../lib/coder/journal-store');
const { budgetExperienceJournal } = require('../lib/experience/budgeted-journal');

const REPO_STATE = { branch: 'feat/test', dirty: false, hasUntracked: false };
const SOURCE_TASK = { id: 'intent', level: 'l0', allowedPaths: ['docs/a.md'],
  operation: { type: 'replace_text', path: 'docs/a.md', find: 'before', replace: 'after' } };
const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const PARAMS = { path: 'docs/a.md', oldText: 'before', newText: 'after' };

function openJournal(root) {
  const store = openCoderJournal(path.join(root, 'journal.db'));
  let clock = 0;
  return { ...store, journal: budgetExperienceJournal(store.journal, { now: () => (clock += 0.1) }) };
}

function withSource(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-intent-only-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'));
  for (const [name, content] of [['a.md', 'before'], ['b.md', 'before'], ['drift.md', 'absent'],
    ['ambiguous.md', 'before before']]) fs.writeFileSync(path.join(root, 'docs', name), content);
  const store = openJournal(root);
  try {
    assert.equal(applyDerivation({ task: SOURCE_TASK, root, repoState: REPO_STATE, journal: store.journal,
      runId: 'source' }).ok, true);
  } finally { store.close(); }
  fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
  return root;
}

function intentTask(target = 'docs/a.md', experience = {}, operation = {}) {
  return { id: 'intent', level: 'l0', allowedPaths: [target],
    operation: { type: 'replace_text', path: target, ...operation },
    experience: { intentOnly: true, riskTier: 'low', candidates: [{ capabilityId: 'replace',
      sourceRunIds: ['source'], params: { ...PARAMS, path: target },
      qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'] }], ...experience } };
}

function dispatch(root, task, runId = 'intent-run') {
  const store = openJournal(root);
  try {
    const result = applyDerivation({ task, root, repoState: REPO_STATE, journal: store.journal, runId });
    return { result, target: fs.readFileSync(path.join(root, task.operation.path), 'utf8'),
      events: store.journal.read(runId) };
  } finally { store.close(); }
}

function assertRefused(observed, reason) {
  assert.equal(observed.result.ok, false);
  assert.equal(observed.result.reason, reason);
  assert.equal(observed.target, 'before', 'a refused intent-only dispatch must not touch the target');
}

test('an intent-only task applies the sealed procedure text to its target', (t) => {
  const root = withSource(t);
  const observed = dispatch(root, intentTask());
  assert.equal(observed.result.ok, true);
  assert.equal(observed.target, 'after');
  const routed = observed.events.find(event => event.type === 'routing_decided');
  assert.ok(routed, 'the learned route is recorded');
  assert.equal(routed.payload.execution.findSha256, sha256('before'));
  assert.equal(routed.payload.execution.replaceSha256, sha256('after'));
  const proposed = observed.events.find(event => event.type === 'action_proposed');
  assert.equal(proposed.payload.findSha256, null, 'the task itself carried no text');
});

test('without intentOnly a learned task still needs its own text', (t) => {
  const root = withSource(t);
  assertRefused(dispatch(root, intentTask('docs/a.md', { intentOnly: undefined })), 'invalid_experience_operation');
});

test('a non-boolean intentOnly is an invalid dispatch', (t) => {
  const root = withSource(t);
  assertRefused(dispatch(root, intentTask('docs/a.md', { intentOnly: 'yes' })), 'invalid_experience_dispatch');
});

test('intent-only refuses a task that also carries its own text', (t) => {
  const root = withSource(t);
  assertRefused(dispatch(root, intentTask('docs/a.md', {}, { find: 'before', replace: 'after' })),
    'invalid_experience_operation');
});

test('intent-only refuses a candidate without params', (t) => {
  const root = withSource(t);
  const task = intentTask();
  task.experience.candidates = [{ ...task.experience.candidates[0], params: undefined }];
  assertRefused(dispatch(root, task), 'invalid_experience_operation');
});

test('intent-only refuses a structural fallback it has no task text for', (t) => {
  const root = withSource(t);
  assertRefused(dispatch(root, intentTask('docs/a.md', { fallbackOnRefusal: true })), 'invalid_experience_operation');
});

test('intent-only params whose text does not match the sealed source hashes are refused', (t) => {
  const root = withSource(t);
  const task = intentTask();
  task.experience.candidates[0].params = { ...PARAMS, newText: 'forged' };
  assertRefused(dispatch(root, task), 'source_procedure_mismatch');
});

test('intent-only does not transfer a path-bound procedure to another path', (t) => {
  const root = withSource(t);
  assertRefused(dispatch(root, intentTask('docs/b.md')), 'source_procedure_mismatch');
});

test('the no-experience baseline cannot act on an intent-only task', (t) => {
  const root = withSource(t);
  const task = intentTask();
  delete task.experience;
  const observed = dispatch(root, task);
  assert.equal(observed.result.ok, false);
  assert.equal(observed.target, 'before');
});
