#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const {
  ACTION_CATEGORIES,
  ACTION_DECISIONS,
  POLICY_VERSION,
  classifyAgentAction,
} = require('../lib/action-risk-classifier');

const MAX_STEPS = 15;
const VERDICTS = Object.freeze({ ALLOW: 'ALLOW', REVIEW: 'REVIEW', BLOCK: 'BLOCK', DRY_RUN_ONLY: 'DRY-RUN-ONLY' });
const RECOMMENDATIONS = Object.freeze({
  AUTOMATE: 'AUTOMATE',
  AUTOMATE_WITH_HUMAN_APPROVAL: 'AUTOMATE_WITH_HUMAN_APPROVAL',
  PILOT_ONLY: 'PILOT_ONLY',
  DO_NOT_AUTOMATE: 'DO_NOT_AUTOMATE',
});
const PROFILE_IDS = Object.freeze({ COGNERA: 'cognera', BEEMAGNETICS: 'beemagnetics' });
const DECISION_RANK = Object.freeze({
  [ACTION_DECISIONS.ALLOW]: 0,
  [ACTION_DECISIONS.QUARANTINE]: 1,
  [ACTION_DECISIONS.HUMAN_REVIEW]: 2,
  [ACTION_DECISIONS.BLOCK]: 3,
});

