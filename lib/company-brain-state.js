"use strict";

// Ingest state for plugins/company-brain.js (#2120): the per-kernel ingest
// counters, success/error tracking and the status endpoint. Pure assembly
// over kernel state; the plugin entry, query and ingest modules share it.
const { recordIngestError, summarizeIngestErrors } = require('./bounded-ingest-errors');

function nowIso() {
  return new Date().toISOString();
}

const INGEST_STATE_KEY = '_companyBrainIngestState';

function ensureCompanyState(kernel) {
  if (!kernel[INGEST_STATE_KEY]) {
    kernel[INGEST_STATE_KEY] = {
      bySource: { repo: 0, markdown: 0, manual: 0, decision: 0, api: 0 },
      lastIngestAt: null,
      ingestErrors: [],
    };
  }
  return kernel[INGEST_STATE_KEY];
}

function trackSuccess(kernel, sourceType, amount = 1) {
  const state = ensureCompanyState(kernel);
  if (!(sourceType in state.bySource)) state.bySource[sourceType] = 0;
  state.bySource[sourceType] += Math.max(0, Number(amount || 0));
  state.lastIngestAt = nowIso();
}

function trackError(kernel, sourceType, message) {
  const state = ensureCompanyState(kernel);
  recordIngestError(state, sourceType, message, nowIso());
  state.lastIngestAt = nowIso();
}

function getIngestStatus(kernel) {
  const state = ensureCompanyState(kernel);
  const repoState = kernel._repoMemoryIngestState;
  const distribution = {};
  for (const ingestState of [repoState, state]) {
    for (const [key, value] of Object.entries(ingestState?.bySource || {})) {
      distribution[key] = Number(distribution[key] || 0) + Number(value || 0);
    }
  }
  const stats = kernel.graph && typeof kernel.graph.getStats === 'function'
    ? kernel.graph.getStats()
    : { nodes: 0, edges: 0 };

  return {
    ok: true,
    totalNodes: stats.nodes || 0,
    distribution,
    lastIngestAt: state.lastIngestAt || repoState?.lastIngestAt || null,
    // Newest first and bounded. Returning the whole array meant a monitoring
    // caller polling this endpoint pulled every error ever recorded: 200k
    // failed ingests produced a 24 MB body, with the one error the operator
    // needed buried at the end.
    ...summarizeIngestErrors(state),
  };
}

module.exports = {
  nowIso,
  INGEST_STATE_KEY,
  ensureCompanyState,
  trackSuccess,
  trackError,
  getIngestStatus,
};
