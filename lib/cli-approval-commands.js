const { parseApprovalDecisionArgs } = require('./command-parser');
const { commandFailure } = require('./cli-helpers');
const { formatCliApprovalList, formatCliApprovalDecision } = require('./mcp-approval-views');

// CLI command handlers (cli.js registry): approvals, audit, receipts, coder.
// The last three keep lazy requires in a block body so require-scan still sees them deferred.

// The MCP tool call is handed in by cli.js: lib/ sits inside the UI ring.
function createApprovalCommands({ callMcpTool }) {
  function approvalListCommand(cli, args, opts, command) {
    const approvalArguments = { limit: 50, workspaceId: args?.workspaceId || 'default' };
    const result = callMcpTool(
      cli.kernel,
      { name: 'huqan.approvals', operatorCapability: cli.createOperatorCapability('huqan.approvals', approvalArguments), arguments: approvalArguments },
      cli.approvalRuntime()
    );
    if (!result || result.ok === false) {
      return commandFailure(`Approval list error: ${result?.error?.message || 'unknown error'}`, opts);
    }
    return formatCliApprovalList(result, args, opts.json);
  }

  function approvalDecisionCommand(cli, args, opts, command) {
    const approval = args && typeof args === 'object' ? args : parseApprovalDecisionArgs(args);
    if (!approval.approvalId || approval.invalidDecision) {
      return commandFailure(
        'Usage: onayla <approvalId> [approved|rejected]',
        opts,
        2
      );
    }
    const approvalArguments = { approvalId: approval.approvalId, decision: approval.decision, workspaceId: approval.workspaceId || 'default' };
    return Promise.resolve(callMcpTool(cli.kernel, {
      name: 'huqan.approve',
      operatorCapability: cli.createOperatorCapability('huqan.approve', approvalArguments),
      arguments: approvalArguments,
    }, cli.approvalRuntime())).then(result => {
      if (!result || result.ok === false) {
        const error = result?.error;
        const message = `Approval error: ${error?.code || 'APPROVAL_FAILED'}: ${error?.message || 'unknown error'}`;
        if (opts.throwOnError === true && error?.code) {
          const failure = new Error(message);
          failure.code = error.code;
          const boundedMeta = {};
          if (result?.meta?.identity && typeof result.meta.identity === 'object') boundedMeta.identity = result.meta.identity;
          if (result?.meta?.oversight && typeof result.meta.oversight === 'object') boundedMeta.oversight = result.meta.oversight;
          if (Object.keys(boundedMeta).length > 0) failure.meta = boundedMeta;
          throw failure;
        }
        return commandFailure(message, opts);
      }
      return formatCliApprovalDecision(result, approval.approvalId, opts.json);
    });
  }

  return { approvalListCommand, approvalDecisionCommand };
}

function auditCommand(cli, args, opts, command) {
  return require('./cli-audit').runCliAudit(cli.kernel, args, opts, { getApprovalStore: () => cli.approvalRuntime().approvalStore });
}

function receiptCommand(cli, args, opts, command) {
  return require('./cli-trust-receipt').runCliTrustReceipt(cli.kernel, args, opts);
}

function coderCommand(cli, args, opts, command) {
  return require('./cli-coder').runCliCoder(args, opts);
}

module.exports = {
  createApprovalCommands,
  auditCommand,
  receiptCommand,
  coderCommand,
};
