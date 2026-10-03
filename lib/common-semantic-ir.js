'use strict';

/**
 * Read-only Common Semantic IR for the language baseline (#3312).
 *
 * The repository already parses language on four separate surfaces —
 * `command-parser` (intent), `predicate-parser` (verb relations),
 * `claim-decomposition` (subject/predicate/object) and `entity-resolution`
 * (canonical entities). Each has its own output shape and none of them is a
 * contract another phase can build on. This module is the thin adapter that
 * composes the existing parsers into one versioned, read-only semantic record
 * without rewriting any of them.
 *
 * Design rules, taken literally from the issue:
 *
 * - Existing parser outputs are preserved. The adapters call the real modules
 *   and never post-process a value back into a different one.
 * - Unsupported fields are explicit `unknown` diagnostics, never a silent
 *   drop. The record carries the ten declared fields; a field with no baseline
 *   parser says so instead of shipping an empty placeholder that reads as
 *   "measured none".
 * - Confidence is not calibrated in the baseline, so it stays `unknown/null`.
 * - Reference and ambiguity candidates are preserved for the caller to resolve
 *   rather than collapsed to a single guess.
 * - Read-only: nothing here mutates the graph, admits a belief or executes an
 *   action. Natural-language text is proposer data, never authority.
 *
 * `lib/inference-rule-ir.js` is a different, stricter contract (clauses,
 * atoms, unification) and is deliberately not reused here; semantic metadata
 * is not squeezed into it.
 */

const { parseCommand } = require('./command-parser');
const { decomposeClaim } = require('./claim-decomposition');
const { parsePredicate } = require('./predicate-parser');
const { resolveEntity } = require('./entity-resolution');

const COMMON_SEMANTIC_IR_VERSION = '1.0.0';

const STATUS = Object.freeze({ PRESENT: 'present', UNKNOWN: 'unknown' });

/** The ten fields the Common Semantic IR declares (language track L1). */
const SEMANTIC_IR_FIELDS = Object.freeze([
  'language',
  'intent',
  'entities',
  'relations',
  'claims',
  'constraints',
  'temporal',
  'modality',
  'references',
  'confidence',
]);

/** Languages the baseline can positively identify; anything else is unknown. */
const IDENTIFIED_LANGUAGES = Object.freeze(['tr', 'en']);

const TURKISH_CHARACTERS = /[çğıöşüÇĞİÖŞÜ]/;
const TURKISH_MARKERS = /\b(ve|bir|ile|için|icin|değil|degil|neden|olur|yapar|engeller|çok|cok|bu|şu|su)\b/i;
const ENGLISH_MARKERS = /\b(the|is|are|was|were|of|and|to|with|causes|prevents|requires|enables|triggers)\b/i;

function field(status, value, reason) {
  return reason === undefined
    ? { status, value }
    : { status, value, reason };
}

function present(value, reason) {
  return field(STATUS.PRESENT, value, reason);
}

function unknown(reason) {
  return field(STATUS.UNKNOWN, null, reason);
}

/**
 * Deterministic language identification from baseline markers only. A text
 * with no marker is `unknown` rather than guessed: the acceptance criterion is
 * that language cannot be silently mislabeled.
 */
function detectLanguage(text) {
  const source = String(text ?? '');
  if (!source.trim()) return 'unknown';
  if (TURKISH_CHARACTERS.test(source) || TURKISH_MARKERS.test(source)) return 'tr';
  if (ENGLISH_MARKERS.test(source)) return 'en';
  return 'unknown';
}

function defaultNormalizeWord(word) {
  return String(word ?? '').toLowerCase();
}

/** Read a claim's real predicate relation; null when the parser finds none. */
function relationFromPredicate(predicate, normalizeWord) {
  const text = String(predicate ?? '').trim();
  if (!text) return null;
  const parsed = parsePredicate(text, normalizeWord);
  if (!parsed || !parsed.object) return null;
  return {
    object: parsed.object,
    relation: parsed.relation,
    // Negation is a polarity the baseline parser already distinguishes
    // (`değil`); it is not a modality and is not merged into one.
    polarity: parsed.relation === 'değil' ? 'negative' : 'affirmative',
    restriction: Boolean(parsed.kistlama),
  };
}

function collectClaims(text, normalizeWord) {
  const decomposition = decomposeClaim(text);
  const claims = [];
  const relations = [];
  const constraints = [];
  for (const subclaim of decomposition.subclaims) {
    claims.push({
      id: subclaim.id,
      text: subclaim.claim,
      subject: subclaim.subject,
      predicate: subclaim.predicate,
      object: subclaim.object,
    });
    const relation = relationFromPredicate(subclaim.predicate, normalizeWord);
    if (relation) {
      relations.push({ subject: subclaim.subject || null, ...relation });
      if (relation.restriction) {
        constraints.push({ kind: 'restriction', subject: subclaim.subject || null, text: subclaim.predicate });
      }
    }
  }
  return { claims, relations, constraints, compound: decomposition.compound, warnings: decomposition.warnings };
}

