'use strict';

// The approval authority service (#3860, ADR-016).
//
// Runs as NT SERVICE\huqan-authority. It is the only holder of the operator's
// TOTP secret and of the keys that sign decisions and open sealed requests,
// and it records every step in its ledger before answering. Each method
// returns `{status, body}`; the HTTP layer (lib/authority/http-server.js)
// signs that answer for the caller's challenge.
//
// Any local process can call every route. Registering is rate-limited and
// spends nothing; deciding needs the operator's sealed code; consuming and
// recording an outcome need the preimage of the consume-proof hash the
// registering runtime chose, so another local process cannot burn an approved
// decision or write a false outcome into the audit trail.
//
// Part of the authority bundle (lib/authority/bundle-manifest.js).

const crypto = require('node:crypto');
const { createApprovalView, summarize } = require('./approval-view');
const { validateRegistration } = require('./approval-registration');
const { checkOperatorCode } = require('./operator-check');
const { openDecisionRequest } = require('./sealed-request');
const { signDecision, keyIdFor, DECISION_VERSION } = require('./decision-envelope');
const { signConsumption } = require('./consumption-envelope');

const DECISION_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 500;
const MAX_ATTEMPTS_PER_MINUTE = 60;
const MAX_REGISTRATIONS_PER_DAY = 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const OPERATOR = 'totp:primary';
const HEX64 = /^[0-9a-f]{64}$/;

const reply = (status, body) => ({ status, body });
const refuse = (status, code, extra = {}) => reply(status, { code, ...extra });

function proves(proof, hash) {
  if (typeof proof !== 'string' || proof.length < 32 || proof.length > 256 || !HEX64.test(hash || '')) return false;
  const digest = crypto.createHash('sha256').update(proof, 'utf8').digest();
  return crypto.timingSafeEqual(digest, Buffer.from(hash, 'hex'));
}

function trimBefore(times, limit) {
  while (times.length && times[0] <= limit) times.shift();
}

