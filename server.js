const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { readFileSync } = require('fs');
const { execSync } = require('child_process');
const CLI = require('./cli');
const { evaluateLlmSor } = require('./lib/shield');
const { handleIngest } = require('./lib/ingest');
const {
  buildTrustReceipt,
  queryAuditTrail,
  queryCandidateClaims,
  queryProvenance,
} = require('./lib/provenance-query');
const pkg = require('./package.json');
const {
  DEFAULT_MAX_UPLOAD_BODY,
  DEFAULT_MAX_JSON_BODY,
  checkRateLimit,
  clearExpiredRateLimitEntries,
  extractApiKey,
  isUnsafePublicApiCommand,
  readJsonBody,
  requireApiKey,
  sanitizeInput,
} = require('./requestGuards');

function computeTestStatus() {
  if (computeTestStatus.cached) return computeTestStatus.cached;
  const status = process.env.AXIOM_TEST_STATUS || pkg.axiom?.testStatus || pkg.axiom?.test_status;
  if (typeof status === 'string' && status.trim()) {
    computeTestStatus.cached = status.trim();
    return computeTestStatus.cached;
  }
  computeTestStatus.cached = 'unknown';
  return computeTestStatus.cached;
}

const kernelOpts = {};
if (process.env.AXIOM_MEMORY_PATH) kernelOpts.memoryPath = process.env.AXIOM_MEMORY_PATH;
if (process.env.AXIOM_DB_PATH) kernelOpts.dbPath = process.env.AXIOM_DB_PATH;
if (process.env.AXIOM_USE_SQLITE === 'false') kernelOpts.useSQLite = false;

const cli = new CLI({ kernel: kernelOpts });
cli.kernel.graph.load();
let companyRuntimeReady = false;

// --- Güvenlik sabitleri ---
const rateLimitCleanupTimer = setInterval(() => {
  clearExpiredRateLimitEntries();
}, 60_000);
rateLimitCleanupTimer.unref?.();

function legacyVerify(result) {
  return {
    status: result.data.status,
    confidence: result.data.confidence,
    evidence: result.evidence.map(e => e.text),
  };
}

const ALLOWED_CORS_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isSafeOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return '';
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (!ALLOWED_CORS_HOSTS.has(url.hostname)) return '';
    return url.origin;
  } catch (_) {
    return '';
  }
}

