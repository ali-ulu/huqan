const http = require('http');
const CLI = require('./cli');

const kernelOpts = {};
if (process.env.AXIOM_MEMORY_PATH) kernelOpts.memoryPath = process.env.AXIOM_MEMORY_PATH;
if (process.env.AXIOM_DB_PATH) kernelOpts.dbPath = process.env.AXIOM_DB_PATH;
if (process.env.AXIOM_USE_SQLITE === 'false') kernelOpts.useSQLite = false;

const cli = new CLI({ kernel: kernelOpts });
cli.kernel.graph.load();

// --- Güvenlik sabitleri ---
const MAX_INPUT_LENGTH = 500;
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 120;
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, RATE_LIMIT_WINDOW);
rateLimitCleanupTimer.unref?.();

function sanitizeInput(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.slice(0, MAX_INPUT_LENGTH);
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return s.trim();
}

function legacyVerify(result) {
  return {
    status: result.data.status,
    confidence: result.data.confidence,
    evidence: result.evidence.map(e => e.text),
  };
}

// Graf verisini D3 formatına dönüştür
function getGraphData() {
  const nodes = Object.values(cli.kernel.graph._nodes).map(n => ({
    id: n.id,
    label: n.label,
    weight: n.weight,
    edgeCount: cli.kernel.graph.getEdges(n.id).length,
  }));

  // Çok fazla node varsa en ağırlıklı 150'yi al
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
  ];

  const counts = phases.reduce((acc, phase) => {
    acc.total += 1;
    acc[phase.status] += 1;
    return acc;
  }, { total: 0, done: 0, in_progress: 0, pending: 0 });

  return {
    ok: true,
    version: require('./package.json').version,
    contractVersion: cli.kernel.contractVersion || '1.0.0',
    counts,
    phases,
    currentFocus: 'v2.3 CLI/REST Runtime',
    nextAction: 'Run with AXIOM_KERNEL_VERSION=v2 to exercise the new verify reasoning in user-facing flows.',
  };
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
.link.tür{stroke:#7b2ff7}
.link.yapabilir{stroke:#00d4ff}
.link.benzer{stroke:#00c853}
.link.özellik{stroke:#ff9800}
.link.hipotez{stroke:#ff5722;stroke-dasharray:4,2}
</style>
</head>
<body>
<div class="header">
  <h1>◇ AXIOM</h1>
  <span id="hdr-stats">yükleniyor...</span>
</div>
<div class="tabs">
  <div class="tab active" onclick="switchTab('chat')">Sohbet</div>
  <div class="tab" onclick="switchTab('graph')">Graf</div>
  <div class="tab" onclick="switchTab('status')">V2 Durumu</div>
</div>

<div class="panel active" id="chat-panel">
  <div class="chat" id="chat"></div>
  <div class="input-bar">
    <input id="input" placeholder="öğret: / sor: / llm-sor: / yükle: dosya.txt" autofocus maxlength="500" />
    <button onclick="send()">Gönder</button>
  </div>
</div>

<div class="panel" id="graph-panel">
  <svg id="graph-svg"></svg>
  <div class="graph-stats" id="graph-stats"></div>
  <div class="graph-controls">
    <button onclick="loadGraph()">↺ Yenile</button>
    <button onclick="resetZoom()">⊙ Sıfırla</button>
    <button onclick="toggleLabels()">🏷 Etiket</button>
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
// ─── Tab yönetimi ─────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', ['chat','graph','status'][i]===name));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById(name+'-panel').classList.add('active');
  if (name === 'graph') loadGraph();
  if (name === 'status') loadStatus();
}

// ─── Chat ─────────────────────────────────────────────────────────────────
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

addMsg('Hoş geldin. Bana bir şey öğret veya Graf sekmesine geç.', 'system');

async function send() {
  const val = input.value.trim();
  if (!val) return;
  input.value = '';
  addMsg(val, 'user');
  try {
    const r = await fetch('/api?' + new URLSearchParams({q: val}));
    if (r.status === 429) { addMsg('⏳ Çok fazla istek.', 'system'); return; }
    if (!r.ok) { addMsg('❌ Sunucu hatası', 'system'); return; }
    const data = await r.json();
    let cls = 'system';
    if (data.result.startsWith('💭') || data.result.startsWith('📊')) cls = 'system highlight';
    else if (data.result.startsWith('✅')) cls = 'system ok';
    else if (data.result.startsWith('⚠')) cls = 'system warn';
    addMsg(data.result, cls);
    updateStats();
  } catch(e) {
    addMsg('❌ Bağlantı hatası', 'system');
  }
}

input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });

async function updateStats() {
  try {
    const r = await fetch('/graph-data');
    const d = await r.json();
    document.getElementById('hdr-stats').textContent = d.nodes.length + ' düğüm · ' + d.links.length + ' kenar';
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
      dashboard.innerHTML = '<div class="metric"><div class="label">Hata</div><div class="value">—</div><div class="sub">Durum ekranı yüklenemedi.</div></div>';
    }
    if (phases) phases.innerHTML = '';
  }
}

function renderStatus(d) {
  const dashboard = document.getElementById('status-dashboard');
  const phases = document.getElementById('status-phases');
  if (!dashboard || !phases) return;

  dashboard.innerHTML =
    '<div class="metric"><div class="label">S?r?m</div><div class="value">' + escapeHtml(d.version || '?') + '</div><div class="sub">Contract: ' + escapeHtml(d.contractVersion || '?') + '</div></div>' +
    '<div class="metric"><div class="label">Fazlar</div><div class="value">' + d.counts.total + '</div><div class="sub">' + d.counts.done + ' tamam, ' + d.counts.in_progress + ' aktif, ' + d.counts.pending + ' bekliyor</div></div>' +
    '<div class="metric"><div class="label">Odak</div><div class="value">' + escapeHtml(d.currentFocus || '?') + '</div><div class="sub">' + escapeHtml(d.nextAction || '?') + '</div></div>';

  phases.innerHTML = (d.phases || []).map(phase => {
    const badge = phase.status === 'done' ? 'Tamamland?' : phase.status === 'in_progress' ? 'Aktif' : 'Bekliyor';
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
  'tür': '#7b2ff7', 'yapabilir': '#00d4ff',
  'benzer': '#00c853', 'özellik': '#ff9800',
  'hipotez': '#ff5722', 'default': '#444'
};

async function loadGraph() {
  try {
    const r = await fetch('/graph-data');
    graphData = await r.json();
    renderGraph(graphData);
    document.getElementById('graph-stats').textContent =
      graphData.nodes.length + ' düğüm · ' + graphData.links.length + ' kenar';
  } catch(e) {
    console.error('Graf yüklenemedi:', e);
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

  // İlişki tipine göre renk
  const relColor = r => RELATION_COLOR[r] || RELATION_COLOR.default;

  // Node büyüklüğü: kenar sayısına göre
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

  // Düğümler
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
      const hasTur = edges.some(l => l.relation === 'tür');
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
    .text(d => d.label.length > 12 ? d.label.slice(0, 11) + '…' : d.label)
    .attr('dy', d => nodeR(d) + 10)
    .style('display', showLabels ? 'block' : 'none');

  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
  });

  // Etiket referansını sakla
  window._axiomLabels = label;
}

function showNodeInfo(d) {
  const info = document.getElementById('graph-info');
  document.getElementById('info-title').textContent = d.label;
  document.getElementById('info-weight').textContent = 'ağırlık: ' + d.weight.toFixed(2) + ' · kenar: ' + d.edgeCount;
  const edges = graphData.links.filter(l =>
    (l.source.id || l.source) === d.id || (l.target.id || l.target) === d.id
  );
  const edgeList = document.getElementById('info-edges');
  edgeList.innerHTML = edges.slice(0, 10).map(e => {
    const from = e.source.id || e.source;
    const to = e.target.id || e.target;
    return '<div class="edge-item">' + escapeHtml(from) + ' →[' + e.relation + ']→ ' + escapeHtml(to) + '</div>';
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

// Graf paneline tıklanınca info'yu kapat
document.getElementById('graph-panel').addEventListener('click', e => {
  if (!e.target.closest('.node') && !e.target.closest('.graph-info')) {
    document.getElementById('graph-info').classList.remove('visible');
  }
});
<\/script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || 'unknown';

  if (!checkRateLimit(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ── /graph-data ──────────────────────────────────────────────────────────
  if (reqUrl.pathname === '/graph-data') {
    if (req.method !== 'GET') {
      res.writeHead(405); res.end(); return;
    }
    const data = getGraphData();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify(data));
    return;
  }

  if (reqUrl.pathname === '/v2-status') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    const data = getV2StatusData();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify(data));
    return;
  }

  if (reqUrl.pathname === '/health') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify(getHealthData()));
    return;
  }

  // ── /llm-sor ─────────────────────────────────────────────────────────────
  if (reqUrl.pathname === '/llm-sor') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    let body = '', bodySize = 0;
    const MAX_BODY = 4096;
    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) { req.destroy(); return; }
      body += chunk;
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      try {
        const data = JSON.parse(body);
        const question = sanitizeInput(data.question || data.q || '');
        const autoLearn = data.autoLearn !== false; // varsayılan: true
        if (!question) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
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
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          ok: true,
          question,
          llmAnswer: llmText,
          model: llmRes.data.model,
          axiomCheck,
          llmCheck,
          learnResult,
        }));
      } catch (e) {
        if (!res.writableEnded) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Geçersiz JSON: ' + e.message }));
        }
      }
    });
    return;
  }

  // ── /dogrula ─────────────────────────────────────────────────────────────
  if (reqUrl.pathname === '/dogrula' || reqUrl.pathname === '/verify') {
    if (req.method !== 'POST' && req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const text = sanitizeInput(data.statement || data.text || '');
          if (!text) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'statement veya text gerekli' }));
            return;
          }
          const result = legacyVerify(cli.kernel.verify(text));
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Geçersiz JSON: ' + e.message }));
        }
      });
      return;
    }
    const text = sanitizeInput(reqUrl.searchParams.get('statement') || '');
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'statement parametresi gerekli' }));
      return;
    }
    const result = legacyVerify(cli.kernel.verify(text));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(result));
    return;
  }

  // ── /yukle ───────────────────────────────────────────────────────────────
  if (reqUrl.pathname === '/yukle' || reqUrl.pathname === '/upload') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    const MAX_BODY = 1024 * 1024;
    let body = '', bodySize = 0;
    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) {
        req.destroy();
        if (!res.writableEnded) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'İçerik çok büyük (max 1MB)' }));
        }
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        const data = JSON.parse(body);
        const text = data.text || data.content || '';
        if (!text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'text veya content gerekli' }));
          return;
        }
        const count = cli.kernel.learnDocument(text);
        cli.kernel.graph.save();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, learned: count }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Geçersiz JSON: ' + e.message }));
      }
    });
    return;
  }

  // ── /api ─────────────────────────────────────────────────────────────────
  if (reqUrl.pathname === '/api') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    const raw = reqUrl.searchParams.get('q') || '';
    const q = sanitizeInput(raw);
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: '❌ Boş girdi.' }));
      return;
    }
    const p = cli.parse(q);
    let result;
    if (!p) {
      result = '❌ Anlamadım.';
    } else if (p.command === 'kaydet') {
      result = '⚠️ Kaydet komutu sadece CLI\'dan kullanılabilir.';
    } else {
      try {
        // Some commands may be sync today and async tomorrow.
        // Normalize here so API never leaks "[object Promise]".
        result = await Promise.resolve(cli.execute(p.command, p.args));
      } catch (err) {
        console.error('[API hata]', err.message);
        result = '❌ İşlem sırasında hata oluştu.';
      }
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify({ result }));
    return;
  }

  // ── Ana sayfa ─────────────────────────────────────────────────────────────
  if (reqUrl.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 AXIOM web arayüzü: http://localhost:${PORT}`);
  console.log(`   Graf görünümü: http://localhost:${PORT} → "Graf" sekmesi`);
});

server.closeAxiom = () => {
  cli.kernel.graph.close();
};

module.exports = server;
