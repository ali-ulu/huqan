'use strict';

/**
 * The runtime outputSchema gate for MCP tool results (#3483).
 *
 * Every tool advertises an output schema in tools/list, and a strict MCP
 * client validates `structuredContent` against it. Measured over the MCP
 * test suites before this gate existed, most results did not conform: the
 * hand-built envelopes (gate refusals, operator tools, read workflows) left
 * out `type`, `meta.contractVersion`, `meta.backend` and `meta.paranoidMode`,
 * and a few handlers drifted at the data level.
 *
 * Two steps, in this order:
 *
 * 1. Complete the envelope from its true sources only. `meta` takes
 *    contractVersion, backend and paranoidMode from the kernel that served
 *    the call (the same values `kernel.ok()` writes; a kernel without one
 *    reports the code's CONTRACT_VERSION); an absent `evidence`
 *    is no evidence (`[]`), an absent `data` or `error` is `null`, an absent
 *    `ok` follows the tool verdict rule (`result.ok !== false`), and an
 *    absent `type` is the tool's workflow id. Nothing already present is
 *    overwritten.
 *
 * 2. Check the completed result against the advertised schema. The surface
 *    is split on purpose:
 *    - applied tools: a result that does not conform is refused fail-closed
 *      as OUTPUT_SCHEMA_VIOLATION, and the refusal itself conforms;
 *    - declared-only tools: the schema is advertised but a known data-level
 *      drift is still open, so the completed result passes unchanged.
 *    Both lists are published in tools/list `_meta`, so a client can see
 *    which declarations are enforced. The characterisation test moves a tool
 *    to the applied list once its results conform, and never back.
 */

const crypto = require('node:crypto');

const { CONTRACT_VERSION } = require('../kernel-contract');
const { conformanceError } = require('./output-schema-conformance');
const { workflowForMcpTool } = require('../workflow-contract');
const { MODEL_VISIBLE_TOOL_SCHEMAS, OPERATOR_TOOL_SCHEMAS } = require('./tool-surface');

const OUTPUT_SCHEMA_VIOLATION = 'OUTPUT_SCHEMA_VIOLATION';

// Tools whose advertised output schema is not enforced yet, each with the
// drift that keeps it here. Every other advertised tool is enforced. Each
// drift is the declared schema lagging its producer; declaring what the tool
// really returns narrows a published output contract, which
// scripts/api-semver-gate.js treats as breaking (major release), so the
// schemas stay as published until that release is decided.
const DECLARED_ONLY_OUTPUT_TOOLS = Object.freeze({
  'huqan.ask': 'kernel.ask answers a "neden ..." question with reason data, which ASK_DATA_SCHEMA does not describe',
  'huqan.plan': 'planned steps carry no status or summary yet, and a goal-integrity refusal returns { goal, goalIntegrity } as data',
  'huqan.approve': 'data.result is null when the decision executed nothing; the schema declares an object',
  'huqan.search': 'the producer reports returned/truncated/limit since #3533; the schema still requires total',
});

const OUTPUT_SCHEMAS = new Map(
  [...MODEL_VISIBLE_TOOL_SCHEMAS, ...OPERATOR_TOOL_SCHEMAS].map(tool => [tool.name, tool.outputSchema]),
);

const APPLIED_OUTPUT_TOOLS = Object.freeze(
  [...OUTPUT_SCHEMAS.keys()].filter(name => !Object.hasOwn(DECLARED_ONLY_OUTPUT_TOOLS, name)).sort(),
);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function kernelMeta(kernel) {
  const core = kernel && kernel.kernel ? kernel.kernel : kernel;
  const graph = (kernel && kernel.graph) || (core && core.graph);
  let backend = 'unknown';
  try {
    const stats = graph && typeof graph.getStats === 'function' ? graph.getStats() : null;
    if (stats && typeof stats.backend === 'string' && stats.backend) backend = stats.backend;
  } catch (_) {
    // A graph that cannot report its backend is reported as unknown, as
    // kernel.ok() does.
  }
  const paranoid = kernel && typeof kernel.paranoidMode === 'boolean'
    ? kernel.paranoidMode
    : Boolean(core && core.paranoidMode);
  return {
    contractVersion: (kernel && kernel.contractVersion) || (core && core.contractVersion) || CONTRACT_VERSION,
    backend,
    paranoidMode: paranoid,
  };
}

