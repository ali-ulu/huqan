'use strict';

/**
 * `huqan.audit` -- the EU AI Act compliance report, over MCP.
 *
 * buildAuditReport is the CLI's own report builder, called directly: the text
 * formatting is the CLI's business, and an MCP client wants the Art 12/13/14
 * structure with its evidence, not a rendering of it.
 *
 * Read-only by contract. It reports on the receipt chain and the approval
 * counts; it writes nothing, and -- as the capability-usage report has always
 * said about it -- the audit is not itself audited.
 */

const { buildAuditReport } = require('../cli-audit');
const { sanitizeMcpString } = require('../mcp-input-sanitizers');
const { withMcpToolVerdictSurface } = require('./response-builders');

function executeMcpComplianceAudit({ kernel, name, args, gate, getApprovalStore = null }) {
  const workspaceId = sanitizeMcpString(args.workspaceId, 128) || 'default';

  let huqanVersion = 'unknown';
  try {
    // eslint-disable-next-line global-require
    huqanVersion = require('../../package.json').version || 'unknown';
  } catch (_) { /* version is informational; never fail the audit over it */ }

  let report;
  try {
    report = buildAuditReport({ kernel, workspaceId, versions: { huqanVersion }, getApprovalStore });
  } catch (error) {
    return withMcpToolVerdictSurface({
      ok: false,
      type: 'compliance_audit',
      data: null,
      evidence: [],
      error: { code: 'AUDIT_UNAVAILABLE', message: error.message },
      meta: {},
    }, name, args, gate);
  }

  return withMcpToolVerdictSurface({
    ok: true,
    type: 'compliance_audit',
    data: report,
    evidence: [],
    error: null,
    meta: {},
  }, name, args, gate);
}

module.exports = { executeMcpComplianceAudit };
