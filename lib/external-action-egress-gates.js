'use strict';

// The external action guard's network egress checks, in the order they run
// (#2505): AB9 records what the payload is and where it was headed, AB12
// refuses citizen data leaving a declared residency, AB13 asks whether the
// destination was expected at all, and AB14 blocks a planted context canary.
//
// Moved out of lib/external-action-guard.js unchanged. The guard passes its own
// `runGate`, so findings and gate errors are recorded exactly as before, and it
// folds the returned decisions into its verdict.

const { evaluateEgress } = require('./data-egress-gate');
const { evaluateDataResidency, collectDestinations } = require('./data-residency-gate');
const { expectedEgressOptions, evaluateUnexpectedEgress } = require('./unexpected-egress-gate');
const { evaluateContextCanaries, plantContextCanaryInValue } = require('./context-canary');
const { plantCanaryForAuraSignal } = require('./aura-canary-bridge');

/**
 * The declared residency for this evaluation.
 *
 * An explicit option wins so a caller can evaluate against a rule that is not
 * on disk; otherwise the deployment policy file is read. Absent means the gate
 * stays inert, which is what keeps an existing installation unchanged.
 */
function resolveDataResidency(options) {
  if (options && options.dataResidency !== undefined) return options.dataResidency;
  return require('./external-action-command-policy').readDataResidency(options && options.policyPath);
}

/**
 * Plant the marker on the outbound payload, through the AURA<->canary bridge
 * when the caller reports AURA signals.
 *
 * The bridge is the module that exists to turn AURA's probabilistic verdict
 * into a deterministic leak proof, so the live egress path has to plant through
 * it rather than beside it: it owns the version framing and the signal binding
 * (the marker is bound to the signals that justified planting it). With no
 * signals nothing is planted and AB14 detects exactly as before -- a
 * detection-only installation is unchanged.
 */
function plantEgressCanary(args, options) {
  const signalIds = options && Array.isArray(options.auraSignalIds) ? options.auraSignalIds : [];
  if (!signalIds.length) return null;
  // Detect against the same string the bridge binds the marker to, so the
  // tripwire result and the planted marker never drift apart.
  const context = typeof args === 'string' ? args : JSON.stringify(args);
  const planted = plantCanaryForAuraSignal({ signalIds, context });
  return { payload: plantContextCanaryInValue(args, { marker: planted.marker }).payload, planted };
}

/**
 * Runs AB9, AB12, AB13 and AB14 for one envelope.
 *
 * Returns `{ decisions, residencyBlocked }`: `decisions` holds each gate's
 * decision in run order for the guard to merge, and `residencyBlocked` says
 * AB12 blocked, which the guard treats as critical risk.
 */
function evaluateExternalActionEgress({ envelope, options, findings, runGate, blockDecision }) {
  const decisions = [];

  // Collected once and shared: AB9 records where the action was headed, and
  // AB13 decides whether anyone expected it to go there. Two calls would let
  // the observation on the receipt and the destination that was judged drift
  // apart, which is precisely the pair that has to agree.
  const observedDestinations = collectDestinations(envelope.args);

  decisions.push(runGate('AB9', findings, () => evaluateEgress(envelope.args), result => ({
    decision: result.piiDetected || result.secretDetected ? 'review' : 'allow',
    reason: result.piiDetected || result.secretDetected ? 'sensitive_payload_review_required' : 'no_sensitive_payload',
    piiTypes: result.piiTypes || [],
    secretDetected: result.secretDetected,
    // Observed always, enforced only when a residency is declared (AB12).
    //
    // Without this the two halves deadlock: a residency rule can be mined from
    // the receipt trail only if the trail records where things went, and the
    // trail recorded destinations only when a rule already existed. Nobody
    // could derive the first rule from evidence.
    //
    // Recording a destination changes no decision. It is an observation, and
    // the receipt keeps it under AB9 -- which reports what the payload IS --
    // rather than under AB12, which reports what was REFUSED. A reader can
    // tell "we saw this go somewhere" from "we stopped this going somewhere".
    destinations: observedDestinations.hosts,
  })));

  // AB12 consumes AB9's finding rather than re-detecting: AB9 owns what counts
  // as citizen data, this gate owns where it may go. Split that way, a change
  // to the PII vocabulary cannot silently narrow the residency boundary.
  const egressFinding = findings[findings.length - 1];
  const residency = resolveDataResidency(options);
  let residencyBlocked = false;
  if (residency) {
    const residencyDecision = runGate('AB12', findings, () => evaluateDataResidency({
      payload: envelope.args,
      piiDetected: Boolean(egressFinding && egressFinding.gate === 'AB9' && (egressFinding.piiTypes || []).length > 0),
      piiTypes: (egressFinding && egressFinding.piiTypes) || [],
      residency,
    }), result => ({
      decision: result.decision,
      reason: result.reason,
      destinations: result.destinations,
      piiTypes: result.piiTypes,
    }));
    decisions.push(residencyDecision);
    residencyBlocked = residencyDecision === blockDecision;
  }

  // AB13 (#1891): AB12 above speaks only when citizen data is in the payload
  // and a residency is declared. This asks the question that holds regardless
  // of what the bytes are -- was this destination expected at all -- so an
  // unexpected host carrying nothing sensitive stops passing in silence.
  const expectedEgress = expectedEgressOptions(options);
  if (expectedEgress) {
    decisions.push(runGate('AB13', findings, () => evaluateUnexpectedEgress({
      destinations: observedDestinations.hosts,
      expected: expectedEgress.expected,
      decision: expectedEgress.decision,
      unparseable: observedDestinations.unparseable,
    }), result => ({
      decision: result.decision,
      reason: result.reason,
      unexpectedDestinations: result.unexpectedDestinations,
    })));
  }

  // AB14: a planted context canary in the payload means context the agent
  // was only meant to read is on its way out. Always armed -- it can fire only
  // on a self-verifying marker, so there is no configuration to forget. Runs
  // last so AB12 above still reads AB9 as the latest finding.
  //
  // Before detecting, plant: the gate is the only place that sees the live
  // egress, so it is the only place that can turn "this context looked risky"
  // into "this context leaked". A caller that knows the action carries a
  // high-risk signal marks the outbound payload with a fresh canary; AB14 then
  // blocks on it and the receipt carries the fingerprint, never the marker.
  // The plant goes through the AURA<->canary bridge, so the module that exists
  // to upgrade an AURA verdict to a leak proof is the one that plants here.
  // No caller opts in, no canary is planted and behavior is exactly as before,
  // which keeps a detection-only installation unchanged.
  const planted = plantEgressCanary(envelope.args, options);
  decisions.push(runGate('AB14', findings, () => evaluateContextCanaries(planted ? planted.payload : envelope.args), result => ({
    decision: result.decision,
    reason: result.reason,
    // Fingerprints only: the receipt must not hand a reader a working canary.
    canaryFingerprints: result.canaryFingerprints,
    // When the plant came through the AURA bridge, name the bridge the leak
    // proof is bound to, so a reader can tell an AURA-driven plant from the
    // generic one without seeing the marker.
    ...(planted ? { auraBridge: planted.planted.bridgeVersion, auraSignalIds: planted.planted.signalIds } : {}),
    encodings: result.encodings,
  })));

  return { decisions, residencyBlocked };
}

module.exports = {
  evaluateExternalActionEgress,
};
