'use strict';

// #4065 PR-2: an approved Coder case runs through the production createAgent,
// exactly once, and only with the scope the operator approved.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { httpCoderFixture } = require('./helpers/http-coder-fixture');

const stepStatus = response => response.body.data?.steps?.[0]?.status;
// A refused Coder step never reaches the executor: the action firewall sees no
// matching approval and holds it for review, and the target stays empty.
function assertHeld(response, target) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(stepStatus(response), 'blocked', JSON.stringify(response.body.data?.steps));
  assert.equal(response.body.data.steps[0].error, 'AGENT_ACTION_REVIEW_REQUIRED');
  assert.deepEqual(fs.readdirSync(target), []);
}

test('an approved case creates the project once through the production agent', async t => {
  const f = httpCoderFixture(t);
  const approved = await f.approvedCase();
  const target = approved.task.operation.targetRoot;
  const ran = await f.run([approved]);
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  assert.equal(ran.body.data.steps[0].id, 'coder:project');
  assert.equal(stepStatus(ran), 'done', JSON.stringify(ran.body.data.steps));
  assert.ok(fs.readdirSync(target).length > 0, 'the project was written');
  assert.equal(fs.readFileSync(path.join(f.source, 'seed.txt'), 'utf8'), 'source', 'the source repository is untouched');
  // Empty the target again so only the single-use reservation can refuse.
  fs.rmSync(target, { recursive: true, force: true }); fs.mkdirSync(target);
  assertHeld(await f.run([approved]), target);
});

test('an unapproved or rejected case never executes', async t => {
  const f = httpCoderFixture(t);
  const task = f.task();
  const pending = (await f.open({ task })).body.data.caseId;
  assertHeld(await f.run([{ caseId: pending, root: f.source, task }]), task.operation.targetRoot);
  const rejectedTask = f.task('rejected');
  const rejected = (await f.open({ task: rejectedTask })).body.data.caseId;
  assert.equal((await f.decide(rejected, 'rejected', 'not this one')).status, 200);
  assertHeld(await f.run([{ caseId: rejected, root: f.source, task: rejectedTask }]), rejectedTask.operation.targetRoot);
});

test('a resent task that differs from the approved one is refused', async t => {
  const f = httpCoderFixture(t);
  const approved = await f.approvedCase();
  const changed = structuredClone(approved.task);
  changed.operation.spec.routes[0].path = '/triple';
  assertHeld(await f.run([{ ...approved, task: changed }]), approved.task.operation.targetRoot);
});

test('a repository that moved after approval blocks the run', async t => {
  const f = httpCoderFixture(t);
  const approved = await f.approvedCase();
  fs.writeFileSync(path.join(f.source, 'seed.txt'), 'moved'); f.git('add', 'seed.txt');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'moved');
  assertHeld(await f.run([approved]), approved.task.operation.targetRoot);
});

test('a runtime without a Coder executor and malformed run requests fail closed', async t => {
  const workflow = httpCoderFixture(t, { createAgent: () => ({ runtime: 'workflow', run: async () => ({ ok: true }), storage: null }) });
  const refused = await workflow.run([await workflow.approvedCase()]);
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'CODER_RUNTIME_UNAVAILABLE');
  const f = httpCoderFixture(t);
  assert.equal((await f.run([])).status, 400);
  const five = await f.run(Array.from({ length: 5 }, (_, i) => ({ caseId: `c${i}`, root: f.source, task: f.task(`t${i}`) })));
  assert.equal(five.status, 400);
  assert.match(five.body.error.message, /1-4 runs/);
  assert.equal((await f.run([{ caseId: 'x', root: f.dir, task: f.task() }])).status, 403);
});

test('an oversight runtime that cannot authorize execution is refused before any run', async t => {
  const f = httpCoderFixture(t);
  const approved = await f.approvedCase();
  const partial = httpCoderFixture(t, { runtimeOverride: runtime => ({ ...runtime, authorizeExecution: undefined }) });
  const refused = await partial.run([approved]);
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'CODER_OVERSIGHT_UNCONFIGURED');
  assert.equal(f.runtime.getReviewCase(approved.caseId).case.status, 'approved');
});
