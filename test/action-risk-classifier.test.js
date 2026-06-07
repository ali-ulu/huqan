const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  ACTION_CATEGORIES,
  DECISIONS,
  RISK_LEVELS,
  FLAGS,
  SECURITY_SENSITIVE_PATH_TOKENS,
  classifyAction,
  isPathInList,
  isPathSecuritySensitive,
  isUrlInList,
} = require('../lib/action-risk-classifier');

describe('action-risk-classifier: constants', () => {
  it('exposes frozen decision and risk-level enums', () => {
    assert.strictEqual(DECISIONS.ALLOW, 'ALLOW');
    assert.strictEqual(DECISIONS.BLOCK, 'BLOCK');
    assert.strictEqual(DECISIONS.QUARANTINE, 'QUARANTINE');
    assert.strictEqual(DECISIONS.HUMAN_REVIEW, 'HUMAN_REVIEW');
    assert.strictEqual(RISK_LEVELS.LOW, 'LOW');
    assert.strictEqual(RISK_LEVELS.MEDIUM, 'MEDIUM');
    assert.strictEqual(RISK_LEVELS.HIGH, 'HIGH');
    assert.strictEqual(RISK_LEVELS.CRITICAL, 'CRITICAL');
    assert.ok(Object.isFrozen(DECISIONS));
    assert.ok(Object.isFrozen(RISK_LEVELS));
  });

  it('lists the security-sensitive path tokens', () => {
    assert.ok(SECURITY_SENSITIVE_PATH_TOKENS.includes('requestGuards.js'));
    assert.ok(SECURITY_SENSITIVE_PATH_TOKENS.includes('server.js'));
    assert.ok(SECURITY_SENSITIVE_PATH_TOKENS.includes('toolPolicy.js'));
    assert.ok(SECURITY_SENSITIVE_PATH_TOKENS.includes('lib/action-risk-classifier.js'));
    assert.ok(SECURITY_SENSITIVE_PATH_TOKENS.includes('lib/trust-policy.js'));
    assert.ok(SECURITY_SENSITIVE_PATH_TOKENS.includes('lib/risk-rules.js'));
    assert.ok(SECURITY_SENSITIVE_PATH_TOKENS.includes('docs/SECURITY-GATE.md'));
    assert.ok(SECURITY_SENSITIVE_PATH_TOKENS.includes('docs/agent-brake-layer.md'));
    assert.ok(SECURITY_SENSITIVE_PATH_TOKENS.includes('docs/action-taxonomy.md'));
  });
});

describe('action-risk-classifier: read-only', () => {
  it('allows read-only inside allowlisted path', () => {
    const result = classifyAction(
      { category: ACTION_CATEGORIES.READ_ONLY, action: 'kernel.ask', target: { path: 'docs/notes.md' } },
      { allowlistedPaths: ['docs/'] }
    );
    assert.strictEqual(result.decision, DECISIONS.ALLOW);
    assert.strictEqual(result.riskLevel, RISK_LEVELS.LOW);
    assert.strictEqual(result.category, 'READ_ONLY');
    assert.ok(!result.flags.includes(FLAGS.PATH_OUTSIDE_ALLOWLIST));
  });

  it('quarantines read-only outside allowlisted path', () => {
    const result = classifyAction(
      { category: ACTION_CATEGORIES.READ_ONLY, action: 'fs.readFile', target: { path: 'secrets/key.txt' } },
      { allowlistedPaths: ['docs/'] }
    );
    assert.strictEqual(result.decision, DECISIONS.QUARANTINE);
    assert.strictEqual(result.riskLevel, RISK_LEVELS.MEDIUM);
    assert.ok(result.flags.includes(FLAGS.PATH_OUTSIDE_ALLOWLIST));
  });
});

describe('action-risk-classifier: filesystem_write', () => {
  it('quarantines filesystem write inside allowlisted root', () => {
    const result = classifyAction(
      { category: ACTION_CATEGORIES.FILESYSTEM_WRITE, target: { path: 'tmp/scratch.txt' } },
      { allowlistedPaths: ['tmp/'] }
    );
    assert.strictEqual(result.decision, DECISIONS.QUARANTINE);
    assert.strictEqual(result.riskLevel, RISK_LEVELS.MEDIUM);
    assert.ok(!result.flags.includes(FLAGS.PATH_OUTSIDE_ALLOWLIST));
  });

  it('requires human review for filesystem write outside allowlisted root', () => {
    const result = classifyAction(
      { category: ACTION_CATEGORIES.FILESYSTEM_WRITE, target: { path: 'lib/foo.js' } },
      { allowlistedPaths: ['tmp/'] }
    );
    assert.strictEqual(result.decision, DECISIONS.HUMAN_REVIEW);
    assert.strictEqual(result.riskLevel, RISK_LEVELS.HIGH);
    assert.ok(result.flags.includes(FLAGS.PATH_OUTSIDE_ALLOWLIST));
  });

  it('blocks filesystem write to a security-sensitive path', () => {
    const result = classifyAction(
      { category: ACTION_CATEGORIES.FILESYSTEM_WRITE, target: { path: 'lib/trust-policy.js' } },
      { allowlistedPaths: ['lib/'] }
    );
    assert.strictEqual(result.decision, DECISIONS.BLOCK);
    assert.strictEqual(result.riskLevel, RISK_LEVELS.CRITICAL);
    assert.ok(result.flags.includes(FLAGS.PATH_SECURITY_SENSITIVE));
  });
});

