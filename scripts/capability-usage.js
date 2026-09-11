'use strict';

/**
 * Has this capability ever actually run?
 *
 * Every other check in this repository asks whether the code is correct,
 * consistent, packaged, reachable, or within budget. None of them asks the one
 * question that decides whether any of that mattered. A capability can pass all
 * of them and never have been used once.
 *
 * That gap is not hypothetical. At the time this was written the live store had
 * 246 audit events, 131 approvals, 122 nodes and 61 receipts -- and zero rows in
 * agent_runs, candidate_claims, checkpoints and all four observability tables.
 * Roughly 9,700 lines of shipped code had produced no evidence of ever running,
 * and nothing in the repository would ever have said so.
 *
 * ## Three answers, never two
 *
 * The hardest part of this check is not counting rows. It is refusing to report
 * "no rows" as "never used" when the truth is "we do not record that".
 *
 *   USED     evidence exists, and here is how much
 *   NEVER    we know exactly where the evidence would be, and there is none
 *   UNKNOWN  nothing in this system would record it either way
 *
 * Folding UNKNOWN into NEVER would make this report a liar in the same shape as
 * the thing it exists to catch: a confident claim with nothing behind it. A
 * read-only workflow leaves no trace by design, so its silence says nothing.
 *
 * The UNKNOWN count is therefore a finding in its own right, not a rounding
 * error. It measures how much of the product cannot answer "did anyone use
 * this?" at all.
 *
 * ## The evidence table is hand-written, and that is the point
 *
 * EVIDENCE below is a deliberate, reviewable claim about where each capability
 * leaves a trace -- the same idiom as scripts/enforcement-coverage-classification.js.
 * A wrong entry here produces a wrong report, so every entry says what it looks
 * at, and every capability with no source says why there is none in plain words.
 */

const fs = require('node:fs');
const path = require('node:path');

const { WORKFLOW_CAPABILITIES } = require('../lib/workflow-contract');
const { readCompatibleEnvironmentVariable } = require('../lib/environment-compat');

