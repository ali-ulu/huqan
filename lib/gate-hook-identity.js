'use strict';

// Read-only identity audit for the huqan-gate-hook CLI entry point (#2248).
//
// Single responsibility: answer "what has this identity done?" from the same
// receipt trail the guard writes. No stdin, no receipt writer, no graph, no
// command dispatch. The entry point keeps dispatch and exit-code ownership;
// this module only performs the lookup and prints it.

const { queryExternalActionsByIdentity } = require('./external-action-identity-log');
const { argumentValue } = require('./gate-hook-input');

function queryIdentityLog() {
  const identityRef = argumentValue('--identity-log');
  const result = queryExternalActionsByIdentity({
    ...(identityRef.startsWith('agent:') ? { identityRef } : { agentId: identityRef }),
    ...(argumentValue('--receipt-log') ? { path: argumentValue('--receipt-log') } : {}),
    ...(argumentValue('--owner') ? { ownerActorId: argumentValue('--owner') } : {}),
    ...(argumentValue('--since') ? { since: argumentValue('--since') } : {}),
    ...(argumentValue('--until') ? { until: argumentValue('--until') } : {}),
    ...(argumentValue('--limit') ? { limit: Number.parseInt(argumentValue('--limit'), 10) } : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
}

module.exports = { queryIdentityLog };
