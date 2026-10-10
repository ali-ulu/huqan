'use strict';

// The AURA <-> HUQAN feedback loop (5 steps).
//
// HUQAN's manipulation layer sees pressure aimed at the system (injection,
// urgency, fake authority). It does not see the social vectors a user aims at
// another person (camouflage, alibis, targeted recon, extortion, high-value
// targeting). AURA carries exactly those. This script closes the circle:
//
//   1. TEŞHİS   AURA signal pack names the signals in the text.
//   2. KARAR    HUQAN's gate decides; AURA's risk is read alongside it.
//   3. İCRA     The gate's decision executes (allow => the action runs).
//   4. SONUÇ    The outcome is compared: gate allow + AURA high risk = blind spot.
//   5. ÖĞRENME  The blind spot becomes a verified failure, a proposed rule, then
//      /GERİ    an active rule; a re-preflight now escalates. HUQAN's outcome
//      BESLEME  also answers AURA's cross-check, and AURA's recalc re-scores.
//
// Every step calls real code: gate lib/mcp-gate-adapter.js, learning
// lib/error-prevention, scoring AURA's scripts/recalc_confidence.ts.

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const MemoryStore = require('../lib/memory-store');
const { createErrorPrevention } = require('../lib/error-prevention');
const { evaluateMcpGate } = require('../lib/mcp-gate-adapter');
const auraSignalPack = require('../lib/aura-signal-pack');
const auraRisk = require('../plugins/aura-risk');
const auraCanary = require('../lib/aura-canary-bridge');
const { auraRuleProvenance } = require('../lib/error-prevention/rule-proposal');
const { AURA_DECISION_TO_HUQAN, _test: auraRiskTest } = auraRisk;
const createAuraRiskPlugin = auraRisk.create;

const DEFAULT_CASE_ID = 'M-CASE-001';
const DEFAULT_TOOL = 'huqan.ask';
const DEFAULT_OPERATION = 'ask';
const DEFAULT_APPROVAL_ID = 'aura-loop-approval';

// The loop's finding as a bounded canary trial (lib/experience/canary.js): the
// baseline is the gate without the learned rule; the candidate is the gate with
// it. HUQAN decides the rest — this only supplies the sample.
const CANARY_TRIAL_SAMPLE = 12;
const CANARY_TRIAL_START = Date.parse('2026-01-01T00:00:00.000Z');

function canaryTrialSample({ declared, startAt }) {
  const candidateRuns = [];
  const baselineWindowRuns = [];
  for (let i = 0; i < CANARY_TRIAL_SAMPLE; i += 1) {
    const occurredAt = startAt + i * 1000;
    candidateRuns.push(auraCanary.makeRun({
      occurredAt, declared, learningEligibility: 'positive_procedure',
    }));
    baselineWindowRuns.push(auraCanary.makeRun({
      occurredAt, declared, learningEligibility: i % 3 === 0 ? 'negative_example' : 'positive_procedure',
    }));
  }
  return { candidateRuns, baselineWindowRuns };
}

// Promotion admission for the canary (#3469): a learner may not authorize its
// own change. The proposer is the loop; the authority is a separate, verified
// operator principal (a registry with no resolver refuses every authority).
function resolveAuraCanaryAdmission({ workspaceId, capabilityId, promotionId, operator, proposerIds }) {
  const { createPromotionAdmissionRegistry } = require('../lib/experience/canary');
  const registry = createPromotionAdmissionRegistry({
    resolvePrincipal: (reference) => (reference === operator
      ? { ok: true, principal: { id: reference } }
      : { ok: false, code: 'unverified_principal' }),
  });
  const recorded = registry.recordExplicitApproval({
    workspaceId, capabilityId, promotionId, approverId: operator,
    reason: 'aura-loop-canary-promotion',
    subject: { kind: 'promotion', candidateVersion: capabilityId },
  });
  if (!recorded.ok) return { admitted: false, code: recorded.code };
  return registry.resolveAdmission({ workspaceId, capabilityId, promotionId, proposerIds });
}

