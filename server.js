const {
  readCompatibleEnvironmentVariable,
  validateEnvironmentCompatibility,
} = require('./lib/environment-compat');
validateEnvironmentCompatibility();

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { readFileSync } = require('fs');
const { createKernel, CANONICAL_KERNEL_VERSION } = require('./lib/kernel-factory');
const { CANONICAL_AGENT_VERSION, createAgent } = require('./agentRuntime');
const { parseCommand } = require('./lib/command-parser');
const { evaluateLlmSor, llmSorCheckFields } = require('./lib/shield');
const {
  toPublicVerifyPayload,
  toPublicVerifyEnvelope,
} = require('./lib/verify-status-vocabulary');
const { handleIngest, buildIngestApprovalSnapshot, sha256 } = require('./lib/ingest');
const HuqanStorage = require('./storage');
const { decideIngestApproval } = require('./lib/workbench/ingest-approval-action');
const { createHttpIngestOversightCase } = require('./lib/http-human-oversight-adapter');
const { buildTrustReceipt, queryAuditTrailPage, queryCandidateClaims, queryProvenance } = require('./lib/provenance-query');
const { readReceiptById } = require('./lib/receipt/receipt-read-index');
const { receiptReadFailure } = require('./lib/http/receipt-read-failures');
const { createWorkbenchReadHttpRouter } = require('./lib/workbench/workbench-read-http-router');
const { resolveRouteAuthPolicy } = require('./lib/http/route-auth-policy');
const { handleWorkflowContractRoute, writeUnavailableWorkflow } = require('./lib/http/workflow-contract-route');
const { createReadWorkflowHttpRouter } = require('./lib/http/read-workflow-actions');
const { createWorkflowDataRoutes } = require('./lib/http/workflow-data-routes');
const { readExactWorkspace } = require('./lib/http/exact-workspace');
const { createSessionStore } = require('./lib/viewer/session-store');
const { createViewerGateway } = require('./lib/viewer/viewer-gateway');
const { createExternalClientProductionBoundary } = require('./lib/external-client-production-boundary');
const { createOptionalRouteBoundaries } = require('./lib/http/optional-boundaries');
const { projectUploadAdmission } = require('./lib/http/upload-admission-contract');
const { createMutationAdmission } = require('./lib/mutation-admission');
const { createIngestApprovalAuditWriter } = require('./lib/workbench/ingest-approval-audit-writer');
const { createTrustEvidenceLedger } = require('./lib/trust-evidence-ledger');
const pkg = require('./package.json');
const {
  DEFAULT_MAX_UPLOAD_BODY,
  DEFAULT_MAX_JSON_BODY,
  checkRateLimit,
  clearExpiredRateLimitEntries,
  isAllowedPublicCommand,
  commandRequiresAuthentication,
  isUnsafePublicApiCommand,
  readJsonBody,
  requireApiKey,
  sanitizeInput,
} = require('./requestGuards');
const kernelOpts = {};
const configuredMemoryPath = readCompatibleEnvironmentVariable('MEMORY_PATH');
const configuredDbPath = readCompatibleEnvironmentVariable('DB_PATH');
if (configuredMemoryPath) kernelOpts.memoryPath = configuredMemoryPath;
if (configuredDbPath) kernelOpts.dbPath = configuredDbPath;
if (readCompatibleEnvironmentVariable('USE_SQLITE') === 'false') kernelOpts.useSQLite = false;
const kernel = createKernel(kernelOpts);
kernel.graph.load();
const externalClientBoundary = createExternalClientProductionBoundary({
  environment: process.env,
  graph: kernel.graph,
});
const optionalRoutes = createOptionalRouteBoundaries({ memoryApproval: { kernel, getParseJsonRequest: () => parseJsonRequest, getWriteJson: () => writeJson, approvalRuntime: () => ({ approvalStore: getIngestApprovalStore() }) } });
let companyRuntimeReady = false;
let ingestApprovalStore = null;
const INGEST_APPROVAL_WORKER_ID = `http-ingest-${crypto.randomUUID()}`;
const INGEST_APPROVAL_LEASE_MS = Math.max(30_000, Math.min(900_000, Number(readCompatibleEnvironmentVariable('INGEST_APPROVAL_LEASE_MS')) || 120_000));

