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
const { runCliArgv: runWorkflowCliArgv } = require('./lib/cli-workflow-adapter');
const { explainSqliteBindingsError } = require('./lib/sqlite-availability');
const { parseCommand, normalizeCommandText } = require('./lib/command-parser');
const Dream = require('./dream');
const LLMAdapter = require('./llmAdapter');
const { createAgent } = require('./agentRuntime');
const { resolvePersistencePaths } = require('./persistencePaths');
const { commitCliMutation } = require('./lib/cli-mutation-gate');
const {
  callTool: callMcpTool, createApprovalStoreFromKernel, createMcpOperatorCapability, operatorCapabilityBinding,
} = require('./mcpServer');
const { shellQuote, mapCliCommandToMcpTool } = require('./lib/cli-helpers');
const { runCliRepl } = require('./lib/cli-repl');
const { installCliRuntimeMethods } = require('./lib/cli-runtime-methods');
const { evaluateCliGate } = require('./lib/cli-gate-evaluation');
const { createCliCommandHandlers } = require('./lib/cli-command-handlers');
const { MemoryLifecycle } = require('./lib/memory-lifecycle');
const {
  compareHypothesisFrames, consumeHypothesisCognition,
} = require('./lib/memory-hypothesis-cognition');
const { GENESIS_PREVIOUS_HASH, appendReceiptToChain, validateReceiptChain } = require('./lib/receipt/receipt-chain');

// #3568 (R49): the K0/K1 cognition consumer, wired here for the same layer
// reason as the receipt collaborators above -- lib/memory-hypothesis-cognition.js
// is Adapters while lib/graph-hypotheses.js is Core, so the CLI entrypoint
// passes it in rather than letting Core require it.
const HYPOTHESIS_COGNITION = Object.freeze({ consumeHypothesisCognition, compareHypothesisFrames });

const CLI_COMMAND_HANDLERS = createCliCommandHandlers({
  callMcpTool,
  createApprovalStoreFromKernel,
  hypothesisCognition: HYPOTHESIS_COGNITION,
});

// The receipt collaborators `MemoryLifecycle` cannot require itself: it lives
// in the Adapters ring while lib/receipt/* is Application, so the layer policy
// puts the wiring here in the UI entrypoint. Built once -- the chain primitives
// are pure functions, so every lifecycle shares the same collaborators.
const MEMORY_LIFECYCLE_CHAIN = Object.freeze({ GENESIS_PREVIOUS_HASH, appendReceiptToChain, validateReceiptChain });

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
        // #3644: upload:/yükle: names a file, so the durable proposal must
        // carry the file's *content*, not the path text the old code replayed.
        // Reading here (not in the queue helper) keeps `readFile` a plain
        // boolean; the helper stays free of the command-parser dependency its
        // module boundary forbids.
        const isUpload = normalizeCommandText(command) === 'yukle';
        let proposal;
        try {
          proposal = this.queueLearnReview(args, { readFile: isUpload });
        } catch (error) {
          return `Could not read file: ${error.message}`;
        }
        if (opts.json) return proposal;
        const approvalId = proposal?.approval?.id || '';
        return approvalId ? `Learn requires review. Approval queued: ${approvalId}` : this._formatCliGateMessage(command, gateResult);
      }
      return this._formatCliGateMessage(command, gateResult);
    }
    const cli = { kernel: this.kernel, agent: this.agent, dream: this.dream, llm: this.llm, mcpOperatorToken: this._mcpOperatorToken,
      approvalRuntime: (...a) => this._approvalRuntime(...a), backupOptions: (...a) => this._backupOptions(...a),
      commitCliMutation: (...a) => this._commitCliMutation(...a), createOperatorCapability: (...a) => this._createOperatorCapability(...a),
      memoryLifecycle: () => this._memoryLifecycle(),
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
  _commitCliMutation(command, classification = null, extra = null) {
    const audit = extra
      ? commitCliMutation(this.kernel, command, classification, extra)
      : commitCliMutation(this.kernel, command, classification);
    return audit.auditRecorded ? '' : `\nWarning: ${command} completed, but its commit audit record could not be written (${audit.errorCode}).`;
  }

  // Builds the MemoryLifecycle the `memory-lifecycle` command drives, or null
  // when the kernel has no store exposing the two reversible primitives. Built
  // once and reused, so the chain tip threads from one CLI mutation to the next
  // within a session -- rebuilding per call would restart every receipt at
  // genesis and leave an operator unable to link successive mutations (#3461).
  _memoryLifecycle() {
    const store = this.kernel && this.kernel.memory;
    if (!store || typeof store.tombstone !== 'function' || typeof store.supersede !== 'function') return null;
    if (!this._memoryLifecycleInstance || this._memoryLifecycleInstance.kernel !== this.kernel) {
      this._memoryLifecycleInstance = new MemoryLifecycle(this.kernel, { memoryStore: store, chain: MEMORY_LIFECYCLE_CHAIN });
    }
    return this._memoryLifecycleInstance;
  }

}

installCliRuntimeMethods(CLI.prototype, {
  resolvePersistencePaths, callMcpTool, createApprovalStoreFromKernel, createMcpOperatorCapability, operatorCapabilityBinding,
});

async function runCliArgv(argv = [], io = {}) {
  assertBootEnvironment();
  return runWorkflowCliArgv(argv, io, {
    createCli: options => new CLI(options),
    parseCommand,
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
    if (!reportBootConflict('cli', error)) {
      const sqliteHint = explainSqliteBindingsError(error);
      console.error(sqliteHint ? `CLI error: ${sqliteHint}` : `CLI error: ${error?.message || error}`);
    }
    process.exitCode = 1;
  });
}

module.exports = CLI;
module.exports.createKernel = createKernel;
module.exports.shellQuote = shellQuote;
module.exports.runCliArgv = runCliArgv;
