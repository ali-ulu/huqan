'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createObservabilityAuthorizer, parsePolicy } = require('./authorization');

const POLICY = JSON.stringify({ memberships: [
  { subject: 'alice', workspaceId: 'ws-a', role: 'viewer' },
  { subject: 'operator', workspaceId: 'ws-a', role: 'operator' },
  { subject: 'admin', workspaceId: 'ws-b', role: 'admin' },
] });

test('authorization requires an exact principal membership and role permission', () => {
  const auth = createObservabilityAuthorizer({ policy: POLICY });
  assert.equal(auth.authorize({ principal: { subject: 'alice' }, workspaceId: 'ws-a', permission: 'read' }).allowed, true);
  assert.equal(auth.authorize({ principal: { subject: 'alice' }, workspaceId: 'ws-b', permission: 'read' }).code, 'OBSERVABILITY_WORKSPACE_FORBIDDEN');
  assert.equal(auth.authorize({ principal: { subject: 'alice' }, workspaceId: 'ws-a', permission: 'queue:write' }).code, 'OBSERVABILITY_PERMISSION_FORBIDDEN');
  assert.equal(auth.authorize({ principal: { subject: 'operator' }, workspaceId: 'ws-a', permission: 'queue:write' }).allowed, true);
  assert.equal(auth.authorize({ principal: { subject: 'admin' }, workspaceId: 'ws-b', permission: 'alerts:write' }).allowed, true);
  assert.equal(auth.authorize({ workspaceId: 'ws-a', permission: 'read' }).code, 'OBSERVABILITY_PRINCIPAL_REQUIRED');
});

test('authorization policy rejects ambiguity, wildcards and malformed roles', () => {
  for (const policy of [
    '',
    '{}',
    JSON.stringify({ memberships: [{ subject: '*', workspaceId: 'ws', role: 'admin' }] }),
    JSON.stringify({ memberships: [{ subject: 'a', workspaceId: '*', role: 'admin' }] }),
    JSON.stringify({ memberships: [{ subject: 'a', workspaceId: 'ws', role: 'owner' }] }),
    JSON.stringify({ memberships: [
      { subject: 'a', workspaceId: 'ws', role: 'viewer' },
      { subject: 'a', workspaceId: 'ws', role: 'admin' },
    ] }),
  ]) assert.throws(() => parsePolicy(policy), { code: 'OBSERVABILITY_AUTHZ_POLICY_INVALID' });
});
