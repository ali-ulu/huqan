'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONNECTOR_ACTION_FIREWALL_VERSION,
  CONNECTOR_ACTIONS,
  evaluateConnectorAction,
  executeConnectorAction,
  normalizeConnectorAction,
} = require('../lib/connector-action-firewall');

const VALID_REPO = 'https://github.com/owner/repo.git?token=not-stored#fragment';

test('every registered connector action declares bounded budget and egress policy', () => {
  for (const actions of Object.values(CONNECTOR_ACTIONS)) {
    for (const contract of Object.values(actions)) {
      assert.equal(typeof contract.egressClass, 'string');
      assert.ok(contract.egressClass.length > 0);
      assert.equal(Number.isInteger(contract.budget.maxTargets), true);
      assert.equal(Number.isFinite(contract.budget.costPerTarget), true);
      assert.equal(Number.isFinite(contract.budget.maxCostUnits), true);
      assert.ok(contract.budget.maxTargets > 0);
      assert.ok(contract.budget.costPerTarget > 0);
      assert.ok(contract.budget.maxCostUnits > 0);
    }
  }
});

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
  assert.equal(result.egressClass, 'github_remote_read');
  assert.deepEqual(result.budget, {
    class: 'remote_repository_read',
    targetCount: 1,
    costPerTarget: 1,
    costUnits: 1,
    maxTargets: 1,
    maxCostUnits: 1,
  });
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

test('HTTP fan-out beyond the bounded policy is blocked before the executor', async () => {
  let calls = 0;
  const result = await executeConnectorAction({
    request: {
      connector: 'http',
      action: 'ingest',
      urls: [
        'https://one.example',
        'https://two.example',
        'https://three.example',
        'https://four.example',
        'https://five.example',
      ],
    },
    execute: async () => {
      calls += 1;
      return ['bypass'];
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'CONNECTOR_ACTION_FIREWALL_BLOCKED');
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, 'CONNECTOR_BUDGET_TARGET_LIMIT');
  assert.equal(result.canExecute, false);
  assert.equal(calls, 0);
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


test('connector firewall normalizes local source connectors with bound targets', () => {
  for (const connector of ['markdown', 'json', 'yaml', 'git-log', 'pdf']) {
    const result = evaluateConnectorAction({
      connector,
      action: 'ingest',
      targetPath: `/workspace/${connector}/source`,
      workspaceId: 'workspace-local',
      actor: 'connector-test',
    });
    assert.equal(result.ok, true);
    assert.equal(result.canExecute, true);
    assert.equal(result.decision, 'allow');
    assert.equal(result.firewallVersion, 'AAFW-v1.0.0');
    assert.equal(result.target, `/workspace/${connector}/source`);
    assert.equal(result.egressClass, 'local_filesystem_read');
    assert.equal(result.budget.costUnits, 1);
    assert.equal(result.firewallSummary.metadata.surface, 'connector');
  }
});

test('connector firewall normalizes multiple HTTP targets and refuses credentials', () => {
  const result = evaluateConnectorAction({
    connector: 'http',
    action: 'ingest',
    urls: ['https://example.com/docs#section', 'http://example.org/feed'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.canExecute, true);
  assert.equal(result.decision, 'allow');
  assert.deepEqual(result.targets, ['https://example.com/docs', 'http://example.org/feed']);
  assert.equal(result.target, 'https://example.com/docs|http://example.org/feed');
  assert.equal(result.egressClass, 'external_http_read');
  assert.equal(result.budget.costUnits, 2);

  const credentials = normalizeConnectorAction({
    connector: 'http',
    action: 'ingest',
    url: 'https://user:secret@example.com/private',
  });
  assert.equal(credentials.ok, false);
  assert.equal(credentials.reason, 'CONNECTOR_TARGET_INVALID');
});

test('connector preview remains dry_run_only for local and HTTP connectors', async () => {
  for (const request of [
    { connector: 'markdown', action: 'ingest', targetPath: '/workspace/docs/readme.md' },
    { connector: 'http', action: 'ingest', urls: ['https://example.com'] },
  ]) {
    let calls = 0;
    const result = await executeConnectorAction({
      request: { ...request, preview: true },
      execute: async () => {
        calls += 1;
        return ['should-not-run'];
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CONNECTOR_ACTION_FIREWALL_BLOCKED');
    assert.equal(result.decision, 'dry_run_only');
    assert.equal(calls, 0);
  }
});

test('connector firewall normalizes HTTP reachability probes as read-only actions', async () => {
  const normalized = normalizeConnectorAction({
    connector: 'http',
    action: 'probe',
    url: 'https://example.com/report#section',
    actor: 'evidence-validator',
  });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.canonicalAction, 'http.probe_url');
  assert.equal(normalized.executor, 'fetchUrl');
  assert.equal(normalized.targetRef, 'https://example.com/report');
  assert.equal(normalized.stateMutationBoundary, 'none');

  let calls = 0;
  const result = await executeConnectorAction({
    request: {
      connector: 'http',
      action: 'probe',
      url: 'https://example.com/report#section',
    },
    execute: async decision => {
      calls += 1;
      assert.equal(decision.targetRef, 'https://example.com/report');
      return { statusCode: 200 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision, 'allow');
  assert.equal(calls, 1);
});

test('connector firewall blocks HTTP reachability probes with credential-bearing targets', async () => {
  let calls = 0;
  const result = await executeConnectorAction({
    request: {
      connector: 'http',
      action: 'probe',
      url: 'https://user:secret@example.com/report',
    },
    execute: async () => {
      calls += 1;
      return { statusCode: 200 };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CONNECTOR_TARGET_INVALID');
  assert.equal(result.canExecute, false);
  assert.equal(calls, 0);
});