function createAuthorityService({ ledger, state, now = () => Date.now() }) {
  const view = createApprovalView(ledger.all());
  const attempts = [];
  const registeredTimes = [...view.values()].map(a => Date.parse(a.registeredAt)).sort((a, b) => a - b);

  function record(type, body) {
    const entry = ledger.append(type, body, new Date(now()).toISOString());
    view.apply(entry);
    return entry;
  }

  function envelopeFor(approval) {
    const d = approval.decision;
    return signDecision({ v: DECISION_VERSION, approvalId: approval.approvalId, workspaceId: approval.workspaceId,
      tool: approval.tool, actionHash: approval.actionHash, decision: d.decision, reason: d.reason, decidedAt: d.decidedAt,
      validUntil: d.validUntil, ledgerSeq: d.ledgerSeq, ledgerHash: d.ledgerHash, operator: d.operator }, state.signingKey);
  }

  function consumptionFor(approval) {
    const c = approval.consumed;
    return signConsumption({ approvalId: approval.approvalId, workspaceId: approval.workspaceId, tool: approval.tool,
      actionHash: approval.actionHash, ledgerSeq: c.ledgerSeq, ledgerHash: c.ledgerHash, consumedAt: c.at }, state.signingKey);
  }

  function identity() {
    return reply(200, { keyId: keyIdFor(state.signingKey), version: DECISION_VERSION,
      sealingKey: crypto.createPublicKey(state.sealingKey).export({ type: 'spki', format: 'pem' }) });
  }

  function overLimit() {
    trimBefore(attempts, now() - MINUTE_MS);
    trimBefore(registeredTimes, now() - DAY_MS);
    attempts.push(now());
    const pending = [...view.values()].filter(a => a.status === 'pending' && Date.parse(a.expiresAt) > now()).length;
    return attempts.length > MAX_ATTEMPTS_PER_MINUTE || registeredTimes.length >= MAX_REGISTRATIONS_PER_DAY
      || pending >= MAX_PENDING;
  }

  function register(input) {
    if (ledger.corrupt) return refuse(503, 'LEDGER_CORRUPT');
    if (overLimit()) return refuse(429, 'RATE_LIMITED');
    const existing = typeof input?.approvalId === 'string' ? view.get(input.approvalId) : undefined;
    if (existing) {
      const same = existing.actionHash === input.actionHash && existing.consumeProofHash === input.consumeProofHash;
      return same ? reply(200, { approval: summarize(existing) }) : refuse(409, 'CONFLICT');
    }
    const checked = validateRegistration(input, now());
    if (!checked.ok) return refuse(checked.status, checked.code, checked.reason ? { reason: checked.reason } : {});
    registeredTimes.push(now());
    record('approval.registered', checked.approval);
    return reply(201, { approval: summarize(view.get(checked.approval.approvalId)) });
  }

  function list({ status, workspaceId } = {}) {
    const approvals = [...view.values()]
      .filter(a => (!status || a.status === status) && (!workspaceId || a.workspaceId === workspaceId)).map(summarize);
    return reply(200, { approvals });
  }

  function show(approvalId) {
    const approval = view.get(approvalId);
    return approval ? reply(200, { approval: { ...approval, consumeProofHash: undefined } }) : refuse(404, 'NOT_FOUND');
  }

  function decide(approvalId, sealed) {
    if (ledger.corrupt) return refuse(503, 'LEDGER_CORRUPT');
    const approval = view.get(approvalId);
    if (!approval) return refuse(404, 'NOT_FOUND');
    if (approval.status !== 'pending') return refuse(409, 'ALREADY_DECIDED');
    if (Date.parse(approval.expiresAt) <= now()) return refuse(409, 'EXPIRED');
    const opened = openDecisionRequest(sealed, state.sealingKey, { approvalId });
    if (!opened.ok) return refuse(400, 'SEALED_REQUEST_INVALID');
    if (opened.request.actionHash !== approval.actionHash) return refuse(409, 'HASH_MISMATCH');
    const progress = state.readTotp();
    const check = checkOperatorCode({ secret: state.totpSecret, code: opened.request.totp, now: now(), progress });
    // The replay floor and failure count are durable before anything else
    // happens: a crash after this point can lose a decision, never reuse a code.
    if (check.progress !== progress) state.writeTotp(check.progress);
    if (!check.ok) {
      if (check.code !== 'LOCKED' || check.lockedNow) record('totp.failed', { approvalId, code: check.code });
      if (check.lockedNow) record('totp.lockout', { lockedUntil: new Date(check.progress.lockedUntil).toISOString() });
      return refuse(check.code === 'LOCKED' ? 423 : 401, check.code);
    }
    const decidedAt = now();
    const validUntil = Math.min(decidedAt + DECISION_TTL_MS, Date.parse(approval.expiresAt));
    record('approval.decided', { approvalId, actionHash: approval.actionHash, decision: opened.request.decision,
      reason: opened.request.reason, operator: OPERATOR, decidedAt: new Date(decidedAt).toISOString(),
      validUntil: new Date(validUntil).toISOString() });
    return reply(200, { envelope: envelopeFor(view.get(approvalId)) });
  }

  function getDecision(approvalId) {
    const approval = view.get(approvalId);
    if (!approval) return refuse(404, 'NOT_FOUND');
    if (!approval.decision) return reply(200, { status: 'pending' });
    return reply(200, { envelope: envelopeFor(approval), ...(approval.consumed ? { consumption: consumptionFor(approval) } : {}) });
  }

  function provenApproval(approvalId, proof) {
    if (ledger.corrupt) return { refusal: refuse(503, 'LEDGER_CORRUPT') };
    const approval = view.get(approvalId);
    if (!approval) return { refusal: refuse(404, 'NOT_FOUND') };
    if (!proves(proof, approval.consumeProofHash)) return { refusal: refuse(403, 'PROOF_REQUIRED') };
    return { approval };
  }

  function consume(approvalId, { actionHash, consumeProof } = {}) {
    const { approval, refusal } = provenApproval(approvalId, consumeProof);
    if (refusal) return refusal;
    if (approval.status !== 'approved') return refuse(409, 'NOT_APPROVED');
    if (approval.consumed) return refuse(409, 'ALREADY_CONSUMED');
    if (actionHash !== approval.actionHash) return refuse(409, 'HASH_MISMATCH');
    if (Date.parse(approval.decision.validUntil) <= now()) return refuse(409, 'DECISION_EXPIRED');
    const entry = record('approval.consumed', { approvalId, actionHash });
    return reply(200, { consumed: { ledgerSeq: entry.seq, ledgerHash: entry.receiptHash },
      consumption: consumptionFor(view.get(approvalId)) });
  }

  function recordOutcome(approvalId, { status, receiptId, receiptHash, consumeProof } = {}) {
    const { approval, refusal } = provenApproval(approvalId, consumeProof);
    if (refusal) return refusal;
    if (!approval.consumed) return refuse(409, 'NOT_CONSUMED');
    if (approval.outcome) return refuse(409, 'OUTCOME_RECORDED');
    if (!['executed', 'failed'].includes(status) || typeof receiptId !== 'string' || receiptId.length > 256
      || (receiptHash !== null && !HEX64.test(receiptHash || ''))) {
      return refuse(400, 'INVALID');
    }
    const entry = record('approval.outcome', { approvalId, status, receiptId, receiptHash });
    return reply(200, { outcome: { ledgerSeq: entry.seq, ledgerHash: entry.receiptHash } });
  }

  const ledgerHead = () => reply(200, ledger.head());
  const ledgerEntries = ({ fromSeq, limit } = {}) => reply(200, { entries: ledger.entries({ fromSeq, limit }), corrupt: ledger.corrupt });

  return { identity, register, list, show, decide, getDecision, consume, recordOutcome, ledgerHead, ledgerEntries };
}

module.exports = { DECISION_TTL_MS, MAX_ATTEMPTS_PER_MINUTE, createAuthorityService };
