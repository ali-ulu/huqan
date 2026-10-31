'use strict';

// #4068 [COG-M5] Lab-only consumption of the dual-process router's advice.
//
// The router (lib/cognition/dual-process-router.js) is annotation-only in
// production (`executes:false`, `authority: ROUTING_ADVICE_ONLY`): nothing
// consumes `advice.mode`, so a Lab that scored the advice without an executor
// would be scoring advice nobody acts on. This module is that executor, kept
// pure so it can be unit-tested without a child process; the preload
// (cog-m5-arm-preload.js) wires it into the real Coder path with `--require`.
//
// The intervention is deliberately narrow. The router's SYSTEM1 fast path is
// the reuse of a *trusted* learned procedure; anything else (SYSTEM1_VERIFY,
// SYSTEM2) refuses the shortcut, expressed as the production selector's own
// `no_applicable_candidate`, which lib/coder/synthesis-memory.js already treats
// as "fall back to fresh synthesis". No production code is modified and both
// arms still run the full Coder gate, the firewall and the approval runtime.

const { adviseMode, MODES } = require('../../lib/cognition/dual-process-router');
const { createCapabilityTrustRegistry } = require('../../lib/experience/capability-trust');
const { replayCoderTrust } = require('../../lib/experience/coder-trust-replay');

// Frozen Lab demand inputs (§3): one known family (low novelty), no risk signal
// (low arousal), zero prediction error because a qualified replayed procedure is
// by construction the expected outcome. Support is read from the trust state the
// replay actually derived, so the router always sees real history.
const LAB_DEMAND = Object.freeze({ novelty: 0.05, arousal: 0.05, predictionErrorRecentMean: 0 });

const SUPPORT_BY_TRUST = Object.freeze({ trusted: 0.95, probationary: 0.60 });

function supportScoreFor(trustState) {
  return SUPPORT_BY_TRUST[trustState] ?? 0.20;
}

// The bound procedure version production actually recorded for this capability.
// An adapted candidate binds the *specialized* procedure hash, not the source
// hash the candidate carries, so the Lab must not guess it: it reads the version
// the real routing path wrote to its own journal. With no prior routing record
// (the first run) there is no history, so the caller keeps insufficient-data.
function latestBoundVersion({ journal, workspaceId, capabilityId }) {
  if (!journal || typeof journal.runIds !== 'function') return null;
  let latest = null;
  let latestAt = -Infinity;
  for (const runId of journal.runIds(workspaceId)) {
    let events;
    try { events = journal.read(runId, { workspaceId }); } catch (_) { continue; }
    const route = events.find(event => event.type === 'routing_decided');
    if (!route || route.payload?.chosenCapabilityId !== capabilityId
      || typeof route.payload?.boundProcedureVersion !== 'string') continue;
    const at = Date.parse(events.find(event => event.type === 'run_started')?.payload?.createdAt);
    if (Number.isFinite(at) ? at >= latestAt : latest === null) {
      latest = route.payload.boundProcedureVersion;
      latestAt = Number.isFinite(at) ? at : latestAt;
    }
  }
  return latest;
}

// Resolve the trust state for one selected candidate by replaying its own
// journal history through the production trust registry. `seededRunIds` are the
// sealed runs the Lab compiled the procedure from; an unreplayable history
// returns `insufficient-data`, which the router turns into SYSTEM2 — never a
// silent shortcut on unknown trust.
function trustStateFor({ journal, workspaceId, candidate, requestId, seededRunIds = [] }) {
  const capabilityId = candidate && candidate.capabilityId;
  if (!capabilityId || !journal) return 'insufficient-data';
  const procedureHash = latestBoundVersion({ journal, workspaceId, capabilityId })
    || (candidate && (candidate.sourceProcedureHash || candidate.procedureHash || candidate.hash));
  if (!procedureHash) return 'insufficient-data';
  const trust = createCapabilityTrustRegistry();
  const created = trust.createCapability({ workspaceId, capabilityId, boundProcedureVersion: procedureHash });
  if (!created.ok && created.code !== 'already_exists') return 'insufficient-data';
  const replay = replayCoderTrust({ journal, workspaceId, requestId, capabilityId, procedureHash,
    trust, seededRunIds: seededRunIds.length ? seededRunIds : (candidate.sourceRunIds || []) });
  if (!replay.ok) return 'insufficient-data';
  return trust.get(workspaceId, capabilityId, Date.now()).trustState;
}

// The router's fast path is the reuse of a compiled procedure; SYSTEM2 is
// deliberation. On the Coder path the reuse always runs the declared test, so
// SYSTEM1_VERIFY's own qualification is exactly that test — both fast modes take
// the shortcut, and only SYSTEM2 falls back to fresh deliberate synthesis.
const isShortcut = mode => mode === MODES.SYSTEM1 || mode === MODES.SYSTEM1_VERIFY;

// The candidate arm: take the shortcut only when the router advises a fast path.
// `onDecision` receives the observed evidence for the result document.
function candidateTakesShortcut({ journal, workspaceId, requestId, candidate, seedRunIds = [], onDecision = () => {} }) {
  const trustState = trustStateFor({ journal, workspaceId, candidate, requestId, seedRunIds });
  const advice = adviseMode({
    predictionError: { recentMean: LAB_DEMAND.predictionErrorRecentMean },
    value: { supportScore: supportScoreFor(trustState) },
    novelty: LAB_DEMAND.novelty,
    arousal: LAB_DEMAND.arousal,
    riskLevel: 'low',
    route: { requestId, chosenCapabilityId: candidate?.capabilityId || null, trustState, refusalReason: null },
  });
  onDecision({ arm: 'candidate', requestId, mode: advice.mode, reasons: advice.reasons, trustState,
    chosenCapabilityId: candidate?.capabilityId || null });
  return isShortcut(advice.mode);
}

// The baseline arm: always SYSTEM2, recorded so the result document can show the
// two arms took different paths rather than asserting it.
function baselineTakesShortcut({ requestId, candidate, onDecision = () => {} }) {
  onDecision({ arm: 'baseline', requestId, mode: MODES.SYSTEM2, reasons: ['arm_always_system2'],
    trustState: null, chosenCapabilityId: candidate?.capabilityId || null });
  return false;
}

module.exports = { LAB_DEMAND, MODES, isShortcut, supportScoreFor, trustStateFor, candidateTakesShortcut, baselineTakesShortcut };
