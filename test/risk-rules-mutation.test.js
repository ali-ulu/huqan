'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ABSOLUTE_TERMS,
  HIGH_RISK_DOMAINS,
  RISK_RULES,
  detectAbsoluteClaim,
  detectHighRiskDomain,
  detectMultilingualAmbiguity,
  detectProvenanceMissing,
  detectRelationDrift,
  detectScopeExpansion,
  detectWeakPartialMatch,
  runRiskRules,
} = require('../lib/risk-rules');

test('every configured high-risk token remains reachable and mapped to its domain', () => {
  for (const [domain, tokens] of Object.entries(HIGH_RISK_DOMAINS)) {
    for (const token of tokens) {
      const result = detectHighRiskDomain(`prefix ${token} suffix`);
      assert.ok(result, `${domain} / ${token}`);
      assert.equal(result.rule, RISK_RULES.HIGH_RISK_DOMAIN);
      assert.equal(result.kind, 'risk');
      assert.equal(result.severity, 0.8);
      assert.equal(result.confidence, 0.9);
      assert.deepEqual(result.flags, [RISK_RULES.HIGH_RISK_DOMAIN]);
      assert.equal(result.meta.domain, domain);
      assert.deepEqual(result.evidence, [{ text: `prefix ${token} suffix`, role: 'input' }]);
    }
  }
  assert.equal(detectHighRiskDomain('ordinary gardening note'), null);
});

test('every configured absolute term remains reachable as a whole term', () => {
  for (const term of ABSOLUTE_TERMS) {
    const result = detectAbsoluteClaim(`prefix ${term} suffix`);
    assert.ok(result, term);
    assert.equal(result.rule, RISK_RULES.ABSOLUTE_CLAIM);
    assert.equal(result.severity, 0.7);
    assert.equal(result.confidence, 0.85);
    assert.deepEqual(result.flags, [RISK_RULES.ABSOLUTE_CLAIM]);
    assert.equal(result.meta.term, term);
  }
  for (const benign of ['install', 'small', 'fall', 'paragraf', 'paralel', 'tumor']) {
    assert.equal(detectAbsoluteClaim(benign), null, benign);
  }
});

test('weak partial-match rule distinguishes confidence, score and threshold', () => {
  assert.equal(detectWeakPartialMatch(null), null);
  assert.equal(detectWeakPartialMatch({ confidence: 0.5 }), null);
  assert.equal(detectWeakPartialMatch({ score: 0.5 }), null);

  const byConfidence = detectWeakPartialMatch({ confidence: 0.49, evidence: ['a'] }, { meta: { source: 'x' } });
  assert.deepEqual(byConfidence, {
    rule: RISK_RULES.WEAK_PARTIAL_MATCH,
    kind: 'risk',
    severity: 0.4,
    confidence: 0.7,
    flags: [RISK_RULES.WEAK_PARTIAL_MATCH],
    detail: 'Lexical overlap is weak and should not be treated as verified truth.',
    evidence: ['a'],
    meta: { confidence: 0.49, source: 'x' },
  });

  const byScore = detectWeakPartialMatch({ score: 0.2 });
  assert.equal(byScore.meta.confidence, 0.2);
  assert.deepEqual(byScore.evidence, []);
});

test('scope expansion only fires for a changed incoming absolute claim', () => {
  assert.equal(detectScopeExpansion('', 'always true'), null);
  assert.equal(detectScopeExpansion('cats purr', 'cats purr'), null);
  assert.equal(detectScopeExpansion('cats purr', 'cats sometimes purr'), null);

  const result = detectScopeExpansion(
    { text: 'cats sometimes purr' },
    { text: 'cats always purr' },
  );
  assert.equal(result.rule, RISK_RULES.SCOPE_EXPANSION);
  assert.equal(result.severity, 0.7);
  assert.equal(result.confidence, 0.8);
  assert.deepEqual(result.flags, [RISK_RULES.SCOPE_EXPANSION, RISK_RULES.ABSOLUTE_CLAIM]);
  assert.deepEqual(result.evidence, [
    { text: 'cats sometimes purr', role: 'stored' },
    { text: 'cats always purr', role: 'incoming' },
  ]);
  assert.deepEqual(result.meta, {
    storedText: 'cats sometimes purr',
    incomingText: 'cats always purr',
  });
});

