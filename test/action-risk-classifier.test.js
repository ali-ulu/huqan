'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTION_CATEGORIES,
  ACTION_TYPES,
  ACTION_DECISIONS,
  DECISIONS,
  RISK_LEVELS,
  FLAGS,
  SECURITY_SENSITIVE_PATH_TOKENS,
  HIGH_IMPACT_WRITE_CATEGORIES,
  POLICY_VERSION,
  normalizeActionType,
  normalizeActionRequest,
  classifyActionCategory,
  resolveRiskLevel,
  deriveDecision,
  applyHardBlockRules,
  classifyAgentAction,
  classify,
  normalizeActionDecision,
  isPathInList,
  isPathSecuritySensitive,
  isUrlInList,
} = require('../lib/action-risk-classifier');

describe('AB1 v2 canon', () => {
  it('exports 13 canonical categories', () => {
    assert.strictEqual(Object.keys(ACTION_CATEGORIES).length, 13);
    assert.ok(Object.isFrozen(ACTION_CATEGORIES));
    assert.strictEqual(ACTION_CATEGORIES.READ_ONLY, 'READ_ONLY');
    assert.strictEqual(ACTION_CATEGORIES.PRODUCTION_MUTATION, 'PRODUCTION_MUTATION');
  });

  it('keeps compatibility aliases for the main API', () => {
    assert.strictEqual(ACTION_TYPES, ACTION_CATEGORIES);
    assert.strictEqual(DECISIONS, ACTION_DECISIONS);
    assert.strictEqual(ACTION_DECISIONS.QUARANTINE, 'QUARANTINE');
    assert.strictEqual(ACTION_DECISIONS.HUMAN_REVIEW, 'HUMAN_REVIEW');
  });

  it('exports four risk levels', () => {
    assert.deepStrictEqual(Object.values(RISK_LEVELS).sort(), ['CRITICAL', 'HIGH', 'LOW', 'MEDIUM']);
  });

  it('policy version is AB1-prefixed', () => {
    assert.ok(POLICY_VERSION.startsWith('AB1'));
  });

  it('flags include the expected gates', () => {
    for (const name of [
      'AUTO_MERGE',
      'AUTO_DEPLOY',
      'SELF_ESCALATION',
      'HARD_BLOCKED',
      'MALFORMED_ACTION',
      'UNKNOWN_ACTION_CATEGORY',
      'PATH_SECURITY_SENSITIVE',
      'PATH_OUTSIDE_ALLOWLIST',
      'URL_OUTSIDE_ALLOWLIST',
      'PRODUCTION_SIDE',
    ]) {
      assert.ok(typeof FLAGS[name] === 'string', `missing ${name}`);
    }
  });

  it('security-sensitive path token list is present', () => {
    for (const token of ['requestGuards.js', 'server.js', 'toolPolicy.js', 'lib/trust-policy.js', 'lib/risk-rules.js']) {
      assert.ok(SECURITY_SENSITIVE_PATH_TOKENS.includes(token), token);
    }
  });

  it('high-impact write categories contains the expected 8 entries', () => {
    assert.strictEqual(HIGH_IMPACT_WRITE_CATEGORIES.size, 8);
  });
});

describe('AB1 v2 normalization', () => {
  it('normalizes legacy lower-case categories to canonical upper-case', () => {
    assert.strictEqual(normalizeActionType('read_only'), 'READ_ONLY');
    assert.strictEqual(normalizeActionType('tool_execution'), 'TOOL_CHAIN_EXECUTION');
    assert.strictEqual(normalizeActionType('network_access'), 'NETWORK_CALL');
    assert.strictEqual(normalizeActionType('local_analysis'), 'READ_ONLY');
    assert.strictEqual(normalizeActionType('test_execution'), 'SANDBOX_SIMULATION');
  });

  it('returns null for unknown categories', () => {
    assert.strictEqual(normalizeActionType('not_a_real_category'), null);
    assert.strictEqual(normalizeActionType(''), null);
    assert.strictEqual(normalizeActionType(null), null);
  });

  it('normalizes requests into canonical shape', () => {
    const r = normalizeActionRequest({ category: 'read_only', action: 'kernel.ask', target: 'docs/x.md' });
    assert.strictEqual(r.malformed, false);
    assert.strictEqual(r.category, 'READ_ONLY');
    assert.strictEqual(r.action, 'kernel.ask');
    assert.deepStrictEqual(r.target, { value: 'docs/x.md' });
  });

  it('marks non-object input malformed', () => {
    assert.strictEqual(normalizeActionRequest(null).malformed, true);
    assert.strictEqual(normalizeActionRequest('read_only').malformed, true);
    assert.strictEqual(normalizeActionRequest([]).malformed, true);
  });
});

