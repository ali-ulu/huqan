'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildCanonicalReceiptPayload, hashCanonicalReceiptPayload, stableStringify } = require('./receipt/canonical-receipt');
const { fromMcpDecision } = require('./verdict/action-verdict');
const { redactExternalValue } = require('./external-action-envelope');

const EXTERNAL_ACTION_GUARD_VERSION = 'huqan-external-action-guard-v1';
const MAX_RECEIPT_LINE_BYTES = 64 * 1024;

function nowIso(options = {}) {
  return typeof options.now === 'function' ? options.now() : new Date().toISOString();
}

function digest(value) {
  return crypto.createHash('sha256').update(stableStringify(redactExternalValue(value)), 'utf8').digest('hex');
}

function receiptId(prefix, fields) {
  return `${prefix}_${crypto.createHash('sha256').update(fields.join('|'), 'utf8').digest('hex').slice(0, 32)}`;
}

function safeFinding(finding = {}) {
  return {
    gate: String(finding.gate || ''),
    decision: String(finding.decision || ''),
    reason: String(finding.reason || ''),
    riskLevel: String(finding.riskLevel || finding.risk?.level || ''),
    flags: Array.isArray(finding.flags) ? finding.flags.map(String).slice(0, 16) : [],
    denylistMatch: finding.denylistMatch ? String(finding.denylistMatch) : null,
    injectionMatches: Array.isArray(finding.injectionMatches) ? finding.injectionMatches.map(String).slice(0, 16) : [],
    piiTypes: Array.isArray(finding.piiTypes) ? finding.piiTypes.map(String).slice(0, 16) : [],
    secretDetected: Boolean(finding.secretDetected),
    crossWorkspace: Boolean(finding.crossWorkspace),
    error: finding.error ? 'gate_error' : null,
  };
}

function buildExternalActionAdmissionReceipt(envelope, decision, options = {}) {
  const createdAt = nowIso(options);
  const id = receiptId('xact_adm', [envelope.invocationId, decision.decision, createdAt]);
  const receipt = {
    receiptId: id,
    receiptKind: decision.decision === 'allow'
      ? 'external_action_admission_receipt'
      : decision.decision === 'review'
        ? 'external_action_review_receipt'
        : 'external_action_rejection_receipt',
    decision: decision.decision,
    status: decision.decision === 'allow' ? 'admitted' : decision.decision === 'review' ? 'review' : 'blocked',
    admissionId: envelope.invocationId,
    workspaceId: envelope.workspaceId,
    actor: envelope.agent.name,
    agentId: envelope.agent.instanceId,
    memoryDraftId: 'not_applicable',
    provenanceId: `external:${envelope.agent.name}:${envelope.session.id}`,
    trustPolicyVersion: EXTERNAL_ACTION_GUARD_VERSION,
    approvalId: decision.approvalId || 'not_applicable',
    approvalStatus: decision.decision === 'review' ? 'required' : 'not_required',
    reason: decision.reason,
    riskScore: Number.isFinite(decision.risk?.score) ? decision.risk.score : 0,
    createdAt,
    metadata: {
      envelopeSchemaVersion: envelope.schemaVersion,
      agentName: envelope.agent.name,
      agentVersion: envelope.agent.version,
      sessionId: envelope.session.id,
      turnId: envelope.session.turnId,
      toolName: envelope.tool.name,
      toolKind: envelope.kind,
      inputDigest: digest(envelope.args),
      findings: (decision.findings || []).map(safeFinding),
    },
  };
  const verdict = fromMcpDecision(decision).verdict;
  const canonical = buildCanonicalReceiptPayload(receipt, { verdict });
  return Object.freeze({ ...canonical, receiptHash: hashCanonicalReceiptPayload(canonical) });
}