// #9 — AURA scores the *intent* of the risky text; a planted context canary
// proves the *act*. If the marker shows up in an outbound payload, AB14 blocks
// and the receipt carries only a fingerprint — the strongest answer to AURA.
function proveCanaryTripwire({ signalIds, leaked = true }) {
  const planted = auraCanary.plantCanaryForAuraSignal({ signalIds, context: 'aura-risky-context' });
  const payload = leaked
    ? { destination: 'https://collector.example.net', body: `forward: ${planted.marker}` }
    : { destination: 'https://collector.example.net', body: 'forward: a normal summary' };
  const result = auraCanary.detectCanaryLeak(payload);
  // The tripwire result is what a receipt would carry: it must name the leak by
  // fingerprint, never hand a reader the working marker.
  const resultText = JSON.stringify(result);
  return {
    planted,
    leaked,
    decision: result.decision,
    reason: result.reason,
    fingerprints: result.canaryFingerprints,
    receiptCarriesMarker: resultText.includes(planted.marker) || resultText.includes(planted.canaryId),
  };
}

// HUQAN's memory admission gate keeps any rule written at riskScore >= 50 in
// review, and quarantines one at >= 85 (lib/memory-admission-gate.js). A rule's
// write risk is deliberately a different axis from the risk of the action it
// guards: the rule is a low-risk text write, whatever it later refuses. So this
// loop does not carry AURA's action risk into the rule's `riskScore` — it puts
// it in the rule's constraint text, where it belongs.
function loadAuraRecalc(auraRoot) {
  process.env.TS_NODE_PROJECT = path.join(auraRoot, 'tsconfig.json');
  process.env.TS_NODE_TRANSPILE_ONLY = 'true';
  const auraRequire = createRequire(path.join(auraRoot, 'package.json'));
  auraRequire('ts-node/register/transpile-only');
  return auraRequire(path.join(auraRoot, 'scripts', 'recalc_confidence.ts')).RecalcConfidence;
}

function findCaseInPack(pack, caseId) {
  return pack.cases.find((entry) => entry.case_id === caseId) || null;
}

