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
const { inspectPersistence, resolvePersistencePaths } = require('./persistencePaths');
const {
  DEFAULT_MAX_UPLOAD_BODY,
  DEFAULT_MAX_JSON_BODY,
  checkRateLimit,
  clearExpiredRateLimitEntries,
  extractApiKey,
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

  return { nodes: topNodes, links };
}

function getHealthData() {
  const stats = cli.kernel.graph.getStats();
  const persistence = inspectPersistence({
    rootDir: __dirname,
    memoryPath: process.env.AXIOM_MEMORY_PATH,
    dbPath: process.env.AXIOM_DB_PATH,
    backupBaseDir: process.env.AXIOM_BACKUP_DIR,
  });
  return {
    ok: true,
    service: 'axiom',
    kernelVersion: process.env.AXIOM_KERNEL_VERSION === 'v2' ? 'v2' : 'v1',
    backend: stats.backend,
    nodes: stats.nodes,
    edges: stats.edges,
    uptimeSec: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    persistence,
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
  const stats = cli.kernel.graph.getStats();
  const persistence = resolvePersistencePaths({
    rootDir: __dirname,
    memoryPath: process.env.AXIOM_MEMORY_PATH,
    dbPath: process.env.AXIOM_DB_PATH,
    backupBaseDir: process.env.AXIOM_BACKUP_DIR,
  });
  const activeKernel = process.env.AXIOM_KERNEL_VERSION === 'v2' ? 'v2' : 'v1';
  const agentRuntime = String(process.env.AXIOM_AGENT_VERSION || 'v2').toLowerCase();
  const agentRuntimeMode = String(process.env.AXIOM_AGENT_RUNTIME || '').toLowerCase() || agentRuntime;
  const checkpointBackend = agentRuntime === 'v3' ? 'sqlite' : 'json';
  const phases = [
    {
      id: 'v2.0',
      title: 'v2.0 Core / Release',
      status: 'done',
      summary: 'Core contract, paranoid mode, MCP, benchmarks, release notes, and v2.0.0 tag are shipped.',
      items: [
        'Core envelope contract',
        'paranoidMode + AXIOM_ERROR + contractVersion',
        'MCP stdio adapter',
        'Deterministic benchmark fixtures',
        'Release docs + v2.0.0 tag',
      ],
    },
    {
      id: 'v2.1',
      title: 'v2.1 Verify Reasoning',
      status: 'done',
      summary: 'KernelV2 verify now supports multi-hop type inference, contradiction reasons, and richer evidence.',
      items: [
        'Multi-hop type-chain inference',
        'Negated known fact conflict',
        'Opposite predicate conflict',
        'Known type mismatch conflict',
      ],
    },
    {
      id: 'v2.2',
      title: 'v2.2 Ecosystem',
      status: 'done',
      summary: 'MCP schema reflects v2 verify fields and can opt into KernelV2 runtime.',
      items: [
        'Richer verify output schema',
        'Optional AXIOM_KERNEL_VERSION=v2 runtime',
        'Schema tests',
      ],
    },
    {
      id: 'v2.3',
      title: 'v2.3 CLI/REST Runtime',
      status: process.env.AXIOM_KERNEL_VERSION === 'v2' ? 'done' : 'in_progress',
      summary: 'CLI, REST, and MCP can run the v2 kernel behind an explicit environment flag.',
      items: [
        'CLI KernelV2 opt-in',
        'REST KernelV2 opt-in',
        'Health/status kernel visibility',
      ],
    },
    {
      id: 'v2.4',
      title: 'v2.4 Status Dashboard',
      status: 'done',
      summary: 'The web UI and /v2-status endpoint show phase, runtime, test, and commit state in one place.',
      items: [
        'Single status endpoint',
        'Runtime kernel/backend cards',
        'Phase progress cards',
        'Last commit visibility',
      ],
    },
    {
      id: 'v2.5',
      title: 'v2.5 REST Structured Verify',
      status: 'done',
      summary: 'New /v2/verify endpoint returns the full core envelope while legacy /dogrula stays stable.',
      items: [
        'GET /v2/verify',
        'POST /v2/verify',
        'Legacy /dogrula compatibility',
        'Structured REST tests',
      ],
    },
    {
      id: 'v2.6',
      title: 'v2.6 MCP Schema Polish',
      status: 'done',
      summary: 'MCP tool descriptions and output schemas now mirror the real payload shapes more closely.',
      items: [
        'Concrete tool descriptions',
        'Per-tool output schemas',
        'Evidence and meta schema details',
        'Developer-friendly MCP docs',
      ],
    },
    {
      id: 'v2.7',
      title: 'v2.7 Manipulation Guard',
      status: 'done',
      summary: 'KernelV2 now flags manipulative, coercive, or injection-style text with additive risk metadata.',
      items: [
        'Prompt-injection detection',
        'Coercive and overclaim risk labels',
        'Risk-aware learnFromLLM filtering',
        'Structured verify risk metadata',
      ],
    },
    {
      id: 'v2.8',
      title: 'v2.8 Status Dashboard Polish',
      status: 'done',
      summary: 'The dashboard now makes progress, remaining phases, and current focus easier to scan at a glance.',
      items: [
        'Progress percentage',
        'Remaining phase count',
        'Current focus clarity',
        'Dashboard readability polish',
      ],
    },
    {
      id: 'v2.9',
      title: 'v2.9 Evidence Polish',
      status: 'done',
      summary: 'KernelV2 verify now adds compact explanation and evidence summary fields for clearer reasoning traces.',
      items: [
        'Verify explanation text',
        'Compact evidence summary',
        'Risk-aware reasoning polish',
        'MCP schema exposure',
      ],
    },
    {
      id: 'v3.0',
      title: 'v3.0 Agent Workflow',
      status: 'in_progress',
      summary: 'AXIOM now has a lightweight multi-step agent planner with persistent goal memory, tool selection policy, and execution reports.',
      items: [
        'Goal planner',
        'Persistent goal memory',
        'Multi-step execution loop',
        'Tool selection policy',
        'CLI agent commands',
      ],
    },
  ];

  const counts = phases.reduce((acc, phase) => {
    acc.total += 1;
    acc[phase.status] += 1;
    return acc;
  }, { total: 0, done: 0, in_progress: 0, pending: 0 });
  const progressPercent = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;
  const remainingPhases = Math.max(0, counts.total - counts.done);

  return {
    ok: true,
    version: pkg.version,
    contractVersion: cli.kernel.contractVersion || '1.0.0',
    activeKernel,
    backend: stats.backend,
    nodes: stats.nodes,
    edges: stats.edges,
    testStatus: computeTestStatus(),
    lastCommit: getLastCommit(),
    updatedAt: new Date().toISOString(),
    counts,
    progressPercent,
    remainingPhases,
    phases,
    currentFocus: 'v3.0 Agent Workflow',
    nextAction: 'Use the planner to run goal-driven multi-step tasks, persist the goal history, and report each tool decision clearly.',
    agentRuntime,
    agentRuntimeMode,
    checkpointBackend,
    agentV3Status: agentRuntime === 'v3' ? getAgentV3Status() : null,
    agentCheckpointPath: agentRuntime === 'v3' ? persistence.dbPath : 'agent.memory.json',
    persistencePaths: persistence,
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

  // â”€â”€ /graph-data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    if (req.method !== 'POST' && req.method !== 'GET') {
      writeJson(req, res, 405, { error: 'Method not allowed' });
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

    if (req.method === 'POST') {
      if (!denyIfUnauthorized(req, res)) return;
      const data = await parseJsonRequest(req, res, { maxBytes: 4_096 });
      if (!data) return;
      sendVerifyResult(data.statement || data.text || '', data.workspaceId || '');
      return;
    }

    sendVerifyResult(reqUrl.searchParams.get('statement') || '', reqUrl.searchParams.get('workspaceId') || '');
    return;
  }

  // â”€â”€ /llm-sor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    if (req.method !== 'POST' && req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (req.method === 'POST') {
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
    const text = sanitizeInput(reqUrl.searchParams.get('statement') || '');
    const workspaceId = sanitizeInput(reqUrl.searchParams.get('workspaceId') || '');
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'statement parametresi gerekli' }));
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
      res.end(JSON.stringify({ result: 'âŒ Boş girdi.' }));
      return;
    }
    const p = cli.parse(q);
    let result;
    if (!p) {
      result = 'âŒ Anlamadım.';
    } else if (p.command === 'kaydet') {
      result = '⚠️ Kaydet komutu sadece CLI\'dan kullanılabilir.';
    } else {
      try {
        // Some commands may be sync today and async tomorrow.
        // Normalize here so API never leaks "[object Promise]".
        result = await Promise.resolve(cli.execute(p.command, p.args));
      } catch (err) {
        console.error('[API hata]', err.code || err.name || 'internal');
        result = 'âŒ İşlem sırasında hata oluştu.';
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

  // â”€â”€ Ana sayfa â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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


