'use strict';

// Admission-receipt side of lib/external-action-receipt.js (#2120): shaping
// helpers and the admission receipt builder. Moved verbatim; the outcome side
// lives in lib/external-action-receipt-outcome.js and persistence stays in
// the entry.
const crypto = require('node:crypto');
const { buildCanonicalReceiptPayload, hashCanonicalReceiptPayload, stableStringify } = require('./receipt/canonical-receipt');
const { fromMcpDecision } = require('./verdict/action-verdict');
const { redactExternalValue } = require('./external-action-envelope');
const { unattestedIdentity } = require('./external-action-identity-records');
const { externalActionJustification } = require('./blast-radius');

const EXTERNAL_ACTION_GUARD_VERSION = 'huqan-external-action-guard-v1';

function nowIso(options = {}) {
  return typeof options.now === 'function' ? options.now() : new Date().toISOString();
}

function digest(value) {
  return crypto.createHash('sha256').update(stableStringify(redactExternalValue(value)), 'utf8').digest('hex');
}

function receiptId(prefix, fields) {
  return `${prefix}_${crypto.createHash('sha256').update(fields.join('|'), 'utf8').digest('hex').slice(0, 32)}`;
}

// A gate's own detail string is bounded before it lands on a receipt (#3617).
// It is a short machine-written reason ("missing score or scope"), not free
// text; the limit keeps a misbehaving gate from inflating every receipt.
const FINDING_DETAIL_LIMIT = 200;

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
    // #3617 (R52): a gate that could not measure its input holds the action for
    // review instead of guessing, and says so with `enforced: true` plus a
    // human-readable `detail` (see lib/impact-budget-gate.js). Both are carried
    // so a reader -- and the outcome builder that must file a degraded allow as
    // `executed_but_degraded` -- can tell a degraded hold from an ordinary
    // review. Present only when the gate actually set them, so every other
    // receipt keeps its exact shape and hash.
    ...(finding.enforced === true ? { enforced: true } : {}),
    ...(typeof finding.detail === 'string' && finding.detail
      ? { detail: finding.detail.slice(0, FINDING_DETAIL_LIMIT) }
      : {}),
    // Which planted canary AB14 caught, as fingerprints: enough for the owner
    // to know which context leaked, not enough for a reader to reuse it.
    // Present only on a trip, so every other receipt keeps its exact shape.
    ...(Array.isArray(finding.canaryFingerprints) && finding.canaryFingerprints.length
      ? { canaryFingerprints: finding.canaryFingerprints.map(String).slice(0, 16) }
      : {}),
  };
}

function trimReceiptText(value) {
  return typeof value === 'string' ? value.trim() : '';
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
 * Where a browser-shaped action was pointed, bounded to what an auditor needs
 * and nothing more.
 *
 * A monitoring reader watching an agent drive a browser needs to know which
 * site was opened -- "it fetched something" is not an answer to "where did our
 * data go". What that reader must never get from a receipt is the page itself:
 * no body, no form values, no query string. Query strings are the sharp edge
 * here, because session tokens, one-time links and search terms all ride in
 * them, so they are dropped wholesale rather than filtered. Userinfo
 * credentials and the fragment go for the same reason.
 *
 * Only http and https produce a destination. `file:`, `data:`, `javascript:`
 * and anything unparseable return null -- a receipt that cannot name a safe
 * destination says nothing rather than guessing, and a null here is not a
 * claim that the action had no target.
 */
const MAX_DESTINATION_BYTES = 200;
const BROWSER_DESTINATION_SCHEMES = new Set(['http:', 'https:']);

function safeBrowserDestination(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (_) {
    return null;
  }
  if (!BROWSER_DESTINATION_SCHEMES.has(parsed.protocol)) return null;
  // `parsed.host` excludes userinfo by construction, so credentials never
  // reach the receipt even when the caller embedded them in the URL.
  const host = parsed.host;
  if (!host) return null;
  const pathname = parsed.pathname || '/';
  const full = `${parsed.protocol}//${host}${pathname}`;
  return {
    scheme: parsed.protocol.slice(0, -1),
    host: host.slice(0, MAX_DESTINATION_BYTES),
    path: pathname.slice(0, MAX_DESTINATION_BYTES),
    url: full.slice(0, MAX_DESTINATION_BYTES),
    truncated: full.length > MAX_DESTINATION_BYTES,
  };
}

function envelopeDestination(envelope) {
  return safeBrowserDestination(envelope && envelope.target && envelope.target.url);
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
      // Where a browser-shaped action was pointed: scheme, host and path only.
      // Null when the action named no URL, or named one this receipt will not
      // vouch for as a safe destination. Admission means "this was allowed to
      // go here", never "this was fetched".
      destination: envelopeDestination(envelope),
      // What the host said about itself. Kept apart from `identity`, which is
      // deployment-attested: an auditor must be able to tell "Codex told us it
      // was this agent on this model" from "this identity was verified".
      host: hostContext(envelope),
      findings: (decision.findings || []).map(safeFinding),
      // Why this was decided: risk score, blast radius with its inputs, and the
      // thresholds that applied. Unknown inputs are named, never zero (#2505).
      justification: externalActionJustification(envelope, decision),
    },
  };
  const verdict = fromMcpDecision(decision).verdict;
  const canonical = buildCanonicalReceiptPayload(receipt, { verdict });
  return Object.freeze({ ...canonical, receiptHash: hashCanonicalReceiptPayload(canonical) });
}

module.exports = {
  EXTERNAL_ACTION_GUARD_VERSION,
  nowIso,
  digest,
  receiptId,
  safeFinding,
  trimReceiptText,
  hostField,
  hostContext,
  safeBrowserDestination,
  MAX_DESTINATION_BYTES,
  envelopeDestination,
  receiptIdentity,
  buildExternalActionAdmissionReceipt,
  // Shared receipt-sealing primitives, re-exported so the outcome module can
  // seal without adding Application-ring edges of its own (#2120).
  buildCanonicalReceiptPayload,
  hashCanonicalReceiptPayload,
  fromMcpDecision,
};
