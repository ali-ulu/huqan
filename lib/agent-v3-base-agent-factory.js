'use strict';

/**
 * Composition root for AgentV3's default base agent.
 *
 * AgentV3 wraps an `Agent` it builds without storage, so its own plan() and
 * step executors -- which share that instance -- do not trip agent.js's v1
 * saveRun()/saveGoalMemory() paths underneath v3, which owns that persistence
 * itself. Constructing the base agent is this module's job, so agent.v3.js
 * receives one rather than building it; an injected `opts.baseAgent` still
 * wins (agent.v3.js keeps that check).
 *
 * `storage` here is not v3's storage: agent.v3.js passes the narrow approval
 * seam it builds, which forwards only saveToolApproval(). Everything else on
 * the base agent's storage stays absent on purpose.
 */

const Agent = require('../agent');

function createDefaultAgentV3BaseAgent({ kernel, dream, maxSteps, storage }) {
  return new Agent({
    kernel,
    dream,
    memoryPath: null,
    maxSteps,
    storage,
  });
}

module.exports = { createDefaultAgentV3BaseAgent };
