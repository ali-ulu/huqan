'use strict';

const {
  AUTOMATION_SAFETY_DECISIONS,
  AUTOMATION_SAFETY_REASONS,
  AUTOMATION_RISK_LEVELS,
  AUTOMATION_SAFETY_POLICY_VERSION,
} = require('./automation-safety-vocabulary');
const { normalizeAutomationSafetyInput } = require('./automation-input-normalizer');
const { classifyAutomationOperation } = require('./automation-operation-classifier');
const { summarizeAutomationFindings } = require('./automation-findings-summary');
const {
  evaluateAutomationSafety,
  normalizeAutomationSafetyDecision,
} = require('./automation-safety-decision');

module.exports = {
  AUTOMATION_SAFETY_DECISIONS,
  AUTOMATION_SAFETY_REASONS,
  AUTOMATION_RISK_LEVELS,
  AUTOMATION_SAFETY_POLICY_VERSION,
  evaluateAutomationSafety,
  normalizeAutomationSafetyInput,
  normalizeAutomationSafetyDecision,
  classifyAutomationOperation,
  summarizeAutomationFindings,
};
