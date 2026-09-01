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

const fs = require('node:fs');
const path = require('node:path');

const { readCompatibleEnvironmentVariable } = require('../environment-compat');
const { readJsonBody } = require('../../requestGuards');
const { writeJson } = require('../server-response-helpers');

const { classifyEvaluatorReason, classifyTransportRefusal } = require('./retry-classification');
// How long this route waits for a request to arrive in full (P0-F). Taken from
// the Agent Card so the advertised deadline and the enforced one are one value.
// It is applied to the socket rather than through `readJsonBody`, which has no
// timeout option: adding one there would change a helper every other route in
// the process shares, for the sake of this one. A stalled upload is dropped
// before the evaluator is ever called, so a timed-out request provably never
// reserved.
const { REQUEST_TIMEOUT_MS } = require('./agent-card');

const MAX_BODY_BYTES = 1024 * 1024;
const CANONICAL_WORKSPACE = 'default';
const A2A_EXCHANGE_PATH = '/api/a2a/exchange';

/**
 * Reason codes this module adds on top of the evaluator's own vocabulary.
 *
 * They describe transport-level refusals only. Every trust decision keeps the
 * evaluator's reason, unmodified, so a rejected exchange reads the same here as
 * it does in the conformance report.
 */
const A2A_ROUTE_ERRORS = Object.freeze({
  METHOD: 'a2a_method_not_allowed',
  BODY: 'a2a_request_body_invalid',
  WORKSPACE: 'a2a_workspace_not_canonical',
  UNAVAILABLE: 'a2a_exchange_unavailable',
});

const A2A_FIREWALL_POLICY_MISSING = 'A2A_DELEGATED_POLICY_MISSING';

function resolveDelegatedPolicy(request, authority) {
  const sourceRef = String(request?.source?.identityRef || '');
  const source = Array.isArray(authority?.identities)
    ? authority.identities.find((entry) => entry && entry.ref === sourceRef)
    : null;
  const policyVersion = String(source?.record?.policy_version || '').trim();
  const constraints = request?.constraints;
  if (!policyVersion || !constraints || !Array.isArray(constraints.allowedTools)
      || !Array.isArray(constraints.allowedConnectors)) return null;
  return Object.freeze({
    policyVersion,
    workspaceId: String(request.workspaceId || ''),
    maxRiskTier: String(constraints.maxRiskTier || ''),
    allowedTools: Object.freeze([...constraints.allowedTools]),
    allowedConnectors: Object.freeze([...constraints.allowedConnectors]),
  });
}

function missingPolicyDecision(request) {
  return {
    ok: false,
    allowed: false,
    canExecute: false,
    canDryRun: false,
    decision: 'block',
    reason: A2A_FIREWALL_POLICY_MISSING,
    risk: { level: 'critical', score: 1, categories: ['a2a-policy'] },
    requiredReview: true,
    dryRunOnly: false,
    findings: [],
    warnings: [],
    metadata: {
      workspaceId: String(request?.workspaceId || CANONICAL_WORKSPACE),
      surface: 'a2a',
    },
  };
}

function evaluateA2aAgentActionFirewall(request, authority, evaluateAgentActionFirewall) {
  const policy = resolveDelegatedPolicy(request, authority);
  if (!policy) return missingPolicyDecision(request);
  const task = request.requestedAction;
  return evaluateAgentActionFirewall({
    surface: 'a2a',
    tool: task.tool,
    action: task.capability,
    input: {
      operationType: task.capability,
      action: task.capability,
      target: task.target,
      connector: task.connector,
      parametersHash: task.parametersHash,
      task,
      policy,
    },
    context: {
      workspaceId: request.workspaceId,
      actor: `agent:${request.source.agentId}`,
      target: task.target,
    },
    policyOverride: policy,
  });
}

function buildFirewallReceiptMetadata(request, decision, authority) {
  const policy = resolveDelegatedPolicy(request, authority);
  const metadata = decision && typeof decision.metadata === 'object' ? decision.metadata : {};
  return Object.freeze({
    decision: String(decision?.decision || 'block'),
    reason: String(decision?.reason || 'AGENT_ACTION_FIREWALL_EVALUATION_FAILED'),
    firewallVersion: String(metadata.firewallVersion || ''),
    policyVersion: String(metadata.policyVersion || policy?.policyVersion || ''),
    actionId: String(metadata.actionId || ''),
    workspaceId: String(request?.workspaceId || CANONICAL_WORKSPACE),
    sourceAgentId: String(request?.source?.agentId || ''),
    targetAgentId: String(request?.target?.agentId || ''),
    task: request?.requestedAction || null,
    policy,
  });
}

