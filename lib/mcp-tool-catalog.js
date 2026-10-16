'use strict';

// The MCP tool catalog served in tools/list, and each tool's provenance.
// The schemas live per domain in mcp-tool-catalog-*.js (#2186); the order
// below is the catalog order.

const { OPERATOR_TOOL_SCHEMAS } = require('./mcp/operator-tool-schemas');
const { CORE_TOOL_SCHEMAS } = require('./mcp-tool-catalog-core');
const { INGEST_TOOL_SCHEMAS } = require('./mcp-tool-catalog-ingest');
const { GOVERNANCE_TOOL_SCHEMAS } = require('./mcp-tool-catalog-governance');
const { REASONING_TOOL_SCHEMAS } = require('./mcp-tool-catalog-reasoning');
const { TRUST_TOOL_SCHEMAS } = require('./mcp-tool-catalog-trust');

const TOOL_SCHEMAS = [
  ...CORE_TOOL_SCHEMAS,
  ...OPERATOR_TOOL_SCHEMAS,
  ...INGEST_TOOL_SCHEMAS,
  ...GOVERNANCE_TOOL_SCHEMAS,
  ...REASONING_TOOL_SCHEMAS,
  ...TRUST_TOOL_SCHEMAS,
];

/**
 * Tool identity chain (#1890). Every catalog entry is first-party, so each
 * one carries the same publisher, the package version it shipped with, and a
 * signature status -- recorded per tool so a future third-party tool cannot
 * slip in without provenance. Kept parallel to TOOL_SCHEMAS (not inlined)
 * because the schemas above are served verbatim in `tools/list`; extra
 * fields there would leak into the client-visible contract.
 */
let TOOL_CATALOG_VERSION = 'unversioned';
try {
  TOOL_CATALOG_VERSION = require('../package.json').version || TOOL_CATALOG_VERSION;
} catch (_) { /* package metadata unavailable: record stays explicit */ }

const TOOL_CATALOG_PROVENANCE = Object.freeze({
  publisher: 'huqan-core',
  version: TOOL_CATALOG_VERSION,
  signatureStatus: 'first-party-bundled',
  source: 'lib/mcp-tool-catalog.js',
});

const TOOL_PROVENANCE = Object.freeze(Object.fromEntries(
  TOOL_SCHEMAS.map(tool => [tool.name, Object.freeze({
    tool: tool.name,
    publisher: TOOL_CATALOG_PROVENANCE.publisher,
    version: TOOL_CATALOG_PROVENANCE.version,
    signatureStatus: TOOL_CATALOG_PROVENANCE.signatureStatus,
    source: TOOL_CATALOG_PROVENANCE.source,
    readOnly: Boolean(tool.annotations && tool.annotations.readOnlyHint),
  })]),
));

function getToolProvenance(name) {
  return typeof name === 'string' ? TOOL_PROVENANCE[name] || null : null;
}

module.exports = {
  TOOL_SCHEMAS,
  TOOL_CATALOG_PROVENANCE,
  TOOL_PROVENANCE,
  getToolProvenance,
};