describe('action-risk-classifier: network_call', () => {
  it('quarantines network call to allowlisted URL', () => {
    const result = classifyAction(
      { category: ACTION_CATEGORIES.NETWORK_CALL, target: { url: 'https://api.axiom.local/health' } },
      { allowlistedUrls: ['https://api.axiom.local'] }
    );
    assert.strictEqual(result.decision, DECISIONS.QUARANTINE);
    assert.strictEqual(result.riskLevel, RISK_LEVELS.MEDIUM);
    assert.ok(!result.flags.includes(FLAGS.URL_OUTSIDE_ALLOWLIST));
  });

  it('requires human review for network call to unknown URL', () => {
    const result = classifyAction(
      { category: ACTION_CATEGORIES.NETWORK_CALL, target: { url: 'https://unknown.example.com/x' } }
    );
    assert.strictEqual(result.decision, DECISIONS.HUMAN_REVIEW);
    assert.strictEqual(result.riskLevel, RISK_LEVELS.HIGH);
    assert.ok(result.flags.includes(FLAGS.URL_OUTSIDE_ALLOWLIST));
  });

  it('never auto-allows a network call, even with allowlist', () => {
    const result = classifyAction(
      { category: ACTION_CATEGORIES.NETWORK_CALL, target: { url: 'https://api.axiom.local/health' } },
      { allowlistedUrls: ['https://api.axiom.local'] }
    );
    assert.notStrictEqual(result.decision, DECISIONS.ALLOW);
  });
});

describe('action-risk-classifier: sandbox_simulation', () => {
  it('quarantines sandbox simulation', () => {
    const result = classifyAction({ category: ACTION_CATEGORIES.SANDBOX_SIMULATION });
    assert.strictEqual(result.decision, DECISIONS.QUARANTINE);
    assert.strictEqual(result.riskLevel, RISK_LEVELS.MEDIUM);
  });
});

describe('action-risk-classifier: high-impact writes', () => {
  const HIGH_IMPACT = [
    ACTION_CATEGORIES.MEMORY_WRITE,
    ACTION_CATEGORIES.CANONICAL_GRAPH_WRITE,
    ACTION_CATEGORIES.CODE_CHANGE,
    ACTION_CATEGORIES.TEST_CHANGE,
  ];

  for (const category of HIGH_IMPACT) {
    it(`${category} defaults to HUMAN_REVIEW / HIGH`, () => {
      const result = classifyAction({ category });
      assert.strictEqual(result.decision, DECISIONS.HUMAN_REVIEW);
      assert.strictEqual(result.riskLevel, RISK_LEVELS.HIGH);
      assert.ok(result.flags.includes(FLAGS.UNKNOWN_HIGH_IMPACT_WRITE));
    });
  }

  it('CODE_CHANGE to a security-sensitive path hardens to BLOCK / CRITICAL', () => {
    const result = classifyAction({
      category: ACTION_CATEGORIES.CODE_CHANGE,
      target: { path: 'lib/risk-rules.js' },
    });
    assert.strictEqual(result.decision, DECISIONS.BLOCK);
    assert.strictEqual(result.riskLevel, RISK_LEVELS.CRITICAL);
    assert.ok(result.flags.includes(FLAGS.PATH_SECURITY_SENSITIVE));
  });

  it('TEST_CHANGE to a security-sensitive path hardens to BLOCK / CRITICAL', () => {
    const result = classifyAction({
      category: ACTION_CATEGORIES.TEST_CHANGE,
      target: { path: 'test/security.test.js' },
    });
    assert.strictEqual(result.decision, DECISIONS.HUMAN_REVIEW);
    assert.strictEqual(result.riskLevel, RISK_LEVELS.HIGH);
  });
});

describe('action-risk-classifier: critical categories always block', () => {
  const CRITICAL = [
    ACTION_CATEGORIES.SECURITY_POLICY_CHANGE,
    ACTION_CATEGORIES.DEPLOYMENT,
    ACTION_CATEGORIES.PERMISSION_CHANGE,
    ACTION_CATEGORIES.PRODUCTION_MUTATION,
  ];

  for (const category of CRITICAL) {
    it(`${category} → BLOCK / CRITICAL by default`, () => {
      const result = classifyAction({ category });
      assert.strictEqual(result.decision, DECISIONS.BLOCK);
      assert.strictEqual(result.riskLevel, RISK_LEVELS.CRITICAL);
    });
  }
});

