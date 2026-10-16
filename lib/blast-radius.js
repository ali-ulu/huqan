'use strict';

// The blast radius of one action (#2505): how far its effect can reach, as a
// score on the canonical 0-100 scale, recorded with the inputs it came from.
//
// Five dimensions, each kept with its value and the source of that value:
//   actionClass    the action taxonomy's default risk for the category
//   breadth        how many targets one call can touch
//   dependency     what depends on the target
//   reversibility  whether the effect can be undone
//   boundary       this workspace, another workspace, or an outside service
//
// The class sets the base score and the other four scale it. A dimension that
// was not computed is never read as harmless: it takes its largest factor, so
// the score is an upper bound, and the reason is listed under `unknowns`.
// Without a class there is no base, and the score is null rather than 0.
//
// The factors are a first calibration, not a policy. Nothing here changes a
// decision; the receipt records the blast radius next to the decision so the
// two can be compared before any threshold is enforced.

const path = require('node:path');
const { ACTION_CATEGORIES, RISK_BY_CATEGORY, RISK_LEVELS } = require('./risk-policy-constants');
const { FILE_STATES } = require('./file-effect-sensor');
const { RISK_LEVEL_BANDS, riskLevelForScore } = require('./risk-scale');

const BLAST_RADIUS_VERSION = 'huqan-blast-radius-v1';
const UNKNOWN = 'unknown';

const CLASS_BASE_SCORES = Object.freeze({
  [RISK_LEVELS.LOW]: 10,
  [RISK_LEVELS.MEDIUM]: 40,
  [RISK_LEVELS.HIGH]: 65,
  [RISK_LEVELS.CRITICAL]: 90,
});

const DIMENSION_FACTORS = Object.freeze({
  breadth: Object.freeze({ none: 0, single: 1, multiple: 1.25, unbounded: 1.5 }),
  dependency: Object.freeze({ not_applicable: 1, none: 1, bounded: 1.25, broad: 1.5 }),
  reversibility: Object.freeze({ not_applicable: 1, reversible: 0.75, irreversible: 1.2 }),
  boundary: Object.freeze({ workspace: 1, cross_workspace: 1.25, external_service: 1.25, outside_workspace: 1.5 }),
});

// The factor a dimension takes when it was not computed: the worst case.
const UNKNOWN_FACTORS = Object.freeze({ breadth: 1.5, dependency: 1.5, reversibility: 1.2, boundary: 1.5 });

const LOCAL_WRITE_CATEGORIES = new Set([
  ACTION_CATEGORIES.FILESYSTEM_WRITE,
  ACTION_CATEGORIES.MEMORY_WRITE,
  ACTION_CATEGORIES.CANONICAL_GRAPH_WRITE,
  ACTION_CATEGORIES.CODE_CHANGE,
  ACTION_CATEGORIES.TEST_CHANGE,
]);
const IRREVERSIBLE_CATEGORIES = new Set([
  ACTION_CATEGORIES.NETWORK_CALL,
  ACTION_CATEGORIES.DEPLOYMENT,
  ACTION_CATEGORIES.PERMISSION_CHANGE,
  ACTION_CATEGORIES.PRODUCTION_MUTATION,
]);

const TARGET_PATTERN = /[*?[\]{}]/;
// Token by token rather than one regex over the command: the command is agent
// input, and a pattern like -[a-z]*r[a-z]* backtracks polynomially on it.
function hasRecursiveFlag(command) {
  return String(command).split(/\s+/).some((token) => token === '--recursive'
    || token.toLowerCase() === '/s'
    || (/^-[a-zA-Z]+$/.test(token) && /r/i.test(token)));
}

function known(value, source) {
  return Object.freeze({ value, source });
}

function unknown(reason) {
  return Object.freeze({ value: UNKNOWN, source: null, reason });
}

