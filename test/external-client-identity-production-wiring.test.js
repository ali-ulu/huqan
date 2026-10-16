'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createRouteFixture, routeIdentityAuthority, routeIdentityRuntime } = require('./helpers/external-client-route-fixture');
const { createRouteHarness } = require('./helpers/external-client-route-harness');

function body(fixture) {
  return JSON.stringify(fixture.envelope(fixture.packageValue({ canonical: true })));
}

test('opt-in external-client production caller composes a receiver-owned identity claim', async (t) => {
  const fixture = createRouteFixture(t, { agentIdentityRuntime: routeIdentityRuntime(routeIdentityAuthority()) });
  const harness = await createRouteHarness({ adapter: fixture.adapter });
  t.after(() => harness.close());
  const response = await harness.send({ headers: { 'content-type': 'application/json' }, body: body(fixture) });
  assert.equal(response.statusCode, 201);
  const state = fixture.state();
  assert.equal(state.receipts[0].canonicalPayload.agentId, fixture.IDS.identitySubject);
  assert.equal(Object.hasOwn(state.receipts[0].canonicalPayload.metadata, 'identityRef'), false);
  assert.equal(state.candidates[0].provenance.actor, fixture.IDS.identitySubject);
});

test('opt-in external-client rejects a delegated identity with a missing authority root', async (t) => {
  const owner = 'connector:route-test';
  const agentId = `agent-route-${owner.replace(/[^a-z0-9]+/gi, '-')}`;
  const fixture = createRouteFixture(t, {
    agentIdentityRuntime: routeIdentityRuntime(routeIdentityAuthority(owner, {
      parent_agent_id: 'agent-missing-grandparent',
      delegation_chain: ['agent-missing-grandparent', agentId],
    })),
  });
  const harness = await createRouteHarness({ adapter: fixture.adapter });
  t.after(() => harness.close());
  const response = await harness.send({ headers: { 'content-type': 'application/json' }, body: body(fixture) });
  assert.equal(response.statusCode, 503);
  assert.deepEqual([fixture.state().candidates.length, fixture.state().journals.length, fixture.state().receipts.length], [0, 0, 0]);
});

test('opt-in external-client identity owner drift fails closed before durable mutation', async (t) => {
  const fixture = createRouteFixture(t, {
    agentIdentityRuntime: routeIdentityRuntime(routeIdentityAuthority('different-owner')),
  });
  const harness = await createRouteHarness({ adapter: fixture.adapter });
  t.after(() => harness.close());
  const response = await harness.send({ headers: { 'content-type': 'application/json' }, body: body(fixture) });
  assert.equal(response.statusCode, 503);
  assert.deepEqual([fixture.state().candidates.length, fixture.state().journals.length, fixture.state().receipts.length], [0, 0, 0]);
});
