const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  CONTRADICTION_RULES,
  detectNumericalConflict,
  detectValueConflict,
  detectTypeConflict,
  detectPredicateDrift,
  detectNegationConflict,
  detectUnitConflict,
  detectRelationInversion,
  detectSemanticOpposition,
  runContradictionRules,
} = require('../lib/contradiction-rules');

describe('contradiction-rules', () => {
  it('emits normalized numerical conflict signals', () => {
    const signal = detectNumericalConflict(
      { text: 'B737 has 2 engines', subject: 'B737' },
      { text: 'B737 has 4 engines', subject: 'B737' },
    );

    assert.ok(signal);
    assert.strictEqual(signal.rule, CONTRADICTION_RULES.NUMERICAL_CONFLICT);
    assert.strictEqual(signal.kind, 'contradiction');
    assert.ok(signal.flags.includes('NUMERICAL_CONFLICT'));
  });

  it('emits deterministic value conflict signals', () => {
    const signal = detectValueConflict(
      { text: 'EDDF is in Frankfurt', subject: 'EDDF' },
      { text: 'EDDF is in Paris', subject: 'EDDF' },
    );

    assert.ok(signal);
    assert.strictEqual(signal.rule, CONTRADICTION_RULES.VALUE_CONFLICT);
    assert.ok(signal.flags.includes('VALUE_CONFLICT'));
  });

  it('emits type conflict for known disjoint pairs', () => {
    const signal = detectTypeConflict(
      { text: 'C172 is piston aircraft', subject: 'C172', object: 'piston aircraft' },
      { text: 'C172 is jet aircraft', subject: 'C172', object: 'jet aircraft' },
    );

    assert.ok(signal);
    assert.strictEqual(signal.rule, CONTRADICTION_RULES.TYPE_CONFLICT);
  });

  it('emits relation drift for semantic mismatch', () => {
    const signal = detectPredicateDrift(
      { text: 'TCAS detects traffic', subject: 'TCAS', relation: 'detects traffic' },
      { text: 'TCAS is weather radar', subject: 'TCAS', relation: 'is weather radar' },
    );

    assert.ok(signal);
    assert.strictEqual(signal.rule, CONTRADICTION_RULES.PREDICATE_DRIFT);
    assert.ok(signal.flags.includes('RELATION_DRIFT'));
  });

  it('emits negation conflict for English and Turkish negation tokens', () => {
    const english = detectNegationConflict(
      { text: 'B737 has 2 engines', subject: 'B737' },
      { text: 'B737 does not have 2 engines', subject: 'B737' },
    );
    const turkish = detectNegationConflict(
      { text: 'B737 has 2 engines', subject: 'B737' },
      { text: 'B737 2 engine değildir', subject: 'B737' },
    );

    assert.ok(english);
    assert.ok(turkish);
    assert.strictEqual(english.rule, CONTRADICTION_RULES.NEGATION_CONFLICT);
    assert.strictEqual(turkish.rule, CONTRADICTION_RULES.NEGATION_CONFLICT);
  });

  it('emits semantic opposition when registry supports it', () => {
    const signal = detectSemanticOpposition(
      { text: 'aspirin kan inceltici olarak etki eder', subject: 'aspirin' },
      { text: 'aspirin kan pıhtılaştırıcı olarak etki eder', subject: 'aspirin' },
    );

    assert.ok(signal);
    assert.strictEqual(signal.rule, CONTRADICTION_RULES.SEMANTIC_OPPOSITION);
    assert.ok(signal.flags.includes('SEMANTIC_OPPOSITION'));
  });

  it('returns no contradiction for unrelated claims', () => {
    const signals = runContradictionRules(
      { text: 'aspirin kan inceltici olarak etki eder', subject: 'aspirin' },
      { text: 'aspirin beyaz tablettir', subject: 'aspirin' },
    );

    assert.ok(Array.isArray(signals));
    assert.strictEqual(signals.length, 0);
  });

  it('supports unit conflict detection', () => {
    const signal = detectUnitConflict(
      { text: 'ISA sea level temperature is 15 celsius', subject: 'ISA' },
      { text: 'ISA sea level temperature is 0 celsius', subject: 'ISA' },
    );

    assert.ok(signal);
    assert.strictEqual(signal.rule, CONTRADICTION_RULES.UNIT_CONFLICT);
  });

  it('does not flag meter vs metre with the same value as a unit conflict (regression)', () => {
    // "meter" (US) and "metre" (UK/TR) are the same unit. Without canonical
    // normalization these would be flagged as a unit conflict even when the
    // numeric value is identical.
    const signal = detectUnitConflict(
      { text: 'wingspan is 10 meter', subject: 'wingspan' },
      { text: 'wingspan is 10 metre', subject: 'wingspan' },
    );
    assert.strictEqual(signal, null);
  });

  it('still flags meter vs metre when the numeric value differs', () => {
    const signal = detectUnitConflict(
      { text: 'wingspan is 10 meter', subject: 'wingspan' },
      { text: 'wingspan is 20 metre', subject: 'wingspan' },
    );
    assert.ok(signal);
    assert.strictEqual(signal.rule, CONTRADICTION_RULES.UNIT_CONFLICT);
  });

  it('supports relation inversion when opposition is known', () => {
    const signal = detectRelationInversion(
      { text: 'Mayday is distress call', subject: 'Mayday', relation: 'is' },
      { text: 'Mayday is urgency call', subject: 'Mayday', relation: 'is' },
    );

    assert.ok(signal);
    assert.strictEqual(signal.rule, CONTRADICTION_RULES.RELATION_INVERSION);
  });

  it('does not false-positive on negation tokens inside other words (#434)', () => {
    // "no" is a negation token, but it must not match inside "snow", "knowledge",
    // or "nope" (substring match was the old buggy behavior).
    // Two identical affirmative claims about "snow" must not be flagged.
    const signal = detectNegationConflict(
      { text: 'snow is white', subject: 'snow' },
      { text: 'snow is white', subject: 'snow' },
    );
    assert.strictEqual(signal, null);
  });

  it('detects negation conflict when a Turkish subject carries a suffix (#434)', () => {
    // stripSubject previously used \b which is ASCII-only and failed to match
    // Turkish letters (ç, ğ, ı, ş, ü, ö). With Unicode-aware boundaries the
    // subject "kuşun" (with Turkish ş) must be stripped correctly so the
    // predicate overlap check can pass.
    const signal = detectNegationConflict(
      { text: 'kuşun yuvası yüksektedir', subject: 'kuşun' },
      { text: 'kuşun yuvası yüksekte değildir', subject: 'kuşun' },
    );
    assert.ok(signal);
    assert.strictEqual(signal.rule, CONTRADICTION_RULES.NEGATION_CONFLICT);
  });
});
