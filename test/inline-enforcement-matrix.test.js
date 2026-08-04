'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Zorunlu Inline Enforcement Matrix (fail-closed)
//
// Issue: mandatory inline enforcement matrix.
// Amaç: "partial trust layer" siniflandirmasini makine-okunur dogrulanabilir
// hale getirmek. Her trust-connected yüzeyin gate enforcement + karar + risk +
// metadata uretmesini ve bilinmeyen/mutating girislerin asla izinsiz (allow)
// cikmamasini (fail-closed) dogrular.
//
// Bu TEST-ONLY bir dosyadir; hicbir runtime/kernel/persistence dosyasina
// dokunmaz. Kaynak: docs/audits/connector-trust-coverage-inventory.md
// ─────────────────────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TOOL_GATE_DECISIONS,
  evaluateToolCall,
} = require('../lib/tool-call-gate');

const {
  MEMORY_MUTATION_GATE_DECISIONS,
  evaluateMemoryMutation,
} = require('../lib/memory-mutation-gate');

const {
  MCP_GATE_ADAPTER_VERSION,
  MCP_TOOL_CLASSIFICATIONS,
  MCP_GATE_DECISIONS,
  evaluateMcpGate,
} = require('../lib/mcp-gate-adapter');

// ─── yardimcilar ─────────────────────────────────────────────────────────────

function makeClassifier(overrides = {}) {
  return {
    classifierVersion: 'AB1-v2.0.0',
    valid: true,
    risk: { level: 'low', score: 0.2, category: 'read' },
    ...overrides,
  };
}

// Her matrix satiri bir "envanter yuzeyi"ni temsil eder. Basit tutuldu:
// { name, run, allowExpected }. allowExpected yalnizca gercekten dusuk riskli /
// okuma yolu icin true olabilir; diger tum satirlar fail-closed invariant'i
// geregi asla allow donmemeli.
const MATRIX = Object.freeze([
  {
    name: 'tool-gate: read (low risk)',
    run: () => evaluateToolCall({ action: 'read', toolName: 'list-files', classifier: makeClassifier() }),
    allowExpected: true,
  },
  {
    name: 'tool-gate: update (write)',
    run: () => evaluateToolCall({
      action: 'update',
      toolName: 'save-profile',
      classifier: makeClassifier({ risk: { level: 'medium', score: 0.55, category: 'write' } }),
    }),
    allowExpected: false,
  },
  {
    name: 'tool-gate: delete (destructive)',
    run: () => evaluateToolCall({
      action: 'delete',
      toolName: 'remove-user',
      classifier: makeClassifier({ risk: { level: 'critical', score: 0.99, category: 'destructive' } }),
    }),
    allowExpected: false,
  },
  {
    name: 'tool-gate: unknown action',
    run: () => evaluateToolCall({
      action: 'mystery',
      toolName: 'maybe-do-thing',
      classifier: makeClassifier({ risk: { level: 'medium', score: 0.5, category: 'unknown' } }),
    }),
    allowExpected: false,
  },
  {
    name: 'memory-gate: write',
    run: () => evaluateMemoryMutation({ action: 'write', kind: 'memory' }),
    allowExpected: false,
  },
  {
    name: 'mcp: axiom.ask (read)',
    run: () => evaluateMcpGate({ tool: 'axiom.ask', args: {} }),
    allowExpected: true,
  },
  {
    name: 'mcp: axiom.learn (write)',
    run: () => evaluateMcpGate({ tool: 'axiom.learn', args: { text: 'x' } }),
    allowExpected: false,
  },
  {
    name: 'mcp: axiom.agent (agent-loop)',
    run: () => evaluateMcpGate({ tool: 'axiom.agent', args: { prompt: 'test' } }),
    allowExpected: false,
  },
  {
    name: 'mcp: unknown tool',
    run: () => evaluateMcpGate({ tool: 'axiom.unknownTool', args: {} }),
    allowExpected: false,
  },
  {
    name: 'mcp: malformed input',
    run: () => evaluateMcpGate(null),
    allowExpected: false,
  },
]);

