'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { constantTimeEqual: sharedConstantTimeEqual } = require('../../requestGuards');
const { readCompatibleEnvironmentVariable } = require('../environment-compat');
const { ACTIONS } = require('../pr-guardian/policy');
const { createReviewService } = require('../pr-guardian/review-service');
const { createGitHubRestClient } = require('../pr-guardian/github-client');

const UI_PATHNAME = '/pr-guardian';
const REVIEWS_PATHNAME = '/api/v2/pr-guardian/reviews';
const DRY_RUN_PATHNAME = '/api/v2/pr-guardian/dry-run';
const WEBHOOK_PATHNAME = '/api/v2/pr-guardian/webhooks/github';
const DECISION_PATTERN = /^\/api\/v2\/pr-guardian\/reviews\/([^/]+)\/decision$/;
const EXECUTE_PATTERN = /^\/api\/v2\/pr-guardian\/reviews\/([^/]+)\/execute$/;
const OPERATOR_TOKEN_HEADER = 'x-huqan-operator-token';
const SIGNATURE_HEADER = 'x-hub-signature-256';
const NO_STORE = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});
const UI_FILE = path.join(__dirname, '..', '..', 'public', 'pr-guardian', 'index.html');

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value == null ? '' : value).trim();
}

/**
 * For the fixed-length HMAC comparison in verifySignature only.
 *
 * Both operands there are `sha256=` plus 64 hex characters, so the length check
 * describes the format rather than leaking a secret. It is deliberately not
 * used for the operator token below, whose length is secret (#1038).
 */
