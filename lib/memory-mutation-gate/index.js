'use strict';

const {
  MEMORY_MUTATION_GATE_DECISIONS,
  MEMORY_MUTATION_GATE_REASONS,
  MEMORY_MUTATION_POLICY_VERSION,
  MEMORY_MUTATION_RISK_LEVELS,
} = require('./memory-mutation-vocabulary');
const { normalizeMemoryMutationInput } = require('./memory-mutation-normalizer');
const { classifyMemoryMutation } = require('./memory-mutation-classifier');
const { summarizeMemoryMutationFindings } = require('./memory-mutation-findings-summary');
const {
  evaluateMemoryMutation,
  normalizeMemoryMutationDecision,
} = require('./memory-mutation-decision');

module.exports = {
  MEMORY_MUTATION_GATE_DECISIONS,
  MEMORY_MUTATION_GATE_REASONS,
  MEMORY_MUTATION_POLICY_VERSION,
  MEMORY_MUTATION_RISK_LEVELS,
  evaluateMemoryMutation,
  normalizeMemoryMutationInput,
  normalizeMemoryMutationDecision,
  classifyMemoryMutation,
  summarizeMemoryMutationFindings,
};
