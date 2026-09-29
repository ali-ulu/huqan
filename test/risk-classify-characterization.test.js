'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { describe, it } = require('node:test');

// #2120: lib/risk-classify.js is split into lib/risk-classify-*.js parts. The
// per-category classifyAgentAction digests live in risk-category-rules.test.js;
// this file pins every OTHER exported function of the public surface over an
// input grid to digests recorded on main before the split, so a move that
// changes any normalizer, matcher, hard-block rule or receipt shape by one
// byte goes red here.

const rc = require('../lib/risk-classify');
const normalize = require('../lib/risk-classify-normalize');
const { CATEGORY_ALIASES } = require('../lib/risk-policy-constants');

const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const NOW = '2026-01-01T00:00:00.000Z';

const CATEGORY_TOKENS = [
  ...Object.values(rc.ACTION_CATEGORIES),
  ...Object.keys(CATEGORY_ALIASES),
  'read-only', ' code change ', 'code__change', 'nope', '', null, undefined, 42,
];
const PATHS = [
  '', '   ', 'docs', 'docs/', 'docs/x.md', 'docs/../lib/x.js', 'C:\\repo\\docs\\x.md',
  '//docs//x.md', 'lib/risk-rules.js', 'LIB/RISK-RULES.JS', 'lib/risk-rules.js.bak',
  'mykernel.js', 'kernel.js', 'src/kernel.js', 'package.json', 'notpackage.json',
  '/home/user/../../etc/passwd', '.', 'tmp/x.txt', 7, null,
];
const PATH_LISTS = [[], ['docs'], ['docs/'], ['docs', 'tmp/'], ['/home/user'], 'docs', null, [''], ['.']];
const URLS = [
  'https://api.axiom.local/health', 'https://api.axiom.local', 'https://api.axiom.local/', 'https://api.axiom.local/v1/x',
  'https://api.axiom.local/v10', 'http://api.axiom.local/health', 'https://api.axiom.local:8443/health',
  'https://evil.example/x', 'https://api.axiom.local/%2fx', 'https://api.axiom.local/a%5Cb', 'not a url', '', null,
];
const URL_LISTS = [[], ['https://api.axiom.local'], ['https://api.axiom.local/v1'], ['https://api.axiom.local/v1/'], 'https://api.axiom.local', ['bad url'], null];
const TARGETS = [
  null, undefined, 'plain-string', 42, { path: 'docs/x.md' }, { path: 'lib/risk-rules.js' },
  { path: '/srv/prod/app.js' }, { resolvedPath: 'srv/live/x' }, { value: 'canonical' }, { env: 'production' },
  { url: 'https://evil.example/x' }, { path: 'docs/x.md', url: 'https://api.axiom.local/health' },
];
const FLAG_SETS = [
  [], ['auto-merge'], ['AUTO_DEPLOYMENT'], ['self escalate'], ['bypass-admission'], ['real-db'], ['ungated'],
  ['production'], ['explicit_human_approval'], ['custom-flag'], 'AUTO_MERGE', null,
];

function results(fn, inputs) {
  return inputs.map((args) => {
    try {
      return { ok: fn(...args) };
    } catch (error) {
      return { threw: error.message };
    }
  });
}

function cartesian(...lists) {
  return lists.reduce((acc, list) => acc.flatMap((prefix) => list.map((item) => [...prefix, item])), [[]]);
}

