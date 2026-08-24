'use strict';

const crypto = require('crypto');

const MANIFEST_VERSION = 'huqan.agent-behavior.v1';

function text(value) { return typeof value === 'string' ? value.trim() : ''; }

function buildBehavioralManifest({ goal, workspaceId, selectedTools } = {}) {
  const manifest = {
    version: MANIFEST_VERSION,
    goal: text(goal),
    workspaceId: text(workspaceId) || 'default',
    allowedTools: [...new Set((Array.isArray(selectedTools) ? selectedTools : []).map(text).filter(Boolean))].sort(),
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  return Object.freeze({ ...manifest, hash });
}

function evaluateBehavioralStep({ manifest, state, step } = {}) {
  // Low-level test and compatibility callers may invoke `_executeStep` without
  // a run state. Production run() always materializes the manifest first.
  if (!manifest) return { allowed: true, code: null, containment: null };
  if (manifest.version !== MANIFEST_VERSION) {
    return { allowed: false, code: 'BEHAVIORAL_MANIFEST_INVALID', containment: 'quarantine' };
  }
  if (text(state?.workspaceId) !== manifest.workspaceId) {
    return { allowed: false, code: 'BEHAVIORAL_WORKSPACE_DRIFT', containment: 'quarantine' };
  }
  if (text(step?.goal) && text(step.goal) !== manifest.goal) {
    return { allowed: false, code: 'BEHAVIORAL_GOAL_DRIFT', containment: 'quarantine' };
  }
  if (!manifest.allowedTools.includes(text(step?.tool))) {
    return { allowed: false, code: 'BEHAVIORAL_TOOL_DEVIATION', containment: 'block' };
  }
  return { allowed: true, code: null, containment: null };
}

function initializeBehavioralState(state, { goal, workspaceId, selectedTools } = {}) {
  state.behavioralManifest ||= buildBehavioralManifest({ goal, workspaceId, selectedTools });
  state.behavioralFindings = Array.isArray(state.behavioralFindings) ? state.behavioralFindings : [];
  return state.behavioralManifest;
}

function behavioralBlockResult(state, step) {
  const behavioral = evaluateBehavioralStep({ manifest: state.behavioralManifest, state, step });
  if (behavioral.allowed) return null;
  state.behavioralFindings ||= [];
  state.behavioralFindings.push({ code: behavioral.code, containment: behavioral.containment, tool: step?.tool || null });
  state.containment = behavioral.containment;
  return {
    ok: false, type: 'agent', data: null, evidence: [],
    error: { code: behavioral.code, message: 'Agent step deviates from its behavioral manifest.' },
    meta: { blocked: true, containment: behavioral.containment, behavioralManifestHash: state.behavioralManifest?.hash || null },
  };
}

module.exports = { MANIFEST_VERSION, buildBehavioralManifest, evaluateBehavioralStep, initializeBehavioralState, behavioralBlockResult };
