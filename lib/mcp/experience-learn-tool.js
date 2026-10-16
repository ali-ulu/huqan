'use strict';

/**
 * `huqan.experience_learn` -- one run's learning proposal, over MCP.
 *
 * Read-only and model-visible like `huqan.experience_read`: the proposal is
 * derived from the sealed journal record and installs nothing. `registered`
 * is always false -- installing a proposal stays a separate human-gated act
 * (#2392/#2393). The journal arrives on the kernel once the runtime seam
 * wiring (#2378) lands a production instance.
 */

const { sanitizeMcpString } = require('../mcp-input-sanitizers');
const { withMcpToolVerdictSurface } = require('./response-builders');
const { buildLearningProposal } = require('../experience/learning-intake');

/**
 * The compiler's `replace_text` params, validated field by field. `oldText` and
 * `newText` are the literal match and replacement text, so they are forwarded
 * byte-for-byte: trimming or stripping them would change what the procedure
 * matches and what it writes, and would diverge from a direct proposal built
 * with the same params. Anything that is not three non-empty bounded strings
 * fails closed as `null` (the compiler's `bad_params`).
 */
function normalizeCompileParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const limits = { path: 512, oldText: 4096, newText: 4096 };
  const out = {};
  for (const [key, max] of Object.entries(limits)) {
    const value = params[key];
    if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
    out[key] = value;
  }
  return out;
}

function normalizeSourceRunIds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32
    || !value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)) return null;
  return value;
}

function executeMcpExperienceLearn({ journal, name, args, gate }) {
  const safe = args && typeof args === 'object' ? args : {};
  const proposal = buildLearningProposal(journal, {
    runId: sanitizeMcpString(safe.runId, 128),
    workspaceId: sanitizeMcpString(safe.workspaceId, 128),
    kind: sanitizeMcpString(safe.kind, 64) || undefined,
    params: normalizeCompileParams(safe.params),
    sourceRunIds: normalizeSourceRunIds(safe.sourceRunIds),
  });
  if (!proposal.ok) {
    return withMcpToolVerdictSurface({
      ok: false,
      data: null,
      evidence: [],
      error: { code: 'EXPERIENCE_LEARN_FAILED', message: proposal.code },
      meta: {},
    }, name, args, gate);
  }
  return withMcpToolVerdictSurface({
    ok: true,
    type: 'experience_learn',
    data: proposal,
    evidence: [],
    error: null,
    meta: {},
  }, name, args, gate);
}

module.exports = { executeMcpExperienceLearn };
