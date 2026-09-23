'use strict';

const { ACTIONS } = require('../pr-guardian/policy');
const { text, verifySignature } = require('./pr-guardian-auth');
const { readRawBody, parseBody, getHeader } = require('./pr-guardian-body');

function createPrGuardianWebhookRoute({
  webhookSecret,
  signatureHeader,
  staticClient,
  service,
  write,
  fail,
  logWebhookFailure,
}) {
  function webhookFail(req, res, status, code, message) {
    logWebhookFailure({ deliveryId: getHeader(req, 'x-github-delivery') || null, status, code });
    fail(req, res, status, code, message);
  }

  return async function routeWebhook(req, res) {
    if (req.method !== 'POST') {
      fail(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }

    let rawBody;
    try {
      rawBody = await readRawBody(req);
    } catch (error) {
      webhookFail(
        req,
        res,
        error.code === 'REQUEST_TOO_LARGE' ? 413 : 400,
        error.code || 'WEBHOOK_BODY_INVALID',
        'Webhook body could not be read.',
      );
      return true;
    }

    if (!verifySignature(webhookSecret, rawBody, getHeader(req, signatureHeader))) {
      webhookFail(req, res, 401, 'WEBHOOK_SIGNATURE_INVALID', 'GitHub webhook signature is invalid.');
      return true;
    }

    const body = parseBody(rawBody);
    const event = text(getHeader(req, 'x-github-event'));
    if (!body || event !== 'pull_request' || !body.pull_request || !body.repository?.full_name) {
      write(req, res, 202, { ok: true, status: 'ignored', reason: 'unsupported_github_event' });
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
      const result = service().enqueue(snapshot, {
        action: ACTIONS.COMMENT_CREATE,
        requestedBy: `github-webhook:${event}`,
      });
      write(req, res, result.decision === 'block' ? 409 : 202, result);
    } catch (error) {
      webhookFail(
        req,
        res,
        400,
        error.code || 'PR_SNAPSHOT_INVALID',
        error.message || 'PR snapshot is invalid.',
      );
    }
    return true;
  };
}

module.exports = { createPrGuardianWebhookRoute };
