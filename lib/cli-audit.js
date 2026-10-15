'use strict';

/**
 * `audit` CLI command — EU AI Act compliance report (#1909, Safe Harbor).
 *
 *   audit [--eu-ai-act] [--workspace <id>] [--json] [--authority]
 *
 * A read-only command: it never mutates the graph, the approval store or the
 * filesystem (callers redirect stdout when they want a file). Every number in
 * the report comes from a bounded read API — countAuditEvents (COUNT(*)),
 * getStats (counters), countPending/UnresolvedToolApprovals (COUNT(*)) — so
 * report cost does not grow with history size (#728 pattern).
 *
 * `--authority` (ADR-016 P6) joins local approval rows and execution receipts
 * against the approval authority ledger and reports the difference: locally
 * executed rows with no ledger consumption, ledger consumptions with no local
 * outcome, and action-hash or receipt-hash mismatches. The ledger pages come
 * in through deps (resolved behind the CLI entrypoint, which alone may reach
 * the authority HTTP client); this module only compares data.
 *
 * ## What each article maps to
 *
 * - Art 12 (Record-keeping): automatic append-only audit logging is active
 *   and countable; every high-risk action carries a chained Trust Receipt.
 * - Art 13 (Transparency): public disclosures go through the allowlisted
 *   redaction policy and the public verify surface, never raw internals.
 * - Art 14 (Human oversight): the approval workflow exists, is counted live
 *   (pending/unresolved), and graduated autonomy is opt-in and receipt-backed.
 *
 * Full chain re-validation over history is deliberately out of scope here:
 * auditors use the receipt-bundle export plus
 * specs/huqan-trust-protocol/0.2/conformance/verify_bundle.py for that, and
 * the report says so under `limitations` instead of claiming it.
 */

const AUDIT_SCHEMA_VERSION = 'huqan-audit-report-v1';
const FRAMEWORK_EU_AI_ACT = 'eu-ai-act';

const { computeTrustScore } = require('./trust-score-aggregator');
const { createHash } = require('node:crypto');
const { compareStopsWithAuthority } = require('./emergency-stop-detection');
const { isOperationalTool } = require('./authority/operational-guard');
const { canonicalActionHash } = require('./mcp-operator-capability');
const { storedArgumentsOf } = require('./authority/registration-payload');
const { formatApprovalRecord, listPersistentApprovals } = require('./mcp-approval-views');

function cliError(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

function parseAuditArgs(raw) {
  const text = Array.isArray(raw) ? raw.join(' ') : String(raw || '');
  const tokens = text.split(/\s+/).filter(Boolean);
  const flags = { framework: FRAMEWORK_EU_AI_ACT, workspaceId: 'default', authority: false };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i].toLowerCase();
    if (token === '--eu-ai-act') {
      flags.framework = FRAMEWORK_EU_AI_ACT;
    } else if (token === '--authority') {
      flags.authority = true;
    } else if (token === '--framework') {
      flags.framework = String(tokens[i + 1] || '').toLowerCase();
      i += 1;
    } else if (token === '--workspace' || token === '-w') {
      flags.workspaceId = String(tokens[i + 1] || '').trim() || 'default';
      i += 1;
    } else if (token === '--json') {
      // Accepted for argv symmetry; output shape is chosen by opts.json.
    } else {
      throw cliError(`Usage: audit [--eu-ai-act] [--workspace <id>] [--json] [--authority]\nUnknown argument: ${tokens[i]}`, 2);
    }
  }
  if (flags.framework !== FRAMEWORK_EU_AI_ACT) {
    throw cliError(`Unsupported framework: ${flags.framework || '(empty)'}. Only --eu-ai-act is supported.`, 2);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(flags.workspaceId)) {
    throw cliError(`Invalid workspace id: ${flags.workspaceId}`, 2);
  }
  return flags;
}

function safeCount(fn) {
  try {
    const value = fn();
    return Number.isFinite(Number(value)) ? Number(value) : null;
  } catch (_) {
    return null;
  }
}

const AUTHORITY_AUDIT_ROW_LIMIT = 500;
const AUTHORITY_AUDIT_RECEIPT_LIMIT = 100;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// The receipt binding recorded in authority outcomes and re-checked by
// detection: a receipt's own hash when it carries one (agent execution
// receipts do), otherwise the sha256 of its canonically ordered JSON. One
// implementation so apply and audit can never disagree on the value.
function expectedReceiptHash(receipt) {
  if (!receipt || typeof receipt !== 'object') return null;
  if (typeof receipt.receiptHash === 'string' && /^[0-9a-f]{64}$/.test(receipt.receiptHash)) {
    return receipt.receiptHash;
  }
  if (typeof receipt.receiptId !== 'string' || !receipt.receiptId.trim()) return null;
  return sha256Hex(stableStringify(receipt));
}

