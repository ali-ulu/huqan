'use strict';

function createMcpServerCloser({
  kernel,
  approvalStore,
  operatorCapabilityNonces,
  ownsKernel,
  ownsApprovalStore,
  ownsOperatorCapabilityNonces,
} = {}) {
  let closed = false;
  return function close() {
    if (closed) return;
    closed = true;
    const errors = [];
    const closeResource = (resource) => {
      if (!resource || typeof resource.close !== 'function') return;
      try { resource.close(); } catch (error) { errors.push(error); }
    };
    if (ownsApprovalStore) closeResource(approvalStore);
    if (ownsOperatorCapabilityNonces) closeResource(operatorCapabilityNonces);
    if (ownsKernel) closeResource(kernel?.graph);
    if (errors.length > 0) throw new AggregateError(errors, 'MCP server resource close failed');
  };
}

module.exports = { createMcpServerCloser };
