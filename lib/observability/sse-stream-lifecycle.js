'use strict';

// SSE stream lifecycle for the observability HTTP router (#2235).
//
// Single responsibility: everything that happens after the router has
// authorized the workspace and acquired the stream rate-limit slot —
// response headers, the ready event, subscription with exact-workspace
// filtering, the keep-alive timer, and idempotent close cleanup.
// Auth, workspace validation, rate limiting and the unavailable-service
// error path stay in http-router.js; this module is never a second
// authority for them (ARCH-001).

const STREAM_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
  'X-Content-Type-Options': 'nosniff',
});

const KEEP_ALIVE_INTERVAL_MS = 25_000;

function openSseStream({ req, res, service, workspaceId, rate }) {
  if (!req || typeof req.once !== 'function') throw new TypeError('req with once is required');
  if (!res || typeof res.writeHead !== 'function' || typeof res.write !== 'function') {
    throw new TypeError('res with writeHead/write is required');
  }
  if (!service || typeof service.subscribe !== 'function') throw new TypeError('service with subscribe is required');
  if (typeof workspaceId !== 'string' || !workspaceId) throw new TypeError('workspaceId is required');
  if (!rate || typeof rate.release !== 'function') throw new TypeError('rate with release is required');

  res.writeHead(200, STREAM_HEADERS);
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, workspaceId })}\n\n`);
  const unsubscribe = service.subscribe(event => {
    if (event.workspaceId !== workspaceId || res.writableEnded) return;
    res.write(`event: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
  }, { workspaceId });
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, KEEP_ALIVE_INTERVAL_MS);
  keepAlive.unref?.();
  const close = () => {
    clearInterval(keepAlive);
    unsubscribe();
    rate.release();
  };
  req.once('close', close);
  res.once('close', close);
  return close;
}

module.exports = { STREAM_HEADERS, KEEP_ALIVE_INTERVAL_MS, openSseStream };