function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.keys(value).sort().reduce((result, key) => { result[key] = stableValue(value[key]); return result; }, {});
}
function deterministicId(value) { return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex').slice(0, 24); }
function normalizeProfile(value) {
  const profile = String(value || '').trim().toLowerCase();
  if (profile === PROFILE_IDS.COGNERA || profile === PROFILE_IDS.BEEMAGNETICS) return profile;
  throw new RangeError(`profile must be one of: ${Object.values(PROFILE_IDS).join(', ')}`);
}
function strongerDecision(left, right) {
  const leftRank = DECISION_RANK[left] ?? DECISION_RANK[ACTION_DECISIONS.HUMAN_REVIEW];
  const rightRank = DECISION_RANK[right] ?? DECISION_RANK[ACTION_DECISIONS.HUMAN_REVIEW];
  return leftRank >= rightRank ? left : right;
}
function decisionToVerdict(decision) {
  if (decision === ACTION_DECISIONS.BLOCK) return VERDICTS.BLOCK;
  if (decision === ACTION_DECISIONS.HUMAN_REVIEW) return VERDICTS.REVIEW;
  if (decision === ACTION_DECISIONS.QUARANTINE) return VERDICTS.DRY_RUN_ONLY;
  if (decision === ACTION_DECISIONS.ALLOW) return VERDICTS.ALLOW;
  return VERDICTS.REVIEW;
}
function recommendationFor(decision, humanApprovalRequested) {
  if (decision === ACTION_DECISIONS.BLOCK) return RECOMMENDATIONS.DO_NOT_AUTOMATE;
  if (decision === ACTION_DECISIONS.HUMAN_REVIEW) return RECOMMENDATIONS.AUTOMATE_WITH_HUMAN_APPROVAL;
  if (decision === ACTION_DECISIONS.QUARANTINE) return RECOMMENDATIONS.PILOT_ONLY;
  return humanApprovalRequested ? RECOMMENDATIONS.AUTOMATE_WITH_HUMAN_APPROVAL : RECOMMENDATIONS.AUTOMATE;
}
function cogneraProfileAssessment(item) {
  const reasons = [];
  let decision = ACTION_DECISIONS.ALLOW;
  if (item.humanApproval) { decision = strongerDecision(decision, ACTION_DECISIONS.HUMAN_REVIEW); reasons.push('Cognera profile marks this step as requiring human approval.'); }
  if (item.dataSensitivity === 'sensitive' || item.dataSensitivity === 'personal') { decision = strongerDecision(decision, ACTION_DECISIONS.HUMAN_REVIEW); reasons.push('Sensitive or personal data requires explicit review in the Cognera profile.'); }
  return { decision, reasons };
}
function beeMagneticsProfileAssessment(item) {
  const engineering = isPlainObject(item.engineering) ? item.engineering : {};
  const requiredInputs = Array.isArray(engineering.requiredInputs) ? engineering.requiredInputs.map(String) : [];
  const suppliedInputs = new Set(Array.isArray(engineering.suppliedInputs) ? engineering.suppliedInputs.map(String) : []);
  const missingInputs = requiredInputs.filter(input => !suppliedInputs.has(input));
  const sourceRefs = Array.isArray(engineering.sourceRefs) ? engineering.sourceRefs.filter(Boolean).map(String) : [];
  const customerFacing = Boolean(engineering.customerFacing);
  const combinesToolOutputs = Boolean(engineering.combinesToolOutputs);
  const reasons = [];
  let decision = ACTION_DECISIONS.ALLOW;
  if (missingInputs.length) { decision = strongerDecision(decision, ACTION_DECISIONS.HUMAN_REVIEW); reasons.push(`Missing required engineering inputs: ${missingInputs.join(', ')}`); }
  if (combinesToolOutputs && !sourceRefs.length) { decision = strongerDecision(decision, ACTION_DECISIONS.HUMAN_REVIEW); reasons.push('Combined engineering tool outputs require source references.'); }
  if (customerFacing || item.humanApproval) { decision = strongerDecision(decision, ACTION_DECISIONS.HUMAN_REVIEW); reasons.push('Customer-facing engineering output requires engineer approval.'); }
  return { decision, reasons, details: { missingInputs, sourceRefs, customerFacing, combinesToolOutputs } };
}
const PROFILES = Object.freeze({
  [PROFILE_IDS.COGNERA]: Object.freeze({ id: PROFILE_IDS.COGNERA, name: 'Cognera Governed Automation Assessment', policyPack: 'cognera-automation-v1', assessStep: cogneraProfileAssessment }),
  [PROFILE_IDS.BEEMAGNETICS]: Object.freeze({ id: PROFILE_IDS.BEEMAGNETICS, name: 'BeeMagnetics Governed Engineering Assessment', policyPack: 'beemagnetics-engineering-v1', assessStep: beeMagneticsProfileAssessment }),
});
function normalizeStep(rawStep, index) {
  if (!isPlainObject(rawStep)) return { malformed: true, description: String(rawStep ?? '').trim(), action: null, actionType: null, target: null, context: {}, flags: [], automationType: 'unspecified', suggestedTechnology: '', humanApproval: false, dataSensitivity: '', engineering: {}, originalIndex: index };
  const description = String(rawStep.description || rawStep.action || '').trim();
  return {
    malformed: !description, description, action: description || null,
    actionType: rawStep.actionType || rawStep.category || ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION,
    target: rawStep.target, context: isPlainObject(rawStep.context) ? rawStep.context : {},
    flags: Array.isArray(rawStep.flags) ? rawStep.flags : rawStep.flags ? [rawStep.flags] : [],
    automationType: String(rawStep.automationType || 'unspecified').trim(), suggestedTechnology: String(rawStep.suggestedTechnology || '').trim(),
    humanApproval: Boolean(rawStep.humanApproval), dataSensitivity: String(rawStep.dataSensitivity || '').trim().toLowerCase(),
    engineering: isPlainObject(rawStep.engineering) ? rawStep.engineering : {}, originalIndex: index,
  };
}
function assess(input, options = {}) {
  if (!isPlainObject(input)) throw new TypeError('assessment input must be an object');
  const rawSteps = Array.isArray(input.steps) ? input.steps : [];
  if (!rawSteps.length) throw new RangeError('at least one process step is required');
  if (rawSteps.length > MAX_STEPS) throw new RangeError(`at most ${MAX_STEPS} process steps are supported`);
  const profileId = normalizeProfile(options.profile || input.profile);
  const profile = PROFILES[profileId];
  const workspaceId = String(input.workspaceId || 'default').trim() || 'default';
  const sourceRef = String(input.sourceRef || '').trim();
  const now = input.now ?? options.now ?? null;
  const assessmentId = deterministicId({ profile: profileId, name: String(input.name || 'Unnamed process').trim(), sourceRef, workspaceId, monthlyVolume: numberOrZero(input.monthlyVolume), minutesPerCase: numberOrZero(input.minutesPerCase), steps: rawSteps });
  const results = rawSteps.map((rawStep, index) => {
    const item = normalizeStep(rawStep, index);
    const policy = classifyAgentAction(item.malformed ? null : { category: item.actionType, action: item.action, target: item.target, context: item.context, flags: item.flags, now }, { allowlistedPaths: input.allowlistedPaths, allowlistedUrls: input.allowlistedUrls, now });
    const profileAssessment = profile.assessStep(item);
    const effectiveDecision = strongerDecision(policy.decision, profileAssessment.decision);
    const trace = Object.freeze({ assessmentId, workspaceId, sourceRef, policyVersion: policy.policyVersion || POLICY_VERSION, policyPack: profile.policyPack, step: index + 1 });
    return { step: index + 1, trace, description: item.description, automationType: item.automationType, suggestedTechnology: item.suggestedTechnology, humanApprovalRequested: item.humanApproval, policy, profileAssessment, effectiveDecision, verdict: decisionToVerdict(effectiveDecision), recommendation: recommendationFor(effectiveDecision, item.humanApproval) };
  });
  const aggregateDecision = results.reduce((decision, result) => strongerDecision(decision, result.effectiveDecision), ACTION_DECISIONS.ALLOW);
  const monthlyVolume = numberOrZero(input.monthlyVolume); const minutesPerCase = numberOrZero(input.minutesPerCase);
  const allowedCount = results.filter(result => result.effectiveDecision === ACTION_DECISIONS.ALLOW).length;
  const reviewCount = results.filter(result => result.effectiveDecision === ACTION_DECISIONS.HUMAN_REVIEW).length;
  const blockedCount = results.filter(result => result.effectiveDecision === ACTION_DECISIONS.BLOCK).length;
  const dryRunCount = results.filter(result => result.effectiveDecision === ACTION_DECISIONS.QUARANTINE).length;
  const allowedRatio = allowedCount / results.length;
  return {
    product: 'HUQAN', engine: 'AXIOM', assessmentType: 'Governed Automation Assessment',
    profile: { id: profile.id, name: profile.name, policyPack: profile.policyPack },
    trace: { assessmentId, workspaceId, sourceRef, policyVersion: POLICY_VERSION, evaluatedAt: now },
    process: { name: String(input.name || 'Unnamed process').trim(), sourceRef, workspaceId },
    verdict: decisionToVerdict(aggregateDecision),
    summary: { steps: results.length, allowed: allowedCount, reviewRequired: reviewCount, dryRunOnly: dryRunCount, blocked: blockedCount, estimatedPotentialMonthlyHoursSaved: Math.round((monthlyVolume * minutesPerCase * allowedRatio / 60) * 10) / 10, savingsCalculation: { method: 'allowed-step-ratio', assumption: 'all process steps have equal effort', monthlyVolume, minutesPerCase, allowedStepRatio: allowedRatio } },
    controls: ['Deterministic action policy classification', 'Profile rules may preserve or increase risk but never reduce the core verdict', 'Human approval requirement is reported but not executed', 'Classifier receipt primitive per assessed action', 'No action execution performed by this assessment'],
    steps: results,
  };
}
function parseProfileArgument(argv) { const index = argv.indexOf('--profile'); return index === -1 ? null : (argv[index + 1] || null); }
if (require.main === module) {
  try { const input = JSON.parse(fs.readFileSync(0, 'utf8')); process.stdout.write(`${JSON.stringify(assess(input, { profile: parseProfileArgument(process.argv.slice(2)) }), null, 2)}\n`); }
  catch (error) { process.stderr.write(`HUQAN governed assessment failed: ${error.message}\n`); process.exitCode = 1; }
}
module.exports = { MAX_STEPS, PROFILE_IDS, PROFILES, RECOMMENDATIONS, VERDICTS, assess, decisionToVerdict, recommendationFor, strongerDecision };
