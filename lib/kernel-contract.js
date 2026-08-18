'use strict';

// Kernel contract vocabulary — pure frozen data shared by kernel.js and its
// consumers. Extracted from kernel.js in the arch-3 (#328) bounded refactor:
// these are the only pieces of kernel.js that are fully side-effect-free and
// can be required without pulling the entire Kernel class, fs, or the Rust
// binary resolver. The Kernel class itself is deliberately NOT touched — its
// methods share mutable state and are split only just-in-time when a runtime
// PR depends on them (docs/v4/big-file-refactor-gate.md).

const AXIOM_ERROR = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  CONFLICT_DETECTED: 'CONFLICT_DETECTED',
  GRAPH_UNAVAILABLE: 'GRAPH_UNAVAILABLE',
  NORMALIZATION_FAILED: 'NORMALIZATION_FAILED',
  LLM_DISABLED: 'LLM_DISABLED',
  INTERNAL: 'INTERNAL',
});

const CONTRACT_VERSION = '1.0.0';

const DEFAULT_CAPABILITIES = Object.freeze({
  graph: true,
  temporal: false,
  pluginCapabilities: false,
  llm: true,
  contradictionDetection: true,
  evidenceRanking: false,
  agentApi: false,
  companyMode: false,
  discoveryLoop: false,
  // Off by default: turning this on makes learnAsync() reach out to the
  // network to check that an http(s) sourceRef actually resolves, which is
  // the wrong default for offline use and for the test suite. See #348.
  evidenceReachability: false,
});

module.exports = {
  AXIOM_ERROR,
  CONTRACT_VERSION,
  DEFAULT_CAPABILITIES,
};
