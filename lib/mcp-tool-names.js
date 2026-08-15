'use strict';

/**
 * MCP tool naming under RFC-001 (HUQAN canonical naming and AXIOM/ATP legacy
 * compatibility).
 *
 * RFC-001 decision 1 makes `HUQAN` the canonical product namespace and demotes
 * `AXIOM` to a legacy compatibility identifier. The MCP server is the surface
 * where that mismatch was most expensive: a user installs the `huqan` package
 * and then has to type `axiom.learn`, which is exactly the "AXIOM against
 * HUQAN" cost the RFC's naming-value audit measured.
 *
 * RFC-001 decision 7 fixes the shape of the fix:
 *
 *   "Legacy identifiers are never used to produce new canonical output once
 *    their migration gate lands. A reader accepts both; a writer emits only
 *    the canonical form."
 *
 * Applied here:
 *
 * - reader  — `tools/call` accepts `huqan.*` and the legacy `axiom.*` spelling
 *             and resolves both to the same handler;
 * - writer  — `tools/list` advertises `huqan.*` only, mirroring gate M1's
 *             "documentation shows only HUQAN_*" rule for environment
 *             variables. Legacy names stay callable; they stop being
 *             advertised.
 *
 * Unlike M1's environment variables there is no dual-configuration case to
 * arbitrate: a `tools/call` carries exactly one name, so M1's fail-closed
 * `HUQAN_ENV_CONFLICT` branch has no analogue and none is invented here.
 *
 * Only the exact suffixes below alias. `axiom.anything-else` is not rewritten,
 * so an unknown tool still reaches the gate adapter's unknown-tool block
 * instead of being silently mapped onto a real handler.
 */

const MCP_TOOL_SUFFIXES = Object.freeze([
  'learn',
  'ask',
  'verify',
  'plan',
  'agent',
  'policy',
  'approvals',
  'approve',
  'reason',
  'compare',
  'dream',
  'advocate',
  'search',
  'trust_receipt',
  'ingest_preview',
  'ingest_status',
]);

const CANONICAL_MCP_TOOL_PREFIX = 'huqan.';
const LEGACY_MCP_TOOL_PREFIX = 'axiom.';

const CANONICAL_MCP_TOOL_NAMES = Object.freeze(
  MCP_TOOL_SUFFIXES.map((suffix) => `${CANONICAL_MCP_TOOL_PREFIX}${suffix}`),
);
const LEGACY_MCP_TOOL_NAMES = Object.freeze(
  MCP_TOOL_SUFFIXES.map((suffix) => `${LEGACY_MCP_TOOL_PREFIX}${suffix}`),
);

const CANONICAL_SET = new Set(CANONICAL_MCP_TOOL_NAMES);
const LEGACY_SET = new Set(LEGACY_MCP_TOOL_NAMES);

function isCanonicalMcpToolName(name) {
  return typeof name === 'string' && CANONICAL_SET.has(name);
}

function isLegacyMcpToolName(name) {
  return typeof name === 'string' && LEGACY_SET.has(name);
}

/**
 * Resolve a requested tool name to its canonical `huqan.*` spelling.
 *
 * Canonical names are returned unchanged. Exactly the declared legacy aliases are
 * rewritten. Everything else — including any other `axiom.`-prefixed string —
 * is returned unchanged so that unknown-tool handling stays intact.
 */
function canonicalMcpToolName(name) {
  if (typeof name !== 'string') return name;
  if (CANONICAL_SET.has(name)) return name;
  if (LEGACY_SET.has(name)) {
    return `${CANONICAL_MCP_TOOL_PREFIX}${name.slice(LEGACY_MCP_TOOL_PREFIX.length)}`;
  }
  return name;
}

/**
 * The legacy spelling of a canonical name, for documentation and compatibility
 * reporting. Returns null for anything that is not a canonical tool name.
 */
function legacyMcpToolName(name) {
  if (!isCanonicalMcpToolName(name)) return null;
  return `${LEGACY_MCP_TOOL_PREFIX}${name.slice(CANONICAL_MCP_TOOL_PREFIX.length)}`;
}

/**
 * The deprecation signal for a requested name, or null when the request already
 * used the canonical spelling.
 *
 * RFC-001 does not mandate a specific runtime deprecation payload, but it does
 * require that a legacy identifier is "never presented as a current, separate
 * product". Returning a structured, machine-readable notice — rather than only
 * a log line — is what lets a client surface the migration without parsing
 * prose, and is what the compatibility tests assert on.
 */
function mcpToolDeprecationNotice(requestedName) {
  if (!isLegacyMcpToolName(requestedName)) return null;
  const canonical = canonicalMcpToolName(requestedName);
  return Object.freeze({
    deprecated: true,
    rfc: 'RFC-001',
    requestedName,
    canonicalName: canonical,
    message: `MCP tool "${requestedName}" is a deprecated AXIOM-era alias accepted for compatibility only. `
      + `Use the canonical name "${canonical}".`,
  });
}

const warnedLegacyMcpToolNames = new Set();

/**
 * Emit the once-per-name stderr deprecation warning for a legacy tool call.
 *
 * stderr, not stdout: the MCP stdio transport owns stdout, so anything written
 * there corrupts the protocol stream. Once per name rather than per call so a
 * client that has not migrated does not turn its own logs into noise.
 */
function warnLegacyMcpToolName(notice) {
  if (warnedLegacyMcpToolNames.has(notice.requestedName)) return;
  warnedLegacyMcpToolNames.add(notice.requestedName);
  try {
    process.stderr.write(`[huqan] DEPRECATION: ${notice.message}
`);
  } catch (_) {
    // A failed warning must never replace the result the caller is waiting for.
  }
}

/**
 * Attach the RFC-001 deprecation notice to a result produced from a legacy
 * `axiom.*` call.
 *
 * The notice rides in `meta.deprecation` rather than replacing any part of the
 * response, so a legacy caller observes exactly the result it observed before
 * plus one additive field. Non-object results are returned untouched.
 */
function withMcpToolDeprecationSurface(result, requestedName) {
  const deprecation = mcpToolDeprecationNotice(requestedName);
  if (!deprecation) return result;
  warnLegacyMcpToolName(deprecation);
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const meta = result.meta && typeof result.meta === 'object' && !Array.isArray(result.meta)
    ? result.meta
    : {};
  return { ...result, meta: { ...meta, deprecation } };
}

module.exports = {
  MCP_TOOL_SUFFIXES,
  CANONICAL_MCP_TOOL_PREFIX,
  LEGACY_MCP_TOOL_PREFIX,
  CANONICAL_MCP_TOOL_NAMES,
  LEGACY_MCP_TOOL_NAMES,
  isCanonicalMcpToolName,
  isLegacyMcpToolName,
  canonicalMcpToolName,
  legacyMcpToolName,
  mcpToolDeprecationNotice,
  warnLegacyMcpToolName,
  withMcpToolDeprecationSurface,
};
