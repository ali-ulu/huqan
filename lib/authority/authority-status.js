'use strict';

// `huqan-authority status`: which authority this runtime answers to, whether the
// pinned service answers, and -- since ADR-017 (#3948) -- whether agents run as a
// separate OS user. Extracted from bin/huqan-authority.js so the command stays a
// thin orchestrator and this reporting has one home with its own test.

const { resolveApprovalAuthorityMode } = require('./authority-mode');
const { createAuthorityClient } = require('./authority-client');
const { resolveAgentUserBoundary } = require('./agent-user-boundary');

function defaults(deps) {
  return { resolveMode: resolveApprovalAuthorityMode, createClient: createAuthorityClient,
    resolveAgentBoundary: resolveAgentUserBoundary, ...deps };
}

async function status(deps = {}) {
  const { resolveMode, createClient, resolveAgentBoundary } = defaults(deps);
  const mode = resolveMode();
  // The agent-user boundary (ADR-017) is orthogonal to the authority boundary:
  // `boundary` names which authority this runtime answers to, `agentBoundary`
  // names whether agents run as a separate OS user. Reporting the second must
  // not overwrite the first, so it is its own field in every mode.
  const agentBoundary = resolveAgentBoundary().value;
  if (mode.mode === 'legacy') {
    return { code: 0, report: { mode: 'legacy', boundary: mode.boundary, agentBoundary,
      note: 'no approval authority is installed; operator decisions are protected only by the same OS user' } };
  }
  if (mode.mode !== 'service') {
    return { code: 2, report: { mode: mode.mode, reason: mode.reason, pinPath: mode.pinPath, agentBoundary } };
  }
  const base = { mode: 'service', boundary: mode.boundary, agentBoundary, pinPath: mode.pinPath,
    port: mode.pin.port, keyId: mode.pin.keyId };
  try {
    const identity = await createClient({ pin: mode.pin }).identity();
    // Signed is not enough: the service must answer 200 under the very key the pin names.
    if (identity.status !== 200 || !identity.body || identity.body.keyId !== mode.pin.keyId) {
      return { code: 2, report: { ...base, answering: false, error: 'AUTHORITY_IDENTITY_MISMATCH' } };
    }
    return { code: 0, report: { ...base, answering: true } };
  } catch (error) {
    return { code: 2, report: { ...base, answering: false, error: error.code || 'STATUS_FAILED' } };
  }
}

module.exports = { status };
