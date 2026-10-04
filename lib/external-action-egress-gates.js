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
const { evaluateContextCanaries } = require('./context-canary');

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
  decisions.push(runGate('AB14', findings, () => evaluateContextCanaries(envelope.args), result => ({
    decision: result.decision,
    reason: result.reason,
    // Fingerprints only: the receipt must not hand a reader a working canary.
    canaryFingerprints: result.canaryFingerprints,
    encodings: result.encodings,
  })));

  return { decisions, residencyBlocked };
}

module.exports = {
  evaluateExternalActionEgress,
};
