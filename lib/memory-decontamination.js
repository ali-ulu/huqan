'use strict';

/**
 * Memory decontamination scoring — the measurement behind #3464 (R09).
 *
 * A memory loop that learns from its own output contaminates itself: a record
 * the system generated, recalled, and re-learned looks like independent
 * evidence when it is only an echo. `lm_eval/decontamination/decontaminate.py`
 * (see #3288, recommendation O4) answers the same question for benchmark
 * corpora with n-gram overlap against the training set; this module ports that
 * discipline to memory recall.
 *
 * Given a record's text and a caller-supplied corpus (source texts, training
 * material, or any reference set the recall must not echo), it reports a
 * containment score in [0, 1]: what fraction of the record's n-grams also
 * occurs in the most overlapping corpus entry. A score at or above the
 * threshold marks the record contaminated.
 *
 * Deliberate constraints, mirroring lib/memory-recall-gate.js:
 *
 * 1. **Pure and deterministic.** No I/O, no randomness, no wall-clock reads.
 *    The same (text, corpus, ngramSize) always yields the same score, so the
 *    measurement is repeatable across runs and machines.
 * 2. **It scores; it does not decide.** The recall gate
 *    (lib/memory-recall-gate.js) owns the admit/degrade/withhold verdict and
 *    reuses this module for the overlap signal only.
 * 3. **Bounded inputs.** Corpus size, entry length and record length are
 *    capped; anything over the cap is a validation error, never a silent
 *    truncation, so a caller cannot accidentally measure a prefix and call it
 *    the whole.
 */

const { meaningfulTokens, normalizeFuzzyText } = require('./fuzzy-normalization');

const MEMORY_DECONTAMINATION_VERSION = 'huqan-memory-decontamination-v1';
const DEFAULT_NGRAM_SIZE = 8;
const DEFAULT_THRESHOLD = 0.8;
const MIN_NGRAM_SIZE = 3;
const MAX_NGRAM_SIZE = 32;
const MAX_CORPUS_ENTRIES = 256;
const MAX_ENTRY_CHARS = 20000;
const MAX_TEXT_CHARS = 200000;

/**
 * Deterministic content projection for scoring. String content is measured
 * as-is; anything else is serialized with sorted object keys so key order
 * cannot move the score. Lives here — not in lib/receipt — because the
 * recall gate (Adapters ring) may not require the receipt layer; the scoring
 * needs a stable string, not a receipt hash.
 *
 * @param {*} content record content
 * @returns {string} '' when there is nothing measurable
 */
function projectContentText(content) {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  return stableProjection(content);
}

function stableProjection(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableProjection).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableProjection(value[k])}`).join(',')}}`;
  }
  return '';
}

function ngramSet(tokens, n) {
  // Joined on a single space: tokens never contain whitespace (they come out
  // of the whitespace-collapsing normalizer), so the join is injective and no
  // out-of-band separator — in particular no control character — is needed.
  const grams = new Set();
  for (let i = 0; i + n <= tokens.length; i += 1) {
    grams.add(tokens.slice(i, i + n).join(' '));
  }
  return grams;
}

function countIntersection(small, big) {
  let matched = 0;
  for (const gram of small) {
    if (big.has(gram)) matched += 1;
  }
  return matched;
}

/**
 * Validate the shared scoring options. Returns `{ ok, value }` or
 * `{ ok: false, errors }`; the gate treats the latter as fail-closed.
 */
function validateScoringOptions(options = {}) {
  const errors = [];
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    return { ok: false, errors: [{ code: 'VALIDATION_ERROR', field: 'decontamination', message: 'decontamination must be an object' }] };
  }
  if (!Array.isArray(options.corpus)) {
    errors.push({ code: 'VALIDATION_ERROR', field: 'decontamination.corpus', message: 'decontamination.corpus must be an array of strings' });
  }
  let threshold = DEFAULT_THRESHOLD;
  if (options.threshold !== undefined) {
    const parsed = Number(options.threshold);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      errors.push({ code: 'VALIDATION_ERROR', field: 'decontamination.threshold', message: 'decontamination.threshold must be between 0 and 1' });
    } else {
      threshold = parsed;
    }
  }
  let ngramSize = DEFAULT_NGRAM_SIZE;
  if (options.ngramSize !== undefined) {
    const parsed = Number(options.ngramSize);
    if (!Number.isInteger(parsed) || parsed < MIN_NGRAM_SIZE || parsed > MAX_NGRAM_SIZE) {
      errors.push({
        code: 'VALIDATION_ERROR',
        field: 'decontamination.ngramSize',
        message: `decontamination.ngramSize must be an integer between ${MIN_NGRAM_SIZE} and ${MAX_NGRAM_SIZE}`,
      });
    } else {
      ngramSize = parsed;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { corpus: options.corpus, threshold, ngramSize } };
}

