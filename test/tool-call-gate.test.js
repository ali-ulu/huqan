const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AB2_POLICY_VERSION,
  TOOL_GATE_DECISIONS,
  TOOL_GATE_REASONS,
  evaluateToolCall,
  normalizeGateDecision,
  normalizeToolCall,
} = require('../lib/tool-call-gate');

function makeClassifier(overrides = {}) {
  return {
    classifierVersion: 'AB1-v2.0.0',
    risk: {
      level: 'low',
      score: 0.2,
      category: 'read',
    },
    valid: true,
    ...overrides,
  };
}

test('read-only low-risk action returns allow', () => {
  const result = evaluateToolCall({
    action: 'read',
    toolName: 'list-files',
    classifier: makeClassifier(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.allowed, true);
  assert.equal(result.canExecute, true);
  assert.equal(result.canDryRun, true);
  assert.equal(result.decision, TOOL_GATE_DECISIONS.ALLOW);
  assert.equal(result.reason, TOOL_GATE_REASONS.LOW_RISK_ACTION);
  assert.deepEqual(result.risk, { level: 'low', score: 0.2, category: 'read' });
  assert.equal(result.requiredReview, false);
  assert.equal(result.dryRunOnly, false);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.metadata.policyVersion, AB2_POLICY_VERSION);
  assert.equal(result.metadata.classifierVersion, 'AB1-v2.0.0');
  assert.equal(result.metadata.workspaceId, 'default');
});

test('unknown action returns review', () => {
  const result = evaluateToolCall({
    action: 'mystery',
    toolName: 'maybe-do-thing',
    classifier: makeClassifier({
      risk: { level: 'medium', score: 0.5, category: 'unknown' },
    }),
  });

  assert.equal(result.decision, TOOL_GATE_DECISIONS.REVIEW);
  assert.equal(result.reason, TOOL_GATE_REASONS.UNKNOWN_ACTION_REVIEW_REQUIRED);
  assert.equal(result.allowed, false);
  assert.equal(result.canExecute, false);
  assert.equal(result.canDryRun, true);
});

test('unknown destructive-looking action returns block', () => {
  const result = evaluateToolCall({
    action: 'obliterate',
    toolName: 'drop-all-records',
    classifier: makeClassifier({
      risk: { level: 'critical', score: 1, category: 'destructive' },
    }),
  });

  assert.equal(result.decision, TOOL_GATE_DECISIONS.BLOCK);
  assert.equal(result.reason, TOOL_GATE_REASONS.CRITICAL_MUTATION_BLOCKED);
  assert.equal(result.canExecute, false);
  assert.equal(result.canDryRun, false);
});

test('write or mutation action returns review', () => {
  const result = evaluateToolCall({
    action: 'update',
    toolName: 'save-profile',
    classifier: makeClassifier({
      risk: { level: 'medium', score: 0.55, category: 'write' },
    }),
  });

  assert.equal(result.decision, TOOL_GATE_DECISIONS.REVIEW);
  assert.equal(result.reason, TOOL_GATE_REASONS.REVIEW_REQUIRED);
  assert.equal(result.requiredReview, true);
});

test('delete or destructive action returns block', () => {
  const result = evaluateToolCall({
    action: 'delete',
    toolName: 'remove-user',
    classifier: makeClassifier({
      risk: { level: 'critical', score: 0.99, category: 'destructive' },
    }),
  });

  assert.equal(result.decision, TOOL_GATE_DECISIONS.BLOCK);
  assert.equal(result.reason, TOOL_GATE_REASONS.CRITICAL_MUTATION_BLOCKED);
});

test('deploy or publish action returns dry_run_only', () => {
  const result = evaluateToolCall({
    action: 'deploy',
    toolName: 'publish-release',
    classifier: makeClassifier({
      risk: { level: 'high', score: 0.8, category: 'release' },
    }),
  });

  assert.equal(result.decision, TOOL_GATE_DECISIONS.DRY_RUN_ONLY);
  assert.equal(result.reason, TOOL_GATE_REASONS.HIGH_RISK_ACTION_DRY_RUN_ONLY);
  assert.equal(result.canExecute, false);
  assert.equal(result.canDryRun, true);
});

test('read-only network inspection can still allow', () => {
  const result = evaluateToolCall({
    action: 'fetch',
    toolName: 'status-check',
    input: 'GET https://example.com/health',
    classifier: makeClassifier({
      risk: { level: 'low', score: 0.1, category: 'read' },
    }),
  });

  assert.equal(result.decision, TOOL_GATE_DECISIONS.ALLOW);
  assert.equal(result.allowed, true);
  assert.equal(result.reason, TOOL_GATE_REASONS.LOW_RISK_ACTION);
});

test('network mutation tool does not allow', () => {
  const result = evaluateToolCall({
    action: 'fetch',
    toolName: 'mutation-client',
    input: 'POST https://example.com/api/update',
    classifier: makeClassifier({
      risk: { level: 'high', score: 0.9, category: 'network' },
    }),
  });

  assert.notEqual(result.decision, TOOL_GATE_DECISIONS.ALLOW);
  assert.equal(result.allowed, false);
  assert.equal(result.canExecute, false);
  assert.ok([TOOL_GATE_DECISIONS.REVIEW, TOOL_GATE_DECISIONS.DRY_RUN_ONLY, TOOL_GATE_DECISIONS.BLOCK].includes(result.decision));
  assert.equal(result.reason, TOOL_GATE_REASONS.EXTERNAL_SIDE_EFFECT_REVIEW_REQUIRED);
});

test('webhook mutation does not allow', () => {
  const result = evaluateToolCall({
    action: 'send',
    toolName: 'webhook-dispatcher',
    input: {
      method: 'POST',
      url: 'https://hooks.example.com/incoming',
    },
    classifier: makeClassifier({
      risk: { level: 'high', score: 0.9, category: 'network' },
    }),
  });

  assert.notEqual(result.decision, TOOL_GATE_DECISIONS.ALLOW);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, TOOL_GATE_REASONS.EXTERNAL_SIDE_EFFECT_REVIEW_REQUIRED);
});