function constantTimeEqual(left, right) {
  const a = Buffer.from(text(left));
  const b = Buffer.from(text(right));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function operatorAuthorized(configuredToken, presentedToken) {
  if (!text(configuredToken) || !text(presentedToken)) return false;
  // The shared helper hashes both sides, so a variable-length secret's length
  // does not reach the timing of this call.
  return sharedConstantTimeEqual(text(configuredToken), text(presentedToken));
}

function verifySignature(secret, rawBody, signature) {
  if (!text(secret) || !text(signature)) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return constantTimeEqual(expected, signature);
}

function readRawBody(req, { maxBytes = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error('Request body too large');
        error.code = 'REQUEST_TOO_LARGE';
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseBody(rawBody) {
  try { return JSON.parse(rawBody.toString('utf8')); } catch (_) { return null; }
}

function write(writeJson, req, res, status, payload) {
  writeJson(req, res, status, payload, NO_STORE);
}

function getHeader(req, name) {
  const value = req?.headers?.[name];
  return typeof value === 'string' ? value : '';
}

function createPrGuardianRoutes(options = {}) {
  const {
    getApprovalStore,
    parseJsonRequest,
    writeJson,
    getCurrentSnapshot,
    githubClient,
  } = options;
  const operatorToken = options.operatorToken !== undefined
    ? options.operatorToken
    : (readCompatibleEnvironmentVariable('MCP_OPERATOR_TOKEN') || '');
  const webhookSecret = options.webhookSecret !== undefined
    ? options.webhookSecret
    : (readCompatibleEnvironmentVariable('GITHUB_APP_WEBHOOK_SECRET') || '');
  const routesEnabled = Boolean(operatorToken && getApprovalStore && parseJsonRequest && writeJson);
  const webhookEnabled = Boolean(webhookSecret && getApprovalStore && writeJson);
  // The server does not infer a GitHub credential from an undeclared environment
  // variable. Hosts must inject a client explicitly; otherwise webhook ingest and
  // Review Console remain read-only and execution fails closed.
  const staticClient = githubClient || null;

  function fail(req, res, status, code, message) {
    write(writeJson, req, res, status, { ok: false, status: 'failed', error: { code, message } });
  }

  function service() {
    const store = getApprovalStore();
    return createReviewService({
      storage: store,
      getCurrentSnapshot: getCurrentSnapshot || (staticClient ? snapshot => staticClient.getPullRequestSnapshot(snapshot.repo, snapshot.number, {
        workspaceId: snapshot.workspaceId,
        deliveryId: snapshot.deliveryId,
      }) : null),
    });
  }

  function authorizedOperator(req) {
    return operatorAuthorized(operatorToken, getHeader(req, OPERATOR_TOKEN_HEADER));
  }

  async function route(req, res, reqUrl) {
    const pathname = String(reqUrl?.pathname || '');
    const decisionMatch = pathname.match(DECISION_PATTERN);
    const executeMatch = pathname.match(EXECUTE_PATTERN);

    if (pathname === UI_PATHNAME) {
      if (req.method !== 'GET') { fail(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed'); return true; }
      try {
        const html = readFileSync(UI_FILE);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        res.end(html);
      } catch (_) {
        fail(req, res, 503, 'PR_GUARDIAN_UI_UNAVAILABLE', 'Review Console UI is unavailable.');
      }
      return true;
    }

    if (pathname === WEBHOOK_PATHNAME) {
      if (!webhookEnabled) return false;
      if (req.method !== 'POST') { fail(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed'); return true; }
      let rawBody;
      try { rawBody = await readRawBody(req); } catch (error) {
        fail(req, res, error.code === 'REQUEST_TOO_LARGE' ? 413 : 400, error.code || 'WEBHOOK_BODY_INVALID', 'Webhook body could not be read.');
        return true;
      }
      if (!verifySignature(webhookSecret, rawBody, getHeader(req, SIGNATURE_HEADER))) {
        fail(req, res, 401, 'WEBHOOK_SIGNATURE_INVALID', 'GitHub webhook signature is invalid.');
        return true;
      }
      const body = parseBody(rawBody);
      const event = text(getHeader(req, 'x-github-event'));
      if (!body || event !== 'pull_request' || !body.pull_request || !body.repository?.full_name) {
        write(writeJson, req, res, 202, { ok: true, status: 'ignored', reason: 'unsupported_github_event' });
        return true;
      }
      try {
        const snapshot = await (staticClient?.getPullRequestSnapshot
          ? staticClient.getPullRequestSnapshot(body.repository.full_name, body.pull_request.number, {
              workspaceId: `github:${body.repository.full_name}`,
              deliveryId: getHeader(req, 'x-github-delivery'),
            })
          : {
              repo: body.repository.full_name,
              number: body.pull_request.number,
              title: body.pull_request.title,
              body: body.pull_request.body,
              baseRef: body.pull_request.base?.ref,
              headRef: body.pull_request.head?.ref,
              headSha: body.pull_request.head?.sha,
              actor: body.sender?.login,
              url: body.pull_request.html_url,
              workspaceId: `github:${body.repository.full_name}`,
              deliveryId: getHeader(req, 'x-github-delivery'),
            });
        const result = service().enqueue(snapshot, { action: ACTIONS.COMMENT_CREATE, requestedBy: `github-webhook:${event}` });
        write(writeJson, req, res, result.decision === 'block' ? 409 : 202, result);
      } catch (error) {
        fail(req, res, 400, error.code || 'PR_SNAPSHOT_INVALID', error.message || 'PR snapshot is invalid.');
      }
      return true;
    }

    if (!routesEnabled) return false;
    if (pathname !== REVIEWS_PATHNAME && pathname !== DRY_RUN_PATHNAME && !decisionMatch && !executeMatch) return false;
    if (!authorizedOperator(req)) {
      fail(req, res, 403, 'OPERATOR_AUTH_REQUIRED', `Present ${OPERATOR_TOKEN_HEADER}.`);
      return true;
    }

    if (pathname === REVIEWS_PATHNAME && req.method === 'GET') {
      const limit = Math.min(100, Math.max(1, Number(reqUrl.searchParams.get('limit')) || 50));
      write(writeJson, req, res, 200, { ok: true, status: 'completed', data: { reviews: service().list(limit), total: service().list(limit).length } });
      return true;
    }

    if (pathname === REVIEWS_PATHNAME && req.method === 'POST') {
      const body = await parseJsonRequest(req, res, { maxBytes: 1_000_000 });
      if (!body) return true;
      try {
        const result = service().enqueue(body, { action: body.action || ACTIONS.COMMENT_CREATE, requestedBy: 'review-console' });
        write(writeJson, req, res, result.decision === 'block' ? 409 : 202, result);
      } catch (error) {
        fail(req, res, 400, error.code || 'PR_SNAPSHOT_INVALID', error.message || 'PR snapshot is invalid.');
      }
      return true;
    }

    const match = decisionMatch || executeMatch;
    if (match) {
      if (req.method !== 'POST') { fail(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed'); return true; }
      let id;
      try { id = decodeURIComponent(match[1]); } catch (_) { id = ''; }
      if (!id) { fail(req, res, 400, 'PR_APPROVAL_ID_REQUIRED', 'Approval id is required.'); return true; }
      const body = await parseJsonRequest(req, res, { maxBytes: 256_000 });
      if (!body) return true;
      if (decisionMatch) {
        const result = service().decide(id, text(body.decision).toLowerCase(), text(body.reason));
        write(writeJson, req, res, result.status || (result.ok ? 200 : 400), result);
      } else {
        const result = await service().execute(id, {
          action: body.action,
          body: body.body,
          githubClient: staticClient,
          operatorToken,
        });
        write(writeJson, req, res, result.status || (result.ok ? 200 : 400), result);
      }
      return true;
    }

    if (pathname === DRY_RUN_PATHNAME && req.method === 'POST') {
      const body = await parseJsonRequest(req, res, { maxBytes: 1_000_000 });
      if (!body) return true;
      try {
        const result = service().dryRun(body, { action: body.action || ACTIONS.STATUS_PREVIEW });
        write(writeJson, req, res, 200, result);
      } catch (error) {
        fail(req, res, 400, error.code || 'PR_SNAPSHOT_INVALID', error.message || 'PR snapshot is invalid.');
      }
      return true;
    }

    fail(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    return true;
  }

  return Object.freeze({ route, routesEnabled, webhookEnabled });
}

function createPrGuardianBoundary(options = {}) {
  const routes = createPrGuardianRoutes(options);
  return Object.freeze({
    authContext: Object.freeze({
      prGuardianRouteEnabled: routes.routesEnabled,
      prGuardianWebhookEnabled: routes.webhookEnabled,
    }),
    async route(req, res, reqUrl) {
      return routes.route(req, res, reqUrl);
    },
  });
}

module.exports = Object.freeze({
  DECISION_PATTERN,
  DRY_RUN_PATHNAME,
  EXECUTE_PATTERN,
  OPERATOR_TOKEN_HEADER,
  REVIEWS_PATHNAME,
  SIGNATURE_HEADER,
  UI_PATHNAME,
  WEBHOOK_PATHNAME,
  createPrGuardianBoundary,
  createPrGuardianRoutes,
  operatorAuthorized,
  verifySignature,
});
