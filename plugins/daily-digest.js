'use strict';

/**
 * daily-digest (#212).
 *
 * afterAgentRun hook: accumulates a per-calendar-day summary (run outcomes,
 * step outcomes) in memory, exposed via the 'dailyDigest' capability
 * (kernel.runCapability('dailyDigest', { action: 'summary', date })),
 * following the same capability pattern repo-memory.js uses.
 *
 * Hooked on agent.js's afterAgentRun specifically: agentRuntime.js's
 * createAgent() defaults to agent.js (not agent.v3.js) unless `version:
 * 'v3'`/AXIOM_AGENT_VERSION is set, and agent.v3.js does not emit
 * afterAgentRun at all -- confirmed by grep before writing this, since
 * #211/#346 already turned up one case in this codebase of a hook that
 * looks wired but silently never fires on the path actually taken.
 *
 * Uses UTC calendar dates (Date.toISOString().slice(0, 10)) so the digest
 * key is deterministic regardless of local timezone/DST.
 */

function utcDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function emptyBucket(dateKey) {
  return {
    date: dateKey,
    runs: 0,
    runsCompleted: 0,
    runsBlocked: 0,
    steps: 0,
    stepsCompleted: 0,
    stepsPending: 0,
    stepsBlocked: 0,
  };
}

function ensureDigestState(kernel) {
  if (!kernel._dailyDigestState) {
    kernel._dailyDigestState = { byDate: {}, lastRunAt: null };
  }
  return kernel._dailyDigestState;
}

function ensureDayBucket(digestState, dateKey) {
  if (!digestState.byDate[dateKey]) {
    digestState.byDate[dateKey] = emptyBucket(dateKey);
  }
  return digestState.byDate[dateKey];
}

function recordRun(digestState, runState, dateKey) {
  const bucket = ensureDayBucket(digestState, dateKey);
  bucket.runs += 1;
  if (runState && runState.status === 'blocked') {
    bucket.runsBlocked += 1;
  } else {
    bucket.runsCompleted += 1;
  }

  const steps = runState && Array.isArray(runState.steps) ? runState.steps : [];
  for (const step of steps) {
    bucket.steps += 1;
    if (step && step.status === 'blocked') bucket.stepsBlocked += 1;
    else if (step && step.status === 'pending') bucket.stepsPending += 1;
    else bucket.stepsCompleted += 1;
  }
  digestState.lastRunAt = new Date().toISOString();
}

module.exports = {
  name: 'daily-digest',
  requires: [],
  optional: [],
  capabilities: [
    {
      name: 'dailyDigest',
      command: 'daily-digest',
      description: 'End-of-day summary of agent runs: completed/blocked runs and steps, per UTC calendar date.',
    },
  ],

  afterAgentRun(kernel, state) {
    const digestState = ensureDigestState(kernel);
    recordRun(digestState, state, utcDateKey());
  },

  run(kernel, input = {}) {
    const action = String(input.action || 'summary').toLowerCase();
    if (action !== 'summary') {
      return { ok: false, error: `Unsupported daily-digest action: ${action}` };
    }
    const digestState = ensureDigestState(kernel);
    const dateKey = input.date || utcDateKey();
    return {
      ok: true,
      digest: digestState.byDate[dateKey] || emptyBucket(dateKey),
      lastRunAt: digestState.lastRunAt,
    };
  },
};

module.exports._test = { utcDateKey, ensureDigestState, ensureDayBucket, recordRun };
