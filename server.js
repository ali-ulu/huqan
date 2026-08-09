const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { readFileSync } = require('fs');
const { createKernel } = require('./lib/kernel-factory');
const { parseCommand } = require('./lib/command-parser');
const { evaluateLlmSor } = require('./lib/shield');
const { handleIngest, buildIngestApprovalSnapshot, sha256 } = require('./lib/ingest');
const AxiomStorage = require('./storage');
const { decideIngestApproval } = require('./lib/workbench/ingest-approval-action');
const {
  buildTrustReceipt,
  queryAuditTrail,
  queryCandidateClaims,
  queryProvenance,
} = require('./lib/provenance-query');
const { readReceiptById } = require('./lib/receipt/receipt-read-index');
const { createWorkbenchReadHttpRouter } = require('./lib/workbench/workbench-read-http-router');
const { resolveRouteAuthPolicy } = require('./lib/http/route-auth-policy');
const { readExactWorkspace } = require('./lib/http/exact-workspace');
const { createSessionStore } = require('./lib/viewer/session-store');
const { createViewerGateway } = require('./lib/viewer/viewer-gateway');
const pkg = require('./package.json');
const {
  DEFAULT_MAX_UPLOAD_BODY,
  DEFAULT_MAX_JSON_BODY,
  checkRateLimit,
  clearExpiredRateLimitEntries,
  extractApiKey,
  isAllowedPublicCommand,
  isUnsafePublicApiCommand,
  readJsonBody,
  requireApiKey,
  sanitizeInput,
} = require('./requestGuards');

const kernelOpts = {};
if (process.env.AXIOM_MEMORY_PATH) kernelOpts.memoryPath = process.env.AXIOM_MEMORY_PATH;
if (process.env.AXIOM_DB_PATH) kernelOpts.dbPath = process.env.AXIOM_DB_PATH;
if (process.env.AXIOM_USE_SQLITE === 'false') kernelOpts.useSQLite = false;

const kernel = createKernel(kernelOpts);
kernel.graph.load();
let companyRuntimeReady = false;
let ingestApprovalStore = null;
const INGEST_APPROVAL_WORKER_ID = `http-ingest-${crypto.randomUUID()}`;
const INGEST_APPROVAL_LEASE_MS = Math.max(30_000, Math.min(900_000, Number(process.env.AXIOM_INGEST_APPROVAL_LEASE_MS) || 120_000));

function getIngestApprovalStore() {
  if (ingestApprovalStore) return ingestApprovalStore;
  ingestApprovalStore = new AxiomStorage({ kernel });
  recoverExpiredIngestApprovals(ingestApprovalStore);
  return ingestApprovalStore;
}

function recoverExpiredIngestApprovals(store = ingestApprovalStore) {
  if (!store || typeof store.recoverExpiredToolApprovals !== 'function') return [];
  return store.recoverExpiredToolApprovals({
    tool: 'http.ingest',
    reason: 'execution_outcome_unknown:lease_expired',
  });
}

function newIngestApprovalId() {
  return `ingest-approval-${crypto.randomUUID()}`;
}

function publicIngestApproval(record) {
  if (!record) return null;
  const context = record.context && typeof record.context === 'object' ? record.context : {};
  return {
    id: record.id,
    status: record.status,
    decision: record.decision,
    reason: record.reason,
    createdAt: Number(record.created_at || record.createdAt || 0),
    updatedAt: Number(record.updated_at || record.updatedAt || 0),
    snapshotHash: context.snapshot?.snapshotHash || '',
    sourceType: context.snapshot?.sourceType || '',
    sourceRef: context.snapshot?.sourceRef || '',
    idempotencyKey: context.snapshot?.idempotencyKey || '',
    leaseExpiresAt: Number(context.executionClaim?.leaseExpiresAt || 0),
    receipt: context.receipt || null,
  };
}

// The workspace comes from the immutable snapshot the action owner validated,
// never from decision-request bytes and never from a hard-coded fallback.
function recordIngestApprovalAudit(approval, receipt, result = null) {
  const snapshot = approval.context?.snapshot || {};
  const resultRef = result ? sha256(result) : '';
  return kernel.graph.appendAuditEvent({
    eventType: receipt.decision === 'approved' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
    targetType: 'ingest_approval',
    targetId: approval.id,
    details: {
      receipt,
      snapshotHash: snapshot.snapshotHash || '',
      pluginResultRef: resultRef,
      actionOutcome: receipt.actionOutcome || '',
      executionGuarantee: 'bounded_action_outcome',
    },
  }, { workspaceId: snapshot.workspaceId });
}

