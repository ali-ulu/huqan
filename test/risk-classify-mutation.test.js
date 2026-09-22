'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { describe, it } = require('node:test');

const { ACTION_CATEGORIES, classifyAgentAction } = require('../lib/risk-classify');

const NOW = '2026-01-01T00:00:00.000Z';
const TARGETS = [
  null,
  { path: 'docs/x.md' },
  { path: 'lib/x.js' },
  { path: 'lib/risk-rules.js' },
  { path: 'tmp/x.txt', env: 'production' },
  { url: 'https://api.axiom.local/health' },
  { url: 'https://unknown.example.com/x' },
  { value: 'canonical' },
];
const FLAG_SETS = [[], ['REAL_DB'], ['AUTO_MERGE'], ['EXPLICIT_HUMAN_APPROVAL']];
const OPTION_SETS = [
  { allowlistedPaths: ['docs/', 'tmp/'], allowlistedUrls: ['https://api.axiom.local'], now: NOW },
  { now: NOW },
];

const GOLDEN = {
  READ_ONLY: '68912f7f9443eff5d36921d60b7ac31f155f53dddf9a2848fac53bfdc664bf25',
  MEMORY_WRITE: '59e158e07c9fff17c3a2af6e865966fd01a5f94ade5d94746b88ac8fb6d54c29',
  CANONICAL_GRAPH_WRITE: '32970d86e06371182e0b0fca5137efd095f1c450cc048de5f12a74f261dfb71d',
  CODE_CHANGE: 'a30f6e1cdfddb24877751a37f350c1259cf47241a20c544720768e5b0b0c4d82',
  TEST_CHANGE: '2513a20a17884ffeff7db9097eb8dca64d145a79b84be100eb8c0e9f3f825cb1',
  SECURITY_POLICY_CHANGE: '602960a31fb3c910371d5f81c9d18667b395eca4557b31c99d34ef897501771d',
  DEPLOYMENT: '46aecb232595130a3099c01841bc8884c392e776ce608e9a9165fa8c468e6e7e',
  PERMISSION_CHANGE: '645d11cce79df928d379d18c1dce67570af95505e538075c3515aa709d6c43cc',
  FILESYSTEM_WRITE: '4f820d17d5426b21b582733e3fa69688558011f424679baecd5b7527d75bf22c',
  NETWORK_CALL: 'ccd87717ea4fff206cf23156e052c0027d9669658d6a850b9abe07be2790240d',
  TOOL_CHAIN_EXECUTION: '4c43784fb7ea3ca7e02d3a51822f919636f84daeb2593ebd3452e1858addcfb4',
  SANDBOX_SIMULATION: '1510932f082d27be1d06e2730fb71ac08e548062eff7a4f0996594ecd85c82c5',
  PRODUCTION_MUTATION: '241ddb942c2e162342bdc6d387d304443ee603b0b171149dd7832f4e3139831f',
  FINANCIAL_TRANSACTION: 'financial-policy-v1',
};

function outputsFor(category) {
  const outputs = [];
  for (const target of TARGETS) {
    for (const flags of FLAG_SETS) {
      for (const options of OPTION_SETS) {
        const input = { category, action: 'probe', flags };
        if (target) input.target = target;
        outputs.push(classifyAgentAction(input, options));
      }
    }
  }
  return outputs;
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

describe('risk classifier mutation contract', () => {
  it('pins every category across target, flag, and allowlist combinations', () => {
    assert.deepEqual(Object.keys(GOLDEN).sort(), Object.values(ACTION_CATEGORIES).sort());
    for (const category of Object.values(ACTION_CATEGORIES)) {
      if (category === ACTION_CATEGORIES.FINANCIAL_TRANSACTION) {
        for (const output of outputsFor(category)) {
          assert.equal(output.riskLevel, 'CRITICAL');
          assert.equal(output.reason, 'FINANCIAL_DETAILS_ABSENT');
          assert.ok(!output.flags.includes('UNKNOWN_ACTION_CATEGORY'));
          if (output.flags.includes('HARD_BLOCKED')) assert.equal(output.decision, 'BLOCK');
          else assert.equal(output.decision, 'HUMAN_REVIEW');
        }
        continue;
      }
      assert.equal(digest(outputsFor(category)), GOLDEN[category], category);
    }
  });
});