function validateCorpus(corpustext) {
  const errors = [];
  if (corpustext.length > MAX_CORPUS_ENTRIES) {
    errors.push({ code: 'VALIDATION_ERROR', field: 'decontamination.corpus', message: `decontamination.corpus holds at most ${MAX_CORPUS_ENTRIES} entries` });
    return { ok: false, errors };
  }
  for (let i = 0; i < corpustext.length; i += 1) {
    if (typeof corpustext[i] !== 'string') {
      errors.push({ code: 'VALIDATION_ERROR', field: `decontamination.corpus[${i}]`, message: 'decontamination.corpus entries must be strings' });
    } else if (corpustext[i].length > MAX_ENTRY_CHARS) {
      errors.push({ code: 'VALIDATION_ERROR', field: `decontamination.corpus[${i}]`, message: `decontamination.corpus entries hold at most ${MAX_ENTRY_CHARS} characters` });
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

/**
 * Score one text against a corpus.
 *
 * @param {string} text record text to measure
 * @param {string[]} corpusEntries reference texts the record must not echo
 * @param {object} [opts] `{ ngramSize }`
 * @returns `{ score, matchedNgrams, totalNgrams, bestEntryIndex }`.
 *   `bestEntryIndex` is -1 when nothing overlaps. Records too short for one
 *   n-gram fall back to exact normalized containment: a short quote copied
 *   verbatim still scores 1, anything else scores 0.
 */
function scoreTextAgainstCorpus(text, corpusEntries, opts = {}) {
  const ngramSize = opts.ngramSize === undefined ? DEFAULT_NGRAM_SIZE : opts.ngramSize;
  const recordTokens = meaningfulTokens(typeof text === 'string' ? text : '');
  const normalizedRecord = normalizeFuzzyText(typeof text === 'string' ? text : '');
  const empty = {
    score: 0, matchedNgrams: 0, totalNgrams: 0, bestEntryIndex: -1,
  };
  if (recordTokens.length === 0) return { ...empty };
  const normalizedEntries = corpusEntries.map((entry) => ({
    raw: entry,
    normalized: normalizeFuzzyText(entry),
    tokens: meaningfulTokens(entry),
  }));
  if (recordTokens.length < ngramSize) {
    if (normalizedRecord) {
      const hit = normalizedEntries.findIndex((entry) => entry.normalized.includes(normalizedRecord));
      if (hit !== -1) return { score: 1, matchedNgrams: 1, totalNgrams: 1, bestEntryIndex: hit };
    }
    return { ...empty, totalNgrams: 0 };
  }
  const recordGrams = ngramSet(recordTokens, ngramSize);
  let best = { ...empty, totalNgrams: recordGrams.size };
  for (let i = 0; i < normalizedEntries.length; i += 1) {
    const entryTokens = normalizedEntries[i].tokens;
    if (entryTokens.length < ngramSize) continue;
    const matched = countIntersection(recordGrams, ngramSet(entryTokens, ngramSize));
    if (matched > best.matchedNgrams) {
      best = {
        score: recordGrams.size === 0 ? 0 : matched / recordGrams.size,
        matchedNgrams: matched,
        totalNgrams: recordGrams.size,
        bestEntryIndex: i,
      };
    }
  }
  return best;
}

/**
 * Full validated evaluation for one record text.
 *
 * @returns `{ ok: true, score, matchedNgrams, totalNgrams, bestEntryIndex,
 *   threshold, ngramSize, contaminated }` or `{ ok: false, errors }`.
 */
function evaluateDecontamination(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ code: 'VALIDATION_ERROR', field: 'input', message: 'input must be an object' }] };
  }
  const options = validateScoringOptions({ corpus: input.corpus, threshold: input.threshold, ngramSize: input.ngramSize });
  if (!options.ok) return options;
  if (typeof input.text !== 'string') {
    return { ok: false, errors: [{ code: 'VALIDATION_ERROR', field: 'text', message: 'text must be a string' }] };
  }
  if (input.text.length > MAX_TEXT_CHARS) {
    return { ok: false, errors: [{ code: 'VALIDATION_ERROR', field: 'text', message: `text holds at most ${MAX_TEXT_CHARS} characters` }] };
  }
  const corpusCheck = validateCorpus(options.value.corpus);
  if (!corpusCheck.ok) return corpusCheck;
  const scored = scoreTextAgainstCorpus(input.text, options.value.corpus, { ngramSize: options.value.ngramSize });
  return {
    ok: true,
    ...scored,
    threshold: options.value.threshold,
    ngramSize: options.value.ngramSize,
    contaminated: scored.score >= options.value.threshold,
  };
}

module.exports = {
  MEMORY_DECONTAMINATION_VERSION,
  DEFAULT_NGRAM_SIZE,
  DEFAULT_THRESHOLD,
  MIN_NGRAM_SIZE,
  MAX_NGRAM_SIZE,
  MAX_CORPUS_ENTRIES,
  MAX_ENTRY_CHARS,
  MAX_TEXT_CHARS,
  projectContentText,
  scoreTextAgainstCorpus,
  evaluateDecontamination,
};
