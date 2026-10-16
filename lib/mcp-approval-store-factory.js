'use strict';

/**
 * Default construction seam for the MCP approval store (#2351).
 *
 * This module is a composition root by role: building the default
 * HuqanStorage is its whole job, so the `new` below is not a DIP
 * violation. lib/mcp-approval-store.js receives its store -- either an
 * injected `opts.approvalStore` or an injected `opts.createStorage`
 * factory -- and falls back here only when the caller supplied neither.
 */
const HuqanStorage = require('../storage');

function createDefaultApprovalStorage(storageOpts) {
  return new HuqanStorage(storageOpts);
}

module.exports = { createDefaultApprovalStorage };