function indexLedgerByApproval(entries) {
  const decided = new Map();
  const consumed = new Map();
  const outcome = new Map();
  const operational = new Set();
  for (const entry of entries || []) {
    const body = entry && entry.body;
    if (!body || typeof body.approvalId !== 'string' || !body.approvalId) continue;
    // #3892: operational approvals (agent resume, stop lift, terfi, autonomy
    // activation) never have a local row; the tool they were registered for says so.
    if (entry.type === 'approval.registered' && isOperationalTool(body.tool)) operational.add(body.approvalId);
    else if (entry.type === 'approval.decided' && !decided.has(body.approvalId)) decided.set(body.approvalId, body);
    else if (entry.type === 'approval.consumed' && !consumed.has(body.approvalId)) consumed.set(body.approvalId, body);
    else if (entry.type === 'approval.outcome' && !outcome.has(body.approvalId)) outcome.set(body.approvalId, body);
  }
  return { decided, consumed, outcome, operational };
}

function listDecidedApprovals(store, limit, workspaceId) {
  if (!store || typeof store.listDecidedToolApprovals !== 'function') return [];
  try {
    return store.listDecidedToolApprovals(limit, workspaceId).map(formatApprovalRecord).filter(Boolean);
  } catch (_) {
    return [];
  }
}

// Joins local approval rows and execution receipts against a fetched authority
// ledger page set (ADR-016 P6 detection). Pure data comparison: every input
// arrives as arguments, nothing here opens a store, a graph write path or a
// connection. Bounded: at most AUTHORITY_AUDIT_ROW_LIMIT local rows and
// AUTHORITY_AUDIT_RECEIPT_LIMIT receipt re-reads.
function buildAuthoritySection({ workspaceId, getApprovalStore, ledger, localStopEntries = null }) {
  if (!ledger || ledger.mode !== 'service') {
    return { title: 'Approval authority (detection)', status: 'info',
      controls: ['Local approvals and receipts are joined against the authority ledger only in service mode.'],
      evidence: { mode: ledger ? ledger.mode : 'unknown', reason: (ledger && ledger.reason) || 'no authority data', findings: [] } };
  }
  const findings = [];
  if (ledger.error) findings.push({ code: 'AUTHORITY_UNAVAILABLE', detail: String(ledger.error) });
  if (ledger.corrupt) findings.push({ code: 'LEDGER_CORRUPT', detail: 'the authority ledger failed its hash-chain check' });
  let store = null;
  try {
    store = typeof getApprovalStore === 'function' ? getApprovalStore() : null;
  } catch (_) {
    store = null;
  }
  let localDecided = 0;
  let outOfWindow = 0;
  const firstAt = ledger.truncated && Array.isArray(ledger.entries) && ledger.entries.length ? Date.parse(ledger.entries[0].at) : Number.NaN;
  const windowStart = Number.isFinite(firstAt) ? firstAt : null;
  if (store && !ledger.error) {
    const { consumed, outcome, operational } = indexLedgerByApproval(ledger.entries);
    const localById = new Map();
    for (const row of listDecidedApprovals(store, AUTHORITY_AUDIT_ROW_LIMIT, workspaceId)) {
      if (row && row.id && !localById.has(row.id)) localById.set(row.id, row);
    }
    for (const row of listPersistentApprovals(store, AUTHORITY_AUDIT_ROW_LIMIT, workspaceId)) {
      if (row && row.id && !localById.has(row.id)) localById.set(row.id, row);
    }
    localDecided = localById.size;
    let receiptChecks = 0;
    for (const row of localById.values()) {
      // Rejected rows are never consumed (P4); only rows that ran or run now
      // can bypass the authority.
      if (row.status !== 'approved' && row.status !== 'executing' && row.status !== 'cancelled') continue;
      if (!consumed.has(row.id)) {
        // A row last touched before the fetched window began may have been
        // consumed before it too; only rows inside the window can be a bypass.
        if (windowStart !== null && Number(row.updatedAt) < windowStart) outOfWindow += 1;
        else findings.push({ code: 'EXECUTED_WITHOUT_AUTHORITY', approvalId: row.id, status: row.status });
        continue;
      }
      let localHash = null;
      try {
        localHash = canonicalActionHash({ tool: row.tool, workspaceId: row.workspaceId, approvalId: row.id, arguments: storedArgumentsOf(row) });
      } catch (_) {
        localHash = null;
      }
      const chainedHash = consumed.get(row.id).actionHash;
      if (localHash && chainedHash && localHash !== chainedHash) {
        findings.push({ code: 'ACTION_HASH_MISMATCH', approvalId: row.id });
      }
      // Cancelled rows carry their terminal receipt in the emergency-stop
      // ledger, not in an authority outcome entry; demanding one would flag
      // every operator cancellation.
      if (row.status !== 'approved') continue;
      if (!outcome.has(row.id)) {
        findings.push({ code: 'OUTCOME_MISSING', approvalId: row.id });
      } else {
        const entry = outcome.get(row.id);
        const localReceiptId = row.context && row.context.executionRefs && row.context.executionRefs.receiptId;
        if (entry.receiptId && localReceiptId && entry.receiptId !== localReceiptId) {
          findings.push({ code: 'RECEIPT_ID_MISMATCH', approvalId: row.id });
        }
        if (entry.receiptHash && receiptChecks < AUTHORITY_AUDIT_RECEIPT_LIMIT) {
          receiptChecks += 1;
          const receipt = ledger.receipts ? ledger.receipts[entry.receiptId] || null : null;
          const expected = expectedReceiptHash(receipt);
          if (expected && expected !== entry.receiptHash) {
            findings.push({ code: 'RECEIPT_HASH_MISMATCH', approvalId: row.id });
          }
        }
      }
    }
    const windowCut = Boolean(ledger.truncated) || localById.size >= AUTHORITY_AUDIT_ROW_LIMIT;
    for (const id of consumed.keys()) {
      if (operational.has(id)) {
        // No local row by design; a consumed operation must still have run to an outcome.
        if (!outcome.has(id)) findings.push({ code: 'OUTCOME_MISSING', approvalId: id });
      } else if (!localById.has(id)) {
        // With either window cut short, an old consumption has no row in view
        // by construction; that is a gap in the comparison, not a bypass.
        if (windowCut) outOfWindow += 1;
        else findings.push({ code: 'CONSUMED_UNKNOWN_LOCALLY', approvalId: id });
      }
    }
  }
  if (!ledger.error) findings.push(...compareStopsWithAuthority({ authorityEntries: ledger.entries, localEntries: localStopEntries, workspaceId, truncated: ledger.truncated }));
  return { title: 'Approval authority (detection)', status: findings.length ? 'fail' : (ledger.truncated || outOfWindow ? 'info' : 'pass'),
    controls: [
      'Approved and executing local rows must each have an authority consumption entry for the same action hash.',
      'Authority consumptions must each resolve to a local row; outcomes must name the executed receipt.',
      'Recorded stops must remain in the local emergency-stop ledger; local lifts need consumed lift decisions.',
    ],
    evidence: { mode: 'service', ledgerEntries: Array.isArray(ledger.entries) ? ledger.entries.length : 0,
      localRowsCompared: localDecided, outsideWindow: outOfWindow, corrupt: Boolean(ledger.corrupt), truncated: Boolean(ledger.truncated), findings } };
}