function getIngestApprovalStore() {
  if (ingestApprovalStore) return ingestApprovalStore;
  ingestApprovalStore = new HuqanStorage({ kernel });
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

// P1's first caller routed through the mutation admission seam. The context it
// has to build lives in the writer rather than here, so this file keeps gaining
// wiring and delegation only (ARCH-001).
const trustEvidenceLedger = createTrustEvidenceLedger({ graph: kernel.graph });
let httpHumanOversightConfig = null;
let httpAgentIdentityConfig = null;

function configureHttpHumanOversight(config = null) {
  if (config === null || config === undefined) {
    httpHumanOversightConfig = null;
    return null;
  }
  const runtime = config.runtime || config.humanOversightApprovalRuntime;
  if (!runtime || typeof runtime.createReviewCase !== 'function'
      || typeof runtime.getReviewCase !== 'function'
      || typeof runtime.decide !== 'function'
      || typeof runtime.executeApproved !== 'function') {
    throw new TypeError('human oversight approval runtime is required');
  }
  httpHumanOversightConfig = Object.freeze({ ...config, runtime });
  return httpHumanOversightConfig;
}

function configureHttpAgentIdentity(config = null) {
  if (config === null || config === undefined) {
    httpAgentIdentityConfig = null;
    return null;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)
      || !config.action || typeof config.action !== 'object' || Array.isArray(config.action)) {
    throw new TypeError('agent identity runtime config with action is required');
  }
  httpAgentIdentityConfig = Object.freeze({ ...config, action: Object.freeze({ ...config.action }) });
  return httpAgentIdentityConfig;
}

function getHttpApprovalRuntimeConfig() {
  if (!httpHumanOversightConfig && httpAgentIdentityConfig === null) return null;
  return Object.freeze({
    ...(httpHumanOversightConfig || {}),
    ...(httpAgentIdentityConfig !== null ? { agentIdentityRuntime: httpAgentIdentityConfig } : {}),
  });
}

const recordIngestApprovalAudit = createIngestApprovalAuditWriter({
  graph: kernel.graph,
  admission: createMutationAdmission(),
  hashResult: sha256,
  ledger: trustEvidenceLedger,
});

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

const {
  ALLOWED_CORS_HOSTS,
  JSON_CONTENT_TYPE,
  isSafeOrigin,
  buildCorsHeaders,
  memoryContextSecurityHeaders,
  writeJson,
  writeApiError,
  sendOptions,
  getRateLimitKey,
  getSafeMemoryLabel,
  newIngestApprovalId,
  publicIngestApproval,
  legacyVerify,
} = require('./lib/server-response-helpers');

const {
  TRUST_FILTER_MAX_ID,
  TRUST_FILTER_MAX_REF,
  TRUST_FILTER_MAX_ENUM,
  TRUST_RECEIPT_READ_PREFIX,
  readTrustFilters,
  hasTrustQuery,
  readPathReceiptId,
} = require('./lib/http-trust-query');
const { runPublicApiCommand } = require('./lib/http/public-api-commands');
const { V2_STATUS_PHASES } = require('./lib/http/v2-status-phases');
const { buildGraphData } = require('./lib/server-graph-data');