describe('AB1 v2 helper functions', () => {
  it('classifyActionCategory returns canonical category', () => {
    assert.strictEqual(classifyActionCategory({ category: 'deployment' }), 'DEPLOYMENT');
    assert.strictEqual(classifyActionCategory({ category: 'READ_ONLY' }), 'READ_ONLY');
    assert.strictEqual(classifyActionCategory({}), null);
  });

  it('resolveRiskLevel follows the AB0 table', () => {
    assert.strictEqual(resolveRiskLevel('READ_ONLY'), 'LOW');
    assert.strictEqual(resolveRiskLevel('FILESYSTEM_WRITE'), 'MEDIUM');
    assert.strictEqual(resolveRiskLevel('MEMORY_WRITE'), 'HIGH');
    assert.strictEqual(resolveRiskLevel('DEPLOYMENT'), 'CRITICAL');
    assert.strictEqual(resolveRiskLevel('NOT_REAL'), 'HIGH');
  });

  it('deriveDecision maps risk to decisions and respects hard blocks', () => {
    assert.strictEqual(deriveDecision('LOW', false), 'ALLOW');
    assert.strictEqual(deriveDecision('MEDIUM', false), 'QUARANTINE');
    assert.strictEqual(deriveDecision('HIGH', false), 'HUMAN_REVIEW');
    assert.strictEqual(deriveDecision('CRITICAL', false), 'BLOCK');
    assert.strictEqual(deriveDecision('LOW', true), 'BLOCK');
  });

  it('applyHardBlockRules blocks hard cases', () => {
    const partial = {
      category: 'CODE_CHANGE',
      riskLevel: 'HIGH',
      decision: 'HUMAN_REVIEW',
      flags: [],
      reasons: [],
      target: { path: 'lib/trust-policy.js' },
    };
    const out = applyHardBlockRules({ context: { flags: [] } }, partial);
    assert.strictEqual(out.decision, 'BLOCK');
    assert.ok(out.flags.includes(FLAGS.PATH_SECURITY_SENSITIVE));
    assert.ok(out.flags.includes(FLAGS.HARD_BLOCKED));
  });

  it('applyHardBlockRules does not block a normal read', () => {
    const partial = {
      category: 'READ_ONLY',
      riskLevel: 'LOW',
      decision: 'ALLOW',
      flags: [],
      reasons: [],
    };
    const out = applyHardBlockRules({ context: { flags: [] } }, partial);
    assert.strictEqual(out.decision, 'ALLOW');
  });

  it('predicate helpers work', () => {
    assert.strictEqual(isPathInList('docs/sub/file.md', ['docs/']), true);
    assert.strictEqual(isPathInList('docs\\sub\\file.md', ['docs/']), true);
    assert.strictEqual(isPathInList('lib/file.js', ['docs/']), false);

    assert.strictEqual(isPathSecuritySensitive('lib/trust-policy.js'), true);
    assert.strictEqual(isPathSecuritySensitive('src/random.js'), false);

    assert.strictEqual(isUrlInList('https://api.axiom.local/health', ['https://api.axiom.local']), true);
    assert.strictEqual(isUrlInList('https://example.com', ['https://api.axiom.local']), false);
  });
});