function readApprovalCounts(getApprovalStore, workspaceId) {
  // The store always comes from the caller (the CLI reuses its lazy approval
  // runtime). This module never opens a database on its own: a read-only
  // report must not create storage as a side effect.
  if (typeof getApprovalStore !== 'function') return null;
  try {
    const store = getApprovalStore();
    if (!store) return null;
    const pending = safeCount(() => store.countPendingToolApprovals(workspaceId));
    const unresolved = safeCount(() => store.countUnresolvedToolApprovals(workspaceId));
    if (pending === null || unresolved === null) return null;
    return { pending, unresolved };
  } catch (_) {
    return null;
  }
}

function buildAuditReport({ kernel, workspaceId, versions, getApprovalStore, authority, localStopEntries }) {
  const graph = kernel && kernel.graph ? kernel.graph : null;
  if (!graph) throw cliError('Audit requires a loaded kernel graph.', 1);

  const stats = (() => {
    try {
      const value = graph.getStats() || {};
      return {
        nodes: Number.isFinite(Number(value.nodes)) ? Number(value.nodes) : null,
        edges: Number.isFinite(Number(value.edges)) ? Number(value.edges) : null,
      };
    } catch (_) {
      return { nodes: null, edges: null };
    }
  })();
  const auditEventsTotal = safeCount(() => graph.countAuditEvents({ workspaceId }));
  const approvals = readApprovalCounts(getApprovalStore, workspaceId);
  const trustScore = computeTrustScore({ graph, workspaceId, approvalCounts: approvals });

  const articles = {
    art12_record_keeping: {
      title: 'Record-keeping (Art 12)',
      status: auditEventsTotal !== null && auditEventsTotal > 0 ? 'pass' : 'info',
      controls: [
        'Automatic append-only audit logging with bounded COUNT(*) inventory.',
        'Every durable mutation carries a chained Trust Receipt (receipt-chain).',
      ],
      evidence: {
        auditEventsTotal,
        graphNodes: stats.nodes,
        graphEdges: stats.edges,
        boundedReads: true,
      },
    },
    art13_transparency: {
      title: 'Transparency (Art 13)',
      status: 'pass',
      controls: [
        'Public disclosures use the allowlisted redaction policy only.',
        'Machine-readable verify surface plus human-readable trust page.',
      ],
      evidence: {
        redactionPolicy: 'v5-public-receipt-redaction-v1',
        publicVerifySurface: ['/api/badge/:id', '/badge/:id.svg', '/trust/:id'],
        openSpec: 'specs/huqan-trust-protocol/0.2/',
      },
    },
    art14_human_oversight: {
      title: 'Human oversight (Art 14)',
      status: approvals !== null ? 'pass' : 'info',
      controls: [
        'Tool approvals queue for human decision before execution.',
        'Graduated autonomy is opt-in and receipt-backed (T1 read-only default).',
      ],
      evidence: {
        approvalWorkflow: true,
        pendingApprovals: approvals ? approvals.pending : null,
        unresolvedApprovals: approvals ? approvals.unresolved : null,
      },
    },
    trust_score: {
      title: 'Trust Score (pilot)',
      status: trustScore.status === 'scored' ? 'pass' : 'info',
      controls: [
        'Workspace score from governed proxy actions, approval backlog and review backlog.',
      ],
      evidence: {
        score: trustScore.score,
        certified: trustScore.certified,
        windowActions: trustScore.windowActions,
      },
    },
    ...(authority ? { authority_detection: buildAuthoritySection({ workspaceId, getApprovalStore, ledger: authority, localStopEntries }) } : {}),
  };

  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    framework: FRAMEWORK_EU_AI_ACT,
    generatedAt: new Date().toISOString(),
    huqanVersion: versions && versions.huqanVersion ? versions.huqanVersion : 'unknown',
    contractVersion: (kernel && kernel.contractVersion) || (versions && versions.contractVersion) || 'unknown',
    workspaceId,
    articles,
    limitations: [
      'Full chain re-validation over history is performed with the receipt-bundle export plus specs/huqan-trust-protocol/0.2/conformance/verify_bundle.py, not inline in this report.',
      'This report covers a single workspace; multi-workspace rollup is a follow-up.',
    ],
  };
}

