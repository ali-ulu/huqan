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
  detectLanguage,
  buildCommonSemanticIR,
  validateCommonSemanticIR,
} = require('../lib/common-semantic-ir');
const { parseCommand } = require('../lib/command-parser');
const { parsePredicate } = require('../lib/predicate-parser');
const { decomposeClaim } = require('../lib/claim-decomposition');

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
  badLanguage.language = { status: 'present', value: 'de' };
  assert.equal(validateCommonSemanticIR(badLanguage).valid, false);

  const badConfidence = JSON.parse(JSON.stringify(valid));
  badConfidence.confidence = { status: 'present', value: 1.5 };
  assert.equal(validateCommonSemanticIR(badConfidence).valid, false);

  assert.equal(validateCommonSemanticIR(null).valid, false);
  assert.equal(validateCommonSemanticIR([]).valid, false);
});
