const { parseApprovalDecisionArgs } = require('./command-parser');
const { commandFailure } = require('./cli-helpers');
const { requireOperatorPresence } = require('./cli-operator-presence');
const { formatCliApprovalList, formatCliApprovalDecision } = require('./mcp-approval-views');

// CLI command handlers (cli.js registry): approvals, audit, receipts, coder.
// The last three keep lazy requires in a block body so require-scan still sees them deferred.

// A refused presence check is a failure of this command: thrown for the argv
// adapter (exit 4, unauthorized), printed for the REPL. Anything else passes.
function presenceRefusal(error, opts) {
  if (opts.throwOnError === true || error?.code !== 'OPERATOR_AUTH_REQUIRED') throw error;
  return error.message;
}

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
    // Deciding an approval is an operator decision (#3560): it needs the
    // operator at a terminal typing the approval id back.
    const presence = { command: 'onayla', subject: 'approval id', expected: approval.approvalId };
    try {
      return requireOperatorPresence(presence, opts, () => decideApproval(cli, approval, approvalArguments, opts))
        .catch(error => presenceRefusal(error, opts));
    } catch (error) {
      return presenceRefusal(error, opts);
    }
  }

  function decideApproval(cli, approval, approvalArguments, opts) {
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
  const audit = require('./cli-audit');
  const deps = { getApprovalStore: () => cli.approvalRuntime().approvalStore };
  const flags = audit.parseAuditArgs(args);
  if (!flags.authority) return audit.runCliAudit(cli.kernel, args, opts, deps);
  // Detection reads the authority ledger over HTTP. The connection is opened
  // behind the CLI entrypoint (cli.authorityLedger); this handler only passes
  // the fetched pages in as data, so lib/ never reaches the authority client.
  const provider = typeof cli.authorityLedger === 'function'
    ? cli.authorityLedger({ graph: cli.kernel && cli.kernel.graph, workspaceId: flags.workspaceId, resolveReceipts: true, anchors: true })
    : { mode: 'legacy', reason: 'no_provider', entries: [], corrupt: false, receipts: {} };
  return Promise.resolve(provider).then(ledger => audit.runCliAudit(cli.kernel, args, opts,
    { ...deps, authorityLedger: ledger, localStopEntries: require('./emergency-stop-detection').readLocalStopEntries() }));
}

function receiptCommand(cli, args, opts, command) {
  return require('./cli-trust-receipt').runCliTrustReceipt(cli.kernel, args, opts);
}

function receiptVerifyCommand(cli, args, opts, command) {
  return require('./cli-trust-receipt').runCliVerifyReceipt(cli.kernel, args, opts);
}

function coderCommand(cli, args, opts = {}, command) {
  const coder = require('./cli-coder');
  const tokens = Array.isArray(args) ? args.map(String) : String(args || '').trim().split(/\s+/u);
  const names = ['--promotion-approval', '--promotion-capability'];
  if (!tokens.some(token => names.includes(token))) return coder.runCliCoder(args, opts);
  const values = {}, removed = new Set();
  for (const name of names) {
    const index = tokens.indexOf(name), value = tokens[index + 1];
    if (index < 0 || tokens.filter(token => token === name).length !== 1 || !value || value.startsWith('--'))
      return commandFailure(`Coder requires one ${name} value`, opts, 4);
    values[name] = value; removed.add(index); removed.add(index + 1);
  }
  const filtered = tokens.filter((_, index) => !removed.has(index));
  if (['verify', 'propose', 'remember', 'create', 'revise'].includes(filtered[0]))
    return commandFailure('Promotion acceptance requires an ordinary Coder task', opts, 4);
  const flags = coder.parseCoderArgs(filtered);
  if (flags.synthesize || flags.initializeProject || flags.candidateFile || flags.useMemory)
    return commandFailure('Promotion acceptance requires an ordinary Coder task', opts, 4);
  const preflight = opts.coderLoop?.withCoderPromotionAcceptance;
  if (!flags.journal || typeof preflight !== 'function')
    return commandFailure('Promotion acceptance requires a journal and its host verifier', opts, 4);
  return preflight({ journalPath: flags.journal, approvalId: values['--promotion-approval'],
    workspaceId: opts.workspaceId || 'default', capabilityId: values['--promotion-capability'] },
  token => coder.runCliCoder(filtered, { ...opts, promotionAcceptance: token }))
    .catch(error => commandFailure(error.message, opts, error.exitCode || 4));
}

module.exports = {
  createApprovalCommands,
  auditCommand,
  receiptCommand,
  receiptVerifyCommand,
  coderCommand,
};
