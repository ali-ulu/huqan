'use strict';

/**
 * Contract tests for the read-only Common Semantic IR (#3312).
 *
 * The point of these tests is the *contract*, not the parsers: the IR composes
 * `command-parser`, `predicate-parser`, `claim-decomposition` and
 * `entity-resolution` without changing any of them, declares the ten language
 * fields, fails closed on the fields the baseline cannot measure, and never
 * turns ambiguous or unresolved text into a confident answer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COMMON_SEMANTIC_IR_VERSION,
  SEMANTIC_IR_FIELDS,
  IDENTIFIED_LANGUAGES,
  PACK_LANGUAGES,
  detectLanguage,
  buildCommonSemanticIR,
  validateCommonSemanticIR,
} = require('../lib/common-semantic-ir');
const { parseCommand } = require('../lib/command-parser');
const { parsePredicate } = require('../lib/predicate-parser');
const { decomposeClaim } = require('../lib/claim-decomposition');
const createNlp = require('../nlp');
const BASELINE_GOLDEN = require('./fixtures/common-semantic-ir-en-tr-baseline.golden.json');

const NORMALIZE = (word) => String(word);

test('the record declares its version and every one of the ten fields', () => {
  const ir = buildCommonSemanticIR('Deployment requires approval', { normalizeWord: NORMALIZE });
  assert.equal(ir.version, COMMON_SEMANTIC_IR_VERSION);
  for (const name of SEMANTIC_IR_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(ir, name), `${name} must be present`);
    assert.ok(ir[name] && typeof ir[name] === 'object', `${name} must be a {status,value} entry`);
  }
  assert.deepEqual(validateCommonSemanticIR(ir), { valid: true, errors: [] });
});

test('existing parser outputs are carried through unchanged, not re-derived', () => {
  const text = 'onayla ap-1';
  const ir = buildCommonSemanticIR(text, { normalizeWord: NORMALIZE });

  // Intent is the command-parser's output, verbatim.
  assert.equal(ir.intent.status, 'present');
  const commanded = parseCommand(text);
  assert.equal(ir.intent.value.name, commanded.command);
  assert.deepEqual(ir.intent.value.args, commanded.args);

  // Relations are the predicate-parser's output for the decomposed predicate.
  const decomposition = decomposeClaim(text);
  const expectedRelation = parsePredicate(decomposition.subclaims[0].predicate, NORMALIZE);
  assert.equal(ir.relations.value[0].object, expectedRelation.object);
  assert.equal(ir.relations.value[0].relation, expectedRelation.relation);

  // Claims are the decomposition's subclaims, one to one.
  assert.equal(ir.claims.value.length, decomposition.subclaims.length);
  assert.equal(ir.claims.value[0].subject, decomposition.subclaims[0].subject);
});

test('unmeasurable fields are explicit unknown diagnostics, never a silent drop', () => {
  const ir = buildCommonSemanticIR('Deployment requires approval', { normalizeWord: NORMALIZE });
  for (const name of ['temporal', 'modality', 'confidence']) {
    assert.equal(ir[name].status, 'unknown', `${name} is not measured by the baseline`);
    assert.equal(ir[name].value, null);
    assert.equal(typeof ir[name].reason, 'string');
    assert.ok(ir[name].reason.length > 0, `${name} must say why it is unknown`);
  }
  // Baseline confidence is explicitly not calibrated.
  assert.match(ir.confidence.reason, /not_calibrated/);
});

test('modality and time changes retain their unknown diagnostics', () => {
  const pairs = [
    ['modality', 'no_modality_parser_in_baseline',
      'The service is available', 'The service may be available'],
    ['temporal', 'no_temporal_parser_in_baseline',
      'The service is available', 'The service was available yesterday'],
  ];

  for (const [field, reason, baselineText, changedText] of pairs) {
    for (const text of [baselineText, changedText]) {
      const ir = buildCommonSemanticIR(text, { normalizeWord: NORMALIZE });
      assert.deepEqual(ir[field], { status: 'unknown', value: null, reason });
    }
  }
});

test('language identification is marker-based and falls back to unknown, never a guess', () => {
  assert.equal(detectLanguage('Deployment veritabanı zaman aşımı nedeniyle başarısız olur'), 'tr');
  assert.equal(detectLanguage('The deployment causes the incident'), 'en');
  assert.equal(detectLanguage('hello world'), 'unknown');

  const recognized = buildCommonSemanticIR('The deployment causes the incident');
  assert.equal(recognized.language.status, 'present');
  assert.equal(recognized.language.value, 'en');

  const unrecognized = buildCommonSemanticIR('hello world');
  assert.equal(unrecognized.language.status, 'unknown');
  assert.equal(unrecognized.language.value, null);
});

test('EN/TR pair agrees on the language-independent core fields', () => {
  const en = buildCommonSemanticIR('AI causes delay');
  const tr = buildCommonSemanticIR('AI gecikmeye neden olur');

  // Core parity is scoped to the fields that are genuinely language
  // independent at the baseline: the shared entity token (`AI`) must resolve
  // to the same subject and preserve the same ambiguity candidates in both
  // languages. Per-language surface text differs and is asserted separately,
  // so the parity claim never leans on a coincidence of wording.
  assert.equal(en.claims.value[0].subject, 'AI');
  assert.equal(tr.claims.value[0].subject, 'AI');
  const enAI = en.references.value.find((entry) => entry.text === 'AI');
  const trAI = tr.references.value.find((entry) => entry.text === 'AI');
  assert.deepEqual(enAI, trAI);
  // The only field that differs is the identified language.
  assert.equal(en.language.value, 'en');
  assert.equal(tr.language.value, 'tr');
});

test('negation changes polarity and is not swallowed as modality', () => {
  const positive = buildCommonSemanticIR('sistem çalışır', { normalizeWord: NORMALIZE });
  const negative = buildCommonSemanticIR('sistem çalışmaz', { normalizeWord: NORMALIZE });

  assert.equal(positive.relations.value[0].polarity, 'affirmative');
  assert.equal(negative.relations.value[0].polarity, 'negative');
  // Negation is represented in relations, not smuggled into the modality field
  // the baseline cannot measure.
  assert.equal(negative.modality.status, 'unknown');
});

test('non-Turkish negation is not reported as affirmative polarity', () => {
  // The baseline predicate parser only detects Turkish negation (`değil`);
  // for an English negation like "does not require" it measures no polarity,
  // so the IR must stay `unknown` instead of defaulting to `affirmative`.
  const ir = buildCommonSemanticIR('The deployment does not require approval');
  assert.equal(ir.language.value, 'en');
  assert.equal(ir.relations.status, 'present');
  assert.equal(ir.relations.value[0].polarity, 'unknown');
});

test('ambiguity is preserved as candidates and never silently resolved', () => {
  const ambiguous = buildCommonSemanticIR('AI helps');
  assert.equal(ambiguous.entities.status, 'unknown', 'AI must not be resolved without a domain');
  const ai = ambiguous.references.value.find((entry) => entry.text === 'AI');
  assert.equal(ai.status, 'ambiguous');
  assert.ok(ai.candidates.length >= 2, 'the competing canonicals must survive');

  // With a domain the caller has answered the ambiguity, and only then does it
  // become a resolved entity.
  const resolved = buildCommonSemanticIR('AI helps', { domain: 'tech' });
  assert.equal(resolved.entities.status, 'present');
  assert.equal(resolved.entities.value[0].canonical, 'artificial_intelligence');
});

test('empty input fails closed on every measured field', () => {
  const ir = buildCommonSemanticIR('   ');
  for (const name of SEMANTIC_IR_FIELDS) {
    if (name === 'references') continue;
    assert.equal(ir[name].status, 'unknown', `${name} must be unknown for empty input`);
  }
  assert.deepEqual(ir.references.value, []);
  assert.deepEqual(validateCommonSemanticIR(ir), { valid: true, errors: [] });
});

test('the IR is read-only: building it does not mutate the entity registry', () => {
  const before = require('../lib/entity-resolution').listAliases('tech');
  buildCommonSemanticIR('AI helps', { domain: 'tech' });
  const after = require('../lib/entity-resolution').listAliases('tech');
  assert.deepEqual(after, before);
});

test('the validator rejects records that look measured but are not', () => {
  const valid = buildCommonSemanticIR('The deployment causes the incident');

  const missingField = JSON.parse(JSON.stringify(valid));
  delete missingField.temporal;
  assert.equal(validateCommonSemanticIR(missingField).valid, false);

  const presentWithoutValue = JSON.parse(JSON.stringify(valid));
  presentWithoutValue.relations = { status: 'present', value: null };
  assert.equal(validateCommonSemanticIR(presentWithoutValue).valid, false);

  const unknownWithValue = JSON.parse(JSON.stringify(valid));
  unknownWithValue.modality = { status: 'unknown', value: 'possible' };
  assert.equal(validateCommonSemanticIR(unknownWithValue).valid, false);

  const unknownWithoutReason = JSON.parse(JSON.stringify(valid));
  unknownWithoutReason.modality = { status: 'unknown', value: null, reason: '  ' };
  assert.equal(validateCommonSemanticIR(unknownWithoutReason).valid, false);

  const badLanguage = JSON.parse(JSON.stringify(valid));
  badLanguage.language = { status: 'present', value: 'fr' };
  assert.equal(validateCommonSemanticIR(badLanguage).valid, false);

  const badConfidence = JSON.parse(JSON.stringify(valid));
  badConfidence.confidence = { status: 'present', value: 1.5 };
  assert.equal(validateCommonSemanticIR(badConfidence).valid, false);

  assert.equal(validateCommonSemanticIR(null).valid, false);
  assert.equal(validateCommonSemanticIR([]).valid, false);
});

// ---------------------------------------------------------------------------
// L2 language adapters (#3476): new languages read through the shipped `nlp/`
// packs. The contract is the track line "yeni dil semantic/policy core'u
// değiştirmez" -- same record, same validator, EN/TR unchanged.
// ---------------------------------------------------------------------------

test('EN/TR records are byte-identical to the pre-adapter baseline', () => {
  // The golden was produced by the L1 module *before* the adapters existed,
  // so this compares against the old code, not against the new code's output.
  assert.ok(BASELINE_GOLDEN.cases.length >= 20, 'the regression corpus must not shrink');
  for (const entry of BASELINE_GOLDEN.cases) {
    const ir = buildCommonSemanticIR(entry.text, { domain: entry.domain, normalizeWord: NORMALIZE });
    assert.deepEqual(ir, entry.ir, entry.text);
    // deepEqual ignores key order; the invariant is the serialized record.
    assert.equal(JSON.stringify(ir), JSON.stringify(entry.ir), entry.text);
  }
});

test('German and Arabic are identified; unmarked text still stays unknown', () => {
  assert.equal(detectLanguage('Die Bereitstellung erfordert eine Genehmigung'), 'de');
  assert.equal(detectLanguage('Katzen sind Tiere'), 'de');
  assert.equal(detectLanguage('القط هو حيوان'), 'ar');
  assert.equal(detectLanguage('hello world'), 'unknown');
  assert.equal(detectLanguage('Bereitstellung Genehmigung'), 'unknown');
  // Words German shares with English are not German evidence on their own.
  assert.equal(detectLanguage('war ended'), 'unknown');
  assert.equal(detectLanguage('die hard'), 'unknown');
});

test('mixed script follows the dominant script, not the first marker word', () => {
  // Arabic-led text with an English marker is Arabic and reaches the Arabic
  // pack; English-led text quoting an Arabic word stays English.
  assert.equal(detectLanguage('اقرأ the الملف'), 'ar');
  assert.equal(buildCommonSemanticIR('اقرأ the الملف').claims.reason, 'nlp-pack:arabic');
  assert.equal(detectLanguage('The word كتاب is a noun'), 'en');
});

test('shared ö/ü decides nothing alone: German evidence makes it German, otherwise Turkish', () => {
  // The baseline read every ö/ü as Turkish, which mislabeled German such as
  // "Größe ist für ...". That is the only baseline label the adapters change.
  assert.equal(detectLanguage('Die Größe ist für alle gleich'), 'de');
  assert.equal(detectLanguage('göz üzüm'), 'tr');
  // A Turkish-only letter or marker still wins over any German word.
  assert.equal(detectLanguage('Größe için bir değer'), 'tr');
});

test('a pack language carries its pack claims verbatim and measures nothing else', () => {
  for (const [language, text] of [
    ['de', 'der grosse hund ist ein tier'],
    ['ar', 'القط الكبير هو حيوان صغير'],
  ]) {
    const ir = buildCommonSemanticIR(text);
    const facts = createNlp(language).extractFacts(text);
    assert.equal(ir.language.value, language);
    assert.equal(ir.claims.status, 'present');
    assert.deepEqual(
      ir.claims.value.map(({ subject, predicate }) => ({ subject, predicate })),
      facts,
      `${language} claims are the pack's facts, not a re-derivation`,
    );
    // The command grammar and predicate parser are TR/EN: they are not run on
    // a language they were not written for.
    assert.deepEqual(ir.intent, { status: 'unknown', value: null, reason: `no_intent_parser_for_language:${language}` });
    assert.equal(ir.relations.status, 'unknown');
    assert.equal(ir.constraints.status, 'unknown');
    assert.equal(ir.confidence.status, 'unknown');
  }
});

test('every identified language satisfies the same record contract', () => {
  const samples = {
    tr: 'Kedi hayvandır',
    en: 'Cats are animals',
    de: 'Katzen sind Tiere',
    ar: 'القط هو حيوان',
  };
  for (const language of IDENTIFIED_LANGUAGES) {
    const text = samples[language];
    assert.ok(text, `${language} needs a contract sample`);
    const ir = buildCommonSemanticIR(text);
    assert.equal(ir.version, COMMON_SEMANTIC_IR_VERSION);
    assert.deepEqual(Object.keys(ir).filter((key) => key !== 'version'), [...SEMANTIC_IR_FIELDS]);
    assert.equal(ir.language.value, language);
    assert.deepEqual(validateCommonSemanticIR(ir), { valid: true, errors: [] }, language);
  }
  for (const language of PACK_LANGUAGES) assert.ok(IDENTIFIED_LANGUAGES.includes(language));
});
