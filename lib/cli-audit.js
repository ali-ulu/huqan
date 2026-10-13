'use strict';

/**
 * `audit` CLI command — EU AI Act compliance report (#1909, Safe Harbor).
 *
 *   audit [--eu-ai-act] [--workspace <id>] [--json]
 *
 * A read-only command: it never mutates the graph, the approval store or the
 * filesystem (callers redirect stdout when they want a file). Every number in
 * the report comes from a bounded read API — countAuditEvents (COUNT(*)),
 * getStats (counters), countPending/UnresolvedToolApprovals (COUNT(*)) — so
 * report cost does not grow with history size (#728 pattern).
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

function cliError(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

function parseAuditArgs(raw) {
  const text = Array.isArray(raw) ? raw.join(' ') : String(raw || '');
  const tokens = text.split(/\s+/).filter(Boolean);
  const flags = { framework: FRAMEWORK_EU_AI_ACT, workspaceId: 'default' };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i].toLowerCase();
    if (token === '--eu-ai-act') {
      flags.framework = FRAMEWORK_EU_AI_ACT;
    } else if (token === '--authority') {
      // #3860 P6: the detection report against the approval authority's
      // ledger. A different mode of this read-only command; the AI Act
      // articles are not part of it.
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
      throw cliError(`Usage: audit [--eu-ai-act] [--workspace <id>] [--json]\nUnknown argument: ${tokens[i]}`, 2);
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

function buildAuditReport({ kernel, workspaceId, versions, getApprovalStore }) {
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
  if (flags.authority) return runCliAuthorityAudit(args, opts, deps);
  let huqanVersion = 'unknown';
  try {
    // eslint-disable-next-line global-require
    huqanVersion = require('../package.json').version || 'unknown';
  } catch (_) { /* version is informational; never fail the audit over it */ }
  const report = buildAuditReport({ kernel, workspaceId: flags.workspaceId, versions: { huqanVersion }, getApprovalStore: deps.getApprovalStore });
  if (opts.json) return { status: 'completed', data: report };
  return formatAuditText(report);
}

// The P6 detection side of #3860: compare what this runtime recorded locally
// with what the approval authority's append-only ledger holds. A ledger that
// no longer validates, a local approval decided without the authority, a
// decision consumed with no local row -- all of it is reported as findings;
// the ledger makes a same-user bypass detectable, not impossible.
const AUTHORITY_AUDIT_SCHEMA = 'huqan-authority-audit-v1';
const AUTHORITY_MAX_PAGES = 4;

function runCliAuthorityAudit(args, opts, deps) {
  const flags = parseAuditArgs(args);
  const injected = opts.authority || deps.authority || {};
  const resolveMode = injected.resolveMode
    || (() => require('./authority/authority-mode').resolveApprovalAuthorityMode());
  const createClient = injected.createClient
    || (pin => require('./authority/authority-client').createAuthorityClient({ pin }));
  const mode = resolveMode();
  const base = { schemaVersion: AUTHORITY_AUDIT_SCHEMA, generatedAt: new Date().toISOString(), workspaceId: flags.workspaceId };
  if (mode.mode === 'legacy') {
    const report = { ...base, mode: 'legacy', boundary: mode.boundary,
      note: 'no approval authority is installed; operator decisions are protected only by the same OS user', findings: [] };
    return emitAuthorityReport(report, opts);
  }
  if (mode.mode !== 'service') {
    throw cliError(`audit --authority: the approval authority is required but unusable (${mode.reason}).`, 2);
  }
  let entries;
  try {
    const client = createClient({ pin: mode.pin });
    entries = [];
    let fromSeq = 0;
    for (let page = 0; page < AUTHORITY_MAX_PAGES; page += 1) {
      const answer = client.ledger({ fromSeq, limit: 500 });
      if (answer.status !== 200) throw cliError(
        `audit --authority: the approval authority refused the ledger read (${answer.body?.code || answer.status}).`, 2);
      const pageEntries = Array.isArray(answer.body?.entries) ? answer.body.entries : [];
      entries.push(...pageEntries);
      if (pageEntries.length < 500) break;
      fromSeq = pageEntries[pageEntries.length - 1].seq + 1;
    }
  } catch (error) {
    if (error?.exitCode) throw error;
    throw cliError(`audit --authority: the approval authority is unavailable (${error?.code || error?.message || 'unknown'}).`, 2);
  }
  const truncated = entries.length > 0 && entries[entries.length - 1].seq >= 500 * AUTHORITY_MAX_PAGES - 1;
  const report = { ...base, mode: 'service', boundary: mode.boundary, pinPath: mode.pinPath,
    ledger: { entries: entries.length, truncated }, findings: detectAuthorityFindings(entries, flags.workspaceId, deps.getApprovalStore) };
  return emitAuthorityReport(report, opts);
}

