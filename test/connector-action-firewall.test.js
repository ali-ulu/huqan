'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONNECTOR_ACTION_FIREWALL_VERSION,
  evaluateConnectorAction,
  executeConnectorAction,
  normalizeConnectorAction,
} = require('../lib/connector-action-firewall');

const VALID_REPO = 'https://github.com/owner/repo.git?token=not-stored#fragment';

test('connector firewall normalizes GitHub ingest into the existing AAFW contract', () => {
  const result = evaluateConnectorAction({
    connector: 'github',
    action: 'ingest',
    repoUrl: VALID_REPO,
    branch: 'main',
    workspaceId: 'workspace-connector',
    actor: 'connector-test',
  });

  assert.equal(result.ok, true);
  assert.equal(result.canExecute, true);
  assert.equal(result.decision, 'allow');
  assert.equal(result.connectorFirewallVersion, CONNECTOR_ACTION_FIREWALL_VERSION);
  assert.equal(result.target, 'https://github.com/owner/repo');
  assert.match(result.firewallSummary.metadata.actionId, /^[a-f0-9]{24}$/);
  assert.equal(JSON.stringify(result).includes('token=not-stored'), false);
  assert.equal(JSON.stringify(result).includes('#fragment'), false);
});

test('connector firewall rejects missing, malformed and unknown connector context', () => {
  const missingTarget = normalizeConnectorAction({ connector: 'github', action: 'ingest' });
  assert.equal(missingTarget.ok, false);
  assert.equal(missingTarget.canExecute, false);
  assert.equal(missingTarget.reason, 'CONNECTOR_TARGET_REQUIRED');

  const malformedTarget = normalizeConnectorAction({
    connector: 'github',
    action: 'ingest',
    repoUrl: 'https://example.com/owner/repo',
  });
  assert.equal(malformedTarget.ok, false);
  assert.equal(malformedTarget.canExecute, false);
  assert.equal(malformedTarget.reason, 'CONNECTOR_TARGET_INVALID');

  const unknownAction = evaluateConnectorAction({
    connector: 'github',
    action: 'push',
    repoUrl: 'https://github.com/owner/repo',
  });
  assert.equal(unknownAction.ok, false);
  assert.equal(unknownAction.canExecute, false);
  assert.equal(unknownAction.decision, 'block');
  assert.equal(unknownAction.reason, 'CONNECTOR_ACTION_UNKNOWN');
});

test('connector preview is dry_run_only and cannot invoke executor', async () => {
  let calls = 0;
  const result = await executeConnectorAction({
    request: {
      connector: 'github',
      action: 'ingest',
      repoUrl: 'https://github.com/owner/repo',
      preview: true,
    },
    execute: async () => {
      calls += 1;
      return ['should-not-run'];
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'CONNECTOR_ACTION_FIREWALL_BLOCKED');
  assert.equal(result.decision, 'dry_run_only');
  assert.equal(result.canExecute, false);
  assert.equal(calls, 0);
});

test('missing target prevents direct executor invocation through the wrapper', async () => {
  let calls = 0;
  const result = await executeConnectorAction({
    request: { connector: 'github', action: 'ingest' },
    execute: async () => {
      calls += 1;
      return ['bypass'];
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'CONNECTOR_ACTION_FIREWALL_BLOCKED');
  assert.equal(result.reason, 'CONNECTOR_TARGET_REQUIRED');
  assert.equal(calls, 0);
});

test('allowed connector action invokes executor exactly once with bounded decision', async () => {
  let calls = 0;
  const result = await executeConnectorAction({
    request: {
      connector: 'github',
      action: 'ingest',
      repoUrl: 'https://github.com/owner/repo',
    },
    execute: async decision => {
      calls += 1;
      assert.equal(decision.target, 'https://github.com/owner/repo');
      assert.equal(typeof decision.firewallSummary.metadata.actionId, 'string');
      return ['file'];
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.decision, 'allow');
  assert.deepEqual(result.value, ['file']);
  assert.equal(calls, 1);
});
