'use strict';

// #3482 (R27): audit record of the MCP tool-surface filter decision.
//
// `tools/list` serves MODEL_VISIBLE_TOOL_SCHEMAS while OPERATOR_TOOL_SCHEMAS
// stays withheld, but no machine-readable record said *why* a tool was
// absent: a model asking "why isn't huqan.approve listed?" met silence, not
// a reason. This module builds that record -- one entry per tool carrying
// tool + allow/block + reason -- versioned and hash-pinned so the claim
// "tool X was withheld because it needs an operator capability" is
// recomputable by anyone holding the same surface version.
//
// Recorded only: the filter itself (lib/mcp/tool-surface.js) is untouched,
// so a bug here can never hide or expose a tool. A name present in both
// lists is a surface misconfiguration and is recorded fail-closed
// (block + surface_conflict) rather than resolved by precedence.

const { stableStringify, sha256Hex } = require('../receipt/canonical-receipt');

const FILTER_AUDIT_VERSION = 'huqan-tool-surface-filter-audit-v1';

// The allow/block vocabulary mirrors MCP_GATE_DECISIONS deliberately without
// importing the AgentAction-owned gate contract across the Platform boundary
// (#2446 rule 2: contexts talk only through public contracts, and two string
// literals do not earn a published port). Vocabulary agreement is pinned by
// test/mcp-tool-surface-filter-audit.test.js instead of by require.
const FILTER_DECISIONS = Object.freeze({ allow: 'allow', block: 'block' });

const FILTER_REASONS = Object.freeze({
  MODEL_VISIBLE: 'model_visible',
  OPERATOR_WITHHELD: 'operator_capability_required',
  SURFACE_CONFLICT: 'surface_conflict',
});

function toolNameOf(schema) {
  return schema && typeof schema.name === 'string' ? schema.name : null;
}

/**
 * @param {object} lists `{ visibleSchemas, operatorSchemas }` -- the exact
 *   arrays the `tools/list` handler serves and withholds. No defaults: the
 *   caller names the surface it audits, so the record can never describe a
 *   different split than the one served.
 * @returns {object} frozen `{ version, records, recordHash }`; `recordHash`
 *   is sha256 over the canonical serialization of `records`.
 */
function auditToolSurfaceFilter({ visibleSchemas, operatorSchemas } = {}) {
  if (!Array.isArray(visibleSchemas) || !Array.isArray(operatorSchemas)) {
    throw new TypeError('auditToolSurfaceFilter requires { visibleSchemas, operatorSchemas } arrays');
  }

  const visibleNames = new Set();
  for (const schema of visibleSchemas) {
    const name = toolNameOf(schema);
    if (name === null) throw new TypeError('auditToolSurfaceFilter: every visible schema needs a string name');
    visibleNames.add(name);
  }

  const records = [];
  for (const name of visibleNames) {
    records.push(Object.freeze({
      tool: name,
      visible: true,
      decision: FILTER_DECISIONS.allow,
      reason: FILTER_REASONS.MODEL_VISIBLE,
    }));
  }

  const operatorNames = new Set();
  for (const schema of operatorSchemas) {
    const name = toolNameOf(schema);
    if (name === null) throw new TypeError('auditToolSurfaceFilter: every operator schema needs a string name');
    operatorNames.add(name);
  }

  for (const name of operatorNames) {
    // A tool on both sides is misconfigured: block it in the record rather
    // than letting list order decide which truth the audit tells.
    const conflicted = visibleNames.has(name);
    records.push(Object.freeze({
      tool: name,
      visible: false,
      decision: FILTER_DECISIONS.block,
      reason: conflicted ? FILTER_REASONS.SURFACE_CONFLICT : FILTER_REASONS.OPERATOR_WITHHELD,
    }));
  }

  records.sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
  Object.freeze(records);

  return Object.freeze({
    version: FILTER_AUDIT_VERSION,
    records,
    recordHash: sha256Hex(stableStringify(records)),
  });
}

module.exports = {
  FILTER_AUDIT_VERSION,
  FILTER_DECISIONS,
  FILTER_REASONS,
  auditToolSurfaceFilter,
};