test('external api write does not allow', () => {
  const result = evaluateToolCall({
    action: 'fetch',
    toolName: 'api-client',
    input: 'PUT https://api.example.com/v1/items/42',
    classifier: makeClassifier({
      risk: { level: 'high', score: 0.95, category: 'network' },
    }),
  });

  assert.notEqual(result.decision, TOOL_GATE_DECISIONS.ALLOW);
  assert.equal(result.allowed, false);
  assert.equal(result.canExecute, false);
});

test('network call with token does not leak token in warnings', () => {
  const token = 'sk-test-abcdef1234567890';
  const result = evaluateToolCall({
    action: 'fetch',
    toolName: 'api-client',
    input: {
      method: 'POST',
      url: 'https://api.example.com/v1/items',
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
    classifier: makeClassifier({
      risk: { level: 'high', score: 0.95, category: 'network' },
    }),
  });

  assert.ok(result.warnings.every(warning => !warning.includes(token)));
  assert.ok(result.warnings.every(warning => !warning.toLowerCase().includes('authorization')));
});

test('secret-looking args trigger review or block', () => {
  const result = evaluateToolCall({
    action: 'read',
    toolName: 'inspect-secrets',
    args: {
      apiKey: 'sk-live-1234567890abcdef',
      nested: {
        password: 'super-secret-value',
      },
    },
    classifier: makeClassifier(),
  });

  assert.equal(result.allowed, false);
  assert.equal(result.decision, TOOL_GATE_DECISIONS.REVIEW);
  assert.equal(result.reason, TOOL_GATE_REASONS.SECRET_ARGS_REVIEW_REQUIRED);
  assert.ok(result.warnings.every(warning => !warning.includes('sk-live-1234567890abcdef')));
  assert.ok(result.warnings.every(warning => !warning.includes('super-secret-value')));
});

test('missing AB1 output does not allow', () => {
  const result = evaluateToolCall({
    action: 'read',
    toolName: 'list-files',
  });

  assert.notEqual(result.decision, TOOL_GATE_DECISIONS.ALLOW);
  assert.equal(result.allowed, false);
  assert.equal(result.canExecute, false);
  assert.equal(result.warnings.includes('Missing or malformed AB1 classifier output.'), true);
});

test('malformed input normalizes safely', () => {
  const normalized = normalizeToolCall(null);

  assert.equal(normalized.action, '');
  assert.equal(normalized.toolName, '');
  assert.equal(normalized.dryRun, false);
  assert.equal(normalized.workspaceId, 'default');

  const result = evaluateToolCall(undefined);
  assert.equal(result.ok, true);
  assert.equal(result.allowed, false);
  assert.equal(result.canExecute, false);
  assert.equal(result.canDryRun, true);
});

test('decision output shape is stable', () => {
  const result = evaluateToolCall({
    action: 'read',
    toolName: 'list-files',
    classifier: makeClassifier(),
    workspaceId: 'workspace-a',
  });

  assert.deepEqual(Object.keys(result), [
    'ok',
    'allowed',
    'canExecute',
    'canDryRun',
    'decision',
    'reason',
    'risk',
    'requiredReview',
    'dryRunOnly',
    'warnings',
    'metadata',
  ]);
  assert.deepEqual(Object.keys(result.risk), ['level', 'score', 'category']);
  assert.deepEqual(Object.keys(result.metadata), ['policyVersion', 'classifierVersion', 'workspaceId']);
});

test('same input returns same output', () => {
  const input = {
    action: 'read',
    toolName: 'list-files',
    classifier: makeClassifier(),
    workspaceId: 'ws-1',
  };

  assert.deepEqual(evaluateToolCall(input), evaluateToolCall(input));
});

test('gate never executes passed tool function', () => {
  let called = false;

  const result = evaluateToolCall({
    action: 'read',
    toolName: 'list-files',
    classifier: makeClassifier(),
    toolFn: () => {
      called = true;
    },
  });

  assert.equal(called, false);
  assert.equal(result.allowed, true);
});

test('dry-run flag is preserved', () => {
  const result = evaluateToolCall({
    action: 'read',
    toolName: 'list-files',
    dryRun: true,
    classifier: makeClassifier(),
  });

  assert.equal(result.decision, TOOL_GATE_DECISIONS.DRY_RUN_ONLY);
  assert.equal(result.reason, TOOL_GATE_REASONS.DRY_RUN_REQUESTED);
  assert.equal(result.dryRunOnly, true);
  assert.equal(result.canDryRun, true);
  assert.equal(result.canExecute, false);
});

test('workspaceId is preserved in metadata', () => {
  const result = evaluateToolCall({
    action: 'read',
    toolName: 'list-files',
    workspaceId: 'workspace-42',
    classifier: makeClassifier(),
  });

  assert.equal(result.metadata.workspaceId, 'workspace-42');
});

test('policy override can upgrade medium risk to review or block', () => {
  const reviewResult = evaluateToolCall({
    action: 'read',
    toolName: 'list-files',
    classifier: makeClassifier({
      risk: { level: 'medium', score: 0.55, category: 'read' },
    }),
  }, {
    minimumDecision: 'review',
  });

  const blockResult = evaluateToolCall({
    action: 'read',
    toolName: 'list-files',
    classifier: makeClassifier({
      risk: { level: 'medium', score: 0.55, category: 'read' },
    }),
  }, {
    minimumDecision: 'block',
  });

  assert.equal(reviewResult.decision, TOOL_GATE_DECISIONS.REVIEW);
  assert.equal(blockResult.decision, TOOL_GATE_DECISIONS.BLOCK);
});

test('policy override cannot downgrade critical risk to allow', () => {
  const result = evaluateToolCall({
    action: 'delete',
    toolName: 'wipe-database',
    classifier: makeClassifier({
      risk: { level: 'critical', score: 1, category: 'destructive' },
    }),
  }, {
    minimumDecision: 'allow',
  });

  assert.equal(result.decision, TOOL_GATE_DECISIONS.BLOCK);
});

test('AB1 policy version appears in metadata when available', () => {
  const result = evaluateToolCall({
    action: 'read',
    toolName: 'list-files',
    classifier: {
      version: 'AB1-v9.9.9',
      risk: { level: 'low', score: 0.1, category: 'read' },
    },
  });

  assert.equal(result.metadata.classifierVersion, 'AB1-v9.9.9');
});

test('no raw token or API key appears in warnings', () => {
  const token = 'sk-test-abcdef1234567890';
  const result = evaluateToolCall({
    action: 'read',
    toolName: 'inspect',
    args: {
      apiKey: token,
      nested: {
        token,
      },
    },
    classifier: makeClassifier(),
  });

  assert.ok(result.warnings.every(warning => !warning.includes(token)));
  assert.ok(result.warnings.every(warning => !warning.toLowerCase().includes('apikey')));
});

test('null and undefined args do not crash', () => {
  const nullArgs = evaluateToolCall({
    action: 'read',
    toolName: 'list-files',
    args: null,
    classifier: makeClassifier(),
  });

  const undefinedArgs = evaluateToolCall({
    action: 'read',
    toolName: 'list-files',
    args: undefined,
    classifier: makeClassifier(),
  });

  assert.equal(nullArgs.ok, true);
  assert.equal(undefinedArgs.ok, true);
});

test('critical risk cannot be allowed by default', () => {
  const result = evaluateToolCall({
    action: 'delete',
    toolName: 'remove-all',
    classifier: makeClassifier({
      risk: { level: 'critical', score: 1, category: 'destructive' },
    }),
  });

  assert.notEqual(result.decision, TOOL_GATE_DECISIONS.ALLOW);
  assert.equal(result.allowed, false);
});

test('normalizeGateDecision safely normalizes malformed objects', () => {
  const normalized = normalizeGateDecision({
    decision: 'ALLOW',
    reason: 'LOW_RISK_ACTION',
    risk: { level: 'LOW', score: 0.3, category: 'read' },
    metadata: { policyVersion: 'AB2-v0.1.0', workspaceId: 'ws-a' },
    warnings: ['ok'],
  });

  assert.equal(normalized.decision, TOOL_GATE_DECISIONS.ALLOW);
  assert.equal(normalized.metadata.workspaceId, 'ws-a');
  assert.equal(normalized.metadata.policyVersion, 'AB2-v0.1.0');
});
