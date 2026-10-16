'use strict';

/**
 * Transparent OpenAI-compatible LLM proxy (#1908, "Invisible Infrastructure").
 *
 *   POST /v1/chat/completions   OpenAI Chat Completions passthrough
 *   GET  /v1/models             OpenAI model list passthrough
 *
 * The client keeps its OpenAI SDK and changes only the base URL. HUQAN sits
 * in the middle: it forwards the request bytes verbatim, returns the
 * upstream response verbatim, and — on the side — writes a chained Trust
 * Evidence receipt (`trust_evidence` family) with scrubbed metadata only.
 *
 * ## What is and is not inspected
 *
 * The recorded copy is scrubbed with lib/secret-scrub-gate.js before it is
 * journaled, so a pasted token in a prompt never survives in plain text in
 * HUQAN storage. The upstream call itself is byte-transparent: HUQAN never
 * rewrites prompts or completions. Blocking dangerous content is explicitly
 * out of scope for this slice (tracked for the policy-engine follow-up);
 * this module observes and receipts, it does not gate.
 *
 * ## Limits (fail-closed shapes)
 *
 * - Request bodies over MAX_REQUEST_BYTES are refused (413), never truncated.
 * - Upstream responses over MAX_RESPONSE_BYTES are refused (502): HUQAN will
 *   not receipt what it could not fully observe.
 * - `stream: true` is refused (400): a streamed body cannot be receipted as
 *   one bounded unit yet.
 * - Ledger failure never breaks passthrough: the upstream answer is still
 *   returned, and the miss is logged for operators.
 */

const crypto = require('node:crypto');

const { scrubSecrets } = require('../secret-scrub-gate');
const { createTrustEvidenceLedger } = require('../trust-evidence-ledger');

const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
const MODELS_PATH = '/v1/models';

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const PROXY_ERRORS = Object.freeze({
  METHOD: 'llm_proxy_method_not_allowed',
  BAD_JSON: 'llm_proxy_invalid_json',
  TOO_LARGE: 'llm_proxy_request_too_large',
  STREAM: 'llm_proxy_stream_unsupported',
  NO_KEY: 'llm_proxy_missing_api_key',
  UPSTREAM: 'llm_proxy_upstream_error',
  UPSTREAM_TOO_LARGE: 'llm_proxy_upstream_too_large',
});

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * @returns {'chat-completions'|'models'|null}
 */
function parseLlmProxyPath(pathname, method) {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  if (pathname === CHAT_COMPLETIONS_PATH) {
    return normalizedMethod === 'POST' ? 'chat-completions' : 'method-mismatch';
  }
  if (pathname === MODELS_PATH) {
    return normalizedMethod === 'GET' ? 'models' : 'method-mismatch';
  }
  return null;
}

function readBoundedBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let refused = false;
    req.on('data', (chunk) => {
      if (refused) return;
      total += chunk.length;
      if (total > maxBytes) {
        refused = true;
        reject(Object.assign(new Error('request too large'), { code: PROXY_ERRORS.TOO_LARGE }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!refused) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function openaiError(message, type = 'invalid_request_error') {
  return { error: { message, type } };
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (_) {
    return { ok: false, value: null };
  }
}

function pickModel(requestJson) {
  const model = requestJson && typeof requestJson.model === 'string' ? requestJson.model : '';
  return model.slice(0, 128);
}

function pickUsage(responseJson) {
  const usage = responseJson && typeof responseJson === 'object' ? responseJson.usage : null;
  if (!usage || typeof usage !== 'object') return { promptTokens: null, completionTokens: null };
  const promptTokens = Number(usage.prompt_tokens);
  const completionTokens = Number(usage.completion_tokens);
  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : null,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : null,
  };
}

function createLlmProxyHandler({ graph, writeJson, fetchImpl, config }) {
  if (!graph) throw new TypeError('graph is required');
  if (typeof writeJson !== 'function') throw new TypeError('writeJson is required');
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const proxyConfig = config || { upstream: 'https://api.openai.com', timeoutMs: 60000, apiKey: '' };
  let ledger = null;
  try {
    ledger = createTrustEvidenceLedger({ graph });
  } catch (_) {
    ledger = null;
  }

  function recordReceipt({ model, upstreamStatus, latencyMs, usage, scrubbed, requestBytes }) {
    if (!ledger) return null;
    try {
      const createdAt = new Date().toISOString();
      const outcome = `upstream_${upstreamStatus}`;
      const receipt = ledger.append({
        operationId: `llm-proxy:${crypto.randomUUID()}`,
        event: {
          workspaceId: 'default',
          decision: 'allow',
          reason: 'transparent proxy observation (no content gate in this slice)',
          actionFingerprint: sha256Hex(`${model}:${upstreamStatus}`).slice(0, 32),
          createdAt,
          connectorRef: 'llm-proxy',
          resourceRef: 'openai-compatible upstream',
          executionOutcome: outcome,
          metadata: {
            provider: 'openai-compatible',
            model: model || 'unknown',
            upstreamStatus,
            latencyMs,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            scrubApplied: Boolean(scrubbed),
            streamed: false,
            requestBytes: Math.min(requestBytes, MAX_REQUEST_BYTES),
          },
        },
        mutate: () => ({ proxied: true, model: model || 'unknown', upstreamStatus }),
      });
      return receipt;
    } catch (error) {
      console.error('[llm-proxy] receipt recording failed (passthrough unaffected):', error && error.message);
      return null;
    }
  }

  async function forward({ path, method, clientAuth, rawBody }) {
    const headers = { 'Content-Type': 'application/json' };
    const serverKey = proxyConfig.apiKey;
    if (serverKey) {
      headers.Authorization = `Bearer ${serverKey}`;
    } else if (clientAuth) {
      headers.Authorization = clientAuth;
    } else {
      return { keyMissing: true };
    }
    const startedAt = Date.now();
    const res = await fetchFn(`${proxyConfig.upstream}${path}`, {
      method,
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(proxyConfig.timeoutMs),
    });
    const latencyMs = Date.now() - startedAt;
    return { res, latencyMs };
  }

  async function handleChatCompletions(req, res) {
    let rawBody;
    try {
      rawBody = await readBoundedBody(req, MAX_REQUEST_BYTES);
    } catch (error) {
      if (error && error.code === PROXY_ERRORS.TOO_LARGE) {
        writeJson(req, res, 413, openaiError('Request body exceeds the proxy limit.'));
        return true;
      }
      throw error;
    }
    const parsed = safeJsonParse(rawBody.toString('utf8'));
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      writeJson(req, res, 400, openaiError('Request body must be a JSON object.'));
      return true;
    }
    if (parsed.value.stream === true) {
      writeJson(req, res, 400, openaiError('Streaming is not supported by the HUQAN proxy yet.', 'invalid_request_error'), { 'Cache-Control': 'no-store' });
      return true;
    }
    const model = pickModel(parsed.value);

    const clientAuth = typeof req.headers?.authorization === 'string' ? req.headers.authorization : '';
    let forwarded;
    try {
      forwarded = await forward({ path: CHAT_COMPLETIONS_PATH, method: 'POST', clientAuth, rawBody });
    } catch (error) {
      writeJson(req, res, 502, openaiError(`Upstream unreachable: ${error && error.message ? String(error.message).slice(0, 200) : 'network error'}.`, 'api_connection_error'));
      return true;
    }
    if (forwarded.keyMissing) {
      writeJson(req, res, 401, openaiError('API key required: configure LLM_PROXY_API_KEY or send Authorization.', 'authentication_error'));
      return true;
    }

    const upstreamText = await forwarded.res.text();
    if (Buffer.byteLength(upstreamText, 'utf8') > MAX_RESPONSE_BYTES) {
      writeJson(req, res, 502, openaiError('Upstream response exceeds the observable limit.', 'server_error'));
      return true;
    }
    const upstreamJson = safeJsonParse(upstreamText);
    const usage = upstreamJson.ok ? pickUsage(upstreamJson.value) : { promptTokens: null, completionTokens: null };

    // The recorded copy is scrubbed; the wire copy is verbatim.
    let scrubbed = false;
    try {
      const inspected = scrubSecrets({ request: parsed.value });
      scrubbed = Boolean(inspected && inspected.secretDetected);
    } catch (_) {
      scrubbed = false;
    }
    recordReceipt({
      model,
      upstreamStatus: forwarded.res.status,
      latencyMs: forwarded.latencyMs,
      usage,
      scrubbed,
      requestBytes: rawBody.length,
    });

    const contentType = forwarded.res.headers && typeof forwarded.res.headers.get === 'function'
      ? forwarded.res.headers.get('content-type') || 'application/json'
      : 'application/json';
    res.writeHead(forwarded.res.status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(upstreamText);
    return true;
  }

  async function handleModels(req, res) {
    const clientAuth = typeof req.headers?.authorization === 'string' ? req.headers.authorization : '';
    let forwarded;
    try {
      forwarded = await forward({ path: MODELS_PATH, method: 'GET', clientAuth, rawBody: undefined });
    } catch (error) {
      writeJson(req, res, 502, openaiError('Upstream unreachable.', 'api_connection_error'));
      return true;
    }
    if (forwarded.keyMissing) {
      writeJson(req, res, 401, openaiError('API key required.', 'authentication_error'));
      return true;
    }
    const upstreamText = await forwarded.res.text();
    if (Buffer.byteLength(upstreamText, 'utf8') > MAX_RESPONSE_BYTES) {
      writeJson(req, res, 502, openaiError('Upstream response exceeds the observable limit.', 'server_error'));
      return true;
    }
    recordReceipt({
      model: '',
      upstreamStatus: forwarded.res.status,
      latencyMs: forwarded.latencyMs,
      usage: { promptTokens: null, completionTokens: null },
      scrubbed: false,
      requestBytes: 0,
    });
    res.writeHead(forwarded.res.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(upstreamText);
    return true;
  }

  async function handleLlmProxy(req, res, reqUrl) {
    const route = parseLlmProxyPath(reqUrl && reqUrl.pathname, req.method);
    if (route === null) return false;
    if (route === 'method-mismatch') {
      writeJson(req, res, 405, openaiError('Method not allowed.'));
      return true;
    }
    if (route === 'models') return handleModels(req, res);
    return handleChatCompletions(req, res);
  }

  return { handleLlmProxy };
}

module.exports = {
  CHAT_COMPLETIONS_PATH,
  MODELS_PATH,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  PROXY_ERRORS,
  parseLlmProxyPath,
  createLlmProxyHandler,
};