describe('action-risk-classifier: tool chain execution', () => {
  it('always routes to HUMAN_REVIEW / HIGH', () => {
    const result = classifyAction({ category: ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION });
    assert.strictEqual(result.decision, DECISIONS.HUMAN_REVIEW);
    assert.strictEqual(result.riskLevel, RISK_LEVELS.HIGH);
  });
});

describe('action-risk-classifier: unknown and malformed', () => {
  it('unknown category → HUMAN_REVIEW / HIGH with UNKNOWN_ACTION_CATEGORY flag', () => {
    const result = classifyAction({ category: 'SOMETHING_NEW' });
    assert.strictEqual(result.decision, DECISIONS.HUMAN_REVIEW);
    assert.strictEqual(result.riskLevel, RISK_LEVELS.HIGH);
    assert.ok(result.flags.includes(FLAGS.UNKNOWN_ACTION_CATEGORY));
    assert.ok(result.flags.includes(FLAGS.UNKNOWN_CATEGORY_FAILSAFE));
    assert.notStrictEqual(result.decision, DECISIONS.ALLOW);
  });

  it('null input → fail-safe HUMAN_REVIEW, no throw', () => {
    let result;
    assert.doesNotThrow(() => {
      result = classifyAction(null);
    });
    assert.strictEqual(result.decision, DECISIONS.HUMAN_REVIEW);
    assert.strictEqual(result.riskLevel, RISK_LEVELS.HIGH);
    assert.ok(result.flags.includes(FLAGS.MALFORMED_ACTION));
    assert.ok(result.flags.includes(FLAGS.UNKNOWN_CATEGORY_FAILSAFE));
  });

  it('undefined input → fail-safe HUMAN_REVIEW, no throw', () => {
    let result;
    assert.doesNotThrow(() => {
      result = classifyAction(undefined);
    });
    assert.strictEqual(result.decision, DECISIONS.HUMAN_REVIEW);
    assert.ok(result.flags.includes(FLAGS.MALFORMED_ACTION));
  });

  it('non-object input (string) → fail-safe HUMAN_REVIEW, no throw', () => {
    let result;
    assert.doesNotThrow(() => {
      result = classifyAction('READ_ONLY');
    });
    assert.strictEqual(result.decision, DECISIONS.HUMAN_REVIEW);
    assert.ok(result.flags.includes(FLAGS.MALFORMED_ACTION));
  });

  it('empty object input → fail-safe HUMAN_REVIEW, no throw', () => {
    let result;
    assert.doesNotThrow(() => {
      result = classifyAction({});
    });
    assert.strictEqual(result.decision, DECISIONS.HUMAN_REVIEW);
    assert.ok(result.flags.includes(FLAGS.MALFORMED_ACTION));
  });

  it('empty-string category → fail-safe, no throw', () => {
    let result;
    assert.doesNotThrow(() => {
      result = classifyAction({ category: '' });
    });
    assert.strictEqual(result.decision, DECISIONS.HUMAN_REVIEW);
    assert.ok(result.flags.includes(FLAGS.MALFORMED_ACTION));
  });

  it('whitespace-only category → fail-safe, no throw', () => {
    let result;
    assert.doesNotThrow(() => {
      result = classifyAction({ category: '   ' });
    });
    assert.strictEqual(result.decision, DECISIONS.HUMAN_REVIEW);
    assert.ok(result.flags.includes(FLAGS.MALFORMED_ACTION));
  });
});

describe('action-risk-classifier: trust receipt', () => {
  it('builds a receipt without timestamp when now is not provided', () => {
    const result = classifyAction({ category: ACTION_CATEGORIES.READ_ONLY });
    assert.ok(result.trustReceipt);
    assert.strictEqual(result.trustReceipt.decision, DECISIONS.ALLOW);
    assert.strictEqual(result.trustReceipt.riskLevel, RISK_LEVELS.LOW);
    assert.strictEqual(result.trustReceipt.category, 'READ_ONLY');
    assert.ok(Array.isArray(result.trustReceipt.reasons));
    assert.ok(Array.isArray(result.trustReceipt.flags));
    assert.strictEqual(result.trustReceipt.timestamp, undefined);
  });

  it('builds a receipt with timestamp when now is provided', () => {
    const result = classifyAction(
      { category: ACTION_CATEGORIES.DEPLOYMENT },
      { now: 1700000000000 }
    );
    assert.strictEqual(result.trustReceipt.timestamp, 1700000000000);
  });

  it('trust receipt is frozen', () => {
    const result = classifyAction({ category: ACTION_CATEGORIES.READ_ONLY });
    assert.ok(Object.isFrozen(result.trustReceipt));
  });
});