const CASES = {
  normalizeActionType: () => results(rc.normalizeActionType, CATEGORY_TOKENS.map((t) => [t])),
  normalizeDecision: () => results(rc.normalizeDecision, ['allow', ' Block ', 'quarantine', 'human_review', 'x', '', null, 3].map((d) => [d])),
  resolveRiskLevel: () => results(rc.resolveRiskLevel, CATEGORY_TOKENS.map((t) => [t])),
  deriveDecision: () => results(rc.deriveDecision, cartesian(['low', 'MEDIUM', 'High', 'CRITICAL', 'x', null], [false, true])),
  isPathInList: () => results(rc.isPathInList, cartesian(PATHS, PATH_LISTS)),
  isPathSecuritySensitive: () => results(rc.isPathSecuritySensitive, [...PATHS, ...rc.SECURITY_SENSITIVE_PATH_TOKENS].map((p) => [p])),
  isUrlInList: () => results(rc.isUrlInList, cartesian(URLS, URL_LISTS)),
  normalizeActionRequest: () => results(rc.normalizeActionRequest, [
    [null], ['x'], [[]], [{}],
    ...cartesian(['CODE_CHANGE', 'read', 'nope'], TARGETS.slice(0, 6), FLAG_SETS.slice(0, 6)).map(([category, target, flags]) => [
      { category, target, flags, context: { flags: ['real-db'], allowlistedPaths: ['docs'] }, action: 'a', now: 5, reason: 'r' },
    ]),
    [{ actionType: 'deploy', timestamp: NOW, action: 7, reason: 9, context: 'bad' }],
    [{ type: 'network', context: { flags: 'ungated' } }],
  ]),
  classifyActionCategory: () => results(rc.classifyActionCategory, [
    [null], [{}], ...CATEGORY_TOKENS.map((t) => [{ category: t }]), [{ actionType: 'deploy' }], [{ type: 'read' }],
  ]),
  applyHardBlockRules: () => results(rc.applyHardBlockRules, cartesian(
    [...Object.values(rc.ACTION_CATEGORIES), null],
    TARGETS,
    FLAG_SETS,
  ).map(([category, target, flags]) => [
    { flags, context: { flags: ['custom'] } },
    { category, target, flags: ['seed'], reasons: ['seed reason'], decision: 'ALLOW', riskLevel: 'LOW' },
  ]).concat([[null, { category: 'READ_ONLY' }], [undefined, {}]])),
  normalizeActionDecision: () => results(rc.normalizeActionDecision, [
    [null], ['x'], [[]], [{}],
    [{ ok: false, actionType: 'deploy', riskLevel: 'low', decision: 'allow', reasons: ['a', 'a', 'b'], flags: 'F', hardBlocked: 1, policyVersion: 'p', target: 'x', reason: 'why' }],
    [{ category: 'read', trustReceipt: 'bad' }],
    [{ actionCategory: 'network', trustReceipt: { decision: 'block', riskLevel: 'critical', reasons: ['r'], flags: ['f'], timestamp: 0, target: { path: 'p' } } }],
    [{ trustReceipt: { timestamp: new Date(0) }, reasons: ['first'] }],
    [{ trustReceipt: { timestamp: new Date('nope') }, target: 5 }],
    [{ trustReceipt: { timestamp: '  ' }, policyVersion: 3 }],
    [{ trustReceipt: { timestamp: { x: 1 }, reason: 'rr' } }],
  ]),
  classifyAgentAction: () => results(rc.classifyAgentAction, [
    [null], ['x'], [{}], [{ category: 'nope', flags: ['auto-merge'] }, { flags: ['real-db'], now: 1 }],
    ...cartesian(['read', 'fs-write', 'network', 'sandbox', 'tool-chain', 'memory', 'financial'], TARGETS, [[], ['auto-merge'], ['real-db'], ['ungated']]).map(([category, target, flags]) => [
      { category, target, flags, context: { allowlistedPaths: ['docs'], allowlistedUrls: ['https://api.axiom.local'], financial: { amount: 5, destination: 'acct', currency: 'usd' } } },
      { now: new Date(0) },
    ]),
    [{ category: 'FINANCIAL_TRANSACTION', context: { financial: { amount: 1e9, destination: 'x', reversible: true } } }, { now: NOW, allowlistedPaths: 'docs' }],
    [{ category: 'READ_ONLY', target: { path: 'lib/x.js' }, now: 'later' }, { context: { flags: ['self-escalation'] } }],
  ]),
  classifyIsAlias: () => [rc.classify === rc.classifyAgentAction || digest(rc.classify({ category: 'read' }, { now: NOW })) === digest(rc.classifyAgentAction({ category: 'read' }, { now: NOW }))],
  exportShape: () => Object.keys(rc).map((key) => [key, typeof rc[key]]),
};