/** Fill absent envelope fields from their true sources; never overwrite. */
function completeMcpEnvelope(kernel, name, result) {
  if (!isPlainObject(result)) return result;
  const workflow = workflowForMcpTool(name);
  const completed = { ...result };
  if (typeof completed.ok !== 'boolean') completed.ok = result.ok !== false;
  if (typeof completed.type !== 'string' && workflow) completed.type = workflow.workflowId;
  if (completed.data === undefined) completed.data = null;
  if (completed.evidence === undefined) completed.evidence = [];
  if (completed.error === undefined) completed.error = null;
  const meta = isPlainObject(result.meta) ? result.meta : {};
  const fromKernel = kernelMeta(kernel);
  completed.meta = {
    ...Object.fromEntries(Object.entries(fromKernel).filter(([key]) => meta[key] === undefined)),
    ...meta,
  };
  return completed;
}

// The reference is derived from the tool and the rule it broke, so the same
// drift always carries the same reference: it groups repeated violations in
// the log and keeps the refusal deterministic. The rule stays in the log; the
// client gets only the reference.
function violationReference(name, reason) {
  return crypto.createHash('sha256').update(`${name}\n${reason}`).digest('hex').slice(0, 8);
}

/**
 * The refusal is built from scratch, never spread from the withheld result:
 * nothing the result carried reaches the client except two facts about what
 * already happened, which a refusal must not hide. `canonicalWrite` stays
 * true when the call did write, and a string `receiptId` stays so that write
 * remains traceable. Everything else is the envelope's empty value, so the
 * refusal conforms to the same schema it enforces.
 */
// Whether the withheld result shows a write the refusal must not hide. The
// verdict surface's canonicalWrite misses dream's committed hypotheses, so a
// non-empty `data.learned` (dream's edge list, learn's count) counts too.
function wroteCanonically(source) {
  if (source.canonicalWrite === true) return true;
  const learned = isPlainObject(source.data) ? source.data.learned : undefined;
  return (Array.isArray(learned) && learned.length > 0) || (typeof learned === 'number' && learned > 0);
}

function violationResult(kernel, name, completed, reason) {
  const errorRef = violationReference(name, reason);
  const source = isPlainObject(completed) ? completed : {};
  const originalCode = isPlainObject(source.error) && typeof source.error.code === 'string'
    ? source.error.code
    : 'none';
  try {
    console.error(`[mcp][tools/call output] schema violation ref=${errorRef} ${name} (original error ${originalCode}): ${reason}`);
  } catch (_) {
    // Diagnostics are best-effort; the refusal below is not.
  }
  const workflow = workflowForMcpTool(name);
  return {
    ok: false,
    workflowId: workflow ? workflow.workflowId : name,
    version: workflow ? workflow.version : '0.0.0',
    status: 'failed',
    type: workflow ? workflow.workflowId : name,
    data: null,
    evidence: [],
    confidence: null,
    policy: null,
    approval: null,
    canonicalWrite: wroteCanonically(source),
    candidateId: null,
    provenance: null,
    audit: null,
    receipt: null,
    trace: null,
    receiptId: typeof source.receiptId === 'string' ? source.receiptId : null,
    error: {
      code: OUTPUT_SCHEMA_VIOLATION,
      message: `The tool result did not match its declared output schema and was withheld (ref: ${errorRef}).`,
    },
    meta: kernelMeta(kernel),
  };
}

/**
 * Complete a tool result and hold it to the schema the tool advertises.
 * Unknown tools (no advertised schema) are completed and passed: there is
 * no declaration to enforce, and dispatch already refused the call.
 */
function conformMcpToolOutput(kernel, name, result) {
  const completed = completeMcpEnvelope(kernel, name, result);
  const schema = OUTPUT_SCHEMAS.get(name);
  if (!schema || Object.hasOwn(DECLARED_ONLY_OUTPUT_TOOLS, name)) return completed;
  const reason = conformanceError(completed, schema);
  return reason ? violationResult(kernel, name, completed, reason) : completed;
}

/** The enforcement split, for tools/list `_meta`. */
function outputConformanceSurface() {
  return {
    applied: [...APPLIED_OUTPUT_TOOLS],
    declaredOnly: Object.keys(DECLARED_ONLY_OUTPUT_TOOLS).sort()
      .map(tool => ({ tool, reason: DECLARED_ONLY_OUTPUT_TOOLS[tool] })),
  };
}

module.exports = Object.freeze({
  OUTPUT_SCHEMA_VIOLATION,
  DECLARED_ONLY_OUTPUT_TOOLS,
  APPLIED_OUTPUT_TOOLS,
  completeMcpEnvelope,
  conformMcpToolOutput,
  outputConformanceSurface,
});