describe('AB1 v2 classifier behavior', () => {
  it('READ_ONLY inside allowlist is ALLOW / LOW', () => {
    const r = classifyAgentAction(
      { category: 'READ_ONLY', action: 'kernel.ask', target: { path: 'docs/x.md' } },
      { allowlistedPaths: ['docs/'] }
    );
    assert.strictEqual(r.category, 'READ_ONLY');
    assert.strictEqual(r.decision, 'ALLOW');
    assert.strictEqual(r.riskLevel, 'LOW');
    assert.ok(Array.isArray(r.reasons));
    assert.ok(Array.isArray(r.flags));
    assert.ok(Object.isFrozen(r));
    assert.ok(Object.isFrozen(r.trustReceipt));
  });

  it('MEMORY_WRITE defaults to HUMAN_REVIEW / HIGH', () => {
    const r = classifyAgentAction({ category: 'MEMORY_WRITE', action: 'memory.store' });
    assert.strictEqual(r.decision, 'HUMAN_REVIEW');
    assert.strictEqual(r.riskLevel, 'HIGH');
  });

  it('FILESYSTEM_WRITE inside allowlist is QUARANTINE / MEDIUM', () => {
    const r = classifyAgentAction(
      { category: 'FILESYSTEM_WRITE', target: { path: 'tmp/x.txt' } },
      { allowlistedPaths: ['tmp/'] }
    );
    assert.strictEqual(r.decision, 'QUARANTINE');
    assert.strictEqual(r.riskLevel, 'MEDIUM');
  });

  it('FILESYSTEM_WRITE outside allowlist is HUMAN_REVIEW / HIGH', () => {
    const r = classifyAgentAction(
      { category: 'FILESYSTEM_WRITE', target: { path: 'lib/x.js' } },
      { allowlistedPaths: ['tmp/'] }
    );
    assert.strictEqual(r.decision, 'HUMAN_REVIEW');
    assert.strictEqual(r.riskLevel, 'HIGH');
    assert.ok(r.flags.includes(FLAGS.PATH_OUTSIDE_ALLOWLIST));
  });

  it('NETWORK_CALL to allowlisted URL is QUARANTINE / MEDIUM', () => {
    const r = classifyAgentAction(
      { category: 'NETWORK_CALL', target: { url: 'https://api.axiom.local/health' } },
      { allowlistedUrls: ['https://api.axiom.local'] }
    );
    assert.strictEqual(r.decision, 'QUARANTINE');
    assert.strictEqual(r.riskLevel, 'MEDIUM');
  });

  it('NETWORK_CALL to unknown URL is HUMAN_REVIEW / HIGH', () => {
    const r = classifyAgentAction({ category: 'NETWORK_CALL', target: { url: 'https://unknown.example.com/x' } });
    assert.strictEqual(r.decision, 'HUMAN_REVIEW');
    assert.strictEqual(r.riskLevel, 'HIGH');
    assert.ok(r.flags.includes(FLAGS.URL_OUTSIDE_ALLOWLIST));
  });

  it('CODE_CHANGE to security-sensitive path is BLOCK / CRITICAL', () => {
    const r = classifyAgentAction({ category: 'CODE_CHANGE', target: { path: 'lib/risk-rules.js' } });
    assert.strictEqual(r.decision, 'BLOCK');
    assert.strictEqual(r.riskLevel, 'CRITICAL');
    assert.ok(r.flags.includes(FLAGS.PATH_SECURITY_SENSITIVE));
  });

  it('DEPLOYMENT is BLOCK / CRITICAL', () => {
    const r = classifyAgentAction({ category: 'DEPLOYMENT' });
    assert.strictEqual(r.decision, 'BLOCK');
    assert.strictEqual(r.riskLevel, 'CRITICAL');
  });

  it('SECURITY_POLICY_CHANGE is BLOCK / CRITICAL', () => {
    const r = classifyAgentAction({ category: 'SECURITY_POLICY_CHANGE' });
    assert.strictEqual(r.decision, 'BLOCK');
    assert.strictEqual(r.riskLevel, 'CRITICAL');
  });

  it('SANDBOX_SIMULATION is QUARANTINE / MEDIUM', () => {
    const r = classifyAgentAction({ category: 'SANDBOX_SIMULATION' });
    assert.strictEqual(r.decision, 'QUARANTINE');
    assert.strictEqual(r.riskLevel, 'MEDIUM');
  });

  it('TOOL_CHAIN_EXECUTION is HUMAN_REVIEW / HIGH', () => {
    const r = classifyAgentAction({ category: 'TOOL_CHAIN_EXECUTION' });
    assert.strictEqual(r.decision, 'HUMAN_REVIEW');
    assert.strictEqual(r.riskLevel, 'HIGH');
  });

  it('PRODUCTION_MUTATION is BLOCK / CRITICAL', () => {
    const r = classifyAgentAction({ category: 'PRODUCTION_MUTATION' });
    assert.strictEqual(r.decision, 'BLOCK');
    assert.strictEqual(r.riskLevel, 'CRITICAL');
  });

  it('unknown category is never silently allowed', () => {
    const r = classifyAgentAction({ category: 'SOMETHING_NEW' });
    assert.strictEqual(r.decision, 'HUMAN_REVIEW');
    assert.strictEqual(r.riskLevel, 'HIGH');
    assert.ok(r.flags.includes(FLAGS.UNKNOWN_ACTION_CATEGORY));
    assert.notStrictEqual(r.decision, 'ALLOW');
  });

  it('malformed inputs fail safe', () => {
    for (const input of [null, undefined, 'READ_ONLY', 42, true, [], {}]) {
      const r = classifyAgentAction(input);
      assert.strictEqual(r.decision, 'HUMAN_REVIEW');
      assert.strictEqual(r.riskLevel, 'HIGH');
    }
  });

  it('trust receipt is deterministic for the same input', () => {
    const a = classifyAgentAction({ category: 'NETWORK_CALL', target: { url: 'https://x' } });
    const b = classifyAgentAction({ category: 'NETWORK_CALL', target: { url: 'https://x' } });
    assert.deepStrictEqual(a, b);
  });

  it('trust receipt carries timestamp when supplied', () => {
    const r = classifyAgentAction({ category: 'DEPLOYMENT' }, { now: 1700000000000 });
    assert.strictEqual(r.trustReceipt.timestamp, '2023-11-14T22:13:20.000Z');
  });

  it('classify alias returns the same output as classifyAgentAction', () => {
    const a = classifyAgentAction({ category: 'READ_ONLY', target: { path: 'docs/x.md' } }, { allowlistedPaths: ['docs/'] });
    const b = classify({ category: 'READ_ONLY', target: { path: 'docs/x.md' } }, { allowlistedPaths: ['docs/'] });
    assert.deepStrictEqual(a, b);
  });

  it('normalizeActionDecision canonicalizes canonical objects', () => {
    const r = normalizeActionDecision({
      actionCategory: 'READ_ONLY',
      riskLevel: 'low',
      decision: 'allow',
      reasons: ['ok'],
      flags: ['alpha'],
    });
    assert.strictEqual(r.actionCategory, 'READ_ONLY');
    assert.strictEqual(r.riskLevel, 'LOW');
    assert.strictEqual(r.decision, 'ALLOW');
    assert.ok(Object.isFrozen(r));
  });
});