// --- Güvenlik sabitleri ---
const rateLimitCleanupTimer = setInterval(() => {
  clearExpiredRateLimitEntries();
}, 60_000);
rateLimitCleanupTimer.unref?.();
const VIEWER_RATE_LIMIT_WINDOW_MS = 60_000;
const VIEWER_RATE_LIMIT_MAX = 120;
const VIEWER_RATE_LIMIT_MAX_ENTRIES = 2048;
const viewerRateLimits = new Map();
const ingestApprovalRecoveryTimer = setInterval(() => {
  try { recoverExpiredIngestApprovals(); } catch (error) { console.error('[ingest-approval-recovery] failed:', error); }
}, Math.max(5_000, Math.floor(INGEST_APPROVAL_LEASE_MS / 2)));
ingestApprovalRecoveryTimer.unref?.();

function legacyVerify(result) {
  return {
    status: result.data.status,
    confidence: result.data.confidence,
    evidence: result.evidence.map(e => e.text),
  };
}

function runPublicApiCommand(command, args) {
  const normalizedCommand = String(command || '')
    .replace(/\uFEFF/g, '')
    .toLowerCase()
    .replace(/[ç]/g, 'c')
    .replace(/[ğ]/g, 'g')
    .replace(/[ı]/g, 'i')
    .replace(/[ö]/g, 'o')
    .replace(/[ş]/g, 's')
    .replace(/[ü]/g, 'u')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  switch (normalizedCommand) {
    case 'selam':
      return 'Merhaba! Bana bir sey ogretebilir veya soru sorabilirsin.';
    case 'yardim':
      return [
        'AXIOM komutlari:',
        '  "kedi balik yer"          -> bilgi ogrenirim',
        '  "kedi nedir"              -> soruyu cevaplarim',
        '  "neden tavuk"             -> sebep analizi',
        '  "tavuk mu yumurta mi"     -> karsilastirma',
        '  "durum"                   -> sistem durumu',
        '  "ruya"                    -> hipotez uretirim',
        '  "plan: hedef"             -> ajan plani uretirim',
        '  "ajan: hedef"             -> cok adimli ajan calistiririm',
        '  "backup"                  -> calisma durumunu yedeklerim',
        '  "restore[: yol]"          -> en son veya secili yedekten geri yuklerim',
        '  "kaydet"                  -> hafizayi kaydederim',
        '  "llm-sor: soru"           -> LLM tavsiyesi hazirlarim',
        '  "yukle: dosya.txt"        -> dosyadan ogrenirim',
        '  "cikis"                   -> cikis',
      ].join('\n');
    case 'anlamadim':
      return 'Anlamadim. Daha uzun bir cumle yaz veya "yardim" yaz.';
    case 'sor': {
      const result = kernel.ask(args);
      const answer = result.data.answer;
      return answer === 'Bilmiyorum' ? `X ${answer}` : `Cevap: ${answer}`;
    }
    case 'durum': {
      const stats = kernel.graph.getStats();
      const gaps = kernel.detectGaps();
      const contradictions = kernel.detectContradictions();
      let out = `Durum: ${stats.nodes} düğüm, ${stats.edges} kenar, entropi: ${kernel.entropy().toFixed(3)}`;
      if (gaps.length > 0) out += `\n  ${gaps.length} baglantisiz dugum: ${gaps.slice(0, 10).join(', ')}${gaps.length > 10 ? '...' : ''}`;
      for (const item of contradictions.slice(0, 5)) {
        out += `\n  Celiski [${item.type}]: ${item.node} -> ${item.targets.join(', ')}`;
      }
      return out;
    }
    default:
      return null;
  }
}

const ALLOWED_CORS_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

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