describe('action-risk-classifier: determinism', () => {
  it('same input produces identical output', () => {
    const a = classifyAction({ category: ACTION_CATEGORIES.NETWORK_CALL, target: { url: 'https://x' } });
    const b = classifyAction({ category: ACTION_CATEGORIES.NETWORK_CALL, target: { url: 'https://x' } });
    assert.deepStrictEqual(a, b);
  });

  it('different input produces different output', () => {
    const a = classifyAction({ category: ACTION_CATEGORIES.READ_ONLY });
    const b = classifyAction({ category: ACTION_CATEGORIES.DEPLOYMENT });
    assert.notDeepStrictEqual(a, b);
  });

  it('output is frozen', () => {
    const result = classifyAction({ category: ACTION_CATEGORIES.READ_ONLY });
    assert.ok(Object.isFrozen(result));
  });

  it('repeated calls do not leak state', () => {
    for (let i = 0; i < 25; i += 1) {
      const result = classifyAction({ category: ACTION_CATEGORIES.MEMORY_WRITE });
      assert.strictEqual(result.decision, DECISIONS.HUMAN_REVIEW);
    }
  });
});

describe('action-risk-classifier: MEDIUM is never auto-allow', () => {
  it('SANDBOX_SIMULATION does not auto-allow', () => {
    const result = classifyAction({ category: ACTION_CATEGORIES.SANDBOX_SIMULATION });
    assert.notStrictEqual(result.decision, DECISIONS.ALLOW);
  });

  it('FILESYSTEM_WRITE inside allowlist does not auto-allow', () => {
    const result = classifyAction(
      { category: ACTION_CATEGORIES.FILESYSTEM_WRITE, target: { path: 'tmp/x.txt' } },
      { allowlistedPaths: ['tmp/'] }
    );
    assert.notStrictEqual(result.decision, DECISIONS.ALLOW);
    assert.strictEqual(result.decision, DECISIONS.QUARANTINE);
  });

  it('NETWORK_CALL inside allowlist does not auto-allow', () => {
    const result = classifyAction(
      { category: ACTION_CATEGORIES.NETWORK_CALL, target: { url: 'https://api.axiom.local/health' } },
      { allowlistedUrls: ['https://api.axiom.local'] }
    );
    assert.notStrictEqual(result.decision, DECISIONS.ALLOW);
    assert.strictEqual(result.decision, DECISIONS.QUARANTINE);
  });
});

describe('action-risk-classifier: helper predicates', () => {
  it('isPathInList treats subpaths as inside', () => {
    assert.strictEqual(isPathInList('docs/sub/file.md', ['docs/']), true);
    assert.strictEqual(isPathInList('docs/file.md', ['docs/']), true);
    assert.strictEqual(isPathInList('lib/file.js', ['docs/']), false);
  });

  it('isPathInList normalizes backslashes', () => {
    assert.strictEqual(isPathInList('docs\\sub\\file.md', ['docs/']), true);
  });

  it('isPathInList returns false for empty inputs', () => {
    assert.strictEqual(isPathInList('', ['docs/']), false);
    assert.strictEqual(isPathInList('docs/file.md', []), false);
  });

  it('isPathSecuritySensitive flags expanded token set', () => {
    assert.strictEqual(isPathSecuritySensitive('lib/action-risk-classifier.js'), true);
    assert.strictEqual(isPathSecuritySensitive('requestGuards.js'), true);
    assert.strictEqual(isPathSecuritySensitive('server.js'), true);
    assert.strictEqual(isPathSecuritySensitive('toolPolicy.js'), true);
    assert.strictEqual(isPathSecuritySensitive('lib/trust-policy.js'), true);
    assert.strictEqual(isPathSecuritySensitive('lib/risk-rules.js'), true);
    assert.strictEqual(isPathSecuritySensitive('docs/SECURITY-GATE.md'), true);
    assert.strictEqual(isPathSecuritySensitive('docs/agent-brake-layer.md'), true);
    assert.strictEqual(isPathSecuritySensitive('docs/action-taxonomy.md'), true);
    assert.strictEqual(isPathSecuritySensitive('subdir/server.js'), true);
    assert.strictEqual(isPathSecuritySensitive('src/random.js'), false);
  });

  it('isUrlInList matches prefix and exact URLs', () => {
    assert.strictEqual(isUrlInList('https://api.axiom.local/health', ['https://api.axiom.local']), true);
    assert.strictEqual(isUrlInList('https://api.axiom.local', ['https://api.axiom.local']), true);
    assert.strictEqual(isUrlInList('https://other.example.com', ['https://api.axiom.local']), false);
    assert.strictEqual(isUrlInList('', ['https://api.axiom.local']), false);
  });
});
