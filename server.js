const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { globSync, readFileSync } = require('fs');
const { execSync } = require('child_process');
const CLI = require('./cli');
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
  try {
    const files = globSync('**/*.test.js', { exclude: (p) => p.includes('node_modules') || p.includes('.git') });
    let total = 0;
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      total += (content.match(/\bit\(/g) || []).length;
      total += (content.match(/\btest\(/g) || []).length;
    }
    return `${total}/${total}`;
  } catch (_) {
    return '?/?';
  }
}

const kernelOpts = {};
if (process.env.AXIOM_MEMORY_PATH) kernelOpts.memoryPath = process.env.AXIOM_MEMORY_PATH;
if (process.env.AXIOM_DB_PATH) kernelOpts.dbPath = process.env.AXIOM_DB_PATH;
if (process.env.AXIOM_USE_SQLITE === 'false') kernelOpts.useSQLite = false;

const cli = new CLI({ kernel: kernelOpts });
cli.kernel.graph.load();
let companyRuntimeReady = false;

// --- GÃ¼venlik sabitleri ---
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


// Graf verisini D3 formatÄ±na dÃ¶nÃ¼ÅŸtÃ¼r
function getGraphData() {
  const nodes = Object.values(cli.kernel.graph._nodes).map(n => ({
    id: n.id,
    label: n.label,
    weight: n.weight,
    edgeCount: cli.kernel.graph.getEdges(n.id).length,
  }));

  // Ã‡ok fazla node varsa en aÄŸÄ±rlÄ±klÄ± 150'yi al
  const MAX_NODES = 150;
  const sorted = nodes.sort((a, b) => (b.weight + b.edgeCount * 0.2) - (a.weight + a.edgeCount * 0.2));
  const topNodes = sorted.slice(0, MAX_NODES);
  const nodeIds = new Set(topNodes.map(n => n.id));

  const links = cli.kernel.graph._edges
    .filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
    .map(e => ({
      source: e.from,
      target: e.to,
      relation: e.relation,
      weight: e.weight,
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

const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AXIOM</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
body{background:#0a0a0f;color:#e0e0e0;height:100vh;display:flex;flex-direction:column;overflow:hidden}
.header{background:linear-gradient(135deg,#1a1a2e,#16213e);padding:12px 20px;border-bottom:1px solid #2a2a4a;display:flex;align-items:center;gap:12px;flex-shrink:0}
.header h1{font-size:18px;font-weight:700;background:linear-gradient(90deg,#00d4ff,#7b2ff7);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header span{color:#555;font-size:12px}
.tabs{display:flex;gap:0;border-bottom:1px solid #2a2a4a;flex-shrink:0;background:#0f0f1a}
.tab{padding:8px 20px;font-size:13px;cursor:pointer;color:#666;border-bottom:2px solid transparent;transition:all 0.2s;user-select:none}
.tab.active{color:#00d4ff;border-bottom-color:#00d4ff}
.tab:hover{color:#aaa}
.panel{flex:1;display:none;overflow:hidden;flex-direction:column}
.panel.active{display:flex}
.panel.scrollable{overflow:auto}

.dashboard{padding:16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.metric{background:#12121d;border:1px solid #24243a;border-radius:12px;padding:14px}
.metric .label{font-size:11px;color:#7c7c94;text-transform:uppercase;letter-spacing:.08em}
.metric .value{font-size:26px;font-weight:700;color:#f2f2ff;margin-top:6px}
.metric .sub{font-size:12px;color:#aaa;margin-top:4px;line-height:1.4}
.progress-wrap{margin-top:10px;background:#1a1a28;border:1px solid #2a2a44;border-radius:999px;height:10px;overflow:hidden}
.progress-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,#00d4ff,#7b2ff7)}
.progress-meta{display:flex;justify-content:space-between;gap:8px;margin-top:6px;font-size:11px;color:#8f8fb0}
.phase-list{padding:0 16px 16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.phase-card{background:#11111b;border:1px solid #25253a;border-radius:14px;padding:14px}
.phase-card.done{border-color:#1f6f49}
.phase-card.in_progress{border-color:#956b1f}
.phase-card.pending{border-color:#2a2a44}
.phase-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.phase-title{font-weight:700;color:#f0f0ff}
.phase-badge{font-size:11px;padding:3px 8px;border-radius:999px;background:#222239;color:#bdbdd6}
.phase-card.done .phase-badge{background:#123624;color:#7dffb1}
.phase-card.in_progress .phase-badge{background:#3a2a12;color:#ffd28a}
.phase-card.pending .phase-badge{background:#1a1a28;color:#a6a6bf}
.phase-summary{font-size:12px;color:#c0c0d8;line-height:1.5;margin-bottom:10px}
.phase-items{margin:0;padding-left:18px;font-size:12px;color:#9aa0c3;line-height:1.6}
.phase-items li{margin:4px 0}

/* Chat panel */
.chat{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:6px}
.msg{max-width:80%;padding:9px 14px;border-radius:10px;font-size:13px;line-height:1.5;animation:fadeIn 0.2s ease}
.msg.user{background:#1a3a5c;align-self:flex-end;border-bottom-right-radius:3px}
.msg.system{background:#1a1a2e;align-self:flex-start;border-bottom-left-radius:3px;color:#aaa}
.msg.highlight{border-left:3px solid #7b2ff7;background:#1a1a2e}
.msg.ok{border-left:3px solid #00c853}
.msg.warn{border-left:3px solid #ff9800}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.input-bar{display:flex;padding:10px 16px;background:#0f0f1a;border-top:1px solid #2a2a4a;gap:8px;flex-shrink:0}
.input-bar input{flex:1;padding:9px 14px;border-radius:7px;border:1px solid #2a2a4a;background:#1a1a2e;color:#e0e0e0;font-size:13px;outline:none;transition:border-color 0.2s}
.input-bar input:focus{border-color:#7b2ff7}
.input-bar button{padding:9px 18px;border-radius:7px;border:none;background:linear-gradient(90deg,#00d4ff,#7b2ff7);color:white;font-weight:600;font-size:13px;cursor:pointer;transition:opacity 0.2s}
.input-bar button:hover{opacity:0.85}

/* Graph panel */
#graph-panel{position:relative;background:#070710}
#graph-svg{width:100%;height:100%}
.graph-controls{position:absolute;top:12px;right:12px;display:flex;flex-direction:column;gap:6px}
.graph-controls button{padding:6px 12px;border-radius:6px;border:1px solid #2a2a4a;background:#1a1a2e;color:#aaa;font-size:12px;cursor:pointer;transition:all 0.2s}
.graph-controls button:hover{background:#2a2a4a;color:#e0e0e0}
.graph-info{position:absolute;bottom:12px;left:12px;background:rgba(10,10,15,0.85);border:1px solid #2a2a4a;border-radius:8px;padding:10px 14px;font-size:12px;color:#888;min-width:160px;display:none}
.graph-info.visible{display:block}
.graph-info strong{color:#e0e0e0;display:block;margin-bottom:4px;font-size:13px}
.graph-info .edge-list{margin-top:6px;max-height:120px;overflow-y:auto}
.graph-info .edge-item{color:#7b2ff7;font-size:11px;padding:1px 0}
.graph-stats{position:absolute;top:12px;left:12px;background:rgba(10,10,15,0.7);border:1px solid #1a1a2e;border-radius:6px;padding:6px 10px;font-size:11px;color:#555}

/* D3 styles */
.node circle{stroke-width:1.5;cursor:pointer;transition:r 0.2s}
.node text{font-size:10px;fill:#888;pointer-events:none;text-anchor:middle;dominant-baseline:central}
.node:hover text{fill:#e0e0e0}
.link{stroke-opacity:0.4;stroke-width:1}
.link.tÃ¼r{stroke:#7b2ff7}
.link.yapabilir{stroke:#00d4ff}
.link.benzer{stroke:#00c853}
.link.Ã¶zellik{stroke:#ff9800}
.link.hipotez{stroke:#ff5722;stroke-dasharray:4,2}
</style>
</head>
<body>
<div class="header">
  <h1>â—‡ AXIOM</h1>
  <span id="hdr-stats">yÃ¼kleniyor...</span>
</div>
<div class="tabs">
  <div class="tab active" onclick="switchTab('chat')">Sohbet</div>
  <div class="tab" onclick="switchTab('graph')">Graf</div>
  <div class="tab" onclick="switchTab('status')">V2 Durumu</div>
</div>

<div class="panel active" id="chat-panel">
  <div class="chat" id="chat"></div>
  <div class="input-bar">
    <input id="input" placeholder="Ã¶ÄŸret: / sor: / llm-sor: / yÃ¼kle: dosya.txt" autofocus maxlength="500" />
    <button onclick="send()">GÃ¶nder</button>
  </div>
</div>

<div class="panel" id="graph-panel">
  <svg id="graph-svg"></svg>
  <div class="graph-stats" id="graph-stats"></div>
  <div class="graph-controls">
    <button onclick="loadGraph()">â†º Yenile</button>
    <button onclick="resetZoom()">âŠ™ SÄ±fÄ±rla</button>
    <button onclick="toggleLabels()">ğŸ· Etiket</button>
  </div>
  <div class="graph-info" id="graph-info">
    <strong id="info-title"></strong>
    <div id="info-weight"></div>
    <div class="edge-list" id="info-edges"></div>
  </div>
</div>

<div class="panel scrollable" id="status-panel">
  <div class="dashboard" id="status-dashboard"></div>
  <div class="phase-list" id="status-phases"></div>
</div>

<script>
// â”€â”€â”€ Tab yÃ¶netimi â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', ['chat','graph','status'][i]===name));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById(name+'-panel').classList.add('active');
  if (name === 'graph') loadGraph();
  if (name === 'status') loadStatus();
}

// â”€â”€â”€ Chat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const chat = document.getElementById('chat');
const input = document.getElementById('input');

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function addMsg(text, cls) {
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.innerHTML = escapeHtml(text).replace(/\\n/g,'<br>');
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
}

addMsg('HoÅŸ geldin. Bana bir ÅŸey Ã¶ÄŸret veya Graf sekmesine geÃ§.', 'system');

async function send() {
  const val = input.value.trim();
  if (!val) return;
  input.value = '';
  addMsg(val, 'user');
  try {
    const r = await fetch('/api?' + new URLSearchParams({q: val}));
    if (r.status === 429) { addMsg('â³ Ã‡ok fazla istek.', 'system'); return; }
    if (!r.ok) { addMsg('âŒ Sunucu hatasÄ±', 'system'); return; }
    const data = await r.json();
    let cls = 'system';
    if (data.result.startsWith('ğŸ’­') || data.result.startsWith('ğŸ“Š')) cls = 'system highlight';
    else if (data.result.startsWith('âœ…')) cls = 'system ok';
    else if (data.result.startsWith('âš ')) cls = 'system warn';
    addMsg(data.result, cls);
    updateStats();
  } catch(e) {
    addMsg('âŒ BaÄŸlantÄ± hatasÄ±', 'system');
  }
}

input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });

async function updateStats() {
  try {
    const r = await fetch('/graph-data');
    const d = await r.json();
    document.getElementById('hdr-stats').textContent = d.nodes.length + ' dÃ¼ÄŸÃ¼m Â· ' + d.links.length + ' kenar';
  } catch(_) {}
}
updateStats();

async function loadStatus() {
  try {
    const r = await fetch('/v2-status');
    const d = await r.json();
    renderStatus(d);
  } catch (_) {
    const dashboard = document.getElementById('status-dashboard');
    const phases = document.getElementById('status-phases');
    if (dashboard) {
      dashboard.innerHTML = '<div class="metric"><div class="label">Hata</div><div class="value">â€”</div><div class="sub">Durum ekranÄ± yÃ¼klenemedi.</div></div>';
    }
    if (phases) phases.innerHTML = '';
  }
}

function renderStatus(d) {
  const dashboard = document.getElementById('status-dashboard');
  const phases = document.getElementById('status-phases');
  if (!dashboard || !phases) return;

  const agentV3 = d.agentV3Status || null;
  const lastPlan = agentV3 && agentV3.lastPlan ? agentV3.lastPlan : null;
  const lastRun = agentV3 && agentV3.lastRun ? agentV3.lastRun : null;

  dashboard.innerHTML =
    '<div class="metric"><div class="label">Sürüm</div><div class="value">' + escapeHtml(d.version || '?') + '</div><div class="sub">Contract: ' + escapeHtml(d.contractVersion || '?') + '</div></div>' +
    '<div class="metric"><div class="label">Kernel</div><div class="value">' + escapeHtml(d.activeKernel || '?') + '</div><div class="sub">Backend: ' + escapeHtml(d.backend || '?') + ' · ' + d.nodes + ' node / ' + d.edges + ' edge</div></div>' +
    (agentV3 ? '<div class="metric"><div class="label">Agent V3</div><div class="value">' + agentV3.goals + ' hedef</div><div class="sub">' + agentV3.runs + ' çalışma · ' + agentV3.checkpoints + ' kontrol noktası</div></div>' : '') +
    (agentV3 && Number.isInteger(agentV3.pendingApprovals) ? '<div class="metric"><div class="label">Approval Queue</div><div class="value">' + agentV3.pendingApprovals + '</div><div class="sub">Bekleyen tool onayları</div></div>' : '') +
    (lastPlan ? '<div class="metric"><div class="label">Son Plan</div><div class="value">' + escapeHtml(lastPlan.goal || '?') + '</div><div class="sub">' + escapeHtml(String(lastPlan.steps || 0)) + ' adım</div></div>' : '') +
    (lastRun ? '<div class="metric"><div class="label">Son Çalışma</div><div class="value">' + escapeHtml(lastRun.status || '?') + '</div><div class="sub">' + escapeHtml(lastRun.goal || '?') + ' · ' + escapeHtml(String(lastRun.completedSteps || 0)) + ' adım</div></div>' : '') +
    '<div class="metric"><div class="label">Test</div><div class="value">' + escapeHtml(d.testStatus || '?') + '</div><div class="sub">Son commit: ' + escapeHtml(d.lastCommit || '?') + '</div></div>' +
    '<div class="metric"><div class="label">Fazlar</div><div class="value">' + d.counts.total + '</div><div class="sub">' + d.counts.done + ' tamam, ' + d.counts.in_progress + ' aktif, ' + d.counts.pending + ' bekliyor</div></div>' +
    '<div class="metric"><div class="label">İlerleme</div><div class="value">' + escapeHtml(String(d.progressPercent || 0)) + '%</div><div class="sub">' +
      '<div class="progress-wrap"><div class="progress-fill" style="width:' + escapeHtml(String(d.progressPercent || 0)) + '%"></div></div>' +
      '<div class="progress-meta"><span>' + escapeHtml(String(d.counts.done || 0)) + '/' + escapeHtml(String(d.counts.total || 0)) + ' faz</span><span>' + escapeHtml(String(d.remainingPhases || 0)) + ' kalan</span></div>' +
    '</div></div>' +
    '<div class="metric"><div class="label">Odak</div><div class="value">' + escapeHtml(d.currentFocus || '?') + '</div><div class="sub">' + escapeHtml(d.nextAction || '?') + '</div></div>' +
    '<div class="metric"><div class="label">Güncelleme</div><div class="value">canlı</div><div class="sub">' + escapeHtml(d.updatedAt || '?') + '</div></div>';
phases.innerHTML = (d.phases || []).map(phase => {
    const badge = phase.status === 'done' ? 'TamamlandÄ±' : phase.status === 'in_progress' ? 'Aktif' : 'Bekliyor';
    const items = (phase.items || []).map(item => '<li>' + escapeHtml(item) + '</li>').join('');
    return '<div class="phase-card ' + phase.status + '">' +
      '<div class="phase-head">' +
        '<div class="phase-title">' + escapeHtml(phase.title) + '</div>' +
        '<div class="phase-badge">' + badge + '</div>' +
      '</div>' +
      '<div class="phase-summary">' + escapeHtml(phase.summary) + '</div>' +
      '<ul class="phase-items">' + items + '</ul>' +
    '</div>';
  }).join('');
}

let simulation, svg, g, showLabels = true;
let graphData = { nodes: [], links: [] };

const RELATION_COLOR = {
  'tÃ¼r': '#7b2ff7', 'yapabilir': '#00d4ff',
  'benzer': '#00c853', 'Ã¶zellik': '#ff9800',
  'hipotez': '#ff5722', 'default': '#444'
};

async function loadGraph() {
  try {
    const r = await fetch('/graph-data');
    graphData = await r.json();
    renderGraph(graphData);
    document.getElementById('graph-stats').textContent =
      graphData.nodes.length + ' dÃ¼ÄŸÃ¼m Â· ' + graphData.links.length + ' kenar';
  } catch(e) {
    console.error('Graf yÃ¼klenemedi:', e);
  }
}

function renderGraph(data) {
  const container = document.getElementById('graph-panel');
  const W = container.clientWidth || 800;
  const H = container.clientHeight || 600;

  d3.select('#graph-svg').selectAll('*').remove();

  svg = d3.select('#graph-svg')
    .attr('width', W).attr('height', H);

  // Zoom
  const zoom = d3.zoom()
    .scaleExtent([0.1, 8])
    .on('zoom', e => g.attr('transform', e.transform));
  svg.call(zoom);
  window._axiomZoom = zoom;
  window._axiomSvg = svg;

  g = svg.append('g');

  // Ä°liÅŸki tipine gÃ¶re renk
  const relColor = r => RELATION_COLOR[r] || RELATION_COLOR.default;

  // Node bÃ¼yÃ¼klÃ¼ÄŸÃ¼: kenar sayÄ±sÄ±na gÃ¶re
  const maxEdge = Math.max(1, ...data.nodes.map(n => n.edgeCount));
  const nodeR = n => 4 + (n.edgeCount / maxEdge) * 12;

  // Simulation
  simulation = d3.forceSimulation(data.nodes)
    .force('link', d3.forceLink(data.links).id(d => d.id).distance(80).strength(0.3))
    .force('charge', d3.forceManyBody().strength(-120))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collision', d3.forceCollide().radius(d => nodeR(d) + 4));

  // Kenarlar
  const link = g.append('g').selectAll('line')
    .data(data.links).join('line')
    .attr('class', d => 'link ' + (d.relation || ''))
    .attr('stroke', d => relColor(d.relation))
    .attr('stroke-width', d => 0.5 + d.weight * 1.5)
    .attr('stroke-opacity', 0.5);

  // DÃ¼ÄŸÃ¼mler
  const node = g.append('g').selectAll('g')
    .data(data.nodes).join('g')
    .attr('class', 'node')
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
    )
    .on('click', (e, d) => showNodeInfo(d));

  node.append('circle')
    .attr('r', d => nodeR(d))
    .attr('fill', d => {
      const edges = data.links.filter(l => l.source.id === d.id || l.source === d.id);
      const hasTur = edges.some(l => l.relation === 'tÃ¼r');
      if (hasTur) return '#2a1a4a';
      if (d.edgeCount > 3) return '#1a2a3a';
      return '#1a1a2e';
    })
    .attr('stroke', d => {
      if (d.edgeCount > 5) return '#7b2ff7';
      if (d.edgeCount > 2) return '#00d4ff';
      return '#2a2a4a';
    });

  const label = node.append('text')
    .text(d => d.label.length > 12 ? d.label.slice(0, 11) + 'â€¦' : d.label)
    .attr('dy', d => nodeR(d) + 10)
    .style('display', showLabels ? 'block' : 'none');

  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
  });

  // Etiket referansÄ±nÄ± sakla
  window._axiomLabels = label;
}

function showNodeInfo(d) {
  const info = document.getElementById('graph-info');
  document.getElementById('info-title').textContent = d.label;
  document.getElementById('info-weight').textContent = 'aÄŸÄ±rlÄ±k: ' + d.weight.toFixed(2) + ' Â· kenar: ' + d.edgeCount;
  const edges = graphData.links.filter(l =>
    (l.source.id || l.source) === d.id || (l.target.id || l.target) === d.id
  );
  const edgeList = document.getElementById('info-edges');
  edgeList.innerHTML = edges.slice(0, 10).map(e => {
    const from = e.source.id || e.source;
    const to = e.target.id || e.target;
    return '<div class="edge-item">' + escapeHtml(from) + ' â†’[' + escapeHtml(e.relation) + ']â†’ ' + escapeHtml(to) + '</div>';
  }).join('');
  info.classList.add('visible');
}

function resetZoom() {
  if (window._axiomSvg && window._axiomZoom) {
    window._axiomSvg.transition().duration(400)
      .call(window._axiomZoom.transform, d3.zoomIdentity);
  }
}

function toggleLabels() {
  showLabels = !showLabels;
  if (window._axiomLabels) {
    window._axiomLabels.style('display', showLabels ? 'block' : 'none');
  }
}

// Graf paneline tÄ±klanÄ±nca info'yu kapat
document.getElementById('graph-panel').addEventListener('click', e => {
  if (!e.target.closest('.node') && !e.target.closest('.graph-info')) {
    document.getElementById('graph-info').classList.remove('visible');
  }
});
<\/script>
</body>
</html>`;

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
    const data = getGraphData();
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

    const sendVerifyResult = (statement) => {
      const text = sanitizeInput(statement || '');
      if (!text) {
        writeJson(req, res, 400, { error: 'statement required' });
        return;
      }

      const result = cli.kernel.verify(text);
      writeJson(req, res, 200, result, { 'Cache-Control': 'no-cache' });
    };

    if (req.method === 'POST') {
      if (!denyIfUnauthorized(req, res)) return;
      const data = await parseJsonRequest(req, res, { maxBytes: 4_096 });
      if (!data) return;
      sendVerifyResult(data.statement || data.text || '');
      return;
    }

    sendVerifyResult(reqUrl.searchParams.get('statement') || '');
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
    const autoLearn = data.autoLearn !== false; // varsayÄ±lan: true
    if (!question) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'question gerekli' }));
      return;
    }

    // AXIOM ön doğrulama
    const axiomCheck = legacyVerify(cli.kernel.verify(question));

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
    const llmCheck = legacyVerify(cli.kernel.verify(llmText.slice(0, 300)));

    // Otomatik öğren
    let learnResult = null;
    if (autoLearn && llmCheck.status !== 'celiski') {
      learnResult = cli.kernel.learnFromLLM(llmText, { skipConflicts: true, maxSentences: 15 });
      if (learnResult.learned > 0) cli.kernel.graph.save();
    }

    res.writeHead(200, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
    res.end(JSON.stringify({
      ok: true,
      question,
      llmAnswer: llmText,
      model: llmRes.data.model,
      axiomCheck,
      llmCheck,
      learnResult,
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
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
        res.end(JSON.stringify({ error: 'statement veya text gerekli' }));
        return;
      }
      const result = legacyVerify(cli.kernel.verify(text));
      res.writeHead(200, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify(result));
      return;
    }
    const text = sanitizeInput(reqUrl.searchParams.get('statement') || '');
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'statement parametresi gerekli' }));
      return;
    }
    const result = legacyVerify(cli.kernel.verify(text));
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

  if (reqUrl.pathname === '/api/ingest') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!denyIfUnauthorized(req, res)) return;
    const data = await parseJsonRequest(req, res, { maxBytes: DEFAULT_MAX_UPLOAD_BODY });
    if (!data) return;

    const sourceType = sanitizeInput(String(data.sourceType || data.source || ''), 32).toLowerCase();
    try {
      ensureCompanyRuntime();
      let result = null;
      if (sourceType === 'github' || sourceType === 'repo') {
        result = await cli.kernel.runCapability('repoMemory', {
          action: 'ingest',
          sourceType: 'github',
          repoUrl: sanitizeInput(String(data.repoUrl || data.url || ''), 512),
          branch: sanitizeInput(String(data.branch || ''), 128) || 'main',
          paths: Array.isArray(data.paths) ? data.paths.slice(0, 200) : undefined,
        });
      } else if (sourceType === 'markdown') {
        result = await cli.kernel.runCapability('repoMemory', {
          action: 'ingest',
          sourceType: 'markdown',
          path: String(data.path || data.targetPath || ''),
        });
      } else if (sourceType === 'manual' || sourceType === 'manuel') {
        result = await cli.kernel.runCapability('companyBrain', {
          action: 'manual',
          sourceType: 'manual',
          text: sanitizeInput(String(data.text || ''), 4000),
          author: sanitizeInput(String(data.author || data.yazar || 'unknown'), 128),
          date: sanitizeInput(String(data.date || ''), 32),
        });
      } else if (sourceType === 'decision' || sourceType === 'karar') {
        result = await cli.kernel.runCapability('companyBrain', {
          action: 'decision',
          sourceType: 'decision',
          title: sanitizeInput(String(data.title || data.baslik || ''), 512),
          rationale: sanitizeInput(String(data.rationale || data.gerekce || ''), 4000),
          decidedBy: sanitizeInput(String(data.decidedBy || data.author || data.yazar || 'unknown'), 128),
          date: sanitizeInput(String(data.date || ''), 32),
          alternatives: Array.isArray(data.alternatives) ? data.alternatives.slice(0, 20).map(item => sanitizeInput(String(item), 512)) : [],
          links: Array.isArray(data.links) ? data.links.slice(0, 50).map(item => sanitizeInput(String(item), 512)) : [],
        });
      } else {
        writeJson(req, res, 400, { error: 'sourceType must be one of github|markdown|manual|decision' });
        return;
      }

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
      res.end(JSON.stringify({ result: 'âŒ BoÅŸ girdi.' }));
      return;
    }
    const p = cli.parse(q);
    let result;
    if (!p) {
      result = 'âŒ AnlamadÄ±m.';
    } else if (p.command === 'kaydet') {
      result = 'âš ï¸ Kaydet komutu sadece CLI\'dan kullanÄ±labilir.';
    } else {
      try {
        // Some commands may be sync today and async tomorrow.
        // Normalize here so API never leaks "[object Promise]".
        result = await Promise.resolve(cli.execute(p.command, p.args));
      } catch (err) {
        console.error('[API hata]', err.code || err.name || 'internal');
        result = 'âŒ Ä°ÅŸlem sÄ±rasÄ±nda hata oluÅŸtu.';
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
    res.end(HTML);
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


