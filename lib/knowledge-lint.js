'use strict';

/**
 * Read-only knowledge health lint (#4144, slice 2).
 *
 * The knowledge-wiki scope note (docs/architecture/knowledge-wiki-scope.md,
 * section 6) fixes what a lint over the derived view may do: it reports, and
 * only reports. It names five findings -- source staleness, missing
 * provenance, an orphan derived page, a conflict between a candidate and a
 * canonical claim, and a coverage gap -- and states that lint performs no
 * mutation of canonical memory, of the graph or of policy.
 *
 * This module is that surface. It is pure: it takes a plain state object,
 * returns a report, and does no I/O. The caller owns reading the store, the
 * graph and the policy and handing their records in -- the same boundary
 * `lib/provenance-drift.js` draws for drift detection, and the reason this
 * module can be exercised without standing any of them up.
 *
 * Read-only is a checked property here, not a promise. The state is digested
 * before and after the run; a mismatch throws rather than returning a report
 * that quietly disagrees with itself.
 *
 * Nothing here becomes a second source of truth. A finding is a fact about a
 * record, surfaced for a human, exactly like every other conflict candidate:
 * it never carries an authority, never promotes a claim to canonical memory,
 * and never invents a `sourceVersion` a record did not supply.
 */

const { isPlainObject } = require('./is-plain-object');
const { stableStringify, sha256Hex } = require('./hash-chain');

const KNOWLEDGE_LINT_SCHEMA_VERSION = 'huqan-knowledge-lint-v1';

// The surfaces a run inspects. It reads them and never writes: the list is
// exported so a fixture or a caller can pin the same set the report names.
const LINT_SURFACES = Object.freeze(['canonicalMemory', 'graph', 'policy']);

// The finding vocabulary. Section 6 of the scope note names each one; the
// fixture cases in test/fixtures/knowledge-wiki/cases.json carry the inputs
// that produce four of them.
const LINT_CODES = Object.freeze({
  SOURCE_DRIFT: 'source_drift',
  MISSING_PROVENANCE: 'missing_provenance',
  ORPHAN_PAGE: 'orphan_page',
  CONFLICT: 'conflict',
  COVERAGE_GAP: 'coverage_gap',
});

function coerceString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function listOf(value) {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

/**
 * sha256 over the state's canonical form; equal state always digests equal.
 *
 * `stableStringify` rejects a cycle with a TypeError and `JSON.stringify`
 * rejects a `BigInt`, both of which would otherwise reach the caller as a raw
 * helper error. Every other refusal here carries a stable `code`, so this one
 * does too: a caller switching on the code never has to match a message.
 */
function stateDigest(state) {
  try {
    return sha256Hex(stableStringify(state));
  } catch (error) {
    const wrapped = new TypeError('lintKnowledgeState received an unserializable state');
    wrapped.code = 'KNOWLEDGE_LINT_STATE_UNSERIALIZABLE';
    wrapped.cause = error;
    throw wrapped;
  }
}

/**
 * A finding reports. It carries no authority and authorizes no mutation, so
 * the two fields that would let a caller read it as one are pinned here
 * rather than left to each call site.
 */
function finding(code, detail) {
  return Object.freeze({ code, mutation: false, authoritative: false, ...detail });
}

/**
 * A source changed under its `sourceRef` since ingest: the hash re-read now
 * differs from the one pinned at ingest. Two absent hashes are not drift --
 * there is nothing to compare, and guessing one would be the fabrication
 * section 4 forbids.
 */
function driftFindings(source) {
  const sourceRef = coerceString(source.sourceRef);
  const pinned = coerceString(source.contentHash).toLowerCase();
  const fresh = coerceString(source.currentContentHash).toLowerCase();
  if (!pinned || !fresh || pinned === fresh) return [];
  return [finding(LINT_CODES.SOURCE_DRIFT, {
    sourceRef,
    sourceVersion: coerceString(source.sourceVersion),
    ingestedContentHash: pinned,
    rereadContentHash: fresh,
  })];
}

/**
 * A source nothing derives a claim from. The source exists in the record but
 * no claim cites it back, so the knowledge it holds is present and unused.
 */
function coverageFindings(source, claims) {
  const sourceRef = coerceString(source.sourceRef);
  if (!sourceRef) return [];
  if (claims.some((claim) => coerceString(claim.sourceRef) === sourceRef)) return [];
  return [finding(LINT_CODES.COVERAGE_GAP, {
    sourceRef,
    sourceVersion: coerceString(source.sourceVersion),
  })];
}

/**
 * A claim whose provenance is incomplete: no `sourceRef`, or no
 * `sourceVersion`. The version is reported as empty rather than filled in --
 * a version invented at read time is indistinguishable from one the source
 * actually supplied (scope note section 4), so the gap is named, not closed.
 */
function provenanceFindings(claim, index) {
  const sourceRef = coerceString(claim.sourceRef);
  const sourceVersion = coerceString(claim.sourceVersion);
  if (sourceRef && sourceVersion) return [];
  return [finding(LINT_CODES.MISSING_PROVENANCE, {
    claimId: coerceString(claim.claimId) || `claim[${index}]`,
    sourceRef,
    sourceVersion,
    missing: sourceRef ? 'sourceVersion' : 'sourceRef',
  })];
}

/**
 * A candidate claim that contradicts a canonical one. The finding states the
 * conflict and stops there: `canonicalPromotion: false` is what keeps a report
 * from being read as a promotion, which stays the admission gate's decision.
 */
function conflictFindings(claim, index) {
  const status = coerceString(claim.status).toLowerCase();
  if (status !== 'candidate') return [];
  const conflictsWith = coerceString(claim.conflictsWith);
  if (!conflictsWith && claim.conflict !== true) return [];
  return [finding(LINT_CODES.CONFLICT, {
    claimId: coerceString(claim.claimId) || `claim[${index}]`,
    status,
    conflictsWith,
    canonicalPromotion: false,
  })];
}

/**
 * A derived page nothing links to. `inboundLinks` is required: a page whose
 * link count was never measured is not reported as an orphan, because a
 * missing measurement is not a measured zero.
 */
function orphanFindings(page, index) {
  if (!Number.isFinite(page.inboundLinks) || page.inboundLinks > 0) return [];
  return [finding(LINT_CODES.ORPHAN_PAGE, {
    pageId: coerceString(page.pageId) || `page[${index}]`,
    inboundLinks: 0,
  })];
}

/**
 * Refuse a state whose records are not plain data.
 *
 * The read-only guarantee is measured by digesting the state before and after
 * the run, but that measurement itself reads properties. An accessor on an
 * accepted record can therefore fire during the *first* digest, change another
 * field, and be absorbed into `before` -- the second digest then matches and
 * the run reports `readOnly: true` about an object it helped change. The
 * authority hands records in as data, so an accessor is not a shape this lint
 * accepts; `lib/deterministic-json-copy.js` draws the same boundary for the
 * same reason. Descriptors are read directly, so this walk never invokes a
 * getter, and `seen` keeps a cycle from recursing forever.
 */
function rejectAccessors(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      const error = new Error(`lintKnowledgeState requires data properties; "${String(key)}" is an accessor`);
      error.code = 'KNOWLEDGE_LINT_STATE_ACCESSOR';
      throw error;
    }
    rejectAccessors(descriptor.value, seen);
  }
}

/**
 * Run the lint over one state.
 *
 * @param {object} state plain records the caller read from the authority:
 *   `{ workspaceId, sources[], claims[], pages[] }`. Only these shapes are
 *   read; anything else is ignored rather than guessed at.
 * @returns {object} a frozen report. `findings` is a report list; the report
 *   and every finding state `mutation: false` and carry no authority.
 * @throws when `state` is not a plain object, when it carries an accessor, and
 *   -- the tripwire -- when the digest moved across the run, which would mean
 *   the lint wrote.
 */
function lintKnowledgeState(state) {
  if (!isPlainObject(state)) {
    const error = new Error('lintKnowledgeState requires a plain state object');
    error.code = 'KNOWLEDGE_LINT_STATE_REQUIRED';
    throw error;
  }

  rejectAccessors(state);
  const before = stateDigest(state);
  const sources = listOf(state.sources);
  const claims = listOf(state.claims);
  const pages = listOf(state.pages);

  const findings = [
    ...sources.flatMap((source) => driftFindings(source)),
    ...sources.flatMap((source) => coverageFindings(source, claims)),
    ...claims.flatMap((claim, index) => provenanceFindings(claim, index)),
    ...claims.flatMap((claim, index) => conflictFindings(claim, index)),
    ...pages.flatMap((page, index) => orphanFindings(page, index)),
  ];

  const after = stateDigest(state);
  if (after !== before) {
    // Unreachable while the function stays pure. It is the tripwire that makes
    // "read-only" a checked property rather than a claim about the code.
    const error = new Error('lintKnowledgeState mutated the state it inspected');
    error.code = 'KNOWLEDGE_LINT_MUTATED_STATE';
    throw error;
  }

  return Object.freeze({
    schemaVersion: KNOWLEDGE_LINT_SCHEMA_VERSION,
    workspaceId: coerceString(state.workspaceId, 'default'),
    readOnly: true,
    mutation: false,
    stateChanged: false,
    surfaces: LINT_SURFACES,
    observedStateDigest: before,
    findings: Object.freeze(findings),
  });
}

module.exports = {
  KNOWLEDGE_LINT_SCHEMA_VERSION,
  LINT_CODES,
  LINT_SURFACES,
  stateDigest,
  lintKnowledgeState,
};
