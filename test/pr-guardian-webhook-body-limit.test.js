'use strict';

/**
 * An oversized webhook body must produce the 413 the route promises, not a
 * destroyed socket.
 *
 * readRawBody used to call req.destroy() on overflow, so the connection was
 * gone before the route could write its 413 and the client saw ECONNRESET.
 * requestGuards.readJsonBody had already fixed exactly this (#749); the webhook
 * reader kept the old behaviour, making the same size limit behave differently
 * depending on which door a request came through.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

const { createPrGuardianRoutes, WEBHOOK_PATHNAME } = require('../lib/http/pr-guardian-routes');

const WEBHOOK_SECRET = 'webhook-secret';

function makeRequest(headers = {}) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = { 'x-github-event': 'issue_comment', ...headers };
  req.destroyed = false;
  req.destroy = () => { req.destroyed = true; };
  return req;
}

function makeRoutes() {
  return createPrGuardianRoutes({
    operatorToken: 'operator-secret',
    webhookSecret: WEBHOOK_SECRET,
    getApprovalStore: () => ({ saveToolApprovalIfAbsent: () => ({}) }),
    parseJsonRequest: async () => ({}),
    writeJson: (req, res, status, body) => {
      res.captured = { status, body };
    },
  });
}

function post(req) {
  const res = {};
  const routed = makeRoutes().route(req, res, new URL(`http://127.0.0.1${WEBHOOK_PATHNAME}`));
  return { res, routed };
}

test('an oversized webhook body answers 413 instead of resetting the connection', async () => {
  const req = makeRequest();
  const { res, routed } = post(req);

  req.emit('data', Buffer.alloc(1_000_001, 0x61));
  const handled = await routed;

  assert.equal(handled, true);
  assert.equal(res.captured.status, 413, 'the caller must receive the policy answer');
  assert.equal(res.captured.body.error.code, 'REQUEST_TOO_LARGE');
  assert.equal(req.destroyed, false, 'the socket must stay open long enough to write the response');
});

test('further chunks and a late error do not change the settled 413', async () => {
  const req = makeRequest();
  const { res, routed } = post(req);

  req.emit('data', Buffer.alloc(1_000_001, 0x61));
  req.emit('data', Buffer.alloc(4_000, 0x62));
  req.emit('error', new Error('peer gave up'));
  const handled = await routed;

  assert.equal(handled, true);
  assert.equal(res.captured.status, 413, 'a late error must not downgrade the 413 to a 400');
  assert.equal(res.captured.body.error.code, 'REQUEST_TOO_LARGE');
});

test('a body within the limit is still read and verified normally', async () => {
  const payload = JSON.stringify({ action: 'created' });
  const signature = `sha256=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(Buffer.from(payload)).digest('hex')}`;
  const req = makeRequest({ 'x-hub-signature-256': signature });
  const { res, routed } = post(req);

  req.emit('data', Buffer.from(payload));
  req.emit('end');
  await routed;

  // The signature matched, so the request got past the body reader; what it
  // fails on next is the payload shape, not the read.
  assert.notEqual(res.captured.status, 413);
  assert.notEqual(res.captured.status, 401);
});

test('a bad signature is still rejected with 401, not a body error', async () => {
  const req = makeRequest({ 'x-hub-signature-256': 'sha256=deadbeef' });
  const { res, routed } = post(req);

  req.emit('data', Buffer.from('{"action":"created"}'));
  req.emit('end');
  await routed;

  assert.equal(res.captured.status, 401);
  assert.equal(res.captured.body.error.code, 'WEBHOOK_SIGNATURE_INVALID');
});
