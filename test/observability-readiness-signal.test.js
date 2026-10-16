'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createObservabilityServerRuntime } = require('../lib/observability/server-runtime');
const { createRuntimeStatusHandlers } = require('../lib/http/runtime-status');

function runtimeWithPolicy(policy) {
  return createObservabilityServerRuntime({
    getStorage: () => ({}),
    createAgent: () => ({}),
    getService: () => ({}),
    getHealth: () => ({ inspect: () => ({}) }),
    parseJsonRequest: async () => null,
    writeJson: () => {},
    denyIfUnauthorized: () => true,
    readEnvironment: suffix => ({ OBSERVABILITY_AUTHZ_POLICY: policy })[suffix],
  });
}

test('authorization readiness reports whether the policy is configured, never its content', () => {
  assert.equal(runtimeWithPolicy(undefined).getAuthorizationReadiness().configured, false);
  assert.equal(runtimeWithPolicy('').getAuthorizationReadiness().configured, false);
  assert.equal(runtimeWithPolicy('   ').getAuthorizationReadiness().configured, false);
  const configured = runtimeWithPolicy(JSON.stringify({ memberships: [{ subject: 's', workspaceId: 'default', role: 'viewer' }] }));
  assert.equal(configured.getAuthorizationReadiness().configured, true);
});

test('authorization readiness stays fail-closed when reading the policy throws', () => {
  const runtime = createObservabilityServerRuntime({
    getStorage: () => ({}),
    createAgent: () => ({}),
    getService: () => ({}),
    getHealth: () => ({ inspect: () => ({}) }),
    parseJsonRequest: async () => null,
    writeJson: () => {},
    denyIfUnauthorized: () => true,
    readEnvironment: () => {
      throw new Error('environment validation failed');
    },
  });
  assert.deepEqual(runtime.getAuthorizationReadiness(), { configured: false });
});

function statusHandlers(observabilityReadiness) {
  const kernel = {
    contractVersion: '1.0.0',
    graph: { getStats: () => ({ backend: 'memory', nodes: 0, edges: 0 }) },
  };
  return createRuntimeStatusHandlers({
    kernel,
    pkg: { version: '0.0.0-test' },
    kernelVersion: 'v2',
    agentVersion: 'v3',
    agentRuntimeMode: 'v3',
    phases: [{ id: 'p1', status: 'done' }],
    observabilityReadiness,
  });
}

test('v2-status carries the observability readiness field when the runtime wires it', () => {
  const wired = statusHandlers(() => ({ configured: true })).getV2StatusData();
  assert.deepEqual(wired.observability, { configured: true });

  const unconfigured = statusHandlers(() => ({ configured: false })).getV2StatusData();
  assert.deepEqual(unconfigured.observability, { configured: false });

  // Not wired (e.g. a host that never builds the observability runtime): the
  // field must not claim either state.
  const unwired = statusHandlers(undefined).getV2StatusData();
  assert.deepEqual(unwired.observability, { configured: null });
});

test('the shipped readiness payload can only carry the configured boolean', () => {
  const runtime = runtimeWithPolicy(JSON.stringify({ memberships: [{ subject: 's', workspaceId: 'default', role: 'viewer' }] }));
  const readiness = runtime.getAuthorizationReadiness();
  assert.deepEqual(Object.keys(readiness), ['configured']);
  assert.equal(readiness.configured, true);
});