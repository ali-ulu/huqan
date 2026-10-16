'use strict';

const crypto = require('node:crypto');
const {
  buildCanonicalReceiptPayload,
  hashCanonicalReceiptPayload,
} = require('./receipt/canonical-receipt');
const { safeBrowserDestination, persistExternalActionReceipt, createDurableExternalActionReceiptWriter } = require('./external-action-receipt');
const { argumentValue } = require('./gate-hook-input');

const OBSERVER_VERSION = 'huqan-browser-session-observer-v1';
const RECEIPT_KIND = 'browser_session_event_receipt';
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_DURATION_MS = 30_000;
const MAX_DURATION_MS = 60 * 60 * 1000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function boundedText(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function validateCdpEndpoint(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new TypeError('CDP endpoint is required');
  let url;
  try { url = new URL(raw.trim()); } catch (_) { throw new TypeError('CDP endpoint must be a valid URL'); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new TypeError('CDP endpoint must use http(s) or ws(s)');
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('CDP endpoint must be loopback-only');
  }
  if (url.username || url.password) throw new Error('CDP endpoint credentials are not accepted');
  return url;
}

function targetMetadata(target = {}) {
  return {
    targetIdHash: target.id ? sha256(target.id) : '',
    type: boundedText(target.type, 32) || 'page',
    destination: safeBrowserDestination(target.url) || null,
  };
}

async function resolvePageTarget(endpoint, options = {}) {
  const url = validateCdpEndpoint(endpoint);
  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    return { webSocketDebuggerUrl: url.toString(), metadata: { targetIdHash: sha256(url.pathname), type: 'page', destination: null } };
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable for CDP target discovery');
  const timeoutMs = options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
  const listUrl = new URL('/json/list', url.origin);
  const response = await fetchImpl(listUrl, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  if (!response.ok) throw new Error('CDP target discovery failed with HTTP ' + response.status);
  const targets = await response.json();
  if (!Array.isArray(targets)) throw new Error('CDP target discovery returned a non-array payload');
  const page = targets.find(item => item && item.type === 'page' && item.webSocketDebuggerUrl);
  if (!page) throw new Error('CDP target discovery found no page target');
  validateCdpEndpoint(page.webSocketDebuggerUrl);
  return { webSocketDebuggerUrl: page.webSocketDebuggerUrl, metadata: targetMetadata(page) };
}

function buildBrowserSessionReceipt(context, observation, options = {}) {
  const createdAt = typeof options.now === 'function' ? options.now() : new Date().toISOString();
  const sequence = Number.isFinite(options.sequence) ? options.sequence : 0;
  const sessionId = boundedText(context.sessionId, 200);
  const workspaceId = boundedText(context.workspaceId, 200) || 'default';
  const agentName = boundedText(context.agentName, 200) || 'browser-agent';
  const outcomeReceiptId = boundedText(context.outcomeReceiptId, 200);
  if (!sessionId) throw new TypeError('browser session id is required');
  const event = boundedText(observation.event, 80) || 'unknown';
  const receipt = {
    receiptId: 'browser_evt_' + sha256([sessionId, event, createdAt, sequence].join('|')).slice(0, 32),
    receiptKind: RECEIPT_KIND,
    decision: 'allow',
    status: 'observed',
    admissionId: outcomeReceiptId || ('browser-session:' + sessionId),
    workspaceId,
    actor: agentName,
    agentId: boundedText(context.agentId, 200),
    memoryDraftId: 'not_applicable',
    provenanceId: 'browser-session:' + sessionId,
    trustPolicyVersion: OBSERVER_VERSION,
    approvalId: 'not_applicable',
    approvalStatus: 'not_required',
    reason: 'browser_session_' + event,
    riskScore: 0,
    createdAt,
    metadata: {
      action: 'browser.' + event,
      sessionId,
      outcomeReceiptId,
      outcomeBinding: boundedText(context.outcomeBinding, 20) || (outcomeReceiptId ? 'reported' : 'none'),
      event,
      phase: boundedText(observation.phase, 80),
      destination: observation.destination || null,
      targetIdHash: boundedText(observation.targetIdHash, 64),
      targetType: boundedText(observation.targetType || observation.type, 32),
      requestIdHash: boundedText(observation.requestIdHash, 64),
      method: boundedText(observation.method, 20),
      resourceType: boundedText(observation.resourceType, 40),
      statusCode: Number.isFinite(observation.statusCode) ? observation.statusCode : null,
      consoleType: boundedText(observation.consoleType, 40),
      argumentCount: Number.isFinite(observation.argumentCount) ? observation.argumentCount : null,
      failed: observation.failed === true,
    },
  };
  const canonical = buildCanonicalReceiptPayload(receipt, { verdict: 'allow' });
  return Object.freeze({ ...canonical, receiptHash: hashCanonicalReceiptPayload(canonical) });
}

function observationFromCdpMessage(message) {
  const method = message && message.method;
  const params = message && message.params || {};
  if (method === 'Page.frameNavigated') {
    const frame = params.frame || {};
    return {
      event: 'navigate',
      phase: frame.parentId ? 'subframe' : 'top-frame',
      destination: safeBrowserDestination(frame.url) || null,
      targetIdHash: frame.id ? sha256(frame.id) : '',
    };
  }
  if (method === 'Page.domContentEventFired') return { event: 'dom', phase: 'content-ready' };
  if (method === 'Page.loadEventFired') return { event: 'load', phase: 'complete' };
  if (method === 'Runtime.consoleAPICalled') {
    return {
      event: 'console',
      phase: 'api-call',
      consoleType: boundedText(params.type, 40),
      argumentCount: Array.isArray(params.args) ? params.args.length : 0,
    };
  }
  if (method === 'Runtime.exceptionThrown') return { event: 'console', phase: 'exception', consoleType: 'error', argumentCount: 0, failed: true };
  if (method === 'Network.requestWillBeSent') {
    const request = params.request || {};
    return {
      event: 'network',
      phase: 'request',
      requestIdHash: params.requestId ? sha256(params.requestId) : '',
      method: boundedText(request.method, 20),
      resourceType: boundedText(params.type, 40),
      destination: safeBrowserDestination(request.url) || null,
    };
  }
  if (method === 'Network.responseReceived') {
    const response = params.response || {};
    return {
      event: 'network',
      phase: 'response',
      requestIdHash: params.requestId ? sha256(params.requestId) : '',
      resourceType: boundedText(params.type, 40),
      statusCode: Number.isFinite(response.status) ? response.status : null,
      destination: safeBrowserDestination(response.url) || null,
      failed: Number.isFinite(response.status) ? response.status >= 400 : false,
    };
  }
  if (method === 'Network.loadingFailed') {
    return {
      event: 'network',
      phase: 'failed',
      requestIdHash: params.requestId ? sha256(params.requestId) : '',
      resourceType: boundedText(params.type, 40),
      failed: true,
    };
  }
  return null;
}

function connectSocket(webSocketDebuggerUrl, options = {}) {
  const WebSocketClass = options.WebSocketClass || globalThis.WebSocket;
  if (typeof WebSocketClass !== 'function') return Promise.reject(new Error('global WebSocket is unavailable'));
  const timeoutMs = options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const socket = new WebSocketClass(webSocketDebuggerUrl);
    const timer = setTimeout(() => reject(new Error('CDP socket did not open in time')), timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(socket); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP socket failed to open')); }, { once: true });
  });
}

function attachTransport(socket, onObservation, options = {}) {
  let nextId = 0;
  const pending = new Map();
  const timeoutMs = options.commandTimeoutMs || DEFAULT_COMMAND_TIMEOUT_MS;
  const onMessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(String(message.error.message || 'CDP command failed')));
      else entry.resolve(message.result || {});
      return;
    }
    const observation = observationFromCdpMessage(message);
    if (observation) onObservation(observation);
  };
  const failPending = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('CDP socket closed'));
    }
    pending.clear();
  };
  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', failPending, { once: true });
  function send(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('CDP command timed out: ' + method));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  return { send, detach() { socket.removeEventListener('message', onMessage); failPending(); } };
}