function formatAuditText(report) {
  const lines = [
    `HUQAN ${report.framework} compliance report`,
    `generated: ${report.generatedAt} · workspace: ${report.workspaceId} · huqan ${report.huqanVersion} (contract ${report.contractVersion})`,
    '',
  ];
  for (const article of Object.values(report.articles)) {
    lines.push(`[${article.status.toUpperCase()}] ${article.title}`);
    for (const control of article.controls) lines.push(`  control: ${control}`);
    for (const [key, value] of Object.entries(article.evidence)) {
      lines.push(`  ${key}: ${value === null ? 'unavailable' : JSON.stringify(value)}`);
    }
    lines.push('');
  }
  lines.push('limitations:');
  for (const limitation of report.limitations) lines.push(`  - ${limitation}`);
  return lines.join('\n');
}

function runCliAudit(kernel, args, opts = {}, deps = {}) {
  const flags = parseAuditArgs(args);
  let huqanVersion = 'unknown';
  try {
    // eslint-disable-next-line global-require
    huqanVersion = require('../package.json').version || 'unknown';
  } catch (_) { /* version is informational; never fail the audit over it */ }
  const report = buildAuditReport({ kernel, workspaceId: flags.workspaceId, versions: { huqanVersion }, getApprovalStore: deps.getApprovalStore, localStopEntries: deps.localStopEntries, authority: flags.authority ? (deps.authorityLedger || { mode: 'legacy', reason: 'no_provider', entries: [], corrupt: false }) : null });
  if (opts.json) return { status: 'completed', data: report };
  return formatAuditText(report);
}

module.exports = {
  AUDIT_SCHEMA_VERSION,
  FRAMEWORK_EU_AI_ACT,
  parseAuditArgs,
  buildAuditReport,
  buildAuthoritySection,
  stableStringify,
  sha256Hex,
  expectedReceiptHash,
  formatAuditText,
  runCliAudit,
};
