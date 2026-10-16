'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolvePathWithinRoot } = require('../path-safety');
const { buildLearningProposal, readSealedRun } = require('./learning-intake');
const { compile, qualify, specializeRenameSequence, bindRenameQualification } = require('./compiler');
const { renameIdentifier } = require('../task-identifier-lexer');
const { createProcedureRegistry } = require('./procedure-registry');
const { createCapabilityTrustRegistry } = require('./capability-trust');
const { composePersonalExecutionModel, evaluatePersonalExecutionModel } = require('./personal-execution-model');
const { selectCoderCanary } = require('./coder-canary-runtime');
const { replayCoderTrust } = require('./coder-trust-replay');
const { adaptExpression, bindQualification } = require('./expression-adaptation');

const digest = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const failed = code => ({ ok: false, code });

function observeFile(root, relative) {
  return fs.readFileSync(resolvePathWithinRoot(root, path.resolve(root, relative)), 'utf8');
}

// #3310 B4 §17: a single occurrence on a markdown blockquote line or inside a
// fenced code block may be a quoted record that must not move. A learned
// procedure cannot tell, so it refuses rather than rewrite it. Quoted strings
// are deliberately not covered: configuration values legitimately change.
function inProtectedContext(content, oldText) {
  const at = content.indexOf(oldText);
  if (at < 0 || content.indexOf(oldText, at + 1) >= 0) return false;
  const lines = content.slice(0, at).split('\n');
  const line = lines.pop() + content.slice(at).split('\n')[0];
  const fences = lines.filter(text => text.trimStart().startsWith('```')).length;
  return line.trimStart().startsWith('>') || fences % 2 === 1;
}

function transform(procedure, content) {
  const { oldText, newText } = procedure.params;
  const sites = content.split(oldText).length - 1;
  return { sites, after: sites === 1 ? content.replace(oldText, () => newText) : content };
}