// Recorded on origin/main b4caed4f (before the #2120 split).
const GOLDEN = {
  normalizeActionType: '6134f68d0b4b15364da6fb22bb48f0565d946f5e0cc28d490409b3b115bddd25',
  normalizeDecision: '03487754a4855f27ebddd9af224f5e06492811af3ff8d5df586c5da7297b3807',
  resolveRiskLevel: '90673d9a797c0285139e348e9f7ef02bd4e0384fdd6e2c75e809db6a218305b2',
  deriveDecision: '048584a622ac0db995031f8fa5430bfa59a893bf5598c839a59a689778d5d73d',
  isPathInList: '9b6d66928648caf952b74a68b11d5a10976377f4116ad082093f831ac882b5ec',
  isPathSecuritySensitive: 'f76c82a29e3944339a02ca10f61bd3947efcc1da6380a4787f810c9a0e4856a8',
  isUrlInList: '479b097f9141fbe8b75d1fc149737c6b7d34234c721390753063b9dcec17888e',
  normalizeActionRequest: 'eb5745d1ace46d9bad6f8241c40a9521091589b1e55880b459687d2696a10c17',
  classifyActionCategory: '0cb2e5d76f0f35c08995467ec6730a1cad2122d20dd850b48eaa62909298887f',
  applyHardBlockRules: '1557c5862521f2e27068fe80add536f7581974dd1d0889a541f81cac8d592229',
  normalizeActionDecision: '927ed3d05c1025374819fc7e3d577a2250fba58e44c0b937d4c0ba0138012fe8',
  classifyAgentAction: '83e250eb352e00f24e15c88b868777d0b03d088b369b476fea6b8aa1b6d614fa',
  classifyIsAlias: '1c28f2eb0958c3d15db1f0f0e7f2b8998ca2b8f67ab426a1fbb3d561fe76fad9',
  exportShape: '2eb3a3fa855bc6f48aac9fbd9560e38e38c8f9091d3f2aa31c3e3042e396627f',
};

describe('risk-classify public surface is byte-identical across the #2120 split', () => {
  it('pins every case', () => {
    assert.deepEqual(Object.keys(GOLDEN).sort(), Object.keys(CASES).sort());
  });
  for (const [name, run] of Object.entries(CASES)) {
    it(`${name} output matches its recorded digest`, () => {
      assert.equal(digest(run()), GOLDEN[name]);
    });
  }
});