function suppliedDimension(name, supplied) {
  if (!supplied || typeof supplied !== 'object' || typeof supplied.value !== 'string') {
    return unknown(`${name} was not supplied`);
  }
  if (supplied.value === UNKNOWN) return unknown(String(supplied.reason || `${name} was not computed`));
  if (!Object.hasOwn(DIMENSION_FACTORS[name], supplied.value)) {
    throw new TypeError(`unknown ${name} value: ${supplied.value}`);
  }
  return known(supplied.value, String(supplied.source || ''));
}

/**
 * The blast radius from an action category and four dimensions, each given as
 * `{ value, source }` or `{ value: 'unknown', reason }`.
 */
function computeBlastRadius({ category, breadth, dependency, reversibility, boundary } = {}) {
  const classLevel = Object.hasOwn(RISK_BY_CATEGORY, category) ? RISK_BY_CATEGORY[category] : null;
  const dimensions = Object.freeze({
    actionClass: classLevel
      ? known(category, 'docs/action-taxonomy.md')
      : unknown(`action category ${JSON.stringify(category ?? null)} is not in the action taxonomy`),
    breadth: suppliedDimension('breadth', breadth),
    dependency: suppliedDimension('dependency', dependency),
    reversibility: suppliedDimension('reversibility', reversibility),
    boundary: suppliedDimension('boundary', boundary),
  });
  const unknowns = Object.entries(dimensions)
    .filter(([, dimension]) => dimension.value === UNKNOWN)
    .map(([name, dimension]) => `${name}: ${dimension.reason}`);
  let score = null;
  if (classLevel) {
    const factor = Object.keys(DIMENSION_FACTORS).reduce((product, name) => {
      const { value } = dimensions[name];
      return product * (value === UNKNOWN ? UNKNOWN_FACTORS[name] : DIMENSION_FACTORS[name][value]);
    }, 1);
    score = Math.round(Math.min(100, CLASS_BASE_SCORES[classLevel] * factor));
  }
  return Object.freeze({
    version: BLAST_RADIUS_VERSION,
    score,
    level: riskLevelForScore(score),
    status: !classLevel ? UNKNOWN : unknowns.length > 0 ? 'upper_bound' : 'computed',
    dimensions,
    unknowns: Object.freeze(unknowns),
  });
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative));
}

function externalBoundary(envelope) {
  if (envelope.targetWorkspaceId && envelope.targetWorkspaceId !== envelope.workspaceId) {
    return known('cross_workspace', 'envelope.targetWorkspaceId');
  }
  if (envelope.target.url) return known('external_service', 'envelope.target.url');
  if (envelope.target.resolvedPath) {
    return known(isInside(envelope.workspaceRoot, envelope.target.resolvedPath) ? 'workspace' : 'outside_workspace',
      'envelope.target.resolvedPath');
  }
  if (envelope.kind === 'shell') return unknown('the command is not parsed for the paths or hosts it reaches');
  return unknown('the action names no path, URL or workspace');
}

function externalBreadth(envelope) {
  if (envelope.target.path) {
    return known(TARGET_PATTERN.test(envelope.target.path) ? 'unbounded' : 'single', 'envelope.target.path');
  }
  if (envelope.target.url) return known('single', 'envelope.target.url');
  if (envelope.kind === 'shell') {
    if (TARGET_PATTERN.test(envelope.command) || hasRecursiveFlag(envelope.command)) {
      return known('unbounded', 'envelope.command');
    }
    return unknown('the command is not parsed for how many targets it touches');
  }
  return unknown('the action names no target to count');
}

// A shell command is called read-only by matching its text, not by observing
// it: `find . -delete` matches a read pattern. So a shell read is not assumed
// to have nothing downstream or nothing to undo.
const SHELL_READ_UNVERIFIED = 'a shell command is classified read-only by pattern, not observed';

function externalDependency(envelope) {
  const category = envelope.riskCategory;
  if (category === ACTION_CATEGORIES.READ_ONLY) {
    return envelope.kind === 'shell' ? unknown(SHELL_READ_UNVERIFIED) : known('not_applicable', 'read-only action');
  }
  if (category === ACTION_CATEGORIES.NETWORK_CALL) return known('not_applicable', 'the target is an outside service');
  return unknown('what depends on the target is not computed for external actions');
}

