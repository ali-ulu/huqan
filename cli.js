#!/usr/bin/env node

const {
  assertBootEnvironment, readCompatibleEnvironmentVariable, reportBootConflict,
} = require('./lib/environment-compat');
const crypto = require('crypto');
const { createKernel } = require('./lib/kernel-factory');
const {
  createProcessFailureHandlers, failureCodeFor,
} = require('./lib/http/process-failure-handlers');
const { writeStructuredLog } = require('./lib/http/structured-log');
const { cliHelpText } = require('./lib/cli-help');
const { runCliArgv: runWorkflowCliArgv } = require('./lib/cli-workflow-adapter');
const { parseCommand } = require('./lib/command-parser');
const Dream = require('./dream');
const LLMAdapter = require('./llmAdapter');
const { createAgent } = require('./agentRuntime');
const { resolvePersistencePaths } = require('./persistencePaths');
const { commitCliMutation } = require('./lib/cli-mutation-gate');
const {
  callTool: callMcpTool, createApprovalStoreFromKernel, createMcpOperatorCapability, operatorCapabilityBinding,
} = require('./mcpServer');
const { shellQuote, mapCliCommandToMcpTool } = require('./lib/cli-helpers');
const { runCompanyIngest } = require('./lib/cli-company-ingest'); const { runBackupCommand, runRestoreCommand } = require('./lib/cli-backup-commands');
const { runStatusCommand, runDoctorCommand } = require('./lib/cli-status-command');
const { runCliRepl } = require('./lib/cli-repl');
const { installCliRuntimeMethods } = require('./lib/cli-runtime-methods');
const { evaluateCliGate } = require('./lib/cli-gate-evaluation');
const {
  teachCommand, verifyCommand, askCommand, reasonCommand, compareCommand, llmAskCommand,
  loadDocumentCommand, dreamCommand, persistCommand, thinkCommand,
} = require('./lib/cli-knowledge-commands');
const {
  ideaMriCommand, debateCommand, contradictionCommand, companyQueryCommand, ingestStatusCommand,
} = require('./lib/cli-capability-commands');
const {
  planCommand, agentRunCommand, hypothesesCommand, createQuickstartCommand,
} = require('./lib/cli-agent-commands');
const {
  createApprovalCommands, auditCommand, receiptCommand, coderCommand,
} = require('./lib/cli-approval-commands');

const { approvalListCommand, approvalDecisionCommand } = createApprovalCommands({ callMcpTool });
const quickstartCommand = createQuickstartCommand({ callMcpTool, createApprovalStoreFromKernel });

// #2136: one handler per CLI command; a new command is a row, not a case. Handlers get the command context
// CLI#execute builds, not the instance; lazy requires keep a block body so require-scan still sees them deferred.
const canonicalMutationUnavailable = (cli, args, opts, command) => cli.formatCliGateMessage(command, { decision: 'block', reason: 'cli_canonical_mutation_unavailable' });

const CLI_COMMAND_HANDLERS = Object.freeze(Object.assign(Object.create(null), {
  'öğret': (cli, ...rest) => teachCommand(cli, ...rest),
  'verify': (cli, ...rest) => verifyCommand(cli, ...rest),
  'sor': (cli, ...rest) => askCommand(cli, ...rest),
  'neden': (cli, ...rest) => reasonCommand(cli, ...rest),
  'karşılaştır': (cli, ...rest) => compareCommand(cli, ...rest),
  'mri': (cli, ...rest) => ideaMriCommand(cli, ...rest),
  'tartis': (cli, ...rest) => debateCommand(cli, ...rest),
  'celiski': (cli, ...rest) => contradictionCommand(cli, ...rest),
  'llm-sor': (cli, ...rest) => llmAskCommand(cli, ...rest),
  'plan': (cli, ...rest) => planCommand(cli, ...rest),
  'ajan': (cli, ...rest) => agentRunCommand(cli, ...rest),
  'yükle': (cli, ...rest) => loadDocumentCommand(cli, ...rest),
  'company-ingest': (cli, args, opts) => runCompanyIngest(cli, args, opts),
  'company-query': (cli, ...rest) => companyQueryCommand(cli, ...rest),
  'ingest-status': (cli, ...rest) => ingestStatusCommand(cli, ...rest),
  'backup': (cli) => runBackupCommand(cli),
  'kaydet': (cli, ...rest) => persistCommand(cli, ...rest),
  'onaylar': (cli, ...rest) => approvalListCommand(cli, ...rest),
  'onayla': (cli, ...rest) => approvalDecisionCommand(cli, ...rest),
  'audit': (cli, ...rest) => auditCommand(cli, ...rest),
  'receipt': (cli, ...rest) => receiptCommand(cli, ...rest),
  'coder': (cli, ...rest) => coderCommand(cli, ...rest),
  'restore': (cli, args, opts) => runRestoreCommand(cli, args, opts),
  'düşün': (cli, ...rest) => thinkCommand(cli, ...rest),
  'optimize': canonicalMutationUnavailable, 'konsolide': canonicalMutationUnavailable, 'evolve': canonicalMutationUnavailable,
  'quickstart': (cli, ...rest) => quickstartCommand(cli, ...rest),
  'durum': (cli) => runStatusCommand(cli),
  'doctor': (cli) => runDoctorCommand({ rootDir: process.cwd(), kernel: cli.kernel }),
  'rüya': (cli, ...rest) => dreamCommand(cli, ...rest),
  'hypotheses': (cli, ...rest) => hypothesesCommand(cli, ...rest),
  'selam': (cli, args, opts, command) => 'Hello! You can teach me something or ask me a question.',
  'yardım': (cli, args, opts, command) => cliHelpText(),
  'anlamadım': (cli, args, opts, command) => 'I did not understand. Write a longer sentence, or type "yardım" for help.',
}));