const USAGE_STATUS = Object.freeze({
  USED: 'USED',
  NEVER: 'NEVER',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Where a capability leaves a trace.
 *
 * `table` + `where` describe a countable query. `none` states, in words, why no
 * trace exists -- an entry that says nothing is not allowed, because "we forgot
 * to look" and "there is nothing to look at" are different situations and the
 * report has to be able to tell them apart.
 *
 * `approvalTool` means: this workflow mutates or needs approval, so a call
 * leaves a tool_approvals row. Read-only workflows do NOT leave one, which is
 * why their absence is never read as disuse.
 */
const EVIDENCE = Object.freeze({
  'learn-review': { table: 'audit_log', where: "event_type = 'LEARN'", label: 'learn events' },
  'approval-decision': { table: 'tool_approvals', where: 'decided_at IS NOT NULL', label: 'resolved approvals' },
  'approvals': { table: 'tool_approvals', where: '1=1', label: 'approval records' },
  'approval-detail': { none: 'reading one approval writes nothing; the approval row it reads was created by a different capability' },
  'agent-run': { table: 'agent_runs', where: '1=1', label: 'agent runs' },
  'agent-resume': { table: 'agent_runs', where: 'resumed = 1', label: 'resumed runs' },
  'agent-plan': { none: 'planning is read-only and writes nothing; a plan that is never run leaves no trace' },
  'dream': { table: 'candidate_claims', where: '1=1', label: 'candidate claims' },
  'hypotheses': { table: 'candidate_claims', where: '1=1', label: 'candidate claims' },
  'ingest-execute': { approvalTool: true },
  'ingest-preview': { none: 'preview is read-only by contract' },
  'ingest-run-detail': { none: 'a read of ingest status writes nothing' },
  'fractal-learn': { approvalTool: true },
  'self-evolve': { approvalTool: true },
  'ask': { none: 'read-only question answering leaves no record' },
  'verify': { none: 'verification is read-only; its result is returned, not stored' },
  'reason': { none: 'reasoning returns a derivation to the caller and stores nothing about having been asked' },
  'compare': { none: 'a comparison is computed and returned; no row marks that it happened' },
  'advocate': { none: 'the counter-argument is returned to the caller and never written down' },
  'tool-policy': { none: 'a policy question is answered, not recorded' },
  'memory-search': { none: 'a search reads the store and returns matches; nothing records that the question was asked' },
  'web-research': { none: 'external web results are returned, never written; nothing records that the question was asked' },
  'trust-receipt': { none: 'reading a receipt writes nothing' },
  'trust-receipt-detail': { none: 'reading a receipt writes nothing' },
  'compliance-audit': { none: 'the audit report is read-only and is not itself audited' },
  'system-status': { none: 'status is computed on demand' },
  'quickstart': { none: 'quickstart writes ordinary state; nothing marks it as its origin' },
  'recommendation': { none: 'the LLM recommendation path stores no marker of its own' },
  'auto-think': { none: 'no marker distinguishes auto-think output from ordinary graph writes' },
  'optimize': { none: 'graph maintenance leaves no operation-specific row' },
  'consolidate': { none: 'graph maintenance leaves no operation-specific row' },
  'evolve': { none: 'graph maintenance leaves no operation-specific row' },
  'persist': { none: 'a save leaves the saved data, not a record that a save happened' },
  'backup': { none: 'backups are files on disk, outside the store this check reads' },
  'restore': { none: 'restores are files on disk, outside the store this check reads' },
  // Named explicitly rather than left to fall through. This capability shipped
  // with no usage signal at all -- the derivation records it produces live in
  // the repository, not the store -- so this check cannot tell whether anyone
  // has ever run it. Worth fixing in the capability, not papered over here.
  'deterministic-coder': { none: 'derivation records are committed to the repository, not written to the store; no usage signal reaches this check' },
});

function tableExists(db, table) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
  return Boolean(row);
}

function countRows(db, table, where) {
  if (!tableExists(db, table)) return null;
  try {
    return db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get().c;
  } catch {
    return null;
  }
}

/**
 * A mutating workflow's calls pass the tool gate, so they leave a
 * tool_approvals row keyed by the MCP tool name. `axiom.*` is the pre-rename
 * form of the same tool and is counted with it -- ignoring it would report a
 * capability with 123 historical uses as never used.
 */
function countApprovals(db, mcpTool) {
  if (!mcpTool || !tableExists(db, 'tool_approvals')) return null;
  const legacy = mcpTool.replace(/^huqan\./u, 'axiom.');
  return db.prepare('SELECT COUNT(*) AS c FROM tool_approvals WHERE tool = ? OR tool = ?').get(mcpTool, legacy).c;
}

function evidenceFor(workflow, db) {
  const declared = EVIDENCE[workflow.workflowId];

  if (!declared) {
    return {
      status: USAGE_STATUS.UNKNOWN,
      detail: 'no evidence source declared for this capability',
      undeclared: true,
    };
  }
  if (declared.none) {
    return { status: USAGE_STATUS.UNKNOWN, detail: declared.none };
  }
  if (declared.approvalTool) {
    const count = countApprovals(db, workflow.mcpTool);
    if (count === null) return { status: USAGE_STATUS.UNKNOWN, detail: 'tool_approvals is not present in this store' };
    return {
      status: count > 0 ? USAGE_STATUS.USED : USAGE_STATUS.NEVER,
      count,
      detail: `${count} approval(s) for ${workflow.mcpTool}`,
    };
  }

  const count = countRows(db, declared.table, declared.where);
  if (count === null) {
    return { status: USAGE_STATUS.UNKNOWN, detail: `${declared.table} is not present in this store` };
  }
  return {
    status: count > 0 ? USAGE_STATUS.USED : USAGE_STATUS.NEVER,
    count,
    detail: `${count} ${declared.label}`,
  };
}

function buildUsageReport(db, workflows = WORKFLOW_CAPABILITIES) {
  const rows = workflows.map(workflow => ({
    workflowId: workflow.workflowId,
    mcpTool: workflow.mcpTool || '',
    mutation: workflow.mutation === true,
    ...evidenceFor(workflow, db),
  }));

  const by = status => rows.filter(row => row.status === status);
  return {
    total: rows.length,
    used: by(USAGE_STATUS.USED),
    never: by(USAGE_STATUS.NEVER),
    unknown: by(USAGE_STATUS.UNKNOWN),
    undeclared: rows.filter(row => row.undeclared === true),
    rows,
  };
}

/**
 * The store this check reads. It deliberately does not create one: a check that
 * creates the thing it measures would report an empty store it made itself as
 * evidence about the product.
 */
function resolveStorePath() {
  const configured = readCompatibleEnvironmentVariable('DB_PATH');
  if (configured) return configured;
  return path.join(process.env.USERPROFILE || process.env.HOME || '.', 'huqan', 'memory.db');
}

function formatReport(report, storePath) {
  const lines = [`capability usage — ${storePath}`, ''];
  const pad = (text, width) => String(text).padEnd(width);

  for (const group of [
    ['USED', report.used],
    ['NEVER', report.never],
    ['UNKNOWN', report.unknown],
  ]) {
    const [title, rows] = group;
    if (!rows.length) continue;
    lines.push(`${title} (${rows.length})`);
    for (const row of rows.slice().sort((a, b) => a.workflowId.localeCompare(b.workflowId))) {
      lines.push(`  ${pad(row.workflowId, 24)} ${row.detail}`);
    }
    lines.push('');
  }

  lines.push(`${report.used.length} used · ${report.never.length} never · ${report.unknown.length} unknown · ${report.total} total`);
  if (report.never.length) {
    lines.push('');
    lines.push('NEVER means the evidence would be recorded and there is none.');
  }
  if (report.unknown.length) {
    lines.push('UNKNOWN means nothing records it either way — silence is not evidence of use or disuse.');
  }
  if (report.undeclared.length) {
    lines.push(`${report.undeclared.length} capability(ies) have no declared evidence source; add one in scripts/capability-usage.js.`);
  }
  return lines.join('\n');
}

module.exports = {
  EVIDENCE,
  USAGE_STATUS,
  buildUsageReport,
  countApprovals,
  evidenceFor,
  formatReport,
  resolveStorePath,
};

if (require.main === module) {
  const storePath = resolveStorePath();
  if (!fs.existsSync(storePath)) {
    console.log(`capability usage: no store at ${storePath}`);
    console.log('Nothing measured. This is not evidence that nothing is used.');
    process.exit(0);
  }
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3');
  const db = new Database(storePath, { readonly: true });
  try {
    console.log(formatReport(buildUsageReport(db), storePath));
  } finally {
    db.close();
  }
  // Always exits zero. This reports; it does not gate. A capability that has
  // not been used yet is a fact about the product, not a defect in a change,
  // and failing a pull request over it would push people to delete the report
  // rather than the gap.
  process.exit(0);
}