async function observeBrowserSession(options = {}) {
  if (options.enabled !== true) throw new Error('browser session observation is opt-in; enabled=true is required');
  if (!options.receiptWriter) throw new TypeError('browser session observation requires a receipt writer');
  const workspaceId = boundedText(options.workspaceId, 200) || 'default';
  const sessionId = boundedText(options.sessionId, 200);
  const outcomeReceiptId = boundedText(options.outcomeReceiptId, 200);
  if (!sessionId) throw new TypeError('browser session id is required');
  let outcomeBinding = outcomeReceiptId ? 'reported' : 'none';
  let boundOutcome = null;
  if (outcomeReceiptId && options.receiptWriter.path) {
    const state = require('./browser-hook-outcome').browserOutcomeReviewState(options.receiptWriter.path, outcomeReceiptId);
    boundOutcome = state.outcome;
    if (!boundOutcome) throw new Error('Bound browser outcome receipt was not found or did not verify');
    if (boundOutcome.workspaceId !== workspaceId) throw new Error('Bound browser outcome belongs to a different workspace');
    const expectedProvenance = 'external:' + boundOutcome.actor + ':' + sessionId;
    if (boundOutcome.provenanceId !== expectedProvenance) throw new Error('Bound browser outcome belongs to a different session');
    outcomeBinding = 'verified';
  }
  const context = {
    sessionId,
    workspaceId,
    agentName: boundOutcome ? boundOutcome.actor : (options.agentName || 'browser-agent'),
    agentId: boundOutcome ? (boundOutcome.agentId || '') : (options.agentId || ''),
    outcomeReceiptId,
    outcomeBinding,
  };
  let sequence = 0;
  const persist = observation => {
    const receipt = buildBrowserSessionReceipt(context, observation, { now: options.now, sequence: ++sequence });
    persistExternalActionReceipt(options.receiptWriter, receipt);
    return receipt;
  };
  const target = await resolvePageTarget(options.endpoint, options);
  const socket = await connectSocket(target.webSocketDebuggerUrl, options);
  const transport = attachTransport(socket, persist, options);
  let disconnected = false;
  const onClose = () => {
    if (disconnected) return;
    disconnected = true;
    persist({ event: 'connection', phase: 'closed', ...target.metadata });
  };
  socket.addEventListener('close', onClose, { once: true });
  persist({ event: 'connection', phase: 'connected', ...target.metadata });
  try {
    await transport.send('Page.enable');
    await transport.send('Runtime.enable');
    await transport.send('Network.enable');
    const durationMs = parsePositiveInt(options.durationMs, DEFAULT_DURATION_MS, MAX_DURATION_MS);
    await new Promise(resolve => setTimeout(resolve, durationMs));
  } finally {
    transport.detach();
    try { socket.close(); } catch (_) { /* already closed */ }
    onClose();
  }
  return { ok: true, events: sequence };
}

