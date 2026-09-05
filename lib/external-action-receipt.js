'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildCanonicalReceiptPayload, hashCanonicalReceiptPayload, stableStringify } = require('./receipt/canonical-receipt');
const { fromMcpDecision } = require('./verdict/action-verdict');
const { redactExternalValue } = require('./external-action-envelope');
const { unattestedIdentity } = require('./external-action-identity');
const {
  FILE_EFFECT_SENSOR_VERSION,
  observeFile,
  compareObservations,
  isObserved,
} = require('./file-effect-sensor');

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
    // The destinations AB12 refused. A residency block whose receipt does not
    // name where the data was going tells a compliance reader that something
    // was stopped without telling them what -- and "where" is the entire
    // question a cross-border transfer raises. Hostnames only; the payload
    // stays out, redacted by AB9.
    destinations: Array.isArray(finding.destinations) ? finding.destinations.map(String).slice(0, 16) : [],
    secretDetected: Boolean(finding.secretDetected),
    crossWorkspace: Boolean(finding.crossWorkspace),
    identityRef: finding.identityRef ? String(finding.identityRef) : null,
    attested: typeof finding.attested === 'boolean' ? finding.attested : null,
    error: finding.error ? 'gate_error' : null,
  };
}

const HOST_FIELD_LIMIT = 200;
function hostField(value) {
  return typeof value === 'string' ? value.trim().slice(0, HOST_FIELD_LIMIT) : '';
}
/**
 * What the host said about itself, kept deliberately apart from the identity
 * block below: Codex's PreToolUse payload names the agent, its type and the
 * model, and an auditor needs "Codex reported this" to be distinguishable
 * from "this identity was verified". Bounded and string-only, because it is
 * attacker-influenced in the same way tool arguments are.
 */
function hostContext(envelope) {
  const metadata = envelope.metadata || {};
  return {
    attested: false,
    agentId: hostField(metadata.hostAgentId),
    agentType: hostField(metadata.hostAgentType),
    model: hostField(metadata.hostModel),
    permissionMode: hostField(metadata.permissionMode),
  };
}

/**
 * Faz C (#1769): the identity block is persisted verbatim into receipt
 * metadata, so it is covered by the canonical receipt hash and is queryable
 * from the JSONL trail and the graph audit_log alike. `unattestedIdentity`
 * is the fallback for callers that build a receipt without going through the
 * guard — a receipt is never written with the identity field missing.
 */
function receiptIdentity(envelope) {
  return envelope.identity || unattestedIdentity(envelope);
}

function buildExternalActionAdmissionReceipt(envelope, decision, options = {}) {
  const createdAt = nowIso(options);
  const id = receiptId('xact_adm', [envelope.invocationId, decision.decision, createdAt]);
  const identity = receiptIdentity(envelope);
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
    agentId: identity.agentId,
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
      identity: { ...identity, capabilities: [...identity.capabilities], delegationChain: [...identity.delegationChain] },
      autonomy: envelope.autonomy ? { ...envelope.autonomy } : null,
      inputDigest: digest(envelope.args),
      // Empty unless the deployment's command policy is what made this an
      // allow: an auditor should not have to guess why a command that would
      // otherwise need review went through (#1799).
      allowlistedCommand: envelope.allowlistedCommand || '',
      // The pre-action reading of the file this action names, taken by the guard
      // from the filesystem rather than reported by the caller. The outcome
      // receipt takes the second reading and compares them; that pair is what
      // lets `effectVerification` say `observed` instead of `reported`.
      fileBefore: envelope.fileBefore || null,
      // The absolute file the first reading measured: the action-cwd-resolved
      // target, pinned so the outcome cannot measure a different file (#1865).
      fileTarget: (envelope.target && envelope.target.resolvedPath) || '',
      // What the host said about itself. Kept apart from `identity`, which is
      // deployment-attested: an auditor must be able to tell "Codex told us it
      // was this agent on this model" from "this identity was verified".
      host: hostContext(envelope),
      findings: (decision.findings || []).map(safeFinding),
    },
  };
  const verdict = fromMcpDecision(decision).verdict;
  const canonical = buildCanonicalReceiptPayload(receipt, { verdict });
  return Object.freeze({ ...canonical, receiptHash: hashCanonicalReceiptPayload(canonical) });
}