function buildCorsHeaders(req, preflight = false) {
  const origin = isSafeOrigin(req.headers?.origin || '');
  if (!origin) return {};
  const headers = {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
  };
  if (preflight) {
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-API-Key';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}

function writeJson(req, res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...buildCorsHeaders(req),
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function writeApiError(req, res, statusCode, code, message, details = {}) {
  writeJson(req, res, statusCode, {
    ok: false,
    error: {
      code,
      message,
      details,
    },
  }, { 'Cache-Control': 'no-cache' });
}

function readTrustFilters(reqUrl) {
  const params = reqUrl.searchParams;
  const read = (name) => sanitizeInput(params.get(name) || '');
  return {
    workspaceId: read('workspaceId'),
    targetId: read('targetId'),
    provenanceId: read('provenanceId'),
    sourceRef: read('sourceRef'),
    sourceType: read('sourceType'),
    sourceSubType: read('sourceSubType'),
    actor: read('actor'),
    eventType: read('eventType'),
    candidateId: read('candidateId'),
    status: read('status'),
    recommendation: read('recommendation'),
    order: read('order'),
    targetType: read('targetType'),
  };
}

function hasTrustQuery(filters, keys) {
  return keys.some((key) => Boolean(filters[key]));
}

function getRateLimitKey(req) {
  const apiKey = extractApiKey(req.headers || {});
  if (apiKey) {
    return 'key:' + crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  }
  if (process.env.AXIOM_TRUST_PROXY === '1') {
    const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return 'ip:' + forwarded;
  }
  return 'ip:' + String(req.socket?.remoteAddress || 'unknown');
}

function sendOptions(req, res) {
  const corsHeaders = buildCorsHeaders(req, true);
  if (!Object.keys(corsHeaders).length) {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(204, {
    ...corsHeaders,
    'Content-Length': '0',
  });
  res.end();
}



function denyIfUnauthorized(req, res) {
  const auth = requireApiKey(req);
  if (auth.ok) return true;
  writeJson(req, res, auth.status, auth.error, auth.headers);
  return false;
}

async function parseJsonRequest(req, res, options = {}) {
  const result = await readJsonBody(req, options);
  if (result.ok) return result.data;
  writeJson(req, res, result.status, result.error, result.headers);
  return null;
}


// Graf verisini D3 formatına dönüştür
function getSafeMemoryLabel(content) {
  if (content === null || content === undefined) return '';
  let str = '';
  if (typeof content === 'string') {
    str = content;
  } else if (typeof content === 'object') {
    if (content.text && typeof content.text === 'string') {
      str = content.text;
    } else if (content.statement && typeof content.statement === 'string') {
      str = content.statement;
    } else if (content.content && typeof content.content === 'string') {
      str = content.content;
    } else {
      try {
        str = JSON.stringify(content);
      } catch (_) {
        str = String(content);
      }
    }
  } else {
    str = String(content);
  }

  // HTML injection guard
  str = str.replace(/<\/?[^>]+(>|$)/g, '');

  if (str.length > 100) {
    str = str.substring(0, 97) + '...';
  }
  return str;
}
function getGraphData(workspaceId = 'default') {
  const scope = typeof workspaceId === 'string' && workspaceId.trim() ? workspaceId.trim() : 'default';
  const nodesById = cli.kernel.graph.getNodes(scope);
  const nodeEdges = new Map();
  for (const edge of cli.kernel.graph._edges.filter((edge) => {
    const edgeScope = edge.workspaceId || 'default';
    return edgeScope === scope;
  })) {
    if (!nodeEdges.has(edge.from)) nodeEdges.set(edge.from, []);
    if (!nodeEdges.has(edge.to)) nodeEdges.set(edge.to, []);
    nodeEdges.get(edge.from).push(edge);
    nodeEdges.get(edge.to).push(edge);
  }

  const nodes = Object.values(nodesById).map(n => {
    const edges = nodeEdges.get(n.id) || [];
    const sources = [...new Set(edges.map(e => e.source || e.source_type || 'manual').filter(Boolean))].slice(0, 3);
    const confidence = edges.length > 0
      ? edges.reduce((max, e) => Math.max(max, Number(e.confidence ?? e.weight ?? 0.5)), 0)
      : Number(n.weight ?? 0.5);
    const evidenceCount = edges.reduce((sum, e) => sum + (Array.isArray(e.evidence) ? e.evidence.length : 0), 0);
    return {
      id: n.id,
      label: n.label,
      weight: n.weight,
      edgeCount: cli.kernel.graph.getEdges(n.id, scope).length,
      confidence,
      sources,
      evidenceCount,
      workspaceId: n.workspaceId || scope,
      last_seen: n.last_seen || n.lastSeen || '',
      created_at: n.created_at || '',
    };
  });

  // Çok fazla node varsa en ağırlıklı 150'yi al
  const MAX_NODES = 150;
  const sorted = nodes.sort((a, b) => (b.weight + b.edgeCount * 0.2) - (a.weight + a.edgeCount * 0.2));
  const topNodes = sorted.slice(0, MAX_NODES);
  const nodeIds = new Set(topNodes.map(n => n.id));

  const links = cli.kernel.graph._edges
    .filter(e => nodeIds.has(e.from) && nodeIds.has(e.to) && (e.workspaceId || 'default') === scope)
    .map(e => ({
      source: e.from,
      target: e.to,
      relation: e.relation,
      weight: e.weight,
      confidence: e.confidence ?? e.weight ?? 0.5,
      sourceType: e.source_type || '',
      evidenceSource: e.source || 'manual',
      sourceRef: e.source_ref || '',
      evidenceCount: Array.isArray(e.evidence) ? e.evidence.length : 0,
      evidence: Array.isArray(e.evidence) ? e.evidence.slice(0, 2) : [],
      updatedAt: e.updated_at || '',
      createdAt: e.created_at || '',
      sessionId: e.session_id || '',
      workspaceId: e.workspaceId || scope,
    }));

  let memoryNodes = [];
  let memoryLinks = [];
  const memoryMetadata = {
    enabled: false
  };

  if (cli.kernel && cli.kernel.memory && typeof cli.kernel.memory.list === 'function') {
    try {
      const listResult = cli.kernel.memory.list({ workspaceId: scope });
      if (listResult && listResult.ok) {
        const activeMemories = listResult.memories || [];
        const topMemories = activeMemories.slice(0, 150);

        memoryNodes = topMemories.map(m => ({
          id: m.memoryId,
          label: getSafeMemoryLabel(m.content),
          type: 'memory',
          workspaceId: m.workspaceId || scope,
          status: m.status || 'active',
          weight: typeof m.metadata?.weight === 'number' ? m.metadata.weight : 1.0,
          metadata: m.metadata || {}
        }));

        const memoryNodeIds = new Set(memoryNodes.map(n => n.id));

        let queryLinksAvailable = typeof cli.kernel.memory.queryLinks === 'function';
        let allLinks = [];
        if (queryLinksAvailable) {
          const linksResult = cli.kernel.memory.queryLinks({ workspaceId: scope });
          if (linksResult && linksResult.ok) {
            allLinks = linksResult.links || [];
          }
        }

        const validLinks = allLinks.filter(l => memoryNodeIds.has(l.fromMemoryId) && memoryNodeIds.has(l.toMemoryId));

        memoryLinks = validLinks.slice(0, 300).map(l => ({
          source: l.fromMemoryId,
          target: l.toMemoryId,
          relation: l.relation,
          type: 'memory-link',
          workspaceId: l.workspaceId || scope,
          weight: typeof l.strength === 'number' ? l.strength : 1.0
        }));

        memoryMetadata.enabled = true;
        memoryMetadata.nodeCount = memoryNodes.length;
        memoryMetadata.linkCount = memoryLinks.length;
        memoryMetadata.source = 'kernel.memory';
      } else {
        memoryMetadata.reason = 'kernel.memory list failed';
      }
    } catch (err) {
      memoryMetadata.reason = 'kernel.memory access error: ' + err.message;
    }
  } else {
    memoryMetadata.reason = 'kernel.memory unavailable';
  }

  return {
    nodes: topNodes,
    links,
    memoryNodes,
    memoryLinks,
    metadata: {
      memory: memoryMetadata
    }
  };
}

function getHealthData() {
  return {
    ok: true,
  };
}

function getLastCommit() {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) {
    return 'unknown';
  }
}

function getV2StatusData() {
  return {
    ok: true,
    service: 'axiom',
    version: pkg.version,
    status: 'running',
  };
}

function getAgentV3Status() {
  try {
    if (cli.agent && typeof cli.agent.getStatus === 'function') {
      return cli.agent.getStatus();
    }
  } catch (_) {}
  return null;
}

function ensureCompanyRuntime() {
  if (typeof cli.kernel.hasCapability === 'function' && !cli.kernel.hasCapability('companyMode')) {
    cli.kernel.enableCapability('companyMode');
  }
  if (typeof cli.kernel.hasCapability === 'function' && !cli.kernel.hasCapability('pluginCapabilities')) {
    cli.kernel.enableCapability('pluginCapabilities');
  }
  if (!companyRuntimeReady && cli.kernel.plugins && typeof cli.kernel.plugins.load === 'function') {
    cli.kernel.plugins.load(path.join(__dirname, 'plugins'));
    companyRuntimeReady = true;
  }
}

const PUBLIC_INDEX_PATH = path.join(__dirname, 'public', 'index.html');
function getHtmlPage() {
  return readFileSync(PUBLIC_INDEX_PATH, 'utf8');
}


const server = http.createServer(async (req, res) => {
  res.setHeader('Connection', 'close');
  if (req.method === 'OPTIONS') {
    sendOptions(req, res);
    return;
  }

  const rateKey = getRateLimitKey(req);

  if (!checkRateLimit(rateKey)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // --- /graph-data ---
  if (reqUrl.pathname === '/graph-data') {
    if (req.method !== 'GET') {
      res.writeHead(405); res.end(); return;
    }
    const workspaceId = reqUrl.searchParams.get('workspaceId') || 'default';
    const data = getGraphData(workspaceId);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      ...buildCorsHeaders(req),
      'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify(data));
    return;
  }

  if (reqUrl.pathname === '/v2-status') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    const data = getV2StatusData();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      ...buildCorsHeaders(req),
      'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify(data));
    return;
  }

  if (reqUrl.pathname === '/health') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      ...buildCorsHeaders(req),
      'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify(getHealthData()));
    return;
  }

  // Structured v2 contract endpoint. Legacy /dogrula stays unchanged below.
  if (reqUrl.pathname === '/v2/verify') {
    if (req.method !== 'POST') {
      writeJson(req, res, 405, {
        error: 'Method not allowed',
        message: 'Use POST /v2/verify',
      }, { 'Cache-Control': 'no-cache' });
      return;
    }

    const sendVerifyResult = (statement, workspaceId = '') => {
      const text = sanitizeInput(statement || '');
      if (!text) {
        writeJson(req, res, 400, { error: 'statement required' });
        return;
      }

      const normalizedWorkspaceId = sanitizeInput(workspaceId || reqUrl.searchParams.get('workspaceId') || '');
      const result = cli.kernel.verify(text, normalizedWorkspaceId ? { workspaceId: normalizedWorkspaceId } : {});
      writeJson(req, res, 200, result, { 'Cache-Control': 'no-cache' });
    };

    const data = await parseJsonRequest(req, res, { maxBytes: 4_096 });
    if (!data) return;
    sendVerifyResult(data.statement || data.text || '', data.workspaceId || '');
    return;
  }

  // --- /llm-sor ---
  if (reqUrl.pathname === '/llm-sor') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!denyIfUnauthorized(req, res)) return;
    const data = await parseJsonRequest(req, res, { maxBytes: DEFAULT_MAX_JSON_BODY });
    if (!data) return;
    const question = sanitizeInput(data.question || data.q || '');
    const autoLearn = data.autoLearn === true;
    const workspaceId = sanitizeInput(data.workspaceId || reqUrl.searchParams.get('workspaceId') || '');
    if (!question) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'question gerekli' }));
      return;
    }

    // AXIOM ön doğrulama
    const axiomCheck = legacyVerify(cli.kernel.verify(question, workspaceId ? { workspaceId } : {}));

    // LLM'ye sor
    const LLMAdapter = require('./llmAdapter');
    const llm = new LLMAdapter();
    const llmRes = await llm.ask(question);

    if (!llmRes.ok) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({
        ok: false,
        error: llmRes.error,
        axiomCheck,
      }));
      return;
    }

    const llmText = llmRes.data.text;

    // LLM yanıtını doğrula
    const llmCheck = legacyVerify(cli.kernel.verify(llmText.slice(0, 300), workspaceId ? { workspaceId } : {}));

    const shield = evaluateLlmSor({
      kernel: cli.kernel,
      question,
      llmText,
      axiomCheck,
      llmCheck,
      autoLearn,
      maxSentences: 15,
      workspaceId,
    });

    res.writeHead(200, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
    res.end(JSON.stringify({
      ok: true,
      question,
      llmAnswer: llmText,
      model: llmRes.data.model,
      axiomCheck,
      llmCheck: shield.llmCheck,
      label: shield.label,
      shield: shield.shield,
      learnResult: shield.learnResult,
    }));
    return;
  }
  if (reqUrl.pathname === '/dogrula' || reqUrl.pathname === '/verify') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({
        error: 'Method not allowed',
        message: 'Use POST /v2/verify',
      }));
      return;
    }
    if (!denyIfUnauthorized(req, res)) return;
    const data = await parseJsonRequest(req, res, { maxBytes: DEFAULT_MAX_JSON_BODY });
    if (!data) return;
    const text = sanitizeInput(data.statement || data.text || '');
    const workspaceId = sanitizeInput(data.workspaceId || reqUrl.searchParams.get('workspaceId') || '');
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'statement veya text gerekli' }));
      return;
    }
    const result = legacyVerify(cli.kernel.verify(text, workspaceId ? { workspaceId } : {}));
    res.writeHead(200, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
    res.end(JSON.stringify(result));
    return;
  }
  if (reqUrl.pathname === '/yukle' || reqUrl.pathname === '/upload') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!denyIfUnauthorized(req, res)) return;
    const contentLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > DEFAULT_MAX_UPLOAD_BODY) {
      res.writeHead(413, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'İçerik çok büyük (max 1MB)' }));
      return;
    }
    const data = await parseJsonRequest(req, res, { maxBytes: DEFAULT_MAX_UPLOAD_BODY });
    if (!data) return;
    const text = data.text || data.content || '';
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'text veya content gerekli' }));
      return;
    }
    const count = cli.kernel.learnDocument(text);
    cli.kernel.graph.save();
    res.writeHead(200, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
    res.end(JSON.stringify({ ok: true, learned: count }));
    return;
  }

  if (reqUrl.pathname === '/api/ingest/status') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    try {
      ensureCompanyRuntime();
      const status = await cli.kernel.runCapability('ingestStatus', {});
      writeJson(req, res, 200, status, { 'Cache-Control': 'no-cache' });
    } catch (err) {
      writeJson(req, res, 500, { error: err.message || 'ingest status failed' });
    }
    return;
  }

  if (reqUrl.pathname === '/api/provenance' || reqUrl.pathname === '/api/audit' || reqUrl.pathname === '/api/candidate-claims' || reqUrl.pathname === '/api/trust-receipt') {
    if (req.method !== 'GET') {
      writeApiError(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return;
    }
    if (!denyIfUnauthorized(req, res)) return;
    const filters = readTrustFilters(reqUrl);
    const workspaceId = filters.workspaceId || 'default';
    const graph = cli.kernel.graph;
    try {
      if (reqUrl.pathname === '/api/provenance') {
        if (!hasTrustQuery(filters, ['targetId', 'provenanceId', 'sourceRef', 'sourceType', 'actor'])) {
          writeApiError(req, res, 400, 'INVALID_QUERY', 'targetId, provenanceId, sourceRef, sourceType, or actor is required.');
          return;
        }
        const items = queryProvenance(graph, { ...filters, workspaceId });
        writeJson(req, res, 200, {
          ok: true,
          data: {
            items,
            total: items.length,
            workspaceId,
          },
        }, { 'Cache-Control': 'no-cache' });
        return;
      }

      if (reqUrl.pathname === '/api/audit') {
        if (!hasTrustQuery(filters, ['targetId', 'provenanceId', 'sourceRef', 'eventType', 'actor'])) {
          writeApiError(req, res, 400, 'INVALID_QUERY', 'targetId, provenanceId, sourceRef, eventType, or actor is required.');
          return;
        }
        const items = queryAuditTrail(graph, { ...filters, workspaceId });
        writeJson(req, res, 200, {
          ok: true,
          data: {
            items,
            total: items.length,
            workspaceId,
          },
        }, { 'Cache-Control': 'no-cache' });
        return;
      }

      if (reqUrl.pathname === '/api/candidate-claims') {
        if (!hasTrustQuery(filters, ['candidateId', 'status', 'recommendation', 'sourceRef', 'targetId'])) {
          writeApiError(req, res, 400, 'INVALID_QUERY', 'candidateId, status, recommendation, sourceRef, or targetId is required.');
          return;
        }
        const items = queryCandidateClaims(graph, { ...filters, workspaceId });
        writeJson(req, res, 200, {
          ok: true,
          data: {
            items,
            total: items.length,
            workspaceId,
          },
        }, { 'Cache-Control': 'no-cache' });
        return;
      }

      if (!hasTrustQuery(filters, ['targetId', 'provenanceId', 'sourceRef', 'candidateId', 'eventType'])) {
        writeApiError(req, res, 400, 'INVALID_QUERY', 'targetId, provenanceId, sourceRef, candidateId, or eventType is required.');
        return;
      }
      const receipt = buildTrustReceipt({ ...filters, workspaceId }, { target: graph });
      writeJson(req, res, 200, {
        ok: true,
        data: receipt,
      }, { 'Cache-Control': 'no-cache' });
    } catch (err) {
      writeApiError(req, res, 500, 'TRUST_QUERY_FAILED', err.message || 'trust query failed');
    }
    return;
  }

  if (reqUrl.pathname === '/api/ingest') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!denyIfUnauthorized(req, res)) return;
    const data = await parseJsonRequest(req, res, { maxBytes: DEFAULT_MAX_UPLOAD_BODY });
    if (!data) return;
    try {
      const result = await handleIngest({
        kernel: cli.kernel,
        data,
        ensureRuntime: ensureCompanyRuntime,
      });

      if (!result || result.ok === false) {
        writeJson(req, res, 400, result || { error: 'ingest failed' });
        return;
      }
      writeJson(req, res, 200, result, { 'Cache-Control': 'no-cache' });
    } catch (err) {
      writeJson(req, res, 500, { error: err.message || 'ingest failed' });
    }
    return;
  }

  if (reqUrl.pathname === '/api') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    const raw = reqUrl.searchParams.get('q') || '';
    const q = sanitizeInput(raw);
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ result: 'HATA: Boş girdi.' }));
      return;
    }
    if (isUnsafePublicApiCommand(q)) {
      res.writeHead(403, {
        'Content-Type': 'application/json; charset=utf-8',
        ...buildCorsHeaders(req),
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify({ result: 'Bu komut web API üzerinden çalıştırılamaz.' }));
      return;
    }
    const p = cli.parse(q);

    if (p && isUnsafePublicApiCommand(p.command)) {
      res.writeHead(403, {
        'Content-Type': 'application/json; charset=utf-8',
        ...buildCorsHeaders(req),
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify({ result: 'Bu komut web API üzerinden çalıştırılamaz.' }));
      return;
    }

    let result;
    if (!p) {
      result = 'HATA: Anlamadım.';
    } else if (p.command === 'kaydet') {
      result = '⚠️ Kaydet komutu sadece CLI\'dan kullanılabilir.';
    } else {
      try {
        // Some commands may be sync today and async tomorrow.
        // Normalize here so API never leaks "[object Promise]".
        result = await Promise.resolve(cli.execute(p.command, p.args));
      } catch (err) {
        console.error('[API hata]', err.code || err.name || 'internal');
        result = 'HATA: İşlem sırasında hata oluştu.';
      }
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      ...buildCorsHeaders(req),
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify({ result }));
    return;
  }

  // --- Ana sayfa ---
  if (reqUrl.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...buildCorsHeaders(req) });
    res.end(getHtmlPage());
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
  res.end(JSON.stringify({ error: 'Not found' }));
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.AXIOM_HOST || '127.0.0.1';

function startServer(port = PORT, host = HOST) {
  return server.listen(port, host, () => {
    console.log(`?? AXIOM web aray?z?: http://${host}:${port}`);
    console.log(`   Graf g?r?n?m?: http://${host}:${port} ? "Graf" sekmesi`);
  });
}

if (require.main === module && process.env.AXIOM_DISABLE_AUTO_LISTEN !== '1') {
  startServer(PORT, HOST);
}

server.closeAxiom = () => {
  if (cli.agent?.baseAgent?.storage && typeof cli.agent.baseAgent.storage.close === 'function') {
    try { cli.agent.baseAgent.storage.close(); } catch (_) {}
  }
  if (cli.agent?.storage && typeof cli.agent.storage.close === 'function') {
    try { cli.agent.storage.close(); } catch (_) {}
  }
  cli.kernel.graph.close();
};

server.startServer = startServer;
module.exports = server;


