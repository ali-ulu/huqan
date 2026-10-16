'use strict';

/**
 * policy-watchdog (#213).
 *
 * beforeTask hook: monitors lib/trust-policy.js's on-disk trust policy for
 * mid-run drift and locks (blocks) task execution when it changes
 * unexpectedly. Depends on the beforeTask-blocking-propagation fix (see
 * agent.js's _executeStep): before that fix, `blocked: true` set here would
 * have been silently discarded and this plugin would only ever observe
 * task execution, never actually lock it.
 *
 * "Locks" here means a circuit breaker, not a one-shot block: once a
 * change is detected, every subsequent beforeTask stays blocked until the
 * watchdog is explicitly reset (the 'policyWatchdog' capability's 'reset'
 * action) -- a policy that changed once during a run is a standing
 * concern, not a single bad step, so this does not silently resume after
 * the first blocked step passes.
 *
 * The baseline is established lazily, on the first beforeTask call after
 * the watchdog state doesn't have one yet (either fresh, or just reset).
 * loadTrustPolicy() is re-read from disk on every check rather than cached
 * once, since the whole point is to notice a change made after the
 * baseline was captured.
 */

const crypto = require('crypto');
const { loadTrustPolicy, getTrustPolicyVersion } = require('../lib/trust-policy');

function hashPolicy(policy) {
  return crypto.createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

function ensureWatchdogState(kernel) {
  if (!kernel._policyWatchdogState) {
    kernel._policyWatchdogState = {
      baselineHash: null,
      baselineVersion: null,
      locked: false,
      lockedReason: null,
      lockedAt: null,
    };
  }
  return kernel._policyWatchdogState;
}

function checkPolicy(kernel, opts = {}) {
  const watchdogState = ensureWatchdogState(kernel);
  if (watchdogState.locked) return watchdogState; // stays locked until explicitly reset

  let policy;
  try {
    policy = loadTrustPolicy(opts.policyPath);
  } catch (e) {
    // Can't read the policy file at all -- fail closed rather than proceed
    // as if nothing changed.
    watchdogState.locked = true;
    watchdogState.lockedReason = `trust policy unreadable: ${e.message}`;
    watchdogState.lockedAt = new Date().toISOString();
    return watchdogState;
  }

  const currentHash = hashPolicy(policy);
  const currentVersion = getTrustPolicyVersion(policy);

  if (watchdogState.baselineHash === null) {
    watchdogState.baselineHash = currentHash;
    watchdogState.baselineVersion = currentVersion;
    return watchdogState;
  }

  if (currentHash !== watchdogState.baselineHash) {
    watchdogState.locked = true;
    watchdogState.lockedReason = `trust policy changed mid-run (version ${watchdogState.baselineVersion} -> ${currentVersion})`;
    watchdogState.lockedAt = new Date().toISOString();
  }

  return watchdogState;
}

module.exports = {
  name: 'policy-watchdog',
  requires: [],
  optional: [],
  capabilities: [
    {
      name: 'policyWatchdog',
      command: 'policy-watchdog',
      description: 'Monitors trust-policy.json for mid-run drift and locks task execution when it changes unexpectedly.',
    },
  ],

  beforeTask(kernel, data) {
    const watchdogState = checkPolicy(kernel);
    if (watchdogState.locked) {
      data.blocked = true;
      data.blockReason = watchdogState.lockedReason;
      data.blockedBy = 'policy-watchdog';
    }
    return data;
  },

  run(kernel, input = {}) {
    const action = String(input.action || 'status').toLowerCase();
    const watchdogState = ensureWatchdogState(kernel);

    if (action === 'status') {
      return { ok: true, ...watchdogState };
    }

    if (action === 'reset') {
      watchdogState.locked = false;
      watchdogState.lockedReason = null;
      watchdogState.lockedAt = null;
      watchdogState.baselineHash = null;
      watchdogState.baselineVersion = null;
      return { ok: true, reset: true };
    }

    return { ok: false, error: `Unsupported policy-watchdog action: ${action}` };
  },
};

module.exports._test = { ensureWatchdogState, checkPolicy, hashPolicy };