/**
 * How much the receipt actually knows about the effect it describes.
 *
 * An outcome receipt records what the executor *said* happened. Nothing in this
 * path watches the process, the filesystem or the network, so `status:
 * 'executed'` means "the caller reported success", not "we saw it succeed". The
 * two are not the same claim, and a reader holding only the receipt could not
 * previously tell them apart.
 *
 * The distinction already exists one field over, for identity: `metadata.host`
 * carries what the host said about itself and is kept apart from `identity`,
 * which is deployment-attested, so an auditor can separate "Codex told us it
 * was this agent" from "this identity was verified". This applies the same rule
 * to the effect.
 *
 *   none      no effect to describe -- the action was blocked before it ran.
 *   reported  the executor supplied the outcome, and nothing checked it.
 *   observed  HUQAN measured the effect itself.
 *
 * `observed` now has one producer: lib/file-effect-sensor.js. When an action
 * names a file, the guard digests it at admission and again at outcome, both
 * readings taken from the filesystem, so the conclusion does not depend on
 * what the executor said. Everything else is still `reported` -- a command
 * with no file target, a network call, an action whose file was too large to
 * digest or could not be read. An observation that could not be taken is never
 * reported as one that was.
 *
 * What it does not establish is that the change was the *right* one. A file
 * that changed is evidence an effect occurred, not that the goal was met; a
 * file that did not change is not proof of failure, since an action can
 * legitimately be a no-op. `metadata.fileEffect` carries the readings so a
 * reader can see which of those they are looking at.
 *
 * Deliberately in `metadata` rather than at the top level. The canonical
 * payload is a fixed projection: a new top-level key is a schema version, the
 * way `trustRoot` was for v2, and would change the hash of every receipt and
 * every chain built on them. `metadata` passes through verbatim in both the v1
 * and v2 projections, and this receipt already keeps `outcomeStatus` and
 * `outputDigest` there. Promoting it belongs with the next version bump, which
 * needs conformance vectors first (#1820).
 */
const EFFECT_VERIFICATION = Object.freeze({
  NONE: 'none',
  REPORTED: 'reported',
  OBSERVED: 'observed',
});

function effectVerificationFor(outcomeStatus, fileEffect) {
  // Blocked means the guard refused before execution, so there is no effect
  // whose verification could be claimed either way.
  if (outcomeStatus === 'blocked') return EFFECT_VERIFICATION.NONE;
  // `observed` is earned only when both readings were actually taken. An
  // observation we could not make must never be reported as one we did, so
  // anything indeterminate falls back to what the executor said.
  return fileEffect && isObserved(fileEffect.observation)
    ? EFFECT_VERIFICATION.OBSERVED
    : EFFECT_VERIFICATION.REPORTED;
}

/**
 * The second reading, and what the pair says happened.
 *
 * Returns null when the action named no file, or when the admission receipt
 * carries no first reading -- an outcome recorded against an older receipt
 * still works, it simply stays `reported`.
 */
function observeFileEffect(envelope, admissionReceipt) {
  const before = admissionReceipt && admissionReceipt.metadata && admissionReceipt.metadata.fileBefore;
  // The admission pinned the one absolute file it measured; the outcome reads
  // that same file, never a re-resolved envelope path, so both readings are of
  // one target (#1865). A receipt from before the pinning carries no fileTarget
  // and falls back to the envelope's resolved path.
  const targetPath = (admissionReceipt && admissionReceipt.metadata && admissionReceipt.metadata.fileTarget)
    || (envelope && envelope.target && (envelope.target.resolvedPath || envelope.target.path));
  if (!before || !targetPath) return null;
  const after = observeFile(targetPath);
  return { before, after, observation: compareObservations(before, after), sensor: FILE_EFFECT_SENSOR_VERSION };
}

