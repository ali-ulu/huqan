'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolvePathWithinRoot } = require('../path-safety');
const { buildLearningProposal, readSealedRun } = require('./learning-intake');
const { qualify } = require('./compiler');
const { createProcedureRegistry } = require('./procedure-registry');
const { createCapabilityTrustRegistry } = require('./capability-trust');
const { composePersonalExecutionModel, evaluatePersonalExecutionModel } = require('./personal-execution-model');
const { selectCoderCanary } = require('./coder-canary-runtime');
const { replayCoderTrust } = require('./coder-trust-replay');

const digest = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const failed = code => ({ ok: false, code });

function observeFile(root, relative) {
  return fs.readFileSync(resolvePathWithinRoot(root, path.resolve(root, relative)), 'utf8');
}

function transform(procedure, content) {
  const { oldText, newText } = procedure.params;
  const sites = content.split(oldText).length - 1;
  return { sites, after: sites === 1 ? content.replace(oldText, () => newText) : content };
}

// Registries are derived from sealed, integrity-checked journal evidence on
// every invocation. They are caches, never a second persistence authority.
function routeCoderProcedure({ task, root, journal, workspaceId, requestId, files }) {
  const config = task.experience;
  if (config === undefined) return { ok: true, task, decision: null };
  if (!journal) return failed('experience_journal_required');
  if (!config || !Array.isArray(config.candidates) || config.candidates.length > 32
    || task.operation?.type !== 'replace_text'
    || (config.riskTier !== undefined && !['low', 'medium', 'high'].includes(config.riskTier))
    || (config.intentOnly !== undefined && typeof config.intentOnly !== 'boolean')) {
    return failed('invalid_experience_dispatch');
  }
  const { path: target } = task.operation;
  let { find: oldText, replace: newText } = task.operation;
  // Intent-only (#3310 B4): the task names the target but not the text. The
  // text comes from candidate params and stays bound to the sealed source
  // hashes below; there is no task text for a structural fallback to apply.
  if (config.intentOnly === true) {
    if (oldText !== undefined || newText !== undefined || config.fallbackOnRefusal === true
      || !config.candidates.every(candidate => candidate?.params)) return failed('invalid_experience_operation');
    ({ oldText, newText } = config.candidates[0].params);
  }
  if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string' || !newText
    || !task.allowedPaths.includes(target)) return failed('invalid_experience_operation');
  const registry = createProcedureRegistry();
  const trust = createCapabilityTrustRegistry();
  const candidates = [];
  const procedures = new Map();
  const ids = new Set();
  const canonicalProcedures = new Map();
  try {
    for (const candidate of config.candidates) {
      if (!candidate || typeof candidate.capabilityId !== 'string' || !candidate.capabilityId
        || ids.has(candidate.capabilityId) || !Array.isArray(candidate.sourceRunIds)
        || candidate.sourceRunIds.length === 0 || candidate.sourceRunIds.length > 50
        || new Set(candidate.sourceRunIds).size !== candidate.sourceRunIds.length
        || !Array.isArray(candidate.qualificationPaths) || candidate.qualificationPaths.length > 32) {
        return failed('invalid_experience_candidate');
      }
      ids.add(candidate.capabilityId);
      const params = candidate.params || { path: target, oldText, newText };
      const parentVersion = candidate.parentVersion ?? 0;
      if (params.path !== target || params.oldText !== oldText || typeof params.newText !== 'string'
        || !params.newText || !Number.isInteger(parentVersion) || parentVersion < 0) return failed('invalid_candidate_procedure');
      const procedureKey = JSON.stringify([target, oldText, params.newText, parentVersion]);
      let procedure;
      for (const runId of candidate.sourceRunIds) {
        const sealed = readSealedRun(journal, runId, workspaceId);
        if (!sealed.ok) return sealed;
        const action = sealed.events.find(event => event.type === 'action_proposed');
        const priorRoute = sealed.events.find(event => event.type === 'routing_decided');
        if (priorRoute && priorRoute.payload.chosenCapabilityId !== candidate.capabilityId) {
          return failed('source_capability_mismatch');
        }
        const operation = priorRoute?.payload?.execution || action?.payload;
        const start = sealed.events.find(event => event.type === 'run_started');
        const occurredAt = Date.parse(start?.payload?.createdAt);
        if (!Number.isFinite(occurredAt) || operation?.operationType !== 'replace_text'
          || operation.path !== target || operation.findSha256 !== digest(oldText)
          || operation.replaceSha256 !== digest(params.newText)) return failed('source_procedure_mismatch');
        if (!canonicalProcedures.has(procedureKey)) {
          const proposal = buildLearningProposal(journal, { runId, workspaceId, params, parentVersion });
          if (!proposal.ok || !proposal.procedure) return failed(proposal.code || 'source_not_eligible');
          const registered = registry.register({ workspaceId, procedure: proposal.procedure });
          if (!registered.ok) return registered;
          canonicalProcedures.set(procedureKey, proposal.procedure);
        }
        procedure = canonicalProcedures.get(procedureKey);
      }
      const replayed = replayCoderTrust({ journal, workspaceId, requestId, capabilityId: candidate.capabilityId,
        procedureHash: procedure.hash, trust, seededRunIds: candidate.sourceRunIds });
      if (!replayed.ok) return replayed;
      for (const relative of [...candidate.qualificationPaths, target]) {
        if (typeof relative !== 'string' || !relative) return failed('invalid_qualification_path');
        const result = qualify({ procedure, inputs: [relative],
          observe: input => observeFile(root, input),
          apply: (compiled, input) => transform(compiled, observeFile(root, input)) });
        registry.recordQualification({ workspaceId, kind: procedure.kind, details: result });
        if (relative === target && !result.ok) return result;
      }
      const coverage = registry.evaluateCoverageGate({ workspaceId, kind: procedure.kind });
      if (!coverage.admissible) return failed(coverage.code);
      registry.setActiveVersion({ workspaceId, kind: procedure.kind, version: procedure.version });
      const stored = registry.get({ workspaceId, kind: procedure.kind, version: procedure.version });
      if (!stored.ok || stored.entry.hash !== procedure.hash) return failed('procedure_binding_mismatch');
      procedures.set(procedure.hash, stored.entry);
      candidates.push({ ...trust.get(workspaceId, candidate.capabilityId, Date.now()),
        preconditions: stored.entry.preconditions });
    }
    const content = files[target];
    const declared = { oldTextPresent: typeof content === 'string' && content.includes(oldText),
      singleMatchSite: typeof content === 'string' && content.split(oldText).length - 1 === 1 };
    const canary = selectCoderCanary({ config, journal, workspaceId, requestId, candidates,
      procedureHash: candidates.map(row => [row.capabilityId, row.boundProcedureVersion]), trust });
    if (!canary.ok) return canary;
    const composed = composePersonalExecutionModel({ workspaceId, capabilityTrust: canary.candidates });
    if (!composed.ok) return composed;
    const routed = evaluatePersonalExecutionModel(composed.pem, { requestId, declared,
      riskTier: config.riskTier || 'low', policy: { insufficientDataMaxRiskTier: 'low' } });
    if (!routed.ok) return routed;
    if (routed.decision.refusalReason) {
      if (config.fallbackOnRefusal !== true || config.riskTier !== 'low'
        || routed.decision.refusalReason !== 'no_eligible_match') {
        return { ...failed(routed.decision.refusalReason), decision: routed.decision };
      }
      const bypassed = canary.candidates.filter(row => row.preconditions && declared.oldTextPresent && declared.singleMatchSite);
      if (!bypassed.length) return failed('no_structural_match');
      for (const row of bypassed) trust.incrementFallbackPreferredOverCount({ workspaceId, capabilityId: row.capabilityId });
      return { ok: true, task, decision: { ...routed.decision,
        fallback: { capabilityIds: bypassed.map(row => row.capabilityId), reason: routed.decision.refusalReason },
        execution: { operationType: 'replace_text', path: target,
          findSha256: digest(oldText), replaceSha256: digest(newText) } } };
    }
    const procedure = procedures.get(routed.decision.boundProcedureVersion);
    if (!procedure) return failed('procedure_binding_missing');
    const decision = { ...routed.decision, execution: { operationType: 'replace_text', path: procedure.params.path,
      findSha256: digest(procedure.params.oldText), replaceSha256: digest(procedure.params.newText) },
    ...(canary.canary ? { canary: canary.canary } : {}) };
    return { ok: true, decision, modelId: composed.pem.modelId,
      task: { ...task, operation: { type: 'replace_text', path: procedure.params.path,
        find: procedure.params.oldText, replace: procedure.params.newText } } };
  } catch (error) {
    return failed(error.code === 'INTEGRITY_MISMATCH' ? 'integrity_mismatch' : 'experience_dispatch_unavailable');
  }
}

module.exports = { routeCoderProcedure };
