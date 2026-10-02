'use strict';

const crypto = require('node:crypto');
const { readSealedRun } = require('./learning-intake');
const { evaluateCanaryTrial, shouldRouteToCandidate } = require('./canary');
const { detectLatencyRegression } = require('./optimization-hypothesis');

function metricOf(sealed) {
  const started = sealed.events.find(event => event.type === 'run_started');
  const action = sealed.events.find(event => event.type === 'action_proposed');
  const closed = sealed.events.find(event => event.type === 'run_closed');
  const measurements = closed?.payload?.measurements;
  if (!measurements || !['executionCost', 'verificationCost', 'canaryOverheadCost']
    .every(key => Number.isFinite(measurements[key]) && measurements[key] >= 0)) return null;
  const occurredAt = Date.parse(started?.payload?.createdAt);
  if (!Number.isFinite(occurredAt)) return null;
  return { ...measurements, occurredAt, eventId: closed.eventId,
    learningEligibility: sealed.manifest.learningEligibility,
    declared: { path: action?.payload?.path, operationType: action?.payload?.operationType },
    durationMs: measurements.executionCost + measurements.verificationCost };
}

function selectCoderCanary({ config, journal, workspaceId, requestId, candidates, procedureHash, trust }) {
  if (config.canary === undefined) return { ok: true, candidates, canary: null };
  const trial = config.canary;
  const candidate = candidates.find(row => row.capabilityId === trial?.candidateCapabilityId);
  const evidence = trust?.getEvidenceForVersion(workspaceId, trial?.candidateCapabilityId, candidate?.boundProcedureVersion);
  if (trust && (!evidence?.ok || evidence.positiveCount === 0)) return { ok: false, code: 'canary_evidence_missing' };
  if (!trial || typeof trial.trialId !== 'string' || !trial.trialId || trial.trialId.length > 128
    || trial.baselineCapabilityId === trial.candidateCapabilityId
    || !candidates.some(row => row.capabilityId === trial.baselineCapabilityId)
    || !candidates.some(row => row.capabilityId === trial.candidateCapabilityId)
    || typeof journal.runIds !== 'function') return { ok: false, code: 'invalid_canary_trial' };
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([
    workspaceId, trial.trialId, trial.baselineCapabilityId, trial.candidateCapabilityId, procedureHash,
  ])).digest('hex');
  const candidateRuns = [];
  const baselineRuns = [];
  const baselineConfig = config.candidates.find(row => row.capabilityId === trial.baselineCapabilityId);
  const seen = new Set();
  for (const runId of baselineConfig.sourceRunIds) {
    const sealed = readSealedRun(journal, runId, workspaceId);
    if (!sealed.ok) return sealed;
    const metric = metricOf(sealed);
    if (!metric) return { ok: false, code: 'canary_cost_unmeasured' };
    baselineRuns.push(metric);
    seen.add(runId);
  }
  let sequence = 1;
  let startAt = Date.now();
  for (const runId of journal.runIds(workspaceId)) {
    if (runId === requestId) continue;
    const events = journal.read(runId, { workspaceId });
    const routing = events.find(event => event.type === 'routing_decided');
    if (routing?.payload?.canary?.trialId !== trial.trialId) continue;
    if (routing.payload.canary.fingerprint !== fingerprint) return { ok: false, code: 'canary_trial_changed' };
    const sealed = readSealedRun(journal, runId, workspaceId);
    if (!sealed.ok) return sealed; // An unfinished effect cannot be sampled past.
    const metric = metricOf(sealed);
    if (!metric) return { ok: false, code: 'canary_cost_unmeasured' };
    sequence += 1;
    startAt = Math.min(startAt, routing.payload.canary.startAt);
    if (!seen.has(runId)) {
      (routing.payload.chosenCapabilityId === trial.candidateCapabilityId ? candidateRuns : baselineRuns).push(metric);
      seen.add(runId);
    }
  }
  // The pure evaluator compares totals. Use equally sized, most recent
  // windows; the 1-in-5 sampling ratio must never make a slower candidate
  // appear cheaper just because fewer candidate requests were served.
  const byTime = (left, right) => left.occurredAt - right.occurredAt
    || left.eventId.localeCompare(right.eventId);
  candidateRuns.sort(byTime);
  baselineRuns.sort(byTime);
  if (candidateRuns.length > baselineRuns.length) return { ok: false, code: 'canary_baseline_insufficient' };
  const count = Math.min(candidateRuns.length, baselineRuns.length);
  const comparisonBaseline = count > 0 ? baselineRuns.slice(-count) : [];
  const evaluation = evaluateCanaryTrial({ candidateRuns, baselineWindowRuns: comparisonBaseline, startAt });
  if (!evaluation.ok) return evaluation;
  const sampleCandidate = shouldRouteToCandidate({ status: evaluation.status,
    capReached: evaluation.capReached, requestSequenceNumber: sequence });
  // Passing a trial is evidence for a promotion request, never an approval.
  // Until an operator admits promotion, all non-trial requests use baseline.
  const chosen = sampleCandidate ? trial.candidateCapabilityId : trial.baselineCapabilityId;
  const latency = detectLatencyRegression({ capabilityId: trial.candidateCapabilityId, events: candidateRuns });
  return { ok: true, candidates: candidates.filter(row => row.capabilityId === chosen), canary: {
    trialId: trial.trialId, fingerprint, startAt, requestSequenceNumber: sequence,
    sampled: sampleCandidate, evaluation, latencyHypothesis: latency.hypothesis || null,
    ...(evidence ? { versionEvidence: { procedureVersion: evidence.procedureVersion,
      positiveCount: evidence.positiveCount, negativeCount: evidence.negativeCount } } : {}),
  } };
}

module.exports = { selectCoderCanary };
