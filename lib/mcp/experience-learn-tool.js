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

function executeMcpExperienceLearn({ journal, name, args, gate }) {
  const safe = args && typeof args === 'object' ? args : {};
  const proposal = buildLearningProposal(journal, {
    runId: sanitizeMcpString(safe.runId, 128),
    workspaceId: sanitizeMcpString(safe.workspaceId, 128),
    kind: sanitizeMcpString(safe.kind, 64) || undefined,
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