const VALID_DECISIONS = new Set([
  ...Object.values(TOOL_GATE_DECISIONS),
  ...Object.values(MEMORY_MUTATION_GATE_DECISIONS),
  ...Object.values(MCP_GATE_DECISIONS),
]);

// ─── matris genel invariant'lari ─────────────────────────────────────────────

test('matrix: her satir ok, karar, sebep, risk ve metadata uretir', () => {
  for (const row of MATRIX) {
    const r = row.run();
    assert.equal(r.ok, true, `${row.name}: ok olmali`);
    assert.ok(r.decision, `${row.name}: decision bos olamaz`);
    assert.ok(VALID_DECISIONS.has(r.decision), `${row.name}: gecersiz decision "${r.decision}"`);
    assert.ok(r.reason, `${row.name}: reason bos olamaz`);
    assert.ok(r.risk && typeof r.risk === 'object', `${row.name}: risk nesnesi eksik`);
    assert.ok(r.metadata, `${row.name}: metadata eksik`);
  }
});

test('matrix: allowExpected=true yalnizca allowed+canExecute olarak doner', () => {
  for (const row of MATRIX.filter((x) => x.allowExpected)) {
    const r = row.run();
    assert.equal(r.allowed, true, `${row.name}: allowed=true olmali`);
    assert.equal(r.canExecute, true, `${row.name}: canExecute=true olmali`);
  }
});

test('matrix: FAIL-CLOSED — allowExpected=false satirlar asla allow degildir', () => {
  for (const row of MATRIX.filter((x) => !x.allowExpected)) {
    const r = row.run();
    assert.equal(r.allowed, false, `${row.name}: fail-closed ihlali — allow donemez`);
  }
});

// ─── fail-closed / muhendislik invariant'lari ────────────────────────────────

test('fail-closed: bilinmeyen MCP araci block donmeli', () => {
  const r = evaluateMcpGate({ tool: 'axiom.bilinmeyenBahsedilen', args: {} });
  assert.equal(r.decision, MCP_GATE_DECISIONS.block);
});

test('fail-closed: malformed MCP giris asla allow donmemeli', () => {
  const r = evaluateMcpGate(null);
  assert.equal(r.allowed, false);
});

test('fail-closed: kritik risk tool-gate uzerinde asla allow degil', () => {
  const r = evaluateToolCall({
    action: 'delete',
    toolName: 'wipe-database',
    classifier: makeClassifier({ risk: { level: 'critical', score: 1, category: 'destructive' } }),
  });
  assert.notEqual(r.decision, TOOL_GATE_DECISIONS.ALLOW);
  assert.equal(r.allowed, false);
});

test('matrix: tum kayitli MCP araclari gecerli karar uretir', () => {
  const tools = Object.keys(MCP_TOOL_CLASSIFICATIONS);
  assert.ok(tools.length >= 1, 'en az bir kayitli MCP araci olmali');
  for (const tool of tools) {
    const r = evaluateMcpGate({ tool, args: {} });
    assert.equal(r.ok, true, `${tool}: ok olmali`);
    assert.ok(MCP_GATE_DECISIONS[r.decision] !== undefined, `${tool}: gecersiz MCP karari "${r.decision}"`);
    assert.equal(r.metadata.adapterVersion, MCP_GATE_ADAPTER_VERSION, `${tool}: adapterVersion uyumsuz`);
  }
});

test('matrix: secret token warning/reason a sizmaz', () => {
  const token = 'sk-test-0123456789abcdef';
  const r = evaluateToolCall({
    action: 'update',
    toolName: 'save-profile',
    args: { apiKey: token, nested: { token } },
    classifier: makeClassifier({ risk: { level: 'medium', score: 0.5, category: 'write' } }),
  });
  const strings = [...(r.warnings || []), String(r.reason || '')].join(' ');
  assert.ok(!strings.includes(token), 'token warning/reason icine sizamaz');
});

test('matrix: mutating yuzeyler her zaman guarded (denetimli) doner', () => {
  const mutatingRows = MATRIX.filter((x) => /write|learn|agent-loop|destructive/.test(x.name));
  for (const row of mutatingRows) {
    const r = row.run();
    assert.equal(r.allowed, false, `${row.name}: mutating yuzey izinsiz (allow) olamaz`);
  }
});