function resolveEntities(claims, relations, domain) {
  const texts = [];
  for (const claim of claims) if (claim.subject) texts.push(claim.subject);
  for (const relation of relations) if (relation.object) texts.push(relation.object);

  const entities = [];
  const references = [];
  const seen = new Set();
  for (const text of texts) {
    const key = String(text).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const options = domain ? { domain } : {};
    const resolved = resolveEntity(key, options);
    if (resolved.matched) {
      entities.push({
        text: key,
        canonical: resolved.canonical,
        domain: resolved.domain,
        aliases: resolved.aliases || [],
      });
    } else if (resolved.ambiguous) {
      references.push({
        text: key,
        status: 'ambiguous',
        reason: resolved.reason,
        candidates: resolved.candidates || [],
      });
    } else {
      references.push({
        text: key,
        status: 'unresolved',
        reason: resolved.reason,
      });
    }
  }
  return { entities, references };
}

/**
 * Compose the existing parsers into a read-only Common Semantic IR record.
 *
 * @param {string|{text?: string, domain?: string, language?: string}} input
 * @param {object} [opts]
 * @param {(word: string) => string} [opts.normalizeWord] injected word normalizer
 * @returns {object} versioned, JSON-serializable semantic record
 */
function buildCommonSemanticIR(input, opts = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const text = String(typeof input === 'string' ? input : (source.text ?? '')).trim();
  const normalizeWord = typeof opts.normalizeWord === 'function' ? opts.normalizeWord : defaultNormalizeWord;

  if (!text) {
    return {
      version: COMMON_SEMANTIC_IR_VERSION,
      language: unknown('empty_text'),
      intent: unknown('empty_text'),
      entities: unknown('empty_text'),
      relations: unknown('empty_text'),
      claims: unknown('empty_text'),
      constraints: unknown('empty_text'),
      temporal: unknown('no_temporal_parser_in_baseline'),
      modality: unknown('no_modality_parser_in_baseline'),
      references: present([], 'empty_text'),
      confidence: unknown('baseline_confidence_is_not_calibrated'),
    };
  }

  const commanded = parseCommand(text);
  const intentValue = {
    name: commanded.command,
    args: commanded.args,
    workflowId: commanded.workflowId || null,
    source: 'command-parser',
  };

  const { claims, relations, constraints, compound, warnings } = collectClaims(text, normalizeWord);
  const domain = source.domain || opts.domain || undefined;
  const { entities, references } = resolveEntities(claims, relations, domain);
  const language = detectLanguage(text);

  return {
    version: COMMON_SEMANTIC_IR_VERSION,
    language: language === 'unknown'
      ? unknown('language_not_identified_from_baseline_markers')
      : present(language, 'baseline_marker_detection'),
    intent: commanded.command === 'anlamadım'
      ? unknown('command_not_recognized_by_baseline_parser')
      : present(intentValue, 'command-parser'),
    entities: entities.length > 0
      ? present(entities, 'entity-resolution')
      : unknown('no_entity_resolved_by_baseline_registry'),
    relations: relations.length > 0
      ? present(relations, 'predicate-parser')
      : unknown('no_relation_from_baseline_predicate_parser'),
    claims: present(claims, `claim-decomposition:compound=${compound};warnings=${warnings.join(',') || 'none'}`),
    constraints: constraints.length > 0
      ? present(constraints, 'predicate-parser:restriction')
      : unknown('no_constraint_parser_in_baseline'),
    temporal: unknown('no_temporal_parser_in_baseline'),
    modality: unknown('no_modality_parser_in_baseline'),
    references: present(references, 'entity-resolution:unresolved-or-ambiguous-candidates'),
    confidence: unknown('baseline_confidence_is_not_calibrated'),
  };
}

/**
 * Fail-closed structural validation of a record produced by
 * `buildCommonSemanticIR`. An untrusted caller (a plugin, a fixture, a future
 * language adapter) must not be able to pass a record that looks measured but
 * silently omits a field, marks it `present` with no value, or hides a value
 * behind `unknown`.
 *
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateCommonSemanticIR(ir) {
  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) {
    return { valid: false, errors: ['common semantic IR must be a non-array object'] };
  }
  const errors = [];
  if (ir.version !== COMMON_SEMANTIC_IR_VERSION) {
    errors.push(`version must be ${COMMON_SEMANTIC_IR_VERSION}, got ${JSON.stringify(ir.version ?? null)}`);
  }
  for (const name of SEMANTIC_IR_FIELDS) {
    const entry = ir[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${name} must be an object with {status, value}`);
      continue;
    }
    if (entry.status !== STATUS.PRESENT && entry.status !== STATUS.UNKNOWN) {
      errors.push(`${name}.status must be one of ${STATUS.PRESENT}|${STATUS.UNKNOWN}`);
      continue;
    }
    if (entry.status === STATUS.PRESENT && entry.value == null) {
      errors.push(`${name} claims present status but carries no value`);
    }
    if (entry.status === STATUS.UNKNOWN && entry.value != null) {
      errors.push(`${name} claims unknown status but carries a value`);
    }
  }
  const language = ir.language;
  if (language && language.status === STATUS.PRESENT && !IDENTIFIED_LANGUAGES.includes(language.value)) {
    errors.push(`language.value must be one of ${IDENTIFIED_LANGUAGES.join('|')} when present`);
  }
  const confidence = ir.confidence;
  if (confidence && confidence.status === STATUS.PRESENT) {
    if (typeof confidence.value !== 'number' || !Number.isFinite(confidence.value)
      || confidence.value < 0 || confidence.value > 1) {
      errors.push('confidence.value must be a finite number in [0, 1] when present');
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  COMMON_SEMANTIC_IR_VERSION,
  SEMANTIC_IR_FIELDS,
  IDENTIFIED_LANGUAGES,
  detectLanguage,
  buildCommonSemanticIR,
  validateCommonSemanticIR,
};