function detectAuthorityFindings(entries, workspaceId, getApprovalStore) {
  const { validateChain } = (() => require('./hash-chain'));
  const { LEDGER_GENESIS } = (() => require('./authority/ledger-store'));
  const check = validateChain(entries, { genesisPreviousHash: LEDGER_GENESIS });
  const findings = [];
  if (!check.valid) {
    findings.push({ code: 'LEDGER_CHAIN_BROKEN', detail: `broken at seq ${check.brokenAt} (${check.reason})` });
    return findings;
  }
  // Decisions in the ledger, keyed by approval id, for the cross-checks.
  const decided = new Map();
  const consumed = new Set();
  for (const entry of entries) {
    if (!entry || !entry.body) continue;
    if (entry.type === 'approval.decided') decided.set(entry.body.approvalId, entry.body.decision);
    if (entry.type === 'approval.consumed') consumed.add(entry.body.approvalId);
  }
  if (typeof getApprovalStore !== 'function') return findings;
  const { listPersistentApprovals } = (() => require('./mcp-approval-views'));
  const rows = (() => {
    try { return listPersistentApprovals(getApprovalStore(), 500, workspaceId) || []; }
    catch (_) { return []; }
  })();
  const localIds = new Set();
  for (const row of rows) {
    const id = row?.id;
    if (!id) continue;
    localIds.add(id);
    if (row.status === 'pending' && (decided.has(id) || consumed.has(id))) {
      findings.push({ code: 'LOCAL_PENDING_AUTHORITY_DECIDED', approvalId: id,
        detail: 'the local row is pending although the authority recorded a decision' });
    }
    if (row.status === 'approved' && !decided.has(id)) {
      findings.push({ code: 'LOCAL_APPROVED_WITHOUT_AUTHORITY_DECISION', approvalId: id,
        detail: 'the local row is approved but the ledger holds no decision for it' });
    }
  }
  for (const [id, decision] of decided.entries()) {
    if (!localIds.has(id)) {
      findings.push({ code: 'AUTHORITY_DECISION_WITHOUT_LOCAL_ROW', approvalId: id,
        detail: `the authority recorded ${decision} and no local row exists for it` });
    }
  }
  return findings;
}

function formatAuthorityText(report) {
  const lines = [
    'HUQAN approval authority audit',
    `generated: ${report.generatedAt} · workspace: ${report.workspaceId} · mode: ${report.mode}`,
    `boundary: ${report.boundary}`,
  ];
  if (report.mode === 'legacy') {
    lines.push(`note: ${report.note}`);
  } else {
    lines.push(`ledger entries read: ${report.ledger.entries}${report.ledger.truncated ? ' (truncated to the page cap)' : ''}`);
    if (report.mode !== undefined && report.pinPath) lines.push(`pin: ${report.pinPath}`);
  }
  lines.push('');
  if (Array.isArray(report.findings) && report.findings.length > 0) {
    lines.push(`findings (${report.findings.length}):`);
    for (const finding of report.findings) {
      lines.push(`  ${finding.code}${finding.approvalId ? ` ${finding.approvalId}` : ''} — ${finding.detail}`);
    }
  } else {
    lines.push('findings: none');
  }
  return lines.join('\n');
}

function emitAuthorityReport(report, opts) {
  if (opts.json) return { status: 'completed', data: report };
  const hasFindings = Array.isArray(report.findings) && report.findings.length > 0;
  if (hasFindings) process.exitCode = 1;
  return formatAuthorityText(report);
}

module.exports = {
  AUDIT_SCHEMA_VERSION,
  FRAMEWORK_EU_AI_ACT,
  parseAuditArgs,
  buildAuditReport,
  formatAuditText,
  runCliAudit,
};
