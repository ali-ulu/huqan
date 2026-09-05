'use strict';

/**
 * F3 — observation-only robustness wiring for VerifyService.
 *
 * Split out of lib/verify.js (issue #328: that file may not grow), which
 * keeps a single call site: `_verifyResult` wraps its meta through
 * attachRobustnessMeta().
 *
 * `kernel.verify(stmt, { robustness: true })` attaches a `robustness`
 * report to the envelope meta. Default and explicit-false calls return
 * byte-identical envelopes to before: no new key, no decision change, no
 * gate reads this field yet (that is F4).
 *
 * Recursion guard: the probe re-runs verify for its stressed variants
 * through VerifyService directly with the flag forced off, so a probed
 * call never spawns another probe. The service path takes no critical
 * section (the outer kernel.verify already holds it) and performs reads
 * only — the probe cannot write to any graph by construction.
 */

const { normalizeWorkspaceId } = require('../verify-native');
const { runRobustnessProbe } = require('./robustness');

function attachRobustnessMeta(service, base, statement, opts = {}) {
  if (!opts || opts.robustness !== true) return base;
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);
  const innerOpts = { ...opts, robustness: false, workspaceId };
  const innerVerify = (variant) => {
    const raw = service.verify(variant, innerOpts);
    const data = raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' ? raw.data : {};
    return {
      status: typeof data.status === 'string' ? data.status : 'unknown',
      confidence: typeof data.confidence === 'number' ? data.confidence : 0,
    };
  };
  return {
    ...base,
    robustness: runRobustnessProbe(innerVerify, statement, { workspaceId }),
  };
}

module.exports = { attachRobustnessMeta };
