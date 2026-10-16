'use strict';

/**
 * The production entry point for the bounded A2A exchange (P0-B).
 *
 * Until now `evaluateBoundedExchange` had exactly one caller: a child process
 * driven by `npm run conformance:a2a`. The rules were real and the fifty
 * conformance cases were real, but nothing a deployed server did could reach
 * them. This module is that reach, and deliberately nothing more -- it moves
 * bytes between HTTP and the evaluator and refuses everything the evaluator
 * would refuse.
 *
 * The one property worth stating plainly, because it is the property an
 * attacker would attack: **the request body supplies none of the trust.**
 * Identity records, trusted keys, the package allowlist, target binding and the
 * evaluation clock all come from a receiver-owned authority file that the
 * operator points at, exactly as `docs/v5/v5-d6-bounded-a2a-exchange.md`
 * requires. A caller can describe what it did; it cannot describe who it is or
 * what time it is.
 */

const { readJsonBody } = require('../../requestGuards');
const { writeJson } = require('../server-response-helpers');

// Constants only. The log itself is constructed inside the boundary, with the
// replay and task stores, so a directory it cannot use makes the whole route
// unavailable rather than half of it.
const { DELEGATION_OUTCOMES } = require('./delegation-audit-log');
// How long this route waits for a request to arrive in full (P0-F). Taken from
// the Agent Card so the advertised deadline and the enforced one are one value;
// the handler applies it to the socket. Re-exported for the Agent Card route.
const { REQUEST_TIMEOUT_MS } = require('./agent-card');

// Constants, the delegated-policy firewall, the receiver authority, refusal
// shapes and the per-request handler live in exchange-route-*.js (#2185).
const { A2A_EXCHANGE_PATH, A2A_ROUTE_ERRORS, CANONICAL_WORKSPACE, MAX_BODY_BYTES } = require('./exchange-route-contract');
const { readReceiverAuthority, resolveA2aBoundaryPaths } = require('./exchange-route-authority');
const { buildFirewallReceiptMetadata, evaluateA2aAgentActionFirewall } = require('./exchange-route-firewall');
const { createA2aExchangeHandler } = require('./exchange-route-handler');

/**
 * Actually construct everything the exchange route needs, or null.
 *
 * Non-empty configuration strings are not the same claim as a working
 * deployment: an unreadable A2A_REPLAY_DIR, an authority file that fails its
 * path checks, or an environment where bounded-exchange cannot be required all
 * pass the string check and fail here. Callers that only need the authority
 * still construct the stores, because reachability -- not the authority alone
 * -- is what they are asking about.
 *
 * The evaluator and its replay owner are required here rather than at module
 * load, because they reach lib/v5, which package.json deliberately does not
 * publish (test/kernel-facade-contract.test.js forbids it). A top-level
 * require would make the installed tarball's server.js unloadable. Deferring
 * it keeps A2A a deployment surface without turning the V5 modules into
 * published API, and an unconfigured or unpublished environment simply gets
 * no route.
 */
function constructA2aBoundaryDependencies(paths) {
  if (!paths) return null;
  try {
    const { evaluateBoundedExchange } = require('./bounded-exchange');
    const { evaluateAgentActionFirewall } = require('../agent-action-firewall');
    const { createA2aReplayStore } = require('./replay-store');
    const { createA2aTaskStore } = require('./task-store');
    const { createA2aDelegationAuditLog } = require('./delegation-audit-log');
    const authority = readReceiverAuthority(paths.authorityFile);
    // Read the receiver clock exactly once per request from the authority,
    // never from the payload. Holding the parsed authority means an operator
    // edit needs a restart, which is the same lifetime the trusted-key set
    // already has.
    if (!authority || typeof authority !== 'object' || Array.isArray(authority)) return null;
    const replay = createA2aReplayStore(paths.replayDirectory);
    // Same directory: a task record is the accounting half of a reservation,
    // not a separate subsystem with its own lifetime.
    const tasks = createA2aTaskStore(paths.replayDirectory);
    // #1891: the audit half of the same exchange, sharing this directory for
    // the reason the task store already does.
    const delegationAudit = createA2aDelegationAuditLog(paths.replayDirectory);
    return Object.freeze({
      authority,
      replay,
      tasks,
      delegationAudit,
      evaluateBoundedExchange,
      evaluateAgentActionFirewall,
    });
  } catch (_) {
    return null;
  }
}

/**
 * Resolve the boundary once, at construction.
 *
 * A misconfigured deployment must not produce a route that answers some
 * requests and fails others: either the authority and replay directory are
 * both usable, or the route reports itself unavailable for every request.
 */
function createA2aExchangeBoundary(options = {}) {
  const dependencies = constructA2aBoundaryDependencies(resolveA2aBoundaryPaths(options));
  if (!dependencies) return null;
  const {
    authority, replay, tasks, delegationAudit,
    evaluateBoundedExchange, evaluateAgentActionFirewall,
  } = dependencies;

  const handle = createA2aExchangeHandler({
    authority, replay, tasks, evaluateBoundedExchange, evaluateAgentActionFirewall, recordDelegation,
  });

  return Object.freeze({ path: A2A_EXCHANGE_PATH, handle, route, readDelegationAudit });

  /**
   * #1891: read back the delegation trail this boundary wrote.
   *
   * Exposed on the boundary rather than left as a directory an operator has to
   * know the layout of, and kept read-only: nothing here can amend a row.
   */
  function readDelegationAudit(options) {
    return delegationAudit.read(options);
  }

  /**
   * #1891: write one row for this exchange, admitted or refused.
   *
   * Called after the decision rather than inside the effect: the effect's
   * throw path is the replay marker's, and an audit write must not be able to
   * leave a reservation standing. `append` swallows its own failures, so this
   * returns nothing and no caller branches on it.
   */
  function recordDelegation(request, decision, reason, taskId) {
    delegationAudit.append({
      request,
      outcome: decision === 'allow' ? DELEGATION_OUTCOMES.ADMITTED : DELEGATION_OUTCOMES.REFUSED,
      decision,
      reason,
      taskId,
    });
  }

  /**
   * Router form, so server.js delegates instead of growing a handler: it
   * returns false for every other path and writes the whole response itself.
   */
  async function route(req, res, reqUrl) {
    if (reqUrl.pathname !== A2A_EXCHANGE_PATH) return false;
    const descriptor = await handle(req, readJsonBody);
    writeJson(req, res, descriptor.statusCode, descriptor.body, { 'Cache-Control': 'no-store' });
    return true;
  }
}

module.exports = Object.freeze({
  A2A_EXCHANGE_PATH,
  A2A_ROUTE_ERRORS,
  MAX_BODY_BYTES,
  REQUEST_TIMEOUT_MS,
  CANONICAL_WORKSPACE,
  createA2aExchangeBoundary,
  readReceiverAuthority,
  resolveA2aBoundaryPaths,
  constructA2aBoundaryDependencies,
  evaluateA2aAgentActionFirewall,
  buildFirewallReceiptMetadata,
});
