'use strict';

/**
 * A read-only probe answering one question: does HUQAN's self-evolution
 * change what it knows, or how it learns?
 *
 * The two are not the same claim. Writing a derived edge is the system
 * extending its content; changing a threshold is the system altering the
 * process that produces its content. Only the second is learning to learn,
 * and the difference is easy to assert and hard to demonstrate -- so this
 * measures it instead of arguing about it.
 *
 * ## The probe observes; the invocation acts
 *
 * The probe reads counts before and after a caller-supplied invocation and
 * reports the difference. It writes nothing itself, so any delta it reports
 * came from the thing being measured. With no invocation it makes no
 * measurement and returns no verdict, rather than guessing one from the
 * symbols alone.
 */

const { DEFAULTS } = require('./graph-hypotheses');

const VERDICTS = Object.freeze({
  /** A threshold moved: the system changed how it learns. */
  WRITES_CONFIG: 'native-writes-config',
  /** Graph content moved, thresholds did not: it changed what it knows. */
  CONTENT_ONLY: 'native-content-only',
  /** Nothing moved. */
  INACTIVE: 'inactive',
  /** No invocation was supplied, so nothing was observed. */
  UNMEASURED: 'unmeasured',
});

/** The tunable surface. A change to any of these is a change to the process. */
const CONFIG_KEYS = Object.freeze(['confidenceFloor', 'criticalInDegree', 'smallComponentSize']);

function normalizeWorkspaceId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'default';
}

function moduleExports(request) {
  try {
    return require(request);
  } catch {
    return null;
  }
}

function detectSymbols() {
  const selfEvolve = moduleExports('./kernel-self-evolve') || {};
  const dream = moduleExports('./kernel-dream') || {};
  return {
    runSelfEvolve: typeof selfEvolve.runSelfEvolve === 'function',
    buildSelfEvolveCollaborators: typeof selfEvolve.buildSelfEvolveCollaborators === 'function',
    runDream: typeof dream.runDream === 'function',
  };
}

function defaultReadConfig() {
  const config = {};
  for (const key of CONFIG_KEYS) config[key] = DEFAULTS[key];
  return config;
}

function countOf(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

function snapshot(kernel, workspaceId, readConfig) {
  const graph = kernel?.graph;
  return {
    nodes: countOf(graph?.getNodes?.(workspaceId)),
    edges: countOf(graph?.getAllEdges?.(workspaceId)),
    candidates: countOf(kernel?.getCandidateClaims?.({ workspaceId })),
    config: readConfig(),
  };
}

function configChangesBetween(before, after) {
  const changes = [];
  for (const key of CONFIG_KEYS) {
    if (before.config[key] !== after.config[key]) {
      changes.push({ key, before: before.config[key], after: after.config[key] });
    }
  }
  return changes;
}

/**
 * @param {object} kernel
 * @param {{workspaceId?: string, invoke?: Function, readConfig?: Function}} [options]
 * @returns {{symbols: object, measurement: object|null, verdict: string}}
 */
function probeSelfEvolve(kernel, options = {}) {
  const workspaceId = normalizeWorkspaceId(options.workspaceId);
  const readConfig = typeof options.readConfig === 'function' ? options.readConfig : defaultReadConfig;
  const symbols = detectSymbols();

  if (typeof options.invoke !== 'function') {
    return { symbols, measurement: null, verdict: VERDICTS.UNMEASURED };
  }

  const before = snapshot(kernel, workspaceId, readConfig);
  let invocationError = null;
  try {
    options.invoke();
  } catch (error) {
    // Surfaced rather than swallowed: a self-evolution run that throws is a
    // finding about the system, and hiding it would make the probe lie by
    // omission. The after-snapshot still runs, because a partial run may
    // already have written something.
    invocationError = error && error.message ? error.message : String(error);
  }
  const after = snapshot(kernel, workspaceId, readConfig);
  const configChanges = configChangesBetween(before, after);

  const delta = {
    nodes: after.nodes - before.nodes,
    edges: after.edges - before.edges,
    candidates: after.candidates - before.candidates,
    config: configChanges.length,
  };

  const verdict = delta.config > 0
    ? VERDICTS.WRITES_CONFIG
    : (delta.nodes !== 0 || delta.edges !== 0 || delta.candidates !== 0)
      ? VERDICTS.CONTENT_ONLY
      : VERDICTS.INACTIVE;

  return {
    symbols,
    measurement: { workspaceId, before, after, delta, configChanges, invocationError },
    verdict,
  };
}

module.exports = {
  CONFIG_KEYS,
  VERDICTS,
  probeSelfEvolve,
};
