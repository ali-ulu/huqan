const path = require('path');
const { queueCliLearnReview } = require('./cli-learn-review');
const { formatCliGateMessage } = require('./cli-gate-message');
const {
  auditCliMutation, commitCliMutation, evaluateCliMutationGate,
} = require('./cli-mutation-gate');
const { ensureCompanyCapabilities, ensureProductCapabilities } = require('./cli-capabilities');

const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');

// CLI's runtime helpers (cli.js): persistence paths, the MCP operator
// capability and approval runtime, capability switches, and the mutation
// gate/audit calls. Installed as non-enumerable prototype methods, as class
// methods are.
// The persistence-path and MCP collaborators are handed in by cli.js: lib/
// sits inside the UI (mcpServer) and Adapters (persistencePaths) rings.
function installCliRuntimeMethods(proto, collaborators) {
  const {
    resolvePersistencePaths, callMcpTool, createApprovalStoreFromKernel,
    createMcpOperatorCapability, operatorCapabilityBinding,
  } = collaborators;

  function _backupOptions(extra = {}) {
    const descriptor = this.kernel.getPersistenceDescriptor();
    const resolved = resolvePersistencePaths({
      rootDir: process.cwd(),
      ...descriptor,
      ...extra,
    });
    return { ...resolved, ...extra };
  }

  function _createOperatorCapability(tool, args) {
    const binding = operatorCapabilityBinding(tool, args);
    return createMcpOperatorCapability({ secret: this._mcpOperatorToken, ...binding });
  }

  function _approvalRuntime() {
    if (!this.approvalStore) this.approvalStore = createApprovalStoreFromKernel(this.kernel);
    return {
      approvalStore: this.approvalStore,
      operatorSecret: this._mcpOperatorToken,
      operatorCapabilityNonces: this._mcpCapabilityNonces,
      ...this._approvalRuntimeOptions,
    };
  }

  function queueLearnReview(args) { return queueCliLearnReview({ kernel: this.kernel, approvalRuntime: () => this._approvalRuntime(), callTool: callMcpTool }, args); }

  function _ensureCompanyCapabilities() {
    ensureCompanyCapabilities(this.kernel, PLUGINS_DIR);
  }

  function _ensureProductCapabilities() {
    ensureProductCapabilities(this.kernel, PLUGINS_DIR);
  }

  // See lib/cli-gate-message.js (#1693) for why the wording matters.
  function _formatCliGateMessage(command, gate) {
    return formatCliGateMessage(command, gate);
  }

  // F-004: synthetic gate decision for CLI mutation/maintenance commands that
  // have no huqan.* MCP tool. Returns null for unknown/read-only commands so
  // they proceed ungated. Every real mutation attempt is audited (allow OR
  // review) so nothing mutates silently.
  function _evaluateCliMutationGate(command, args) {
    return evaluateCliMutationGate({ kernel: this.kernel, command, args });
  }

  function _auditCliMutation(command, classification, decision, executed, phase = 'attempted') {
    return auditCliMutation(this.kernel, { command, classification, decision, executed, phase });
  }


  for (const method of [
    _backupOptions, _createOperatorCapability, _approvalRuntime, queueLearnReview, _ensureCompanyCapabilities,
    _ensureProductCapabilities, _formatCliGateMessage, _evaluateCliMutationGate, _auditCliMutation,
  ]) {
    Object.defineProperty(proto, method.name, {
      value: method, writable: true, configurable: true, enumerable: false,
    });
  }
}

module.exports = { installCliRuntimeMethods };
