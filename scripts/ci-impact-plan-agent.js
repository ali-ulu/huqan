'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('./ci-shard-manifest');
const { normalizePath } = require('./ci-impact-plan-paths');
const PLAN_SCHEMA_VERSION = 1;
const DEFAULT_AGENT_PLAN = '.huqan/agent-test-plan.json';

function validateAgentPlan(raw, knownTests) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('agent plan must be a JSON object');
  }
  if (raw.schemaVersion !== PLAN_SCHEMA_VERSION) {
    throw new Error(`agent plan schemaVersion must be ${PLAN_SCHEMA_VERSION}`);
  }
  const allowedKeys = new Set(['schemaVersion', 'addTests', 'confidence', 'rationale', 'fallback']);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) throw new Error(`agent plan field is not allowed: ${key}`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'removeTests')) {
    throw new Error('agent plan cannot remove tests');
  }
  if (!Array.isArray(raw.addTests)) throw new Error('agent plan addTests must be an array');
  if (!['high', 'medium', 'low'].includes(raw.confidence)) throw new Error('agent plan confidence must be high, medium or low');
  const known = new Set(knownTests);
  const addTests = [...new Set(raw.addTests.map(normalizePath))].sort();
  const unknown = addTests.filter((file) => !known.has(file));
  if (unknown.length > 0) throw new Error(`agent plan references unknown test files: ${unknown.join(', ')}`);
  if (raw.fallback !== undefined && !['full', 'none'].includes(raw.fallback)) {
    throw new Error('agent plan fallback must be full or none');
  }
  return { addTests, confidence: raw.confidence, rationale: String(raw.rationale || ''), fallback: raw.fallback || 'none' };
}

function loadAgentPlan({ root = REPO_ROOT, agentPlanPath, knownTests }) {
  const relative = agentPlanPath || DEFAULT_AGENT_PLAN;
  const absolute = path.isAbsolute(relative) ? relative : path.join(root, relative);
  if (!fs.existsSync(absolute)) return { status: 'not-provided', addTests: [], confidence: null, rationale: '', fallback: 'none' };
  try {
    const raw = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    const plan = validateAgentPlan(raw, knownTests);
    return { status: 'valid', ...plan };
  } catch (error) {
    return { status: 'invalid', addTests: [], confidence: 'low', rationale: error.message, fallback: 'full' };
  }
}

module.exports = { DEFAULT_AGENT_PLAN, PLAN_SCHEMA_VERSION, validateAgentPlan, loadAgentPlan };
