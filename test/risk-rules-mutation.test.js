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


const EXPECTED_RISK_RULES = Object.freeze({
  WEAK_PARTIAL_MATCH: 'WEAK_PARTIAL_MATCH',
  HIGH_RISK_DOMAIN: 'HIGH_RISK_DOMAIN',
  ABSOLUTE_CLAIM: 'ABSOLUTE_CLAIM',
  SCOPE_EXPANSION: 'SCOPE_EXPANSION',
  RELATION_DRIFT: 'RELATION_DRIFT',
  MULTILINGUAL_AMBIGUITY: 'MULTILINGUAL_AMBIGUITY',
  PROVENANCE_MISSING: 'PROVENANCE_MISSING',
  DOUBLE_NEGATION: 'DOUBLE_NEGATION',
  WEASEL_WORDS: 'WEASEL_WORDS',
  STRAWMAN_ATTRIBUTION: 'STRAWMAN_ATTRIBUTION',
  ALIAS_NORMALIZATION: 'ALIAS_NORMALIZATION',
});

const EXPECTED_HIGH_RISK_DOMAINS = Object.freeze({
  medical: [
    'medical', 'medicine', 'aspirin', 'ilaç', 'tedavi', 'hastalık', 'kanser', 'aşı', 'insülin', 'hipertansiyon',
    'kan inceltici', 'kan pıhtılaştırıcı', 'doz', 'semptom',
  ],
  aviation: [
    'B737', 'A380', 'C172', 'EDDF', 'squawk', 'Mayday', 'Pan-Pan', 'TCAS', 'V1', 'VR', 'ISA', 'FAR Part 25',
    'aircraft', 'engine', 'emergency', 'distress', 'urgency', 'decision speed', 'rotation speed', 'transport category', 'normal category',
  ],
  legal: [
    'legal', 'hukuk', 'sözleşme', 'dava', 'kvkk', 'gdpr', 'izin', 'yasak', 'veri', 'mahremiyet', 'ceza',
  ],
  financial: [
    'finance', 'financial', 'bank', 'loan', 'credit', 'faiz', 'borsa', 'yatırım', 'para', 'risk',
  ],
  security: [
    'security', 'güvenlik', 'attack', 'exploit', 'vulnerability', 'saldırı', 'yetki', 'auth', 'authentication', 'authorization',
  ],
});

const EXPECTED_ABSOLUTE_TERMS = Object.freeze([
  'always', 'never', 'all', 'every', 'guaranteed', '100%', 'eliminate',
  'her zaman', 'asla', 'tüm', 'bütün', 'hiçbir', 'kesin', 'garanti',
  'yüzde yüz', 'daima', 'mutlaka',
]);

test('risk rule configuration is an independent exact contract', () => {
  assert.deepEqual(RISK_RULES, EXPECTED_RISK_RULES);
  assert.deepEqual(HIGH_RISK_DOMAINS, EXPECTED_HIGH_RISK_DOMAINS);
  assert.deepEqual(ABSOLUTE_TERMS, EXPECTED_ABSOLUTE_TERMS);
});

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

test('scope and relation detectors accept statement/claim/from/verb fallbacks', () => {
  const scope = detectScopeExpansion(
    { statement: 'cats sometimes purr' },
    { claim: 'cats always purr' },
  );
  assert.equal(scope.rule, RISK_RULES.SCOPE_EXPANSION);
  assert.equal(scope.meta.storedText, 'cats sometimes purr');
  assert.equal(scope.meta.incomingText, 'cats always purr');

  const relation = detectRelationDrift(
    { statement: 'alpha likes beta', from: 'alpha', verb: 'likes' },
    { claim: 'alpha hates beta', from: 'alpha', verb: 'hates' },
  );
  assert.equal(relation.rule, RISK_RULES.RELATION_DRIFT);
  assert.deepEqual(relation.meta, { storedRelation: 'likes', incomingRelation: 'hates' });

  const inferredSubject = detectRelationDrift('alpha likes beta', 'alpha hates beta');
  assert.equal(inferredSubject.rule, RISK_RULES.RELATION_DRIFT);
  assert.deepEqual(inferredSubject.meta, { storedRelation: '', incomingRelation: '' });
});

test('multilingual detector recognizes each supported non-Latin script independently', () => {
  for (const [text, script] of [
    ['abc مرحبا', 'rtl'],
    ['abc привет', 'cyrillic'],
    ['abc 世界', 'cjk'],
  ]) {
    const result = detectMultilingualAmbiguity(text);
    assert.equal(result.rule, RISK_RULES.MULTILINGUAL_AMBIGUITY, script);
    assert.ok(result.meta.scripts.includes('latin'), script);
    assert.ok(result.meta.scripts.includes(script), script);
  }

  for (const word of ['what', 'was', 'wo', 'welche', 'hangi', 'nedir', 'ne', 'quest', 'que']) {
    assert.ok(detectMultilingualAmbiguity(`${word} value`), word);
  }
});

test('runRiskRules accepts match from options and all incoming text aliases', () => {
  for (const incoming of [
    { text: 'medical always' },
    { statement: 'medical always' },
    { claim: 'medical always' },
    'medical always',
  ]) {
    const rules = runRiskRules({ incoming }, { match: { score: 0.1 } }).map(item => item.rule);
    assert.ok(rules.includes(RISK_RULES.WEAK_PARTIAL_MATCH));
    assert.ok(rules.includes(RISK_RULES.HIGH_RISK_DOMAIN));
    assert.ok(rules.includes(RISK_RULES.ABSOLUTE_CLAIM));
  }
});
