'use strict';

/**
 * The task read route (P0-E): `GET /api/a2a/tasks/{taskId}`.
 *
 * This is the half that makes at-most-once usable. `lib/a2a/bounded-exchange.js`
 * refuses a replayed exchange and, when an effect fails, deliberately leaves the
 * reservation standing so the request is never retried. Correct, but until now a
 * caller that lost its response had no way to find out what happened -- its only
 * move was to resend, and its only answer was `replay_detected`.
 *
 * So: resending is still refused, and asking is now answered. The route is
 * read-only by construction; nothing here reserves, completes or mutates
 * anything.
 *
 * `unknown` is a real answer, not a soft error. It means the exchange was
 * reserved and this receiver cannot account for its effect, and it will never
 * become `completed` afterwards. It is served with 200 for that reason: the
 * lookup succeeded, and the honest state is unknown. A 5xx would invite the
 * retry the whole design is avoiding.
 */

const { readCompatibleEnvironmentVariable } = require('../environment-compat');
const { writeJson } = require('../server-response-helpers');
const { TASK_STATES } = require('./task-store');

const A2A_TASK_PATH_PREFIX = '/api/a2a/tasks/';

const TASK_ROUTE_ERRORS = Object.freeze({
  METHOD: 'a2a_task_method_not_allowed',
  NOT_FOUND: 'a2a_task_not_found',
});

function createTaskReadBoundary(options = {}) {
  const configured = options.authorityFile !== undefined || options.replayDirectory !== undefined;
  const authorityFile = configured
    ? (options.authorityFile || '')
    : (readCompatibleEnvironmentVariable('A2A_AUTHORITY_FILE') || '');
  const replayDirectory = configured
    ? (options.replayDirectory || '')
    : (readCompatibleEnvironmentVariable('A2A_REPLAY_DIR') || '');
  if (!authorityFile || !replayDirectory) return null;

  let tasks;
  try {
    const { createA2aTaskStore } = require('./task-store');
    tasks = createA2aTaskStore(replayDirectory);
  } catch (_) {
    return null;
  }

  return Object.freeze({ path: A2A_TASK_PATH_PREFIX, handle, route });

  function route(req, res, reqUrl) {
    if (!reqUrl.pathname.startsWith(A2A_TASK_PATH_PREFIX)) return false;
    const descriptor = handle(req, reqUrl);
    writeJson(req, res, descriptor.statusCode, descriptor.body, { 'Cache-Control': 'no-store' });
    return true;
  }

  function handle(req, reqUrl) {
    if (String(req.method || '').toUpperCase() !== 'GET') {
      return refusal(405, TASK_ROUTE_ERRORS.METHOD);
    }

    const taskId = reqUrl.pathname.slice(A2A_TASK_PATH_PREFIX.length);
    let record;
    try {
      record = tasks.readTask(taskId);
    } catch (_) {
      // A store this process cannot read must not report a task as absent: an
      // absent task reads as "never happened", which is a stronger claim than
      // this receiver can make right now.
      return refusal(503, TASK_ROUTE_ERRORS.NOT_FOUND);
    }

    if (record.state === TASK_STATES.NOT_FOUND) {
      return refusal(404, TASK_ROUTE_ERRORS.NOT_FOUND);
    }
    if (record.state === TASK_STATES.UNKNOWN) {
      return Object.freeze({
        statusCode: 200,
        body: Object.freeze({ taskId: record.taskId, state: TASK_STATES.UNKNOWN }),
      });
    }
    return Object.freeze({
      statusCode: 200,
      body: Object.freeze({
        taskId: record.taskId,
        state: TASK_STATES.COMPLETED,
        effect: record.effect,
      }),
    });
  }
}

function refusal(statusCode, reason) {
  return Object.freeze({
    statusCode,
    body: Object.freeze({ decision: 'block', reason }),
  });
}

module.exports = Object.freeze({
  A2A_TASK_PATH_PREFIX,
  TASK_ROUTE_ERRORS,
  createTaskReadBoundary,
});
