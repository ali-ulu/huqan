'use strict';
const https = require('https');
const MAX_QUERY_LENGTH = 1000;
const MIN_LIMIT = 1;
const MAX_LIMIT = 10;
const DEFAULT_LIMIT = 5;
const DEFAULT_SNIPPET = 4000;
const MIN_SNIPPET = 500;
const MAX_SNIPPET = 8000;
const TOTAL_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 1024 * 1024;
const PROVIDERS = Object.freeze({
  brave: Object.freeze({ name: 'brave', method: 'GET', endpoint: 'https://api.search.brave.com/res/v1/web/search', envKey: 'BRAVE_API_KEY' }),
  firecrawl: Object.freeze({ name: 'firecrawl', method: 'POST', endpoint: 'https://api.firecrawl.dev/v2/search', envKey: 'FIRECRAWL_API_KEY' }),
  tavily: Object.freeze({ name: 'tavily', method: 'POST', endpoint: 'https://api.tavily.com/search', envKey: 'TAVILY_API_KEY' }),
});
const PROVIDER_METADATA = Object.freeze(Object.values(PROVIDERS).map((p) => Object.freeze({ ...p })));
class WebResearchError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'WebResearchError';
    this.code = code;
    this.status = status;
  }
}
function fail(code, status, message) { throw new WebResearchError(code, status, message); }
function normalizeQuery(query) {
  if (typeof query !== 'string') fail('INVALID_QUERY', 400, 'Invalid query.');
  const q = query.trim();
  if (!q || q.length > MAX_QUERY_LENGTH) fail('INVALID_QUERY', 400, 'Invalid query.');
  return q;
}
function normalizeLimit(limit) {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  if (typeof limit !== 'number' || !Number.isInteger(limit)) fail('INVALID_LIMIT', 400, 'Invalid limit.');
  if (limit < MIN_LIMIT || limit > MAX_LIMIT) fail('INVALID_LIMIT', 400, 'Invalid limit.');
  return limit;
}
function normalizeSnippetLength(maxSnippet) {
  if (maxSnippet === undefined || maxSnippet === null) return DEFAULT_SNIPPET;
  if (typeof maxSnippet !== 'number' || !Number.isInteger(maxSnippet)) fail('INVALID_SNIPPET_LENGTH', 400, 'Invalid snippet length.');
  if (maxSnippet < MIN_SNIPPET || maxSnippet > MAX_SNIPPET) fail('INVALID_SNIPPET_LENGTH', 400, 'Invalid snippet length.');
  return maxSnippet;
}
function apiKeyFor(provider, env) {
  const src = env && typeof env === 'object' ? env : {};
  const v = src[PROVIDERS[provider].envKey];
  if (typeof v !== 'string' || !v.trim()) fail('MISSING_API_KEY', 500, 'Missing API key.');
  return v.trim();
}
function text(v) { return typeof v === 'string' ? v.trim() : ''; }
function urlOk(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s) return false;
  let u;
  try { u = new URL(s); } catch (_e) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username !== '' || u.password !== '') return false;
  return true;
}
function normEntry(raw, maxSnippet) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const title = text(raw.title).slice(0, 300);
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  const snippet = text(raw.snippet !== undefined ? raw.snippet : raw.description !== undefined ? raw.description : raw.content).slice(0, maxSnippet);
  if (url.length > 2048 || !urlOk(url)) return null;
  return { title, url, snippet };
}

function normList(items, limit, maxSnippet) {
  if (!Array.isArray(items)) fail('UPSTREAM_INVALID_PAYLOAD', 502, 'Invalid upstream response.');
  const out = [];
  for (const it of items) { const e = normEntry(it, maxSnippet); if (e) out.push(e); if (out.length >= limit) break; }
  return out;
}
function extract(provider, payload, limit, maxSnippet) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('UPSTREAM_INVALID_PAYLOAD', 502, 'Invalid upstream response.');
  if (provider === 'brave') {
    if (Array.isArray(payload.results)) return normList(payload.results, limit, maxSnippet);
    if (payload.web && typeof payload.web === 'object' && Array.isArray(payload.web.results)) return normList(payload.web.results, limit, maxSnippet);
    fail('UPSTREAM_INVALID_PAYLOAD', 502, 'Invalid upstream response.');
  }
  if (provider === 'firecrawl') {
    if (payload.data && typeof payload.data === 'object' && Array.isArray(payload.data.web)) return normList(payload.data.web, limit, maxSnippet);
    fail('UPSTREAM_INVALID_PAYLOAD', 502, 'Invalid upstream response.');
  }
  if (Array.isArray(payload.results)) return normList(payload.results, limit, maxSnippet);
  fail('UPSTREAM_INVALID_PAYLOAD', 502, 'Invalid upstream response.');
}
function mapStatus(status) {
  if (status === 401) fail('UPSTREAM_UNAUTHORIZED', 401, 'Upstream request unauthorized.');
  if (status === 403) fail('UPSTREAM_FORBIDDEN', 403, 'Upstream request forbidden.');
  if (status === 429) fail('UPSTREAM_RATE_LIMITED', 429, 'Upstream rate limited.');
  if (status >= 500 && status <= 599) fail('UPSTREAM_ERROR', 502, 'Upstream request failed.');
  fail('UPSTREAM_ERROR', 502, 'Upstream request failed.');
}
function timedOut(e) {
  if (!e || typeof e !== 'object') return false;
  const c = typeof e.code === 'string' ? e.code : '';
  if (c === 'ETIMEDOUT' || c === 'ETIMEOUT' || c === 'UPSTREAM_TIMEOUT') return true;
  const m = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  return m.includes('timed out') || m.includes('timeout');
}
function buildReq(provider, query, limit, key) {
  if (provider === 'brave') return { method: 'GET', url: PROVIDERS.brave.endpoint + '?q=' + encodeURIComponent(query) + '&count=' + limit, headers: { Accept: 'application/json', 'X-Subscription-Token': key } };
  if (provider === 'firecrawl') return { method: 'POST', url: PROVIDERS.firecrawl.endpoint, headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ query, limit, sources: ['web'] }) };
  return { method: 'POST', url: PROVIDERS.tavily.endpoint, headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ query, max_results: limit, search_depth: 'basic', include_answer: false }) };
}
function nativeTransport(req) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(req.url); } catch (_e) { reject(new WebResearchError('UPSTREAM_INVALID_PAYLOAD', 502, 'Invalid upstream response.')); return; }
    const ok = Object.values(PROVIDERS).some((p) => req.url === p.endpoint || req.url.startsWith(p.endpoint + '?') || req.url.startsWith(p.endpoint + '/'));
    if (parsed.protocol !== 'https:' || !ok) { reject(new WebResearchError('UPSTREAM_ERROR', 502, 'Upstream request failed.')); return; }
    let settled = false;
    let client;
    let response;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        response?.destroy();
        client?.destroy();
      } else resolve(value);
    };
    const timer = setTimeout(() => finish(new WebResearchError('UPSTREAM_TIMEOUT', 504, 'Upstream request timed out.')), TOTAL_TIMEOUT_MS);
    try {
      client = https.request(parsed, { method: req.method, headers: req.headers }, (res) => {
        response = res;
        res.on('error', error => finish(error));
        res.on('aborted', () => finish(new WebResearchError('UPSTREAM_ERROR', 502, 'Upstream request failed.')));
        if (res.statusCode >= 300 && res.statusCode <= 399) {
          finish(new WebResearchError('UPSTREAM_INVALID_PAYLOAD', 502, 'Invalid upstream response.'));
          return;
        }
        let bytes = 0;
        const chunks = [];
        res.on('data', chunk => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) {
            finish(new WebResearchError('UPSTREAM_OVERSIZE', 502, 'Upstream response too large.'));
          } else chunks.push(chunk);
        });
        res.on('end', () => finish(null, { status: res.statusCode, bodyText: Buffer.concat(chunks).toString('utf8') }));
      });
      client.on('error', error => finish(error));
      client.end(req.body);
    } catch (error) { finish(error); }
  });
}
async function researchWeb(input, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const env = opts.env !== undefined ? opts.env : process.env;
  const transport = opts.request !== undefined ? opts.request : nativeTransport;
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_PROVIDER', 400, 'Unsupported provider.');
  if (typeof transport !== 'function') fail('UPSTREAM_ERROR', 502, 'Upstream request failed.');
  const { provider, query, limit, maxSnippet, summarize } = input;
  if (summarize !== undefined && typeof summarize !== 'boolean') fail('INVALID_INPUT', 400, 'Invalid summarize flag.');
  if (typeof provider !== 'string' || !Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) fail('INVALID_PROVIDER', 400, 'Unsupported provider.');
  const qq = normalizeQuery(query);
  const nn = normalizeLimit(limit);
  const ss = normalizeSnippetLength(maxSnippet);
  const key = apiKeyFor(provider, env);
  const req = buildReq(provider, qq, nn, key);
  let res;
  try { res = await transport(req); } catch (e) {
    if (e instanceof WebResearchError) throw e;
    if (timedOut(e)) fail('UPSTREAM_TIMEOUT', 504, 'Upstream request timed out.');
    fail('UPSTREAM_ERROR', 502, 'Upstream request failed.');
  }
  const status = (res && typeof res.status === 'number') ? res.status : (res && typeof res.statusCode === 'number' ? res.statusCode : undefined);
  if (typeof status !== 'number') fail('UPSTREAM_INVALID_PAYLOAD', 502, 'Invalid upstream response.');
  if (status < 200 || status > 299) mapStatus(status);
  const bt = typeof res.bodyText === 'string' ? res.bodyText : (typeof res.body === 'string' ? res.body : '');
  if (Buffer.byteLength(bt, 'utf8') > MAX_BODY_BYTES) fail('UPSTREAM_OVERSIZE', 502, 'Upstream response too large.');
  let payload;
  try { payload = JSON.parse(bt); } catch (_e) { fail('UPSTREAM_INVALID_PAYLOAD', 502, 'Invalid upstream response.'); }
  const sources = extract(provider, payload, nn, ss);
  let summary = null;
  let summaryStatus = 'off';
  if (summarize === true) {
    summaryStatus = 'unavailable';
    try {
      summary = await summarizeSources(opts.summarize, qq, sources);
      if (summary) summaryStatus = 'ok';
    } catch (_e) { summary = null; }
  }
  return { provider, query: qq, limit: nn, maxSnippet: ss, sources, summary, summaryStatus, canonicalWrite: false, evidenceStatus: 'external_unverified' };
}

/**
 * HUQAN-side summary in natural language. The summarize impl receives the
 * query and the numbered source lines and returns plain text; anything else
 * (or a throw, or empty sources) means no summary. Fail-soft by design: a
 * down LLM must never take the source list down with it.
 */
async function summarizeSources(summarizeImpl, query, sources) {
  if (typeof summarizeImpl !== 'function' || !Array.isArray(sources) || sources.length === 0) return null;
  const lines = sources.map((s, i) => `[${i + 1}] ${s.title} (${s.url}): ${s.snippet}`);
  const answer = await summarizeImpl(query, lines.join('\n'));
  const text = typeof answer === 'string' ? answer.trim() : '';
  if (!text) return null;
  return { text: text.slice(0, 4000), by: 'huqan-llm', sources: sources.length };
}
module.exports = { researchWeb, summarizeSources, PROVIDERS, PROVIDER_METADATA, WebResearchError, MAX_BODY_BYTES, TOTAL_TIMEOUT_MS, DEFAULT_SNIPPET, MIN_SNIPPET, MAX_SNIPPET };
