'use strict';

const {
  MEMORY_MUTATION_GATE_DECISIONS,
  MEMORY_MUTATION_GATE_REASONS,
  MEMORY_MUTATION_POLICY_VERSION,
  MEMORY_MUTATION_RISK_LEVELS,
} = require('./constants');
const { normalizeMemoryMutationInput } = require('./normalize');
const { classifyMemoryMutation } = require('./classify');
const { summarizeMemoryMutationFindings } = require('./summarize');
const {
  evaluateMemoryMutation,
  normalizeMemoryMutationDecision,
} = require('./decision');

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
