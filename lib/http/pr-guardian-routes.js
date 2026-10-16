'use strict';

const { readCompatibleEnvironmentVariable } = require('../environment-compat');
const { ACTIONS } = require('../pr-guardian/policy');
const { createReviewService } = require('../pr-guardian/review-service');
const { createGitHubRestClient } = require('../pr-guardian/github-client');
const { text, operatorAuthorized, verifySignature } = require('./pr-guardian-auth');
const { write, getHeader } = require('./pr-guardian-body');
const { createPrGuardianWebhookRoute } = require('./pr-guardian-webhook-route');
const { UI_PATHNAME, createPrGuardianUiRoute } = require('./pr-guardian-ui-route');
const REVIEWS_PATHNAME = '/api/v2/pr-guardian/reviews';
const DRY_RUN_PATHNAME = '/api/v2/pr-guardian/dry-run';
const WEBHOOK_PATHNAME = '/api/v2/pr-guardian/webhooks/github';
const DECISION_PATTERN = /^\/api\/v2\/pr-guardian\/reviews\/([^/]+)\/decision$/;
const EXECUTE_PATTERN = /^\/api\/v2\/pr-guardian\/reviews\/([^/]+)\/execute$/;
const OPERATOR_TOKEN_HEADER = 'x-huqan-operator-token';
const SIGNATURE_HEADER = 'x-hub-signature-256';

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
  const logWebhookFailure = typeof options.logWebhookFailure === 'function'
    ? options.logWebhookFailure
    : (entry) => console.warn('[pr-guardian webhook]', JSON.stringify(entry));

  function fail(req, res, status, code, message) {
    write(writeJson,req, res, status, { ok: false, status: 'failed', error: { code, message } });
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

  const routeUi = createPrGuardianUiRoute({ fail });
  const routeWebhook = createPrGuardianWebhookRoute({
    webhookSecret,
    signatureHeader: SIGNATURE_HEADER,
    staticClient,
    service,
    write: (req, res, status, payload) => write(writeJson, req, res, status, payload),
    fail,
    logWebhookFailure,
  });

  async function route(req, res, reqUrl) {
    const pathname = String(reqUrl?.pathname || '');
    const decisionMatch = pathname.match(DECISION_PATTERN);
    const executeMatch = pathname.match(EXECUTE_PATTERN);

    if (pathname === UI_PATHNAME) {
      if (!routesEnabled) return false;
      return routeUi(req, res);
    }

    if (pathname === WEBHOOK_PATHNAME) {
      if (!webhookEnabled) return false;
      return routeWebhook(req, res);
    }

    if (!routesEnabled) return false;
    if (pathname !== REVIEWS_PATHNAME && pathname !== DRY_RUN_PATHNAME && !decisionMatch && !executeMatch) return false;
    if (!authorizedOperator(req)) {
      fail(req, res, 403, 'OPERATOR_AUTH_REQUIRED', `Present ${OPERATOR_TOKEN_HEADER}.`);
      return true;
    }

    const workspaceId = text(reqUrl.searchParams.get('workspaceId')) || 'default';

    if (pathname === REVIEWS_PATHNAME && req.method === 'GET') {
      const limit = Math.min(100, Math.max(1, Number(reqUrl.searchParams.get('limit')) || 50));
      // One service, one read. The previous shape called service().list(limit)
      // twice, so the count could come from a different snapshot than the rows
      // it counted -- a client seeing reviews.length !== total would read that
      // as "there are more records" when it was only two reads racing. The
      // count is also capped by `limit`, so it was never a grand total;
      // `returned` and `limit` say what the values actually are.
      const reviews = service().list(limit, workspaceId);
      write(writeJson,req, res, 200, { ok: true, status: 'completed', data: { reviews, returned: reviews.length, limit } });
      return true;
    }

    if (pathname === REVIEWS_PATHNAME && req.method === 'POST') {
      const body = await parseJsonRequest(req, res, { maxBytes: 1_000_000 });
      if (!body) return true;
      try {
        const result = service().enqueue(body, { action: body.action || ACTIONS.COMMENT_CREATE, requestedBy: 'review-console' });
        write(writeJson,req, res, result.decision === 'block' ? 409 : 202, result);
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
        const result = service().decide(id, text(body.decision).toLowerCase(), text(body.reason), workspaceId);
        write(writeJson,req, res, result.status || (result.ok ? 200 : 400), result);
      } else {
        const result = await service().execute(id, {
          action: body.action,
          body: body.body,
          githubClient: staticClient,
          operatorToken,
          workspaceId,
        });
        write(writeJson,req, res, result.status || (result.ok ? 200 : 400), result);
      }
      return true;
    }

    if (pathname === DRY_RUN_PATHNAME && req.method === 'POST') {
      const body = await parseJsonRequest(req, res, { maxBytes: 1_000_000 });
      if (!body) return true;
      try {
        const result = service().dryRun(body, { action: body.action || ACTIONS.STATUS_PREVIEW });
        write(writeJson,req, res, 200, result);
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