// Mutation edge coverage for the #2120 split: every branch the digest grid
// leaves unobserved in lib/risk-classify-normalize.js and lib/risk-classify.js.
describe('risk-classify split edge branches (mutation)', () => {
  it('deepFreeze freezes nested objects and passes frozen/primitive input through', () => {
    const nested = { leaf: 1 };
    const root = { nested, list: [1] };
    const frozen = normalize.deepFreeze(root);
    assert.equal(frozen, root);
    assert.equal(Object.isFrozen(root), true);
    assert.equal(Object.isFrozen(nested), true);
    const already = Object.freeze({ inner: {} });
    assert.equal(normalize.deepFreeze(already), already);
    assert.equal(Object.isFrozen(already.inner), false);
    assert.equal(normalize.deepFreeze(42), 42);
    assert.equal(normalize.deepFreeze(null), null);
  });

  it('toArray and uniqueStrings coerce arrays element-wise', () => {
    assert.deepEqual(normalize.toArray([0, 'a', '', null, 'b']), ['a', 'b']);
    assert.deepEqual(normalize.toArray('x'), ['x']);
    assert.deepEqual(normalize.toArray(null), []);
    assert.deepEqual(normalize.uniqueStrings(['a', '', null, 'a']), ['a']);
  });

  it('normalizeActionType rejects empty input and accepts canonical tokens', () => {
    assert.equal(normalize.normalizeActionType(null), null);
    assert.equal(normalize.normalizeActionType(''), null);
    assert.equal(normalize.normalizeActionType('   '), null);
    const canonical = Object.values(rc.ACTION_CATEGORIES)[0];
    assert.equal(normalize.normalizeActionType(canonical), canonical);
  });

  it('normalizeCategoryToken collapses triple separators', () => {
    assert.equal(normalize.normalizeActionType('code___change'), 'CODE_CHANGE');
    assert.equal(normalize.normalizeActionType('code---change'), 'CODE_CHANGE');
  });

  it('normalizeTimestamp accepts null, Date, epoch and blank input', () => {
    assert.equal(normalize.normalizeTimestamp(null), null);
    assert.equal(normalize.normalizeTimestamp(undefined), null);
    assert.equal(normalize.normalizeTimestamp(new Date(0)), '1970-01-01T00:00:00.000Z');
    assert.equal(normalize.normalizeTimestamp(0), '1970-01-01T00:00:00.000Z');
    assert.equal(normalize.normalizeTimestamp(NaN), null);
    assert.equal(normalize.normalizeTimestamp('  '), null);
    assert.equal(normalize.normalizeTimestamp('2026-01-01'), '2026-01-01');
  });

  it('cloneTarget wraps string targets', () => {
    assert.deepEqual(normalize.cloneTarget('plain-string'), { value: 'plain-string' });
    assert.equal(normalize.cloneTarget(null), null);
  });

  it('normalizeFlags folds case, dashes and triple underscores into aliases', () => {
    assert.deepEqual(normalize.normalizeFlags(['Bypass-Admission']), [rc.FLAGS.BYPASS_ADMISSION]);
    assert.deepEqual(normalize.normalizeFlags([' AUTO_MERGE ']), [rc.FLAGS.AUTO_MERGE]);
    assert.deepEqual(normalize.normalizeFlags(['auto-merge']), [rc.FLAGS.AUTO_MERGE]);
    assert.deepEqual(normalize.normalizeFlags(['auto___merge']), [rc.FLAGS.AUTO_MERGE]);
  });

  it('classifyAgentAction defaults allowlists to empty and reviews plain reads', () => {
    const out = rc.classifyAgentAction({ category: 'read', target: { path: 'docs/x.md' } });
    assert.equal(out.decision, rc.ACTION_DECISIONS.HUMAN_REVIEW);
  });

  it('classifyAgentAction echoes an explicit timestamp option in the trust receipt', () => {
    const out = rc.classifyAgentAction(
      { category: 'deploy' },
      { now: '2026-06-01T00:00:00.000Z' },
    );
    assert.equal(out.trustReceipt.timestamp, '2026-06-01T00:00:00.000Z');
  });

  it('classifyAgentAction hard-blocks auto-merge with flag and rule reason', () => {
    const out = rc.classifyAgentAction({ category: 'read', flags: ['auto-merge'] });
    assert.equal(out.decision, rc.ACTION_DECISIONS.BLOCK);
    assert.equal(out.flags.includes(rc.FLAGS.HARD_BLOCKED), true);
    assert.equal(out.reason, 'Read-only action stays low risk.');
  });

  it('classifyAgentAction honors context allowlists for writes', () => {
    const allowed = rc.classifyAgentAction(
      { category: 'fs-write', target: { path: 'docs/x.md' }, context: { allowlistedPaths: ['docs'] } },
      { now: NOW },
    );
    const denied = rc.classifyAgentAction(
      { category: 'fs-write', target: { path: 'docs/x.md' } },
      { now: NOW },
    );
    assert.notEqual(allowed.decision, denied.decision);
  });

  it('classifyAgentAction default-deny matches no invented allowlist entry', () => {
    const pathOut = rc.classifyAgentAction(
      { category: 'fs-write', target: { path: 'Stryker was here' } },
      { now: NOW },
    );
    assert.equal(pathOut.decision, rc.ACTION_DECISIONS.HUMAN_REVIEW);
    assert.equal(pathOut.reason, 'Filesystem write requires review.');
    const urlOut = rc.classifyAgentAction(
      { category: 'NETWORK_CALL', target: { url: 'https://stryker-was-here.invalid/x' } },
      { now: NOW },
    );
    assert.equal(urlOut.decision, rc.ACTION_DECISIONS.HUMAN_REVIEW);
  });

  it('classifyAgentAction marks security policy blocks as hard-blocked', () => {
    const out = rc.classifyAgentAction({ category: 'SECURITY_POLICY_CHANGE' }, { now: NOW });
    assert.equal(out.decision, rc.ACTION_DECISIONS.BLOCK);
    assert.equal(out.flags.includes(rc.FLAGS.HARD_BLOCKED), true);
  });

  it('classifyAgentAction hard-blocks over-mandate financial transfers', () => {
    const out = rc.classifyAgentAction(
      { category: 'FINANCIAL_TRANSACTION', context: { financial: { amount: 5000, currency: 'USD', destination: 'acct', reversible: true } } },
      { now: NOW },
    );
    assert.equal(out.decision, rc.ACTION_DECISIONS.BLOCK);
    assert.equal(out.flags.includes(rc.FLAGS.HARD_BLOCKED), true);
    assert.equal(out.reason, 'FINANCIAL_TIER_MANDATE_BLOCK');
  });
});
