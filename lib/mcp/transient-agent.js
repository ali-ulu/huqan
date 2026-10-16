'use strict';

// A throwaway agent for one MCP call (#2142). `createAgent` is passed in rather
// than required: agentRuntime.js is an entrypoint, and lib/ may not reach up.

const { readCompatibleEnvironmentVariable } = require('../environment-compat');

/**
 * Run `callback` with a throwaway agent and close that agent's storage
 * afterwards.
 *
 * The close must wait for an async callback to settle (#409). A plain
 * `finally` runs as soon as the callback *returns* -- for a callback that
 * returns a promise that is the moment the promise is created, not the moment
 * the work finishes, so storage was closed out from under the in-flight
 * operation and any later use hit a closed handle.
 *
 * Every current callback (agent.plan / agent.run / agent.inspectToolPolicy) is
 * synchronous, so this is a latent bug rather than an active one today. The
 * thenable branch below keeps it latent: if any of those ever becomes async,
 * the close follows the work instead of racing it.
 */
function createTransientAgentRunner(createAgent) {
  return function withTransientAgent(kernel, callback) {
    const agent = createAgent({
      kernel,
      version: readCompatibleEnvironmentVariable('AGENT_VERSION'),
    });
    const closeStorage = () => {
      try { agent?.storage?.close?.(); } catch (_) {}
    };

    let result;
    try {
      result = callback(agent);
    } catch (error) {
      closeStorage();
      throw error;
    }

    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => { closeStorage(); return value; },
        (error) => { closeStorage(); throw error; },
      );
    }

    closeStorage();
    return result;
  };
}

module.exports = {
  createTransientAgentRunner,
};