async function submitIngestApproval(data) {
  const snapshot = buildIngestApprovalSnapshot(data);
  if (!snapshot.ok) return { status: snapshot.code === 'INGEST_WORKSPACE_UNSUPPORTED' ? 400 : 409, error: { code: snapshot.code || 'INGEST_SNAPSHOT_REQUIRED', message: snapshot.error || 'Ingest cannot be queued safely.' } };
  try {
    const store = getIngestApprovalStore();
    const approvalKey = `http.ingest.${snapshot.sourceType}.${snapshot.idempotencyKey}.${snapshot.snapshotHash}`;
    const saved = store.saveToolApprovalIfAbsent({
      id: newIngestApprovalId(), approvalKey, tool: 'http.ingest', input: JSON.stringify(snapshot.payload),
      status: 'pending', decision: 'review', reason: 'http_ingest_requires_review',
      context: {
        source: 'http-ingest',
        snapshot,
        ...(httpHumanOversightConfig ? { oversightRequired: true } : {}),
      },
      policy: { action: 'ingest', approval: 'review', snapshotIntegrity: 'sha256' },
    });
    const oversightCase = httpHumanOversightConfig
      ? createHttpIngestOversightCase({ approval: saved.approval, humanOversight: getHttpApprovalRuntimeConfig() })
      : { enabled: false, ok: true };
    if (oversightCase.enabled && !oversightCase.ok) {
      return {
        status: 503,
        error: {
          code: 'REVIEW_CASE_NOT_PERSISTED',
          message: 'Human Oversight review case was not durably recorded; ingest remains unexecuted.',
        },
      };
    }
    return {
      status: saved.approval.status === 'pending' ? 202 : 200,
      json: {
        ok: true,
        status: saved.approval.status,
        idempotent: !saved.inserted,
        approval: publicIngestApproval(saved.approval),
        ...(oversightCase.enabled ? { oversight: oversightCase.summary } : {}),
      },
    };
  } catch (_) {
    return { status: 503, error: { code: 'APPROVAL_STORE_UNAVAILABLE', message: 'Persistent ingest approval store is unavailable.' } };
  }
}

const handleWorkflowDataRoute = createWorkflowDataRoutes({ getApprovalStore: getIngestApprovalStore, decideApproval: ({ approvalId, decision, reason }) => decideIngestApproval({ store: getIngestApprovalStore(), kernel, approvalId, decision, reason, humanOversight: getHttpApprovalRuntimeConfig(), handleIngest, ensureRuntime: ensureCompanyRuntime, recordAudit: recordIngestApprovalAudit, toPublicApproval: publicIngestApproval, workerId: INGEST_APPROVAL_WORKER_ID, leaseMs: INGEST_APPROVAL_LEASE_MS }), readReceipt: (receiptId, filters) => readReceiptById(kernel.graph, receiptId, filters), parseJsonRequest, writeJson, learnDocument: (text, options) => kernel.learnDocument(text, options), submitIngest: submitIngestApproval, createAgent: () => createAgent({ kernel, version: readCompatibleEnvironmentVariable('AGENT_VERSION') }) });