function routeRenameSequence({ task, root, journal, workspaceId, requestId, files, transferTestReady }) {
  const config = task.experience;
  if (!config || config.intentOnly !== true || config.riskTier !== 'low' || config.fallbackOnRefusal
    || config.canary || !Array.isArray(config.candidates) || config.candidates.length !== 1)
    return failed('invalid_experience_dispatch');
  if (!transferTestReady || !task.test || typeof task.test.command !== 'string' || !task.test.command.trim())
    return failed('transfer_verification_required');
  const candidate = config.candidates[0];
  const replacement = candidate?.kind === 'replacement_sequence';
  if ((!replacement && candidate?.kind !== 'rename_sequence') || !Array.isArray(candidate.sourceRunIds)
    || candidate.sourceRunIds.length !== 1 || !Array.isArray(candidate.qualificationPaths)
    || candidate.qualificationPaths.length > 32) return failed('invalid_experience_candidate');
  try {
    const runId = candidate.sourceRunIds[0];
    const sealed = readSealedRun(journal, runId, workspaceId);
    if (!sealed.ok) return sealed;
    if (sealed.events.some(event => event.type === 'routing_decided')) return failed('routed_source_requires_original_candidate');
    const params = candidate.sourceParams;
    const asOperation = step => replacement
      ? { type: 'replace_text', path: step.path, find: step.oldText, replace: step.newText }
      : { type: 'rename_identifier', ...step };
    const sourceOperation = { type: 'sequence', steps: params?.steps?.map(asOperation) };
    const action = sealed.events.find(event => event.type === 'action_proposed')?.payload;
    if (action?.operationType !== 'sequence' || action.sequenceSteps !== sourceOperation.steps?.length
      || action.sequenceSha256 !== digest(JSON.stringify(sourceOperation))) return failed('source_procedure_mismatch');
    const proposal = buildLearningProposal(journal, { runId, workspaceId, kind: candidate.kind, params });
    if (!proposal.ok || !proposal.procedure || proposal.eligibility !== 'positive_procedure')
      return failed(proposal.code || 'source_not_eligible');
    if (candidate.sourceProcedureHash !== proposal.procedure.hash) return failed('source_procedure_mismatch');
    if (replacement && (candidate.identifierBindings !== undefined || candidate.rename !== undefined))
      return failed('procedure_binding_mismatch');
    const specialized = replacement ? proposal : specializeRenameSequence({ procedure: proposal.procedure,
      targetPaths: task.operation.steps.map(step => step.path), identifierBindings: candidate.identifierBindings,
      rename: candidate.rename });
    if (!specialized.ok) return specialized;
    const procedure = specialized.procedure;
    const expected = { type: 'sequence', steps: procedure.params.steps.map(asOperation) };
    if (JSON.stringify(task.operation) !== JSON.stringify(expected)
      || candidate.capabilityId !== `stored-${procedure.hash}`
      || !procedure.params.steps.every(step => task.allowedPaths.includes(step.path))) return failed('procedure_binding_mismatch');
    const registry = createProcedureRegistry();
    const registered = registry.register({ workspaceId, procedure, provenance: {
      sourceSha: sealed.sourceHash, procedureVersion: String(procedure.version), configHash: digest(JSON.stringify(expected)) } });
    if (!registered.ok) return registered;
    const apply = (compiled, input) => {
      const next = { ...input };
      for (const step of compiled.params.steps) next[step.path] = replacement
        ? next[step.path].replace(step.oldText, () => step.newText)
        : renameIdentifier(next[step.path], step.from, step.to).source;
      return { files: next };
    };
    for (const relative of candidate.qualificationPaths) {
      if (typeof relative !== 'string' || !relative) return failed('invalid_qualification_path');
      const content = observeFile(root, relative);
      if (content.length > 65536) return failed('qualification_input_limit');
      let input = JSON.parse(content);
      if (!replacement && input?.format === 'huqan-coder-rename-qualification') {
        if (input.schemaVersion !== 1 || Object.keys(input).length !== 3) return failed('invalid_qualification_input');
        const bound = bindRenameQualification({ sourceProcedure: proposal.procedure, targetProcedure: procedure, files: input.files });
        if (!bound.ok) return failed(bound.code);
        input = bound.files;
      }
      const result = qualify({ procedure, inputs: [relative], observe: () => input, apply: compiled => apply(compiled, input) });
      registry.recordQualification({ workspaceId, kind: procedure.kind, version: procedure.version, details: result });
    }
    if (replacement && procedure.params.steps.some(step => typeof files[step.path] === 'string'
      && inProtectedContext(files[step.path], step.oldText))) return failed('protected_context');
    const qualified = qualify({ procedure, inputs: ['target'], observe: () => files, apply: compiled => apply(compiled, files) });
    registry.recordQualification({ workspaceId, kind: procedure.kind, version: procedure.version, details: qualified });
    if (!qualified.ok) return qualified;
    const coverage = registry.evaluateCoverageGate({ workspaceId, kind: procedure.kind });
    if (!coverage.admissible) return failed(coverage.code);
    const activated = registry.setActiveVersion({ workspaceId, kind: procedure.kind, version: procedure.version });
    if (!activated.ok) return activated;
    const trust = createCapabilityTrustRegistry();
    const created = trust.createCapability({ workspaceId, capabilityId: candidate.capabilityId, boundProcedureVersion: procedure.hash });
    if (!created.ok) return created;
    const replayed = replayCoderTrust({ journal, workspaceId, requestId, capabilityId: candidate.capabilityId,
      procedureHash: procedure.hash, trust, seededRunIds: [] });
    if (!replayed.ok) return replayed;
    const composed = composePersonalExecutionModel({ workspaceId, capabilityTrust: [
      { ...trust.get(workspaceId, candidate.capabilityId, Date.now()), preconditions: procedure.preconditions }] });
    if (!composed.ok) return composed;
    const routed = evaluatePersonalExecutionModel(composed.pem, { requestId,
      declared: replacement ? { oldTextPresent: true, singleMatchSite: true }
        : { identifiersPresent: true, targetIdentifiersAbsent: true }, riskTier: 'low',
      policy: { insufficientDataMaxRiskTier: 'low' } });
    if (!routed.ok) return routed;
    if (routed.decision.refusalReason) return { ...failed(routed.decision.refusalReason), decision: routed.decision };
    return { ok: true, task, modelId: composed.pem.modelId, decision: { ...routed.decision,
      execution: { operationType: 'sequence', sequenceSha256: digest(JSON.stringify(expected)), sequenceSteps: expected.steps.length },
      transfer: { sourceProcedureHash: proposal.procedure.hash, sourceHash: sealed.sourceHash,
        targetPaths: procedure.params.steps.map(step => step.path) } } };
  } catch (error) { return failed(error.code === 'INTEGRITY_MISMATCH' ? 'integrity_mismatch' : 'experience_dispatch_unavailable'); }
}