function externalReversibility(envelope) {
  const category = envelope.riskCategory;
  if (category === ACTION_CATEGORIES.READ_ONLY) {
    return envelope.kind === 'shell' ? unknown(SHELL_READ_UNVERIFIED) : known('not_applicable', 'read-only action');
  }
  if (LOCAL_WRITE_CATEGORIES.has(category) && envelope.kind === 'file_write' && envelope.fileBefore) {
    const { state } = envelope.fileBefore;
    if (state === FILE_STATES.ABSENT) return known('reversible', 'fileBefore: absent, the write creates the file');
    if (state === FILE_STATES.DIGESTED || state === FILE_STATES.TOO_LARGE) {
      return known('irreversible', 'fileBefore: the file exists and no prior copy is kept');
    }
    return unknown('the target file could not be read before the action');
  }
  if (IRREVERSIBLE_CATEGORIES.has(category)) return known('irreversible', `action category ${category}`);
  return unknown('no undo path is recorded for this action');
}

/** The blast radius of a normalized external action envelope. */
function externalActionBlastRadius(envelope) {
  return computeBlastRadius({
    category: envelope.riskCategory,
    breadth: externalBreadth(envelope),
    dependency: externalDependency(envelope),
    reversibility: externalReversibility(envelope),
    boundary: externalBoundary(envelope),
  });
}

/**
 * The session's cumulative blast radius including this action: the recorded
 * per-action scores summed, from a `summarizeSessionImpact` summary. Recorded
 * only (`enforced: false`). It is not a bound on impact: each score may itself
 * be an upper bound, and a `partial` or `unknown` status names what was not
 * counted.
 */
function cumulativeImpact(summary, blastRadius) {
  if (!summary || summary.status === UNKNOWN) {
    const reasons = summary?.reasons || ['the session receipt history was not read for this action'];
    return Object.freeze({ ...(summary || {}), status: UNKNOWN, reasons: Object.freeze([...reasons]), enforced: false });
  }
  const current = Number.isFinite(blastRadius?.score) ? blastRadius.score : null;
  const reasons = [...summary.reasons];
  if (current === null) reasons.push('this action has no blast radius score');
  return Object.freeze({
    ...summary,
    actions: summary.priorActions + 1,
    recordedScoreTotal: summary.recordedScoreTotal + (current ?? 0),
    maxScore: current === null ? summary.maxScore : Math.max(summary.maxScore ?? current, current),
    status: reasons.length > 0 ? 'partial' : 'computed',
    reasons: Object.freeze(reasons),
    enforced: false,
  });
}

/**
 * Why an external action was allowed, reviewed or blocked, for its receipt:
 * the decision, its reason and risk score, the blast radius with its inputs,
 * the session's cumulative blast radius, and the thresholds that applied. A
 * missing risk score is `null` with state `unknown`, never 0.
 */
function externalActionJustification(envelope, decision) {
  const riskScore = Number.isFinite(decision?.risk?.score) ? decision.risk.score : null;
  const blastRadius = externalActionBlastRadius(envelope);
  return Object.freeze({
    decision: String(decision?.decision || ''),
    reason: String(decision?.reason || ''),
    riskScore,
    riskScoreState: riskScore === null ? UNKNOWN : 'computed',
    blastRadius,
    cumulative: cumulativeImpact(envelope.sessionImpact, blastRadius),
    thresholds: Object.freeze({
      levelBands: RISK_LEVEL_BANDS.map(([floor, level]) => Object.freeze({ floor, level })),
      decisionSource: 'gate_findings',
      blastRadiusEnforced: false,
    }),
  });
}

module.exports = {
  BLAST_RADIUS_VERSION,
  CLASS_BASE_SCORES,
  DIMENSION_FACTORS,
  UNKNOWN_FACTORS,
  computeBlastRadius,
  externalActionBlastRadius,
  externalActionJustification,
};
