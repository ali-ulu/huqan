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
 * The compiler's `replace_text` params, sanitized field by field. Returns
 * `null` for anything that is not exactly the three non-empty strings the
 * compiler accepts, so a malformed value fails closed as `bad_params` rather
 * than reaching `compile()` as a shape it would have to re-guard.
 */
function normalizeCompileParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const path = sanitizeMcpString(params.path, 512);
  const oldText = sanitizeMcpString(params.oldText, 4096);
  const newText = sanitizeMcpString(params.newText, 4096);
  if (!path || !oldText || !newText) return null;
  return { path, oldText, newText };
}

function executeMcpExperienceLearn({ journal, name, args, gate }) {
  const safe = args && typeof args === 'object' ? args : {};
  const proposal = buildLearningProposal(journal, {
    runId: sanitizeMcpString(safe.runId, 128),
    workspaceId: sanitizeMcpString(safe.workspaceId, 128),
    kind: sanitizeMcpString(safe.kind, 64) || undefined,
    params: normalizeCompileParams(safe.params),
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