function sameResolvedPath(left, right) {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Read the receiver-owned authority from an absolute, non-symlinked file.
 *
 * The path checks are the harness consumer's, kept rather than simplified: the
 * authority decides which keys are trusted, so a symlinked parent directory is
 * a way to swap the trust root without touching the configured path.
 */
function readReceiverAuthority(authorityFile) {
  if (!authorityFile || !path.isAbsolute(authorityFile)) throw new Error('absolute receiver authority required');
  const resolved = path.resolve(authorityFile);
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent);
  const parentReal = fs.realpathSync.native(parent);
  const stat = fs.lstatSync(resolved);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !sameResolvedPath(parentReal, parent)
      || !stat.isFile() || stat.isSymbolicLink() || !sameResolvedPath(fs.realpathSync.native(resolved), resolved)
      || stat.size < 1 || stat.size > MAX_BODY_BYTES) {
    throw new Error('receiver authority path is unsafe');
  }
  const bytes = fs.readFileSync(resolved);
  if (bytes.length !== stat.size) throw new Error('receiver authority changed during read');
  return JSON.parse(bytes.toString('utf8'));
}

/**
 * The configured paths both A2A boundaries are built from, or null.
 *
 * Shared rather than duplicated: the Agent Card advertises the exchange route,
 * so the two must agree on what "configured" means. A second copy of this
 * check that drifted would be a way to serve a card for a route that does not
 * exist (#1182).
 */
function resolveA2aBoundaryPaths(options = {}) {
  const configured = options.authorityFile !== undefined || options.replayDirectory !== undefined;
  const authorityFile = configured
    ? (options.authorityFile || '')
    : (readCompatibleEnvironmentVariable('A2A_AUTHORITY_FILE') || '');
  const replayDirectory = configured
    ? (options.replayDirectory || '')
    : (readCompatibleEnvironmentVariable('A2A_REPLAY_DIR') || '');
  if (!authorityFile || !replayDirectory) return null;
  return Object.freeze({ authorityFile, replayDirectory });
}

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
    return Object.freeze({ authority, replay, tasks, evaluateBoundedExchange, evaluateAgentActionFirewall });
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
  const { authority, replay, tasks, evaluateBoundedExchange, evaluateAgentActionFirewall } = dependencies;

  return Object.freeze({ path: A2A_EXCHANGE_PATH, handle, route });

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

  async function handle(req, readBody) {
    if (String(req.method || '').toUpperCase() !== 'POST') {
      return refusal(405, A2A_ROUTE_ERRORS.METHOD);
    }

    // Bound the read before it starts. A caller that stalls mid-body holds a
    // connection open otherwise, and the deadline has to be enforced rather
    // than only declared in the Agent Card.
    if (typeof req.setTimeout === 'function') req.setTimeout(REQUEST_TIMEOUT_MS);

    let read;
    try {
      read = await readBody(req, { maxBytes: MAX_BODY_BYTES });
    } catch (_) {
      return refusal(400, A2A_ROUTE_ERRORS.BODY);
    }
    // Body-level refusals keep their own status (413 for oversize, 415 for a
    // wrong content type) but never their own body shape: every response from
    // this route is a decision/reason pair.
    if (!read || read.ok !== true) {
      return refusal(Number(read && read.status) || 400, A2A_ROUTE_ERRORS.BODY);
    }
    const body = read.data;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return refusal(400, A2A_ROUTE_ERRORS.BODY);
    }

    // The envelope carries its own workspaceId and the evaluator binds it to
    // the identity records. This check is the route's separate promise that
    // P0-B serves the canonical workspace only, so a non-default exchange is
    // refused before any verification work happens.
    if (body.workspaceId !== undefined && body.workspaceId !== CANONICAL_WORKSPACE) {
      return refusal(400, A2A_ROUTE_ERRORS.WORKSPACE);
    }

    // The evaluator computes the replay key itself and calls `effect()` with
    // no arguments, so the key is captured on its way into the reservation
    // rather than recomputed here. Recomputing would mean a second copy of
    // `replayKeyMaterial`, and a task id derived from a key that had drifted
    // from the real one would point at nothing.
    //
    // It is declared out here, rather than inside the try, because a refusal
    // needs it too: a caller told not to retry has to be told where to look
    // instead (P0-E), and that pointer is only derivable from this key.
    let replayKey = '';
    let firewallDecision = null;
    let result;
    try {
      result = evaluateBoundedExchange({
        request: body,
        authority,
        evaluationTime: authority.evaluationTime,
        replayReserve: (record) => {
          replayKey = String(record && record.replayKey) || '';
          return replay.reserve(record);
        },
        admission: (verifiedRequest) => {
          firewallDecision = evaluateA2aAgentActionFirewall(
            verifiedRequest,
            authority,
            evaluateAgentActionFirewall,
          );
          return firewallDecision;
        },
        // P0-B admits an exchange; it performs no product mutation. The effect
        // still has to run inside the evaluator so that the replay reservation
        // and the admission stay one decision rather than two.
        //
        // P0-E writes the task record here, inside the effect, for the same
        // reason: if the record cannot be written the exchange is not accounted
        // for, and an unaccounted exchange must read as unknown rather than as
        // a success. A throw here leaves the reservation standing, which is
        // exactly the `effect_failure_keeps_replay_marker` behaviour.
        effect: () => {
          const admitted = Object.freeze({
            admitted: true,
            exchangeId: String(body.exchangeId || ''),
            evaluatedAt: authority.evaluationTime,
            taskId: tasks.taskIdForReplayKey(replayKey),
            receiptMetadata: buildFirewallReceiptMetadata(body, firewallDecision, authority),
          });
          tasks.recordCompletion(replayKey, admitted);
          return admitted;
        },
      });
    } catch (_) {
      // The evaluator is written not to throw, and its own catch returns
      // verification_failed. This is the belt to that braces: an unexpected
      // throw must not become a 500 that a caller can distinguish from a
      // refusal.
      return evaluatorRefusal('verification_failed', replayKey, tasks);
    }

    if (!result || result.decision !== 'allow') {
      if (result && result.firewall) {
        return firewallRefusal(body, result.firewall, authority);
      }
      return evaluatorRefusal((result && result.reason) || 'verification_failed', replayKey, tasks);
    }
    return Object.freeze({
      statusCode: 200,
      body: Object.freeze({
        decision: 'allow',
        reason: result.reason,
        effect: result.effect,
      }),
    });
  }
}

