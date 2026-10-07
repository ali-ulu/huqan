'use strict';

/**
 * Characterization for #3487: the observer (delegation audit) is fail-open,
 * and a refusal is not reopened by retrying.
 *
 * The two are pinned together because they are one boundary seen from two
 * sides. The audit trail records a decision; it must never make one. So a dead
 * audit sink changes neither an admission nor a refusal, and a refused caller
 * who retries gets the same refusal rather than a path around it. Neither case
 * adds a default-deny to the observer.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildFixture } = require('../scripts/a2a-conformance/run.js');
const {
  CANONICAL_WORKSPACE,
  constructA2aBoundaryDependencies,
} = require('../lib/a2a/exchange-route');
const { createA2aExchangeHandler } = require('../lib/a2a/exchange-route-handler');
const {
  DELEGATION_OUTCOMES,
  createA2aDelegationAuditLog,
} = require('../lib/a2a/delegation-audit-log');

function makeHandler({ deadAudit }) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-a2a-observer-'));
  const replayDirectory = path.join(root, 'replay');
  const auditDirectory = path.join(root, 'audit');
  fs.mkdirSync(replayDirectory);
  fs.mkdirSync(auditDirectory);
  const fixture = buildFixture(CANONICAL_WORKSPACE);
  const authorityFile = path.join(root, 'authority.json');
  fs.writeFileSync(authorityFile, JSON.stringify(fixture.authority), 'utf8');

  const dependencies = constructA2aBoundaryDependencies({ authorityFile, replayDirectory });
  assert.ok(dependencies, 'the boundary dependencies must construct for this sandbox');

  // The same composition the route uses, with the audit log pointed at its own
  // directory so it can be taken away without touching the replay store.
  const audit = createA2aDelegationAuditLog(auditDirectory);
  if (deadAudit) fs.rmSync(auditDirectory, { recursive: true, force: true });
  const recordDelegation = (request, decision, reason, taskId) => audit.append({
    request,
    outcome: decision === 'allow' ? DELEGATION_OUTCOMES.ADMITTED : DELEGATION_OUTCOMES.REFUSED,
    decision,
    reason,
    taskId,
  });
  const handle = createA2aExchangeHandler({ ...dependencies, recordDelegation });
  const send = (body) => handle({ method: 'POST' }, async () => ({ ok: true, data: body }));
  return { send, audit, fixture };
}

function tamper(request) {
  const copy = JSON.parse(JSON.stringify(request));
  copy.requestedAction.capability = `${copy.requestedAction.capability}-tampered`;
  return copy;
}

test('a dead audit sink does not refuse an admissible exchange', async () => {
  const { send, audit, fixture } = makeHandler({ deadAudit: true });

  const response = await send(fixture.request);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.decision, 'allow');
  assert.equal(audit.read().entries.length, 0, 'the trail is incomplete, and says so by being empty');
});

test('a dead audit sink does not admit a refused exchange', async () => {
  const { send, fixture } = makeHandler({ deadAudit: true });

  const response = await send(tamper(fixture.request));

  assert.notEqual(response.statusCode, 200);
  assert.notEqual(response.body.decision, 'allow');
});

test('the same decisions are reached with a working audit sink', async () => {
  const { send, audit, fixture } = makeHandler({ deadAudit: false });

  const refused = await send(tamper(fixture.request));
  const admitted = await send(fixture.request);

  assert.notEqual(refused.statusCode, 200);
  assert.equal(admitted.statusCode, 200);
  assert.deepEqual(
    audit.read().entries.map((entry) => entry.outcome),
    [DELEGATION_OUTCOMES.REFUSED, DELEGATION_OUTCOMES.ADMITTED],
  );
});

test('retrying a refused exchange gets the same refusal every time', async () => {
  const { send, audit, fixture } = makeHandler({ deadAudit: false });
  const tampered = tamper(fixture.request);

  const first = await send(tampered);
  const second = await send(tampered);
  const third = await send(tampered);

  for (const response of [first, second, third]) {
    assert.notEqual(response.statusCode, 200);
    assert.notEqual(response.body.decision, 'allow');
  }
  assert.deepEqual(second.body.reason, first.body.reason);
  assert.deepEqual(third.body.reason, first.body.reason);
  // Each retry is its own observed refusal rather than being collapsed.
  assert.equal(audit.read().entries.length, 3);
});

test('a refusal does not consume the reservation of the genuine exchange, and a genuine replay is still refused', async () => {
  const { send, fixture } = makeHandler({ deadAudit: false });

  await send(tamper(fixture.request));
  const admitted = await send(fixture.request);
  const replayed = await send(fixture.request);

  assert.equal(admitted.statusCode, 200);
  assert.notEqual(replayed.statusCode, 200);
  assert.notEqual(replayed.body.decision, 'allow');
});