// First caller of the V5 runtime family (#875 task pack). Issuer key records
// are dependency-injected as receiver-owned state: with no real registry
// populated yet the resolver answers every issuer as unknown and the route
// stays fail-closed. No issuer record may ever come from the request body.
const issuerTrustedKeyRecords = [];
let v5PackageImportRouteCache = null;
function handleV5PackageImportRoute(req, res, reqUrl) {
  // Lazy load: the V5 runtime family is repo-only (4C1 keeps the installed
  // tarball minimal), so server.js must still load when the V5 module cannot
  // be required. The route is activated by request, never at boot.
  if (v5PackageImportRouteCache === null) {
    try {
      const { createV5PackageImportRoute, createReceiverTrustedKeyResolver } = require('./lib/http/v5-package-import-route');
      v5PackageImportRouteCache = createV5PackageImportRoute({
        parseJsonRequest,
        trustedKeyResolver: createReceiverTrustedKeyResolver({ issuerRecords: issuerTrustedKeyRecords }),
        auditTarget: kernel.graph,
      });
    } catch (_) {
      // V5 module not available in this installation (installed tarball):
      // the endpoint stays permanently unavailable instead of booting broken.
      v5PackageImportRouteCache = () => false;
    }
  }
  return v5PackageImportRouteCache(req, res, reqUrl);
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

function getGraphData(workspaceId = 'default') {
  return buildGraphData({ graph: kernel.graph, memory: kernel.memory, getSafeMemoryLabel, workspaceId });
}

function getHealthData() {
  const stats = kernel.graph.getStats();
  return {
    ok: true,
    // Canonical product identity (RFC-001). `legacyService` keeps the AXIOM
    // spelling readable for existing health probes during the compatibility
    // window; it is not a second product identity.
    service: 'huqan',
    legacyService: 'axiom',
    kernelVersion: CANONICAL_KERNEL_VERSION, // canonical constant, not the selector (#755)
    backend: stats.backend,
    nodes: stats.nodes,
    edges: stats.edges,
    uptimeSec: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

function getV2StatusData() {
  const stats = kernel.graph.getStats();
  // #755: from the canonical constants, not the optional version selectors.
  // With those absent (the normal configuration) the process ran KernelV2 and
  // AgentV3 while status advertised v1/v2.
  const activeKernel = CANONICAL_KERNEL_VERSION;
  const agentRuntime = CANONICAL_AGENT_VERSION;
  const agentRuntimeMode = String(readCompatibleEnvironmentVariable('AGENT_RUNTIME') || '').toLowerCase() || agentRuntime;
  const checkpointBackend = agentRuntime === 'v3' ? 'sqlite' : 'json';
  const phases = V2_STATUS_PHASES;

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
const handleReadWorkflow = createReadWorkflowHttpRouter({ kernel, parseJsonRequest, writeJson, writeApiError, ensureCapabilities: ensureCompanyRuntime });
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
    externalClientRouteEnabled: externalClientBoundary !== null, ...optionalRoutes.authContext,
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

  if (externalClientBoundary && reqUrl.pathname === externalClientBoundary.path) {
    const descriptor = await externalClientBoundary.handle(req);
    res.writeHead(descriptor.statusCode, descriptor.headers);
    res.end(JSON.stringify(descriptor.body));
    return;
  }

  if (await optionalRoutes.route(req, res, reqUrl)) return;
  if (await handleV5PackageImportRoute(req, res, reqUrl)) return;
  if (handleWorkflowContractRoute(req, res, reqUrl) || await handleReadWorkflow(req, res, reqUrl)) return;
  if (await handleWorkflowDataRoute(req, res, reqUrl)) return;
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
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
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
        'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
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
        writeJson(req, res, 400, { error: 'claim, statement or text is required' });
        return;
      }
      try {
        const normalizedWorkspaceId = sanitizeInput(workspaceId || reqUrl.searchParams.get('workspaceId') || '');
        const result = kernel.verify(text, normalizedWorkspaceId ? { workspaceId: normalizedWorkspaceId } : {});
        // Boundary projection only — the kernel envelope itself is unchanged.
        writeJson(req, res, 200, toPublicVerifyEnvelope(result), { 'Cache-Control': 'no-cache' });
      } catch (err) {
        console.error('[v2/verify]', err);
        writeJson(req, res, 500, { error: 'Internal server error' });
      }
    };

    if (req.method === 'POST') {
      if (!denyIfUnauthorized(req, res)) return;
      const data = await parseJsonRequest(req, res, { maxBytes: 4_096 });
      if (!data) return;
      sendVerifyResult(data.claim || data.statement || data.text || '', data.workspaceId || '');
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
      res.end(JSON.stringify({ error: 'question is required' }));
      return;
    }

    try {
      // HUQAN pre-verification
      const huqanCheck = legacyVerify(kernel.verify(question, workspaceId ? { workspaceId } : {}));

      // LLM'ye sor
      const LLMAdapter = require('./llmAdapter');
      const llm = new LLMAdapter();
      const llmRes = await llm.ask(question);

      if (!llmRes.ok) {
        res.writeHead(200, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
        res.end(JSON.stringify({
          ok: false,
          error: llmRes.error,
          ...llmSorCheckFields(huqanCheck),
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
        huqanCheck,
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
        ...llmSorCheckFields(huqanCheck),
        // normalizeCheck() now yields canonical status, so this projection is
        // a no-op for it; kept because the guard also accepts legacy input.
        llmCheck: toPublicVerifyPayload(shield.llmCheck),
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
      // `claim` is the canonical English input field. `statement` and `text`
      // remain accepted as compatibility spellings (RFC-001 reader rule).
      const text = sanitizeInput(data.claim || data.statement || data.text || '');
      const workspaceId = sanitizeInput(data.workspaceId || reqUrl.searchParams.get('workspaceId') || '');
      if (!text) {
        res.writeHead(400, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
        res.end(JSON.stringify({ error: 'claim, statement or text is required' }));
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
      res.end(JSON.stringify({ error: 'Payload too large (max 1MB)' }));
      return;
    }
    const data = await parseJsonRequest(req, res, { maxBytes: DEFAULT_MAX_UPLOAD_BODY });
    if (!data) return;
    const text = data.text || data.content || '';
    if (!text) {
      res.writeHead(400, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'text or content is required' }));
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
      const admission = projectUploadAdmission(Array.isArray(learnResult.admissions) ? (learnResult.admissions.find(Boolean) || null) : null);
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
      // A receipt from a broken chain is never served as an ordinary 200, and
      // it is not "not found" either -- it gets its own code (#766).
      const failure = receiptReadFailure(read.status);
      writeJson(req, res, failure.statusCode, {
        ok: false,
        error: { code: failure.code, message: read.error?.message || 'receipt could not be read' },
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
        // Bounded page, not the whole trail (#729). `total` is this page's
        // item count; hasMore/nextCursor carry continuation.
        const page = queryAuditTrailPage(graph, { ...filters, workspaceId });
        const { items, limit, hasMore, nextCursor } = page;
        writeJson(req, res, 200, {
          ok: true,
          data: { items, total: items.length, limit, hasMore, nextCursor, workspaceId },
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
        reason: String(body.reason || ''),
        humanOversight: getHttpApprovalRuntimeConfig(),
        handleIngest,
        ensureRuntime: ensureCompanyRuntime,
        recordAudit: recordIngestApprovalAudit,
        toPublicApproval: publicIngestApproval,
        workerId: INGEST_APPROVAL_WORKER_ID,
        leaseMs: INGEST_APPROVAL_LEASE_MS,
      });
      if (outcome.error) {
        writeApiError(req, res, outcome.status, outcome.error.code, outcome.error.message, outcome.error.details);
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
    const outcome = await submitIngestApproval(data);
    if (outcome.error) writeApiError(req, res, outcome.status, outcome.error.code, outcome.error.message);
    else writeJson(req, res, outcome.status, outcome.json, { 'Cache-Control': 'no-cache' });
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
      writeUnavailableWorkflow(req, res);
      return;
    }
    try {
      const p = parseCommand(q, kernel);

      if (p && (!isAllowedPublicCommand(p.command) || isUnsafePublicApiCommand(p.command))) {
        writeUnavailableWorkflow(req, res);
        return;
      }

      // /api is public, but only for fixed-response commands: `sor`/`durum`
      // read live workspace state, so they need a key (#727).
      if (p && commandRequiresAuthentication(p.command) && !denyIfUnauthorized(req, res)) return;
      let result;
      if (!p) {
        result = 'HATA: Anlamadım.';
      } else if (p.command === 'kaydet') {
        result = '⚠️ Kaydet komutu sadece CLI\'dan kullanılabilir.';
      } else {
        result = runPublicApiCommand(p.command, p.args, kernel);
        if (result === null) {
          writeUnavailableWorkflow(req, res);
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
const HOST = readCompatibleEnvironmentVariable('HOST') || '127.0.0.1';

function startServer(port = PORT, host = HOST) {
  return server.listen(port, host, () => {
    console.log(`🧠 HUQAN web interface: http://${host}:${port}`);
    console.log(`   Graph view: http://${host}:${port} → "Graph" tab`);
  });
}

if (require.main === module && readCompatibleEnvironmentVariable('DISABLE_AUTO_LISTEN') !== '1') {
  startServer(PORT, HOST);
}

server.closeHuqan = server.closeAxiom = () => { // closeAxiom: RFC-001 legacy alias
  clearInterval(ingestApprovalRecoveryTimer);
  viewerRateLimits.clear();
  viewerSessionStore.reset();
  if (ingestApprovalStore && typeof ingestApprovalStore.close === 'function') {
    try { ingestApprovalStore.close(); } catch (_) {}
    ingestApprovalStore = null;
  }
  try { externalClientBoundary?.close(); } catch (_) {}
  kernel.graph.close();
};

server.startServer = startServer;
server.configureHttpHumanOversight = configureHttpHumanOversight;
server.configureHttpAgentIdentity = configureHttpAgentIdentity;
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