test('relation drift pins subject and relation guards', () => {
  assert.equal(detectRelationDrift('', 'a likes b'), null);
  assert.equal(detectRelationDrift('a likes b', 'a likes b'), null);
  assert.equal(detectRelationDrift(
    { text: 'a likes b', subject: 'a', relation: 'likes' },
    { text: 'c hates b', subject: 'c', relation: 'hates' },
  ), null);
  assert.equal(detectRelationDrift(
    { text: 'a likes b', subject: 'a', relation: 'likes' },
    { text: 'a likes c', subject: 'a', relation: 'likes' },
  ), null);

  const result = detectRelationDrift(
    { text: 'a likes b', subject: 'a', relation: 'likes' },
    { text: 'a hates b', subject: 'a', relation: 'hates' },
  );
  assert.equal(result.rule, RISK_RULES.RELATION_DRIFT);
  assert.equal(result.severity, 0.55);
  assert.equal(result.confidence, 0.65);
  assert.deepEqual(result.meta, { storedRelation: 'likes', incomingRelation: 'hates' });
});

test('multilingual ambiguity distinguishes script mixing and question words', () => {
  assert.equal(detectMultilingualAmbiguity('plain declarative sentence'), null);
  const mixed = detectMultilingualAmbiguity('abc абв');
  assert.equal(mixed.rule, RISK_RULES.MULTILINGUAL_AMBIGUITY);
  assert.deepEqual(mixed.meta.scripts.sort(), ['cyrillic', 'latin']);

  const question = detectMultilingualAmbiguity('what happens here');
  assert.equal(question.rule, RISK_RULES.MULTILINGUAL_AMBIGUITY);
  assert.deepEqual(question.meta.scripts, ['latin']);
});

test('provenance missing accepts each supported provenance location', () => {
  assert.equal(detectProvenanceMissing({ provenance: { provenanceId: 'p' } }), null);
  assert.equal(detectProvenanceMissing({ provenance: { sourceRef: 's' } }), null);
  assert.equal(detectProvenanceMissing({ provenance: { sourceType: 'web' } }), null);
  assert.equal(detectProvenanceMissing({ provenanceId: 'p' }), null);
  assert.equal(detectProvenanceMissing({ sourceRef: 's' }), null);
  assert.equal(detectProvenanceMissing({ sourceType: 'web' }), null);
  assert.equal(detectProvenanceMissing({}, { provenanceId: 'p' }), null);
  assert.equal(detectProvenanceMissing({}, { sourceRef: 's' }), null);
  assert.equal(detectProvenanceMissing({}, { sourceType: 'web' }), null);

  const result = detectProvenanceMissing({});
  assert.deepEqual(result, {
    rule: RISK_RULES.PROVENANCE_MISSING,
    kind: 'risk',
    severity: 0.6,
    confidence: 0.85,
    flags: [RISK_RULES.PROVENANCE_MISSING],
    detail: 'Claim is missing provenance metadata.',
    evidence: [],
    meta: {},
  });
});

test('runRiskRules composes independent core detectors', () => {
  const rules = runRiskRules({
    incoming: { text: 'medical advice is always guaranteed' },
    match: { confidence: 0.1 },
  }).map(item => item.rule);
  assert.ok(rules.includes(RISK_RULES.WEAK_PARTIAL_MATCH));
  assert.ok(rules.includes(RISK_RULES.HIGH_RISK_DOMAIN));
  assert.ok(rules.includes(RISK_RULES.ABSOLUTE_CLAIM));
  assert.ok(rules.includes(RISK_RULES.PROVENANCE_MISSING));
});