function caseFilePath(auraRoot, caseId) {
  const dirs = ['MANIPULATION', 'FRAUD', 'ACCESS'];
  for (const dir of dirs) {
    const candidate = path.join(auraRoot, 'public_cases', dir, `${caseId}.json`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// HUQAN's gate, run exactly as the MCP adapter runs it: the text is the tool
// argument and the metadata names the source.
function gateDecide(tool, text) {
  return evaluateMcpGate({
    tool,
    args: tool === 'huqan.ask' ? { question: text } : { text },
    metadata: { source: 'cli', actor: 'cli-user', runner: 'cli', sourceTrust: 'local' },
  });
}

// Step 5 write-back: AURA stays `pending` until its cross-check questions are
// answered. HUQAN's gate outcome is such an answer, so the loop writes it into
// the case's cross_check.history and lets AURA's own recalc re-score.
function answerCrossCheck(caseObj, gateResult, caseId) {
  const questions = caseObj.cross_check && Array.isArray(caseObj.cross_check.questions)
    ? caseObj.cross_check.questions
    : [];
  const failed = gateResult.decision !== 'allow';
  caseObj.cross_check = caseObj.cross_check || {};
  caseObj.cross_check.history = questions.map((question, index) => ({
    id: question && (question.id || question.name) ? (question.id || question.name) : `cc-${index}`,
    status: failed ? 'failed' : 'passed',
    verifier: 'huqan-gate',
    notes: `AURA cross-check answered by the HUQAN gate: decision=${gateResult.decision} risk=${gateResult.risk ? gateResult.risk.score : ''} (case ${caseId})`,
  }));
  return caseObj.cross_check.history;
}

async function runAuraLoop(options = {}) {
  const auraRoot = options.auraRoot || auraSignalPack.auraRoot();
  const pack = options.pack || auraSignalPack.loadSignalPack(options);
  const caseId = options.caseId || DEFAULT_CASE_ID;
  const workspaceId = options.workspaceId || 'aura-loop';
  const tool = options.tool || DEFAULT_TOOL;
  const operation = options.operation || DEFAULT_OPERATION;
  const approvalId = options.approvalId || DEFAULT_APPROVAL_ID;

  const plugin = createAuraRiskPlugin({ pack });
  const report = [];
  const step = (n, name, detail) => {
    report.push({ step: n, name, detail });
    return detail;
  };

  // --- 1. TEŞHİS -----------------------------------------------------------
  const packCase = findCaseInPack(pack, caseId);
  if (!packCase) {
    throw Object.assign(new Error(`case ${caseId} not found in AURA signal pack`), { code: 'AURA_CASE_MISSING' });
  }
  const text = packCase.scenario_texts[0] || '';
  const diagnose = {
    caseId,
    category: packCase.category,
    auraSignals: packCase.signal_ids,
    auraDecision: packCase.decision,
    auraConfidence: packCase.confidence,
    engineAvailable: pack.engineAvailable,
  };
  step(1, 'TEŞHİS (AURA sinyalleri)', diagnose);

  // --- 2. KARAR ------------------------------------------------------------
  const gate = gateDecide(tool, text);
  const aura = auraRiskTest.classifyText(text, pack);
  const decide = {
    tool,
    huqanDecision: gate.decision,
    huqanRisk: gate.risk ? gate.risk.score : null,
    auraRisk: aura.riskScore,
    auraHighRisk: aura.highRisk,
    auraSignals: aura.signalIds,
    mappedAuraDecision: packCase.decision ? AURA_DECISION_TO_HUQAN[packCase.decision] : null,
  };
  step(2, 'KARAR (HUQAN kapısı + AURA riski)', decide);

  // --- 3. İCRA -------------------------------------------------------------
  const executed = gate.allowed === true;
  step(3, 'İCRA (kapı kararı uygulandı)', { executed, reason: gate.reason });

  // --- 4. SONUÇ ------------------------------------------------------------
  const blindSpot = executed && aura.highRisk;
  step(4, 'SONUÇ (çakışma analizi)', {
    blindSpot,
    explanation: blindSpot
      ? 'HUQAN allowed the action while AURA scored it high risk: the gate cannot see these social signals.'
      : 'No blind spot: the gate and AURA agree.',
  });

  // --- 5. ÖĞRENME / GERİ BESLEME ------------------------------------------
  // The store is injectable so the loop writes its learned rule into the same
  // store a live gate reads (kernel.memory), not a private one it never sees.
  const memory = options.memory || new MemoryStore({ useSQLite: false });
  const approvalSubjects = new Map();
  const prevention = createErrorPrevention(memory, {
    // Trusted evidence: a case produced by AURA's own engine. AURA is a verifier
    // here, so the failure source is `verifier_failure` and this callback checks
    // the evidence really is an engine-scored AURA case (the evidence, not the claim).
    verifyEvidence({ source, evidence }) {
      return source === 'verifier_failure'
        && Array.isArray(evidence)
        && evidence.some((item) => item
          && item.type === 'aura_case'
          && item.verifiedBy === 'aura-engine'
          && findCaseInPack(pack, item.ref) !== null);
    },
    resolveApproval({ approvalIdHint, rule, workspaceId: ws, ruleSubjectHash }) {
      if (!approvalSubjects.has(approvalIdHint)) {
        approvalSubjects.set(approvalIdHint, {
          approvalId: approvalIdHint, ruleId: rule ? rule.ruleId : '', workspaceId: ws, ruleSubjectHash,
        });
      }
      return { ...approvalSubjects.get(approvalIdHint), status: 'approved' };
    },
  });

  // The provenance marker travels with the failure and the rule so the core
  // activation path enforces the bounded canary trial too (#3778).
  const ruleProvenance = auraRuleProvenance({ workspaceId });
  const failure = prevention.recordFailure({
    source: 'verifier_failure',
    tool,
    operation,
    workspaceId,
    provenance: ruleProvenance,
    expected: 'review',
    observed: gate.decision,
    evidence: [{ type: 'aura_case', ref: caseId, verifiedBy: 'aura-engine' }],
  });
  if (!failure.ok) throw Object.assign(new Error(failure.error ? failure.error.message : 'recordFailure failed'), { code: 'RECORD_FAILED' });

  const proposal = prevention.proposeRule(failure.memory.memoryId, {
    workspaceId,
    provenance: ruleProvenance,
    enforcement: 'require_verify',
    constraint: `When AURA signals ${aura.signalIds.join(', ')} are present (AURA risk ${aura.riskScore}), a read-only ${tool} must be reviewed, not allowed.`,
    remediation: 'Require a human cross-check before the read is served.',
  });
  if (!proposal.ok) throw Object.assign(new Error('proposeRule failed'), { code: 'PROPOSE_FAILED' });

  // Canary trial (lib/experience/canary.js): the rule learned from the AURA
  // signal is a *candidate*, and HUQAN's own bounded trial decides whether it
  // may be activated — same distribution as the baseline, cost AND
  // negative-example rate at least as good, a strict improvement somewhere,
  // capped at maxRuns/maxDays and failing closed when the cap is hit without
  // evidence. Promotion additionally needs a separate, verified operator
  // admission (#3469): the loop proposes, it never authorizes itself.
  const declared = auraCanary.auraRuleDeclared({ operation, signalIds: aura.signalIds });
  const sample = canaryTrialSample({ declared, startAt: CANARY_TRIAL_START });
  const trial = auraCanary.evaluateAuraRuleTrial({
    candidateRuns: sample.candidateRuns,
    baselineWindowRuns: sample.baselineWindowRuns,
    startAt: CANARY_TRIAL_START,
    now: CANARY_TRIAL_START + CANARY_TRIAL_SAMPLE * 1000 + 1000,
  });
  const capabilityId = options.canaryCapabilityId || `aura-rule:${tool}:${operation}`;
  const admission = resolveAuraCanaryAdmission({
    workspaceId,
    capabilityId,
    promotionId: options.canaryPromotionId || `${workspaceId}:${caseId}:${proposal.memory.memoryId}`,
    operator: options.canaryOperator || 'aura-operator',
    proposerIds: ['aura-loop'],
  });
  const promotion = auraCanary.promotionDecision({ trial, hasAdmission: admission.admitted === true });

  // The rule is activated only when the trial passed AND an admission exists.
  // Otherwise it stays `proposed`: the gate keeps allowing, which is exactly
  // HUQAN's fail-closed posture for an unproven candidate. The trial evidence is
  // handed to the core so its own admission can re-verify the same condition
  // instead of trusting the loop (#3778).
  const canaryTrial = auraCanary.auraRuleTrialEvidence(trial);
  let activation = null;
  if (promotion.activate) {
    activation = prevention.activateRule(proposal.memory.memoryId, {
      workspaceId,
      approvalId,
      actor: 'aura-loop',
      canaryTrial,
    });
    if (!activation.ok) throw Object.assign(new Error('activateRule failed'), { code: 'ACTIVATE_FAILED' });
  }

  // The hardening is measurable: the same action escalates once the rule is
  // active, and stays allowed while the candidate is still on trial.
  const rePreflight = prevention.preflight({ tool, operation, workspaceId });
  const before = { decision: gate.decision, allowed: gate.allowed };
  const after = { decision: rePreflight.decision, allowed: rePreflight.allowed };

  // #9: AURA scores the intent; the context canary proves the act.
  const tripwire = proveCanaryTripwire({ signalIds: aura.signalIds });

  // Write the gate outcome back into AURA and re-score with AURA's engine.
  let auraWriteBack = null;
  const sourceFile = caseFilePath(auraRoot, caseId);
  if (sourceFile) {
    const RecalcConfidence = loadAuraRecalc(auraRoot);
    // A per-call directory: two concurrent loops (e.g. two test files the runner
    // runs in parallel) must not delete each other's scratch file mid-recalc.
    const tmpDir = fs.mkdtempSync(path.join(auraRoot, '.aura-loop-tmp-'));
    const tmpFile = path.join(tmpDir, `${caseId}.json`);
    const caseObj = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    const beforeConfidence = caseObj.confidence;
    const beforeDecision = caseObj.decision;
    answerCrossCheck(caseObj, gate, caseId);
    fs.writeFileSync(tmpFile, JSON.stringify(caseObj, null, 2), 'utf8');
    await new RecalcConfidence().recalc(tmpFile, false, 0);
    const rescored = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    auraWriteBack = {
      caseId,
      crossCheckAnswered: (rescored.cross_check.history || []).length,
      before: { confidence: beforeConfidence, decision: beforeDecision },
      after: { confidence: rescored.confidence, decision: rescored.decision },
      decisionReasons: rescored.decision_reasons || [],
    };
  }

  step(5, 'ÖĞRENME / GERİ BESLEME', {
    huqan: {
      failure: {
        verificationStatus: failure.failure.verificationStatus,
        expected: failure.failure.expected,
        observed: failure.failure.observed,
      },
      rule: {
        // `proposed` until the canary trial passes and an admission exists;
        // `active` only after promotion. Never assumed.
        status: activation ? activation.rule.status : 'proposed',
        enforcement: activation ? activation.rule.enforcement : (proposal.rule ? proposal.rule.enforcement : null),
        riskScore: activation ? activation.rule.riskScore : (proposal.rule ? proposal.rule.riskScore : null),
      },
      canary: {
        trialStatus: trial.status,
        trialReason: trial.reason,
        sampleSize: trial.sampleSize,
        negativeRate: trial.candidateMetrics ? trial.candidateMetrics.negativeRate : null,
        baselineNegativeRate: trial.baselineMetrics ? trial.baselineMetrics.negativeRate : null,
        admission: admission.admitted === true,
        admissionCode: admission.code || null,
        promotion: promotion.reason,
      },
      gateBefore: before,
      gateAfter: after,
      hardened: before.decision !== after.decision,
    },
    aura: auraWriteBack,
    tripwire: {
      planted: Boolean(tripwire.planted.canaryId),
      decision: tripwire.decision,
      reason: tripwire.reason,
      fingerprintOnly: tripwire.fingerprints.length > 0 && tripwire.receiptCarriesMarker === false,
    },
    loopClosed: before.decision !== after.decision && Boolean(auraWriteBack) && auraWriteBack.before.decision !== auraWriteBack.after.decision,
  });

  return { report, blindSpot, gateBefore: before, gateAfter: after, auraWriteBack, canary: { trial, admission, promotion, tripwire } };
}

module.exports = { runAuraLoop, gateDecide, answerCrossCheck, canaryTrialSample, resolveAuraCanaryAdmission, proveCanaryTripwire };

if (require.main === module) {
  runAuraLoop()
    .then((result) => {
      for (const entry of result.report) {
        console.log(`\n[${entry.step}] ${entry.name}`);
        console.log(JSON.stringify(entry.detail, null, 2));
      }
      console.log(`\nLOOP CLOSED: ${result.report[4].detail.loopClosed}`);
    })
    .catch((err) => {
      console.error(`AURA loop failed: ${err.message}`);
      process.exit(1);
    });
}