// Passed through to the approval runtime only when the caller supplied them.
const APPROVAL_RUNTIME_OPTIONS = Object.freeze([
  'trustEvidenceLedger', 'humanOversightApprovalRuntime', 'agentIdentityRuntime',
  'humanOversightRequesterContext', 'humanOversightApproverContext', 'humanOversightContextResolver',
]);

class CLI {
  /**
   * @param {object} [opts]
   * @param {Kernel|KernelV2} [opts.kernelInstance]
   * @param {object} [opts.kernel]
   * @param {'v2'|'v3'} [opts.agentVersion]
   */
  constructor(opts = {}) {
    this.kernel = opts.kernelInstance || createKernel(opts.kernel || {});
    this.dream = new Dream(this.kernel);
    this.agent = createAgent({
      kernel: this.kernel,
      dream: this.dream,
      version: opts.agentVersion || readCompatibleEnvironmentVariable('AGENT_VERSION'),
    });
    this.llm = new LLMAdapter();
    this.approvalStore = null;
    this._mcpOperatorToken = opts.mcpOperatorToken || crypto.randomBytes(32).toString('hex');
    this._mcpCapabilityNonces = new Map();
    this._approvalRuntimeOptions = Object.freeze(Object.fromEntries(APPROVAL_RUNTIME_OPTIONS
      .filter(name => Object.hasOwn(opts, name)).map(name => [name, opts[name]])));
  }

  parse(input) {
    return parseCommand(input, this.kernel);
  }

  execute(command, args, opts = {}) {
    const gateResult = Object.prototype.hasOwnProperty.call(opts, 'gateResult')
      ? opts.gateResult
      : this.evaluateCliGate(command, args);
    if (gateResult && !gateResult.canExecute) {
      if (mapCliCommandToMcpTool(command) === 'huqan.learn' && gateResult.decision === 'review') {
        const proposal = this.queueLearnReview(args);
        if (opts.json) return proposal;
        const approvalId = proposal?.approval?.id || '';
        return approvalId ? `Learn requires review. Approval queued: ${approvalId}` : this._formatCliGateMessage(command, gateResult);
      }
      return this._formatCliGateMessage(command, gateResult);
    }
    const cli = { kernel: this.kernel, agent: this.agent, dream: this.dream, llm: this.llm, mcpOperatorToken: this._mcpOperatorToken,
      approvalRuntime: (...a) => this._approvalRuntime(...a), backupOptions: (...a) => this._backupOptions(...a),
      commitCliMutation: (...a) => this._commitCliMutation(...a), createOperatorCapability: (...a) => this._createOperatorCapability(...a),
      ensureCompanyCapabilities: (...a) => this._ensureCompanyCapabilities(...a), ensureProductCapabilities: (...a) => this._ensureProductCapabilities(...a),
      formatCliGateMessage: (...a) => this._formatCliGateMessage(...a) };
    const handler = Object.hasOwn(CLI_COMMAND_HANDLERS, command) ? CLI_COMMAND_HANDLERS[command] : null;
    return handler ? handler(cli, args, opts, command) : 'Unknown command.';
  }

  start() {
    return runCliRepl(this, { auditMutation: (...a) => this._auditCliMutation(...a), commitMutation: (...a) => this._commitCliMutation(...a) });
  }

  evaluateCliGate(command, args) {
    return evaluateCliGate((...a) => this._evaluateCliMutationGate(...a), command, args);
  }

  // Records that a mutation actually completed. Its failure is reported, not
  // fatal: the state change already happened, so refusing it here would only
  // hide it (#760).
  _commitCliMutation(command, classification = null) {
    const audit = commitCliMutation(this.kernel, command, classification);
    return audit.auditRecorded ? '' : `\nWarning: ${command} completed, but its commit audit record could not be written (${audit.errorCode}).`;
  }

}

installCliRuntimeMethods(CLI.prototype, {
  resolvePersistencePaths, callMcpTool, createApprovalStoreFromKernel, createMcpOperatorCapability, operatorCapabilityBinding,
});

async function runCliArgv(argv = [], io = {}) {
  assertBootEnvironment();
  return runWorkflowCliArgv(argv, io, {
    createCli: options => new CLI(options),
    version: require('./package.json').version,
  });
}

async function main(argv = process.argv.slice(2)) {
  const result = await runCliArgv(argv);
  if (result.interactive) {
    const cli = new CLI();
    cli.kernel.reload();
    cli.start();
    return;
  }
  process.exitCode = result.exitCode;
}

const cliProcessFailureHandlers = createProcessFailureHandlers({
  logError: (kind, cause) => writeStructuredLog(console, 'error', kind === 'uncaughtException' ? 'process.uncaught_exception' : 'process.unhandled_rejection', null, {
    runtime: 'cli',
    errorCode: failureCodeFor(kind, cause),
  }),
});

if (require.main === module) {
  cliProcessFailureHandlers.bind();
  main().catch(error => {
    if (!reportBootConflict('cli', error)) console.error(`CLI error: ${error?.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = CLI;
module.exports.createKernel = createKernel;
module.exports.shellQuote = shellQuote;
module.exports.runCliArgv = runCliArgv;