async function runBrowserSessionCommand() {
  const endpoint = argumentValue('--cdp');
  const sessionId = argumentValue('--session-id');
  if (!endpoint || !sessionId) throw new TypeError('browser-session requires --cdp and --session-id');
  const receiptPath = argumentValue('--receipt-log');
  const writer = createDurableExternalActionReceiptWriter({
    ...(receiptPath ? { path: receiptPath } : {}),
    memoryPath: argumentValue('--memory-path') || undefined,
    dbPath: argumentValue('--db-path') || undefined,
  });
  try {
    const result = await observeBrowserSession({
      enabled: true,
      endpoint,
      sessionId,
      workspaceId: argumentValue('--workspace-id', 'default'),
      agentName: argumentValue('--agent-name', 'browser-agent'),
      agentId: argumentValue('--agent-id') || '',
      outcomeReceiptId: argumentValue('--outcome-receipt') || '',
      durationMs: argumentValue('--duration-ms') || DEFAULT_DURATION_MS,
      receiptWriter: writer,
    });
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    writer.close();
  }
}

module.exports = {
  OBSERVER_VERSION,
  RECEIPT_KIND,
  buildBrowserSessionReceipt,
  observationFromCdpMessage,
  observeBrowserSession,
  resolvePageTarget,
  runBrowserSessionCommand,
  validateCdpEndpoint,
};
