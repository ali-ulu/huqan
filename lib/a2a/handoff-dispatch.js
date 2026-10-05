'use strict';

const { createTrustEvidenceLedger } = require('../trust-evidence-ledger');
const { snapshotUntrustedData, canonicalHash } = require('./bounded-exchange-values');
const { validateHandoff, normalizeIntervention, preparedMatches } = require('./pre-dispatch-intervention');
const { operationId, writeInterventionReceipt } = require('./pre-dispatch-intervention-receipt');

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new TypeError(`${name} must be a bounded non-empty string`);
  }
  return value;
}

function allowed(result) {
  const snapshot = snapshotUntrustedData(result);
  return snapshot && snapshot.decision === 'allow' && typeof snapshot.reason === 'string'
    && snapshot.reason.trim().length > 0 && snapshot.reason.length <= 256;
}

async function callStage(fn, input, context, timeoutMs, controller) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => fn(input, { ...context, signal: controller.signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('stage_timeout')); }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Public, transport-independent outbound SDK boundary (#3477).
 * The host owns signing, cryptographic verification, admission and delivery;
 * this module owns their ordering and the durable decision before dispatch.
 * There is no default signer or optimistic verifier, and no new wire schema.
 */
function createA2aHandoffDispatcher(options = {}) {
  const context = Object.freeze({
    workspaceId: requiredText(options.workspaceId, 'workspaceId'),
    sourceAgentId: requiredText(options.sourceAgentId, 'sourceAgentId'),
    policyVersion: requiredText(options.policyVersion, 'policyVersion'),
    now: options.now || (() => new Date().toISOString()),
  });
  const timeoutMs = options.timeoutMs === undefined ? 5000 : options.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new TypeError('timeoutMs must be between 1 and 60000');
  }
  for (const name of ['intervention', 'prepare', 'verify', 'admission', 'dispatch']) {
    if (typeof options[name] !== 'function') throw new TypeError(`${name} callback is required`);
  }
  if (typeof context.now !== 'function') throw new TypeError('now must be a function');
  const graph = options.graph;
  const ledger = createTrustEvidenceLedger({ graph });
  const callbacks = Object.freeze(Object.fromEntries(['intervention', 'prepare', 'verify', 'admission', 'dispatch']
    .map(name => [name, options[name]])));
  const active = new Map();

  function replayResult(previous, id, originalHash) {
    if (!previous.verification.valid) throw new Error('receipt_integrity_invalid');
    const metadata = previous.receipt.canonicalPayload.metadata;
    const delivery = ledger.readByOperation(`${id}:delivery`);
    if (delivery && !delivery.verification.valid) throw new Error('receipt_integrity_invalid');
    return Object.freeze({ decision: metadata.interventionDecision, status: 'replayed',
      reason: metadata.originalHash === originalHash ? 'handoff_already_decided' : 'handoff_identity_conflict',
      dispatchAttempted: false, receipt: previous.receipt,
      deliveryRecorded: Boolean(delivery), outcomeReceipt: delivery?.receipt,
      previousOutcome: delivery?.receipt.canonicalPayload.executionOutcome
        || (previous.receipt.canonicalPayload.decision === 'allow' ? 'delivery_unknown' : 'not_dispatched') });
  }

  async function handoff(input) {
    const original = snapshotUntrustedData(input);
    const originalHash = canonicalHash(original);
    const id = operationId(context, original, originalHash);
    while (active.has(id)) await active.get(id);
    let releaseActive;
    active.set(id, new Promise(resolve => { releaseActive = resolve; }));
    const controller = new AbortController();
    const targetAgentId = original?.target?.agentId;
    let record = { operationId: id, originalHash, effectiveHash: originalHash,
      targetAgentId: typeof targetAgentId === 'string' && targetAgentId.length <= 256 ? targetAgentId : null,
      decision: 'drop', canonicalDecision: 'block', reason: 'handoff_invalid' };
    let receipt = null;
    let attempted = false;
    const finish = (status, reason, extra = {}) => Object.freeze({
      decision: record.decision, status, reason, dispatchAttempted: attempted, receipt, ...extra,
    });
    const persist = () => writeInterventionReceipt(graph, context, record);
    try {
      const previous = ledger.readByOperation(id);
      if (previous) {
        return replayResult(previous, id, originalHash);
      }
      if (!validateHandoff(original, context)) {
        receipt = (await persist()).receipt;
        return finish('dropped', record.reason);
      }
      let intervention;
      try {
        intervention = normalizeIntervention(
          await callStage(callbacks.intervention, original, context, timeoutMs, controller), original, context,
        );
      } catch (_) {
        intervention = { decision: 'drop', reason: 'intervention_failed', message: original };
      }
      record = { ...record, decision: intervention.decision, reason: intervention.reason,
        effectiveHash: canonicalHash(intervention.message) };
      if (intervention.decision === 'drop') {
        receipt = (await persist()).receipt;
        return finish('dropped', record.reason);
      }
      let prepared;
      let stage = 'prepare';
      try {
        prepared = snapshotUntrustedData(await callStage(callbacks.prepare, intervention.message, context, timeoutMs, controller));
        if (!preparedMatches(intervention.message, prepared)) throw new Error('prepared_binding_invalid');
        record.preparedHash = canonicalHash(prepared);
        stage = 'verify';
        if (!allowed(await callStage(callbacks.verify, prepared, context, timeoutMs, controller))) throw new Error('verification_refused');
        stage = 'admission';
        if (!allowed(await callStage(callbacks.admission, prepared, context, timeoutMs, controller))) throw new Error('admission_refused');
      } catch (_) {
        record.reason = `${stage}_failed`;
        receipt = (await persist()).receipt;
        return finish('blocked', record.reason);
      }
      record.canonicalDecision = 'allow';
      const reservation = await persist();
      receipt = reservation.receipt;
      if (reservation.replayed) return replayResult({ receipt, verification: reservation.verification }, id, originalHash);
      attempted = true;
      let response;
      let outcome = 'transport_returned';
      try {
        response = snapshotUntrustedData(await callStage(callbacks.dispatch, prepared, context, timeoutMs, controller));
        if (response === null) throw new Error('transport_response_invalid');
      } catch (_) {
        outcome = 'delivery_unknown';
      }
      let outcomeReceipt;
      try {
        outcomeReceipt = (await writeInterventionReceipt(graph, context, { ...record,
          operationId: `${id}:delivery`, outcome, reason: outcome,
          canonicalDecision: outcome === 'transport_returned' ? 'allow' : 'review',
        })).receipt;
      } catch (_) {
        return finish('unknown', 'delivery_receipt_failed', { response, deliveryRecorded: false });
      }
      return finish(outcome === 'transport_returned' ? 'dispatched' : 'unknown', outcome,
        { response, outcomeReceipt, deliveryRecorded: true });
    } catch (_) {
      return finish('blocked', 'intervention_receipt_failed');
    } finally {
      active.delete(id);
      releaseActive();
    }
  }

  return Object.freeze({ handoff });
}

module.exports = Object.freeze({ createA2aHandoffDispatcher });