// Registries are derived from sealed, integrity-checked journal evidence on
// every invocation. They are caches, never a second persistence authority.
function routeCoderProcedure({ task, root, journal, workspaceId, requestId, files, transferTestReady = false }) {
  const config = task.experience;
  if (config === undefined) return { ok: true, task, decision: null };
  if (!journal) return failed('experience_journal_required');
  if (task.operation?.type === 'sequence') return routeRenameSequence({ task, root, journal, workspaceId, requestId, files, transferTestReady });
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
  const transfers = new Map();
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
      const sourcePath = candidate.sourcePath ?? target;
      const sourceParams = candidate.sourceParams ?? { ...params, path: sourcePath };
      const adapting = candidate.sourceParams !== undefined;
      let adaptationBindings = null;
      let qualificationBinding = null;
      const transferring = sourcePath !== target || adapting;
      if (typeof sourcePath !== 'string' || !sourcePath) return failed('invalid_candidate_procedure');
      if (transferring && (!transferTestReady || !task.test || typeof task.test.command !== 'string'
        || !task.test.command.trim())) return failed('transfer_verification_required');
      if (adapting) {
        if (sourceParams?.path !== sourcePath || !/\.(?:cjs|mjs|js)$/.test(target)) return failed('invalid_candidate_procedure');
        const adapted = adaptExpression({ ...sourceParams, content: files[target],
          functionName: task.synthesis?.functionName, family: task.synthesis?.family });
        if (!adapted.ok || adapted.oldText !== params.oldText || adapted.newText !== params.newText)
          return failed('adaptation_binding_mismatch');
        adaptationBindings = adapted.bindings;
        qualificationBinding = adapted.qualification;
      }
      const procedureKey = JSON.stringify([target, sourcePath, oldText, params.newText, parentVersion,
        candidate.sourceProcedureHash ?? null, sourceParams]);
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
          || operation.path !== sourcePath || operation.findSha256 !== digest(sourceParams.oldText)
          || operation.replaceSha256 !== digest(sourceParams.newText)) return failed('source_procedure_mismatch');
        if (!canonicalProcedures.has(procedureKey)) {
          const proposal = buildLearningProposal(journal, { runId, workspaceId,
            params: sourceParams, parentVersion });
          if (!proposal.ok || !proposal.procedure) return failed(proposal.code || 'source_not_eligible');
          let proposed = proposal.procedure;
          if (transferring) {
            if (candidate.sourceProcedureHash !== proposed.hash) return failed('source_procedure_mismatch');
            const specialized = compile({ candidate: { ...proposal.candidate, procedureHash: proposed.hash },
              kind: proposed.kind, params, parentVersion: proposed.version });
            if (!specialized.ok) return specialized;
            proposed = specialized.procedure;
            transfers.set(proposed.hash, { sourcePath, sourceProcedureHash: candidate.sourceProcedureHash,
              sourceHash: sealed.sourceHash, targetPath: target, ...(adapting ? { adapted: true } : {}) });
          }
          const provenance = { sourceSha: digest(JSON.stringify([...candidate.sourceRunIds].sort())),
            procedureVersion: String(proposed.version),
            configHash: digest(JSON.stringify([target, oldText, params.newText, parentVersion])) };
          const registered = registry.register({ workspaceId, procedure: proposed, provenance });
          if (!registered.ok) return registered;
          canonicalProcedures.set(procedureKey, proposed);
        }
        procedure = canonicalProcedures.get(procedureKey);
      }
      if (transferring) {
        const bound = trust.createCapability({ workspaceId, capabilityId: candidate.capabilityId,
          boundProcedureVersion: procedure.hash });
        if (!bound.ok) return bound;
      }
      const replayed = replayCoderTrust({ journal, workspaceId, requestId, capabilityId: candidate.capabilityId,
        procedureHash: procedure.hash, trust, seededRunIds: transferring ? [] : candidate.sourceRunIds });
      if (!replayed.ok) return replayed;
      for (const relative of [...candidate.qualificationPaths, target]) {
        if (typeof relative !== 'string' || !relative) return failed('invalid_qualification_path');
        const observe = input => {
          const content = observeFile(root, input);
          return adapting && input !== target ? bindQualification(content, adaptationBindings, qualificationBinding) : content;
        };
        const result = qualify({ procedure, inputs: [relative],
          observe, apply: (compiled, input) => transform(compiled, observe(input)) });
        // Bind the outcome to this version so a passing result is what
        // authorizes activating it (#3460), while the coverage history still
        // sees every path.
        registry.recordQualification({ workspaceId, kind: procedure.kind, version: procedure.version, details: result });
        if (relative === target && !result.ok) return result;
      }
      const coverage = registry.evaluateCoverageGate({ workspaceId, kind: procedure.kind });
      if (!coverage.admissible) return failed(coverage.code);
      const activated = registry.setActiveVersion({ workspaceId, kind: procedure.kind, version: procedure.version });
      if (!activated.ok) return failed(activated.code);
      const stored = registry.get({ workspaceId, kind: procedure.kind, version: procedure.version });
      if (!stored.ok || stored.entry.hash !== procedure.hash) return failed('procedure_binding_mismatch');
      procedures.set(procedure.hash, stored.entry);
      candidates.push({ ...trust.get(workspaceId, candidate.capabilityId, Date.now()),
        preconditions: stored.entry.preconditions });
    }
    const content = files[target];
    if (typeof content === 'string' && inProtectedContext(content, oldText)) return failed('protected_context');
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
    ...(transfers.has(procedure.hash) ? { transfer: transfers.get(procedure.hash) } : {}),
    ...(canary.canary ? { canary: canary.canary } : {}) };
    return { ok: true, decision, modelId: composed.pem.modelId,
      task: { ...task, operation: { type: 'replace_text', path: procedure.params.path,
        find: procedure.params.oldText, replace: procedure.params.newText } } };
  } catch (error) {
    return failed(error.code === 'INTEGRITY_MISMATCH' ? 'integrity_mismatch' : 'experience_dispatch_unavailable');
  }
}

module.exports = { routeCoderProcedure };