function buildExternalActionOutcomeReceipt(envelope, admissionReceipt, outcome = {}, options = {}) {
  if (!admissionReceipt || typeof admissionReceipt !== 'object' || !admissionReceipt.receiptId) {
    throw new TypeError('buildExternalActionOutcomeReceipt requires an admission receipt');
  }
  const createdAt = nowIso(options);
  const outcomeStatus = outcome.status === 'success' ? 'executed' : outcome.status === 'blocked' ? 'blocked' : 'failed';
  const fileEffect = observeFileEffect(envelope, admissionReceipt);
  // The admission receipt is the authority on identity: an outcome must not be
  // able to re-attribute an action to a different agent after the fact.
  const identity = admissionReceipt.metadata?.identity || receiptIdentity(envelope);
  const receipt = {
    receiptId: receiptId('xact_out', [envelope.invocationId, admissionReceipt.receiptId, outcomeStatus, createdAt]),
    receiptKind: 'external_action_outcome_receipt',
    decision: admissionReceipt.decision,
    status: outcomeStatus,
    admissionId: envelope.invocationId,
    workspaceId: envelope.workspaceId,
    actor: envelope.agent.name,
    agentId: identity.agentId,
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
      identity: { ...identity, capabilities: [...identity.capabilities], delegationChain: [...identity.delegationChain] },
      autonomy: admissionReceipt.metadata?.autonomy ? { ...admissionReceipt.metadata.autonomy } : null,
      monitoring: envelope.postActionMonitoring ? { ...envelope.postActionMonitoring } : null,
      outcomeStatus,
      effectVerification: effectVerificationFor(outcomeStatus, fileEffect),
      // The two readings behind an `observed` verdict, so a reader can see what
      // was measured rather than take the label on trust. Null when the action
      // named no file or the admission receipt carried no first reading.
      fileEffect,
      outputDigest: digest(outcome.output ?? null),
    },
  };
  const verdict = fromMcpDecision({ decision: admissionReceipt.decision, reason: receipt.reason }).verdict;
  const canonical = buildCanonicalReceiptPayload(receipt, { verdict });
  return Object.freeze({ ...canonical, receiptHash: hashCanonicalReceiptPayload(canonical) });
}

/**
 * The directory the gate keeps its own state in: the receipt trail and, beside
 * it, the command policy. Everything the guard persists or reads for itself
 * hangs off this one directory, so redirecting it moves the whole of the gate's
 * state -- which is what a test run needs, so that a suite can never observe or
 * extend the operator's real policy and receipt chain (#1846).
 *
 * `HUQAN_EXTERNAL_GUARD_RECEIPTS` still names a single file and wins over this,
 * because a deployment that placed its trail somewhere specific should keep it.
 */
function defaultExternalActionStateRoot(environment = process.env) {
  const override = typeof environment.HUQAN_STATE_ROOT === 'string'
    ? environment.HUQAN_STATE_ROOT.trim()
    : '';
  if (override) return path.resolve(override);
  const base = process.platform === 'win32' && environment.LOCALAPPDATA
    ? environment.LOCALAPPDATA
    : path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'huqan');
}

function defaultExternalActionReceiptPath(environment = process.env) {
  const override = typeof environment.HUQAN_EXTERNAL_GUARD_RECEIPTS === 'string'
    ? environment.HUQAN_EXTERNAL_GUARD_RECEIPTS.trim()
    : '';
  if (override) return path.resolve(override);
  return path.join(defaultExternalActionStateRoot(environment), 'external-action-receipts.jsonl');
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
  EFFECT_VERIFICATION,
  EXTERNAL_ACTION_GUARD_VERSION,
  MAX_RECEIPT_LINE_BYTES,
  buildExternalActionAdmissionReceipt,
  buildExternalActionOutcomeReceipt,
  createDurableExternalActionReceiptWriter,
  createJsonlExternalActionReceiptWriter,
  defaultExternalActionReceiptPath,
  defaultExternalActionStateRoot,
  persistExternalActionReceipt,
  digestExternalActionValue: digest,
};
