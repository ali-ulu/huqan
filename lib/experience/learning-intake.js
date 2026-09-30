'use strict';

/**
 * Experience — Learning intake (#2390 production caller).
 *
 * The production caller for ./learning.js. Until now the admission pool was
 * library-only: nothing outside the tests constructed it, so no run's
 * Experience ever reached admission. This module is the seam that reads a
 * real journal record, admits it, and — only when the run is a positive
 * procedure — turns it into a compiled procedure candidate.
 *
 * ## Proposals, never installation
 *
 * This module never writes a registry, never activates a procedure and never
 * promotes trust. `registered` is `false` on every result and `compile()`'s
 * output is returned as data. Installing a proposal stays a separate,
 * human-gated act (#2392/#2393) — that is what "never silent
 * self-installation" means (#3025's rule, applied to procedural memory).
 *
 * ## What the source hash is
 *
 * ./learning.js requires traceability: source hashes plus scope. A run's own
 * sealed projection (./read-model.js `projectionHash`) is that source — it
 * covers the run identity, the manifest and the ordered event bodies, so a
 * reordered or edited record yields a different source hash rather than a
 * quietly admitted lesson. The scope is the run's workspace.
 *
 * ## Failure shape, not exceptions
 *
 * Unknown run, wrong workspace and a tampered record all return
 * `{ ok: false, code }` with the same three codes the read projection uses.
 */

const crypto = require('node:crypto');
const { createLearningPool } = require('./learning');
const { compile, KINDS } = require('./compiler');
const { projectionHash } = require('./read-model');

const CODES = Object.freeze({
  INVALID_REQUEST: 'invalid_request',
  UNAVAILABLE: 'unavailable',
  RUN_NOT_FOUND: 'run_not_found',
  WORKSPACE_MISMATCH: 'workspace_mismatch',
  INTEGRITY_MISMATCH: 'integrity_mismatch',
  NOT_SEALED: 'run_not_sealed',
  NOT_APPLICABLE: 'not_applicable',
});

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function stableJson(value) {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

/**
 * Read one run's sealed record. Returns `{ ok, events, manifest, sourceHash }`
 * or the shared failure shape. The journal is injected, never constructed
 * here, and its throwing read is translated the same way ./read-model.js
 * translates it so the two surfaces cannot disagree on a run's existence.
 */
function readSealedRun(journal, runId, workspaceId) {
  if (!journal || typeof journal.read !== 'function' || typeof journal.manifest !== 'function') {
    return { ok: false, code: CODES.UNAVAILABLE };
  }
  let events;
  try {
    events = journal.read(runId, { workspaceId });
  } catch (err) {
    if (err && err.code === 'INTEGRITY_MISMATCH') return { ok: false, code: CODES.INTEGRITY_MISMATCH };
    throw err;
  }
  if (!Array.isArray(events) || events.length === 0) {
    let unscoped = [];
    try {
      unscoped = journal.read(runId);
    } catch (err) {
      if (err && err.code === 'INTEGRITY_MISMATCH') return { ok: false, code: CODES.INTEGRITY_MISMATCH };
      throw err;
    }
    return { ok: false, code: unscoped.length > 0 ? CODES.WORKSPACE_MISMATCH : CODES.RUN_NOT_FOUND };
  }
  const manifest = journal.manifest(runId);
  // Sealed is sealed: only a closed run is immutable. An open run's projection
  // can still move under a later event, which would leave the proposal's source
  // hash, candidate trace and evidenceRefs pointing at a stale record. Refuse
  // rather than admit a lesson from a run that is still being written.
  if (manifest.closed !== true) return { ok: false, code: CODES.NOT_SEALED };
  return {
    ok: true,
    events,
    manifest,
    sourceHash: projectionHash({ runId, workspaceId, manifest, events }),
  };
}

/**
 * Build a learning proposal for one run. `pool` is optional and injected so a
 * long-lived caller can keep admission state across calls; the default is a
 * fresh in-memory pool, which is honest for a one-shot CLI/MCP invocation.
 *
 * The returned record is sealed over its own decision, candidate and compiled
 * procedure, so a consumer can recompute `hash` and detect an edited proposal.
 */
function buildLearningProposal(journal, {
  runId, workspaceId, kind = KINDS.REPLACE_TEXT, params = null, parentVersion = 0, pool = null,
} = {}) {
  const id = nonEmptyString(runId);
  const ws = nonEmptyString(workspaceId);
  if (!id || !ws) return { ok: false, code: CODES.INVALID_REQUEST };

  const sealed = readSealedRun(journal, id, ws);
  if (!sealed.ok) return sealed;

  const admissionPool = pool || createLearningPool();
  const admission = admissionPool.admit({
    runId: id,
    learningEligibility: sealed.manifest.learningEligibility,
    outcomeStatus: sealed.manifest.outcomeStatus,
    sourceHashes: [sealed.sourceHash],
    scope: { workspaceId: ws },
    revision: String(sealed.manifest.head),
  });

  let candidate = null;
  let procedure = null;
  let compileCode = CODES.NOT_APPLICABLE;
  if (admission.record && admission.record.admitted === 'positive') {
    const proposal = admissionPool.propose({ runId: id, sources: [sealed.sourceHash] });
    if (proposal.ok) {
      candidate = proposal.candidate;
      const compiled = compile({ candidate, kind, params, parentVersion });
      if (compiled.ok) procedure = compiled.procedure;
      else compileCode = compiled.code;
    } else {
      compileCode = proposal.code;
    }
  }

  const body = {
    ok: true,
    type: 'experience_learning_proposal',
    runId: id,
    workspaceId: ws,
    sourceHash: sealed.sourceHash,
    eligibility: sealed.manifest.learningEligibility,
    outcomeStatus: sealed.manifest.outcomeStatus,
    admission: Object.freeze({ decision: admission.decision, code: admission.code }),
    candidate,
    procedure,
    compileCode,
    // Stated, not omitted: this module produces proposals and never installs
    // them. A consumer reading `registered: false` knows the registry was not
    // touched by this call.
    registered: false,
  };
  return Object.freeze({ ...body, hash: sha256(stableJson(body)) });
}

module.exports = Object.freeze({ buildLearningProposal, readSealedRun, CODES });