// Responses for the workbench memory-context route must never be cached or
// content-sniffed, including the ones produced by generic middleware (rate
// limit, auth) that answers before the route handler runs.
function memoryContextSecurityHeaders(rawPath) {
  return String(rawPath || '').startsWith('/api/workbench/memory-context/')
    ? { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
    : {};
}

function writeJson(req, res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': JSON_CONTENT_TYPE,
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

const TRUST_FILTER_MAX_ID = 128;
const TRUST_FILTER_MAX_REF = 256;
const TRUST_FILTER_MAX_ENUM = 32;
const TRUST_RECEIPT_READ_PREFIX = '/api/trust-receipt/';

function readTrustFilters(reqUrl) {
  const params = reqUrl.searchParams;
  const readId = (name) => sanitizeInput(params.get(name) || '', TRUST_FILTER_MAX_ID);
  const readRef = (name) => sanitizeInput(params.get(name) || '', TRUST_FILTER_MAX_REF);
  const readEnum = (name) => sanitizeInput(params.get(name) || '', TRUST_FILTER_MAX_ENUM);
  return {
    workspaceId: readId('workspaceId'),
    targetId: readId('targetId'),
    provenanceId: readId('provenanceId'),
    sourceRef: readRef('sourceRef'),
    sourceType: readEnum('sourceType'),
    sourceSubType: readEnum('sourceSubType'),
    actor: readId('actor'),
    eventType: readEnum('eventType'),
    candidateId: readId('candidateId'),
    status: readEnum('status'),
    recommendation: readEnum('recommendation'),
    order: readEnum('order'),
    targetType: readEnum('targetType'),
  };
}

function hasTrustQuery(filters, keys) {
  return keys.some((key) => Boolean(filters[key]));
}

function readPathReceiptId(pathname) {
  if (!pathname.startsWith(TRUST_RECEIPT_READ_PREFIX)) return null;
  const rawReceiptId = pathname.slice(TRUST_RECEIPT_READ_PREFIX.length);
  if (!rawReceiptId) return { ok: false, code: 'missing_receipt_id', receiptId: '' };
  try {
    const decoded = decodeURIComponent(rawReceiptId);
    const receiptId = sanitizeInput(decoded, TRUST_FILTER_MAX_ID);
    if (!receiptId) return { ok: false, code: 'invalid_receipt_id', receiptId: '' };
    return { ok: true, receiptId };
  } catch (_) {
    return { ok: false, code: 'invalid_receipt_id', receiptId: '' };
  }
}

function getRateLimitKey(req) {
  const apiKey = extractApiKey(req.headers || {});
  if (apiKey) {
    return 'key:' + crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  }
  if (process.env.AXIOM_TRUST_PROXY === '1') {
    const xffList = String(req.headers?.['x-forwarded-for'] || '').split(',').map(s => s.trim());
    // The FIRST entry in X-Forwarded-For is the original client IP.
    // Only use it when we trust the proxy chain (AXIOM_TRUST_PROXY=1).
    if (xffList.length > 0 && /^[\d.:a-fA-F]+$/.test(xffList[0])) {
      return 'ip:' + xffList[0];
    }
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

function checkViewerRateLimit(req, timestamp = Date.now()) {
  const key = String(req.socket?.remoteAddress || 'unknown');
  let record = viewerRateLimits.get(key);
  if (record && timestamp >= record.resetAt) {
    viewerRateLimits.delete(key);
    record = null;
  }
  if (!record) {
    if (viewerRateLimits.size >= VIEWER_RATE_LIMIT_MAX_ENTRIES) {
      for (const [candidate, entry] of viewerRateLimits) {
        if (timestamp >= entry.resetAt) viewerRateLimits.delete(candidate);
      }
    }
    if (viewerRateLimits.size >= VIEWER_RATE_LIMIT_MAX_ENTRIES) return false;
    record = { count: 0, resetAt: timestamp + VIEWER_RATE_LIMIT_WINDOW_MS };
    viewerRateLimits.set(key, record);
  }
  record.count += 1;
  return record.count <= VIEWER_RATE_LIMIT_MAX;
}

const viewerSessionStore = createSessionStore();
const viewerGateway = createViewerGateway({
  sessionStore: viewerSessionStore,
  readReceipt: (receiptId, filters) => readReceiptById(kernel.graph, receiptId, filters),
});


function denyIfUnauthorized(req, res, extraHeaders = {}) {
  const auth = requireApiKey(req);
  if (auth.ok) return true;
  writeJson(req, res, auth.status, auth.error, { ...auth.headers, ...extraHeaders });
  return false;
}

const handleWorkbenchRead = createWorkbenchReadHttpRouter({
  writeJson,
  writeApiError,
  denyIfUnauthorized,
  readTrustFilters,
  readReceiptById,
});

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

  // Encode HTML entities so content is safe in both textContent and innerHTML contexts
  str = str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

  if (str.length > 100) {
    str = str.substring(0, 97) + '...';
  }
  return str;
}
function getGraphData(workspaceId = 'default') {
  const scope = typeof workspaceId === 'string' && workspaceId.trim() ? workspaceId.trim() : 'default';
  const nodesById = kernel.graph.getNodes(scope);
  const scopedEdges = kernel.graph.getAllEdges(scope);
  const nodeEdges = new Map();
  for (const edge of scopedEdges) {
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
      edgeCount: kernel.graph.getEdges(n.id, scope).length,
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

  const links = scopedEdges
    .filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
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

  if (kernel && kernel.memory && typeof kernel.memory.list === 'function') {
    try {
      const listResult = kernel.memory.list({ workspaceId: scope });
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
          metadata: {
            weight: typeof m.metadata?.weight === 'number' ? m.metadata.weight : undefined,
            tags: Array.isArray(m.metadata?.tags)
              ? m.metadata.tags.slice(0, 10).map(t => String(t || '').slice(0, 64))
              : undefined,
          },
        }));

        const memoryNodeIds = new Set(memoryNodes.map(n => n.id));

        let queryLinksAvailable = typeof kernel.memory.queryLinks === 'function';
        let allLinks = [];
        if (queryLinksAvailable) {
          const linksResult = kernel.memory.queryLinks({ workspaceId: scope });
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
      console.error('[graph-data] kernel.memory access error:', err);
      memoryMetadata.reason = 'kernel.memory access error';
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
  const stats = kernel.graph.getStats();
  return {
    ok: true,
    service: 'axiom',
    kernelVersion: process.env.AXIOM_KERNEL_VERSION === 'v2' ? 'v2' : 'v1',
    backend: stats.backend,
    nodes: stats.nodes,
    edges: stats.edges,
    uptimeSec: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

function getV2StatusData() {
  const stats = kernel.graph.getStats();
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
    contractVersion: kernel.contractVersion || '1.0.0',
    activeKernel,
    backend: stats.backend,
    nodes: stats.nodes,
    edges: stats.edges,
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
  };
}

function ensureCompanyRuntime() {
  if (typeof kernel.hasCapability === 'function' && !kernel.hasCapability('companyMode')) {
    kernel.enableCapability('companyMode');
  }
  if (typeof kernel.hasCapability === 'function' && !kernel.hasCapability('pluginCapabilities')) {
    kernel.enableCapability('pluginCapabilities');
  }
  if (!companyRuntimeReady && kernel.plugins && typeof kernel.plugins.load === 'function') {
    kernel.plugins.load(path.join(__dirname, 'plugins'));
    companyRuntimeReady = true;
  }
}

const PUBLIC_INDEX_PATH = path.join(__dirname, 'public', 'index.html');
// The index page is a static build artifact, so read it once and keep the bytes
// in memory instead of doing sync I/O on every `/` request (#420).
//
// Cached lazily rather than at module load: server.js is required directly by
// the test suite, and reading at load time would turn a missing/unreadable
// public/index.html into a require-time crash instead of a 500 on `/`. A failed
// read is not cached either, so fixing the file recovers without a restart.
let cachedHtmlPage = null;
function getHtmlPage() {
  if (cachedHtmlPage === null) {
    cachedHtmlPage = readFileSync(PUBLIC_INDEX_PATH);
  }
  return cachedHtmlPage;
}


const server = http.createServer(async (req, res) => {
  try {
  res.setHeader('Connection', 'close');
  const rawPath = String(req.url || '').split('?', 1)[0].split('#', 1)[0];
  if (viewerGateway.isViewerPath(rawPath)) {
    if (!checkViewerRateLimit(req)) {
      res.writeHead(429, { 'Content-Type': JSON_CONTENT_TYPE, 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: { code: 'rate_limited', message: 'Too many requests' } }));
      return;
    }
    const viewerUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    await viewerGateway.handle(req, res, viewerUrl);
    return;
  }
  if (req.method === 'OPTIONS') {
    sendOptions(req, res);
    return;
  }

  const rateKey = getRateLimitKey(req);

  if (!checkRateLimit(rateKey)) {
    res.writeHead(429, {
      'Content-Type': JSON_CONTENT_TYPE,
      ...memoryContextSecurityHeaders(rawPath),
    });
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // --- Central route authorization gate (issue #330) ---
  // Authorization is decided by lib/http/route-auth-policy.js before any
  // handler runs, so a newly added endpoint is authenticated by default
  // instead of being silently public. Unknown paths are deliberately NOT
  // challenged: they fall through to the generic 404 below, so a 401 never
  // confirms the existence of an unrouted path.
  const routeAuthPolicy = resolveRouteAuthPolicy(reqUrl.pathname, req.method, {
    workspaceId: sanitizeInput(reqUrl.searchParams.get('workspaceId') || ''),
  });
  // The memory-context route hardens every one of its own responses with
  // no-store/nosniff, but this central gate answers 401 before that handler
  // ever runs, so the headers have to be carried here too -- same reason the
  // rate-limit branch above special-cases the prefix.
  if (routeAuthPolicy.authRequired
    && !denyIfUnauthorized(req, res, memoryContextSecurityHeaders(rawPath))) return;
  // An undeclared path must never reach a handler. If one is added without a
  // policy entry it is answered as 404 here rather than executing
  // unauthenticated, so the declaration is enforced at runtime and not only by
  // test/route-auth-policy.test.js. 404 (not 401) preserves non-disclosure.
  if (!routeAuthPolicy.known) {
    res.writeHead(404, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // --- /graph-data ---
  if (reqUrl.pathname === '/graph-data') {
    if (req.method !== 'GET') {
      res.writeHead(405); res.end(); return;
    }
    const rawWorkspaceId = reqUrl.searchParams.get('workspaceId') || '';
    const requestedWorkspaceId = sanitizeInput(rawWorkspaceId);
    const isDefaultScope = !requestedWorkspaceId || requestedWorkspaceId === 'default';
    if (!isDefaultScope && !denyIfUnauthorized(req, res)) return;
    const workspaceId = requestedWorkspaceId || 'default';
    try {
      const data = getGraphData(workspaceId);
      res.writeHead(200, {
        'Content-Type': JSON_CONTENT_TYPE,
        ...buildCorsHeaders(req),
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('[graph-data]', err);
      writeJson(req, res, 500, { error: 'Internal server error' });
    }
    return;
  }

  if (reqUrl.pathname === '/v2-status') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    try {
      const data = getV2StatusData();
      res.writeHead(200, {
        'Content-Type': JSON_CONTENT_TYPE,
        ...buildCorsHeaders(req),
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('[v2-status]', err);
      writeJson(req, res, 500, { error: 'Internal server error' });
    }
    return;
  }

  if (reqUrl.pathname === '/health') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    try {
      res.writeHead(200, {
        'Content-Type': JSON_CONTENT_TYPE,
        ...buildCorsHeaders(req),
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(getHealthData()));
    } catch (err) {
      console.error('[health]', err);
      writeJson(req, res, 500, { error: 'Internal server error' });
    }
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
      try {
        const normalizedWorkspaceId = sanitizeInput(workspaceId || reqUrl.searchParams.get('workspaceId') || '');
        const result = kernel.verify(text, normalizedWorkspaceId ? { workspaceId: normalizedWorkspaceId } : {});
        writeJson(req, res, 200, result, { 'Cache-Control': 'no-cache' });
      } catch (err) {
        console.error('[v2/verify]', err);
        writeJson(req, res, 500, { error: 'Internal server error' });
      }
    };

    if (req.method === 'POST') {
      if (!denyIfUnauthorized(req, res)) return;
      const data = await parseJsonRequest(req, res, { maxBytes: 4_096 });
      if (!data) return;
      sendVerifyResult(data.statement || data.text || '', data.workspaceId || '');
      return;
    }

    writeJson(req, res, 405, { error: 'Method not allowed' });
    return;
  }

  // --- /llm-sor ---
  if (reqUrl.pathname === '/llm-sor') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
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
      res.writeHead(400, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'question gerekli' }));
      return;
    }

    try {
      // AXIOM ön doğrulama
      const axiomCheck = legacyVerify(kernel.verify(question, workspaceId ? { workspaceId } : {}));

      // LLM'ye sor
      const LLMAdapter = require('./llmAdapter');
      const llm = new LLMAdapter();
      const llmRes = await llm.ask(question);

      if (!llmRes.ok) {
        res.writeHead(200, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
        res.end(JSON.stringify({
          ok: false,
          error: llmRes.error,
          axiomCheck,
        }));
        return;
      }

      const llmText = llmRes.data.text;

      // LLM yanıtını doğrula
      const llmCheck = legacyVerify(kernel.verify(llmText.slice(0, 300), workspaceId ? { workspaceId } : {}));

      const shield = evaluateLlmSor({
        kernel: kernel,
        question,
        llmText,
        axiomCheck,
        llmCheck,
        autoLearn,
        maxSentences: 15,
        workspaceId,
      });

      res.writeHead(200, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
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
    } catch (err) {
      console.error('[llm-sor]', err);
      writeJson(req, res, 500, { error: 'Internal server error' });
    }
    return;
  }
  if (reqUrl.pathname === '/dogrula' || reqUrl.pathname === '/verify') {
    if (req.method !== 'POST' && req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
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
        res.writeHead(400, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
        res.end(JSON.stringify({ error: 'statement veya text gerekli' }));
        return;
      }
      try {
        const result = legacyVerify(kernel.verify(text, workspaceId ? { workspaceId } : {}));
        res.writeHead(200, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('[dogrula]', err);
        writeJson(req, res, 500, { error: 'Internal server error' });
      }
      return;
    }
    writeJson(req, res, 405, { error: 'Method not allowed' });
    return;
  }
  if (reqUrl.pathname === '/yukle' || reqUrl.pathname === '/upload') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!denyIfUnauthorized(req, res)) return;
    const contentLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > DEFAULT_MAX_UPLOAD_BODY) {
      res.writeHead(413, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'İçerik çok büyük (max 1MB)' }));
      return;
    }
    const data = await parseJsonRequest(req, res, { maxBytes: DEFAULT_MAX_UPLOAD_BODY });
    if (!data) return;
    const text = data.text || data.content || '';
    if (!text) {
      res.writeHead(400, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'text veya content gerekli' }));
      return;
    }
    const workspaceId = sanitizeInput(data.workspaceId || reqUrl.searchParams.get('workspaceId') || '');
    const suppliedActors = [data.actor, data.provenance?.actor]
      .map(actor => sanitizeInput(actor || ''))
      .filter(Boolean);
    if (suppliedActors.some(actor => actor !== 'http-api')) {
      writeApiError(req, res, 400, 'ACTOR_MISMATCH', 'actor is derived from the authenticated HTTP boundary.');
      return;
    }
    try {
      const learnResult = kernel.learnDocument(text, {
        returnDetails: true,
        workspaceId,
        sourceType: sanitizeInput(data.sourceType || '') || 'upload',
        sourceRef: sanitizeInput(data.sourceRef || '') || reqUrl.pathname,
        sourceTitle: sanitizeInput(data.sourceTitle || '') || 'HTTP upload',
        actor: 'http-api',
        approvalRequired: true,
        provenance: data.provenance && typeof data.provenance === 'object' ? data.provenance : undefined,
      });
      const admission = Array.isArray(learnResult.admissions) ? (learnResult.admissions.find(Boolean) || null) : null;
      res.writeHead(200, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ ok: true, learned: learnResult.learned, admission }));
    } catch (err) {
      console.error('[yukle]', err);
      writeJson(req, res, 500, { error: 'Internal server error' });
    }
    return;
  }

  if (reqUrl.pathname === '/api/ingest/status') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    try {
      ensureCompanyRuntime();
      const status = await kernel.runCapability('ingestStatus', {});
      writeJson(req, res, 200, status, { 'Cache-Control': 'no-cache' });
    } catch (err) {
      console.error('[ingest-status] failed:', err);
      writeJson(req, res, 500, { error: 'ingest status failed' });
    }
    return;
  }

  const receiptReadRequest = readPathReceiptId(reqUrl.pathname);
  if (receiptReadRequest) {
    if (req.method !== 'GET') {
      writeApiError(req, res, 405, 'method_not_allowed', 'Method not allowed');
      return;
    }
    if (!denyIfUnauthorized(req, res)) return;
    if (!receiptReadRequest.ok) {
      writeJson(req, res, 400, {
        ok: false,
        error: {
          code: receiptReadRequest.code,
          message: receiptReadRequest.code === 'missing_receipt_id'
            ? 'receiptId is required'
            : 'receiptId must be a non-empty string',
        },
      }, { 'Cache-Control': 'no-cache' });
      return;
    }
    const workspace = readExactWorkspace(reqUrl.searchParams);
    if (!workspace.ok) {
      writeApiError(req, res, 400, workspace.code, 'Exactly one non-empty workspaceId is required.');
      return;
    }
    const filters = readTrustFilters(reqUrl);
    const readFilters = { workspaceId: workspace.workspaceId };
    const read = readReceiptById(kernel.graph, receiptReadRequest.receiptId, readFilters);
    if (!read.ok) {
      const code = read.status === 'not_found' ? 'receipt_not_found' : 'invalid_receipt_id';
      writeJson(req, res, read.status === 'not_found' ? 404 : 400, {
        ok: false,
        error: {
          code,
          message: read.error?.message || 'receipt could not be read',
        },
      }, { 'Cache-Control': 'no-cache' });
      return;
    }
    writeJson(req, res, 200, {
      ok: true,
      receipt: read.receipt,
    }, { 'Cache-Control': 'no-cache' });
    return;
  }

  if (handleWorkbenchRead(req, res, reqUrl, kernel.graph)) return;

  if (reqUrl.pathname === '/api/provenance' || reqUrl.pathname === '/api/audit' || reqUrl.pathname === '/api/candidate-claims' || reqUrl.pathname === '/api/trust-receipt') {
    if (req.method !== 'GET') {
      writeApiError(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return;
    }
    if (!denyIfUnauthorized(req, res)) return;
    const exactWorkspaceRequired = reqUrl.pathname === '/api/audit'
      || reqUrl.pathname === '/api/trust-receipt';
    const workspace = exactWorkspaceRequired ? readExactWorkspace(reqUrl.searchParams) : null;
    if (workspace && !workspace.ok) {
      writeApiError(req, res, 400, workspace.code, 'Exactly one non-empty workspaceId is required.');
      return;
    }
    const filters = readTrustFilters(reqUrl);
    const workspaceId = workspace ? workspace.workspaceId : (filters.workspaceId || 'default');
    const graph = kernel.graph;
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
      console.error('[trust-query] failed:', err);
      writeApiError(req, res, 500, 'TRUST_QUERY_FAILED', 'trust query failed');
    }
    return;
  }

  if (reqUrl.pathname === '/api/ingest/approvals') {
    if (req.method !== 'GET') {
      writeApiError(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return;
    }
    if (!denyIfUnauthorized(req, res)) return;
    try {
      recoverExpiredIngestApprovals();
      const limit = Math.min(100, Math.max(1, Number(reqUrl.searchParams.get('limit')) || 50));
      const approvals = getIngestApprovalStore().listUnresolvedToolApprovals(limit)
        .filter(item => item.tool === 'http.ingest')
        .map(publicIngestApproval);
      writeJson(req, res, 200, { ok: true, approvals }, { 'Cache-Control': 'no-cache' });
    } catch (error) {
      writeApiError(req, res, 503, 'APPROVAL_STORE_UNAVAILABLE', 'Persistent ingest approval store is unavailable.');
    }
    return;
  }

  const ingestApprovalMatch = reqUrl.pathname.match(/^\/api\/ingest\/approvals\/([^/]+)$/);
  if (ingestApprovalMatch) {
    if (req.method !== 'POST') {
      writeApiError(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return;
    }
    if (!denyIfUnauthorized(req, res)) return;
    const body = await parseJsonRequest(req, res, { maxBytes: DEFAULT_MAX_JSON_BODY });
    if (!body) return;
    const approvalId = sanitizeInput(decodeURIComponent(ingestApprovalMatch[1]), 256);
    const decision = String(body.decision || '').trim().toLowerCase();
    if (!approvalId || !['approved', 'rejected'].includes(decision)) {
      writeApiError(req, res, 400, 'INVALID_APPROVAL_DECISION', 'approval id and decision approved|rejected are required.');
      return;
    }
    try {
      const store = getIngestApprovalStore();
      recoverExpiredIngestApprovals(store);
      const outcome = await decideIngestApproval({
        store,
        kernel,
        approvalId,
        decision,
        handleIngest,
        ensureRuntime: ensureCompanyRuntime,
        recordAudit: recordIngestApprovalAudit,
        toPublicApproval: publicIngestApproval,
        workerId: INGEST_APPROVAL_WORKER_ID,
        leaseMs: INGEST_APPROVAL_LEASE_MS,
      });
      if (outcome.error) {
        writeApiError(req, res, outcome.status, outcome.error.code, outcome.error.message);
        return;
      }
      writeJson(req, res, outcome.status, outcome.json, { 'Cache-Control': 'no-cache' });
    } catch (error) {
      console.error('[ingest-approval] failed:', error);
      writeApiError(req, res, 500, 'INGEST_APPROVAL_FAILED', 'Ingest approval failed; inspect unresolved approvals.');
    }
    return;
  }

  if (reqUrl.pathname === '/api/ingest') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!denyIfUnauthorized(req, res)) return;
    const data = await parseJsonRequest(req, res, { maxBytes: DEFAULT_MAX_UPLOAD_BODY });
    if (!data) return;
    try {
      const snapshot = buildIngestApprovalSnapshot(data);
      if (!snapshot.ok) {
        writeApiError(req, res, snapshot.code === 'INGEST_WORKSPACE_UNSUPPORTED' ? 400 : 409, snapshot.code || 'INGEST_SNAPSHOT_REQUIRED', snapshot.error || 'Ingest cannot be queued safely.');
        return;
      }
      const store = getIngestApprovalStore();
      const approvalKey = `http.ingest.${snapshot.sourceType}.${snapshot.idempotencyKey}.${snapshot.snapshotHash}`;
      const saved = store.saveToolApprovalIfAbsent({
        id: newIngestApprovalId(), approvalKey, tool: 'http.ingest', input: JSON.stringify(snapshot.payload),
        status: 'pending', decision: 'review', reason: 'http_ingest_requires_review',
        context: { source: 'http-ingest', snapshot },
        policy: { action: 'ingest', approval: 'review', snapshotIntegrity: 'sha256' },
      });
      const approval = publicIngestApproval(saved.approval);
      writeJson(req, res, saved.approval.status === 'pending' ? 202 : 200, {
        ok: true, status: saved.approval.status, idempotent: !saved.inserted, approval,
      }, { 'Cache-Control': 'no-cache' });
    } catch (err) {
      console.error('[ingest] failed:', err);
      writeApiError(req, res, 503, 'APPROVAL_STORE_UNAVAILABLE', 'Persistent ingest approval store is unavailable.');
    }
    return;
  }

  if (reqUrl.pathname === '/api') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    const raw = reqUrl.searchParams.get('q') || '';
    const q = sanitizeInput(raw);
    if (!q) {
      res.writeHead(400, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
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
    try {
      const p = parseCommand(q, kernel);

      if (p && (!isAllowedPublicCommand(p.command) || isUnsafePublicApiCommand(p.command))) {
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
        result = runPublicApiCommand(p.command, p.args);
        if (result === null) {
          res.writeHead(403, {
            'Content-Type': 'application/json; charset=utf-8',
            ...buildCorsHeaders(req),
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(JSON.stringify({ result: 'Bu komut web API üzerinden çalıştırılamaz.' }));
          return;
        }
      }
      res.writeHead(200, {
        'Content-Type': JSON_CONTENT_TYPE,
        ...buildCorsHeaders(req),
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify({ result }));
    } catch (err) {
      console.error('[api]', err);
      writeJson(req, res, 500, { error: 'Internal server error' });
    }
    return;
  }

  // --- Ana sayfa ---
  if (reqUrl.pathname === '/') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...buildCorsHeaders(req) });
      res.end(getHtmlPage());
    } catch (err) {
      console.error('[index]', err);
      writeJson(req, res, 500, { error: 'Internal server error' });
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
  res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    console.error('[server] unhandled error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': JSON_CONTENT_TYPE });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.AXIOM_HOST || '127.0.0.1';

function startServer(port = PORT, host = HOST) {
  return server.listen(port, host, () => {
    console.log(`🧠 AXIOM web arayüzü: http://${host}:${port}`);
    console.log(`   Graf görünümü: http://${host}:${port} → "Graf" sekmesi`);
  });
}

if (require.main === module && process.env.AXIOM_DISABLE_AUTO_LISTEN !== '1') {
  startServer(PORT, HOST);
}

server.closeAxiom = () => {
  clearInterval(ingestApprovalRecoveryTimer);
  viewerRateLimits.clear();
  viewerSessionStore.reset();
  if (ingestApprovalStore && typeof ingestApprovalStore.close === 'function') {
    try { ingestApprovalStore.close(); } catch (_) {}
    ingestApprovalStore = null;
  }
  kernel.graph.close();
};

server.startServer = startServer;
// Exposed for tests that need to assert against the same kernel/graph
// instance the HTTP handlers use (e.g. checking audit events a request
// produced). server.js owns this kernel directly now (#326); it is no
// longer reachable by intercepting a CLI instance server.js used to build.
server.kernel = kernel;
module.exports = server;
module.exports.getRateLimitKey = getRateLimitKey;
// Exposed so the index-page cache (#420) can be asserted directly, without
// having to intercept fs from outside the module.
module.exports.getHtmlPage = getHtmlPage;