function firewallRefusal(request, decision, authority) {
  return Object.freeze({
    statusCode: 403,
    body: Object.freeze({
      decision: String(decision.decision || 'block'),
      reason: String(decision.reason || 'AGENT_ACTION_FIREWALL_EVALUATION_FAILED'),
      safeToRetry: true,
      receiptMetadata: buildFirewallReceiptMetadata(request, decision, authority),
    }),
  });
}

/**
 * A refusal decided before the evaluator ran, so no reservation can exist.
 * Safe to retry is a structural fact here, not a judgement about the reason.
 */
function refusal(statusCode, reason) {
  return Object.freeze({
    statusCode,
    body: Object.freeze({ decision: 'block', reason, safeToRetry: classifyTransportRefusal() }),
  });
}

/**
 * A refusal carrying the evaluator's own reason.
 *
 * When it is not safe to retry, the caller is handed the task id instead of
 * being left with resending as its only move -- that pointer is the whole
 * reason P0-E exists, and withholding it here would leave a caller correctly
 * told "do not retry" and given nothing to do about it.
 *
 * The id is derived only from a key that was actually captured. An exchange
 * refused before the reserve call has no key and therefore no task, and
 * inventing one would point at a record that does not exist.
 */
function evaluatorRefusal(reason, replayKey, tasks) {
  const safeToRetry = classifyEvaluatorReason(reason);
  const body = { decision: 'block', reason, safeToRetry };
  if (!safeToRetry && replayKey) {
    try {
      body.taskId = tasks.taskIdForReplayKey(replayKey);
    } catch (_) {
      // A pointer this route cannot derive is simply absent. It is an aid, not
      // part of the refusal, and a broken one would be worse than none.
    }
  }
  return Object.freeze({ statusCode: 403, body: Object.freeze(body) });
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