function buildExternalActionOutcomeReceipt(envelope, admissionReceipt, outcome = {}, options = {}) {
  if (!admissionReceipt || typeof admissionReceipt !== 'object' || !admissionReceipt.receiptId) {
    throw new TypeError('buildExternalActionOutcomeReceipt requires an admission receipt');
  }
  const createdAt = nowIso(options);
  const outcomeStatus = outcome.status === 'success' ? 'executed' : outcome.status === 'blocked' ? 'blocked' : 'failed';
  const receipt = {
    receiptId: receiptId('xact_out', [envelope.invocationId, admissionReceipt.receiptId, outcomeStatus, createdAt]),
    receiptKind: 'external_action_outcome_receipt',
    decision: admissionReceipt.decision,
    status: outcomeStatus,
    admissionId: envelope.invocationId,
    workspaceId: envelope.workspaceId,
    actor: envelope.agent.name,
    agentId: envelope.agent.instanceId,
    memoryDraftId: 'not_applicable',
    provenanceId: admissionReceipt.provenanceId,
    trustPolicyVersion: EXTERNAL_ACTION_GUARD_VERSION,
    approvalId: admissionReceipt.approvalId || 'not_applicable',
    approvalStatus: admissionReceipt.approvalStatus || 'not_required',
    reason: String(outcome.reason || outcomeStatus),
    riskScore: admissionReceipt.riskScore,
    createdAt,
    metadata: {
      admissionReceiptId: admissionReceipt.receiptId,
      admissionReceiptHash: admissionReceipt.receiptHash || '',
      outcomeStatus,
      outputDigest: digest(outcome.output ?? null),
    },
  };
  const verdict = fromMcpDecision({ decision: admissionReceipt.decision, reason: receipt.reason }).verdict;
  const canonical = buildCanonicalReceiptPayload(receipt, { verdict });
  return Object.freeze({ ...canonical, receiptHash: hashCanonicalReceiptPayload(canonical) });
}

function defaultExternalActionReceiptPath(environment = process.env) {
  const override = typeof environment.HUQAN_EXTERNAL_GUARD_RECEIPTS === 'string'
    ? environment.HUQAN_EXTERNAL_GUARD_RECEIPTS.trim()
    : '';
  if (override) return path.resolve(override);
  const stateRoot = process.platform === 'win32' && environment.LOCALAPPDATA
    ? environment.LOCALAPPDATA
    : path.join(os.homedir(), '.local', 'state');
  return path.join(stateRoot, 'huqan', 'external-action-receipts.jsonl');
}

function createJsonlExternalActionReceiptWriter(options = {}) {
  const target = path.resolve(options.path || defaultExternalActionReceiptPath(options.environment));
  return Object.freeze({
    path: target,
    append(receipt) {
      const line = `${JSON.stringify(receipt)}\n`;
      if (Buffer.byteLength(line, 'utf8') > MAX_RECEIPT_LINE_BYTES) {
        throw new Error('external action receipt exceeds the 64 KiB persistence bound');
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(target, 'a', 0o600);
      try {
        fs.writeSync(fd, line, null, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return receipt;
    },
  });
}

function createDurableExternalActionReceiptWriter(options = {}) {
  const jsonlWriter = options.jsonlWriter || createJsonlExternalActionReceiptWriter(options);
  const Graph = require('../graph');
  const graph = options.graph || new Graph({
    memoryPath: options.memoryPath,
    dbPath: options.dbPath,
    useSQLite: options.useSQLite,
  });
  const ownsGraph = !options.graph;
  return Object.freeze({
    path: jsonlWriter.path,
    append(receipt) {
      // The JSONL append is an independent crash-safe receipt trail. The
      // graph append additionally projects the bounded receipt into HUQAN's
      // append-only audit_log when SQLite is available.
      jsonlWriter.append(receipt);
      graph.appendAuditEvent({
        auditId: receipt.receiptId,
        eventType: String(receipt.receiptKind || 'EXTERNAL_ACTION_RECEIPT').toUpperCase(),
        targetType: 'external_agent_action',
        targetId: receipt.admissionId,
        workspaceId: receipt.workspaceId,
        actor: receipt.actor,
        timestamp: receipt.createdAt,
        sourceRef: receipt.receiptHash,
        provenanceId: receipt.provenanceId,
        trustPolicyVersion: receipt.trustPolicyVersion,
        details: receipt,
      });
      return receipt;
    },
    close() {
      if (ownsGraph && typeof graph.close === 'function') graph.close();
    },
    graph,
  });
}

function persistExternalActionReceipt(writer, receipt) {
  if (!writer) return false;
  if (typeof writer === 'function') writer(receipt);
  else if (writer && typeof writer.append === 'function') writer.append(receipt);
  else throw new TypeError('receiptWriter must be a function or expose append(receipt)');
  return true;
}

module.exports = {
  EXTERNAL_ACTION_GUARD_VERSION,
  MAX_RECEIPT_LINE_BYTES,
  buildExternalActionAdmissionReceipt,
  buildExternalActionOutcomeReceipt,
  createDurableExternalActionReceiptWriter,
  createJsonlExternalActionReceiptWriter,
  defaultExternalActionReceiptPath,
  persistExternalActionReceipt,
  digestExternalActionValue: digest,
};
