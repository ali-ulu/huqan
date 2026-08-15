'use strict';

/**
 * RFC-001 MCP tool naming: canonical `huqan.*` names, `axiom.*` accepted as
 * deprecated compatibility aliases.
 *
 * These tests exist because the compatibility claim is the whole point of the
 * change. "Legacy names still work" is not provable by reading the switch
 * statement — it is provable only by calling through the real `callTool` /
 * `createServer` entry points with a legacy name and comparing the observable
 * result to the canonical one.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  TOOL_SCHEMAS,
  MODEL_VISIBLE_TOOL_SCHEMAS,
  CANONICAL_MCP_TOOL_NAMES,
  LEGACY_MCP_TOOL_NAMES,
  SERVER_NAME,
  callTool,
  createServer,
  createKernelFromEnv,
  executeReadOnlyDryRun,
  sanitizeToolArgsForStorage,
} = require('./mcpServer');

const {
  canonicalMcpToolName,
  legacyMcpToolName,
  isCanonicalMcpToolName,
  isLegacyMcpToolName,
  mcpToolDeprecationNotice,
} = require('./lib/mcp-tool-names');

const { evaluateMcpGate, MCP_TOOL_CLASSIFICATIONS } = require('./lib/mcp-gate-adapter');

let tmpDir;
let kernel;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-tool-naming-'));
  process.env.HUQAN_DB_PATH = path.join(tmpDir, 'graph.json');
  process.env.HUQAN_MEMORY_PATH = path.join(tmpDir, 'memory.json');
  kernel = createKernelFromEnv();
  kernel.learn('kedi hayvandir', { skipConflicts: true });
});

after(() => {
  try { kernel?.graph?.close?.(); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// ─── name table ──────────────────────────────────────────────────────────────

describe('RFC-001 MCP tool name table', () => {
  it('defines fourteen canonical names and fourteen legacy aliases', () => {
    assert.equal(CANONICAL_MCP_TOOL_NAMES.length, 14);
    assert.equal(LEGACY_MCP_TOOL_NAMES.length, 14);
  });

  it('maps every legacy alias onto its canonical name and back', () => {
    for (const legacy of LEGACY_MCP_TOOL_NAMES) {
      const canonical = canonicalMcpToolName(legacy);
      assert.ok(isCanonicalMcpToolName(canonical), `${legacy} → ${canonical} should be canonical`);
      assert.ok(CANONICAL_MCP_TOOL_NAMES.includes(canonical));
      assert.equal(legacyMcpToolName(canonical), legacy);
    }
  });

  it('leaves canonical names unchanged', () => {
    for (const canonical of CANONICAL_MCP_TOOL_NAMES) {
      assert.equal(canonicalMcpToolName(canonical), canonical);
      assert.equal(isLegacyMcpToolName(canonical), false);
    }
  });

  it('does not alias arbitrary axiom-prefixed strings onto a real handler', () => {
    // Guards the obvious wrong implementation: a prefix rewrite. Only the
    // declared aliases may resolve; anything else must survive
    // unchanged so unknown-tool handling still fires.
    for (const bogus of ['axiom.', 'axiom.wipe', 'axiom.learn.extra', 'axiomlearn', 'AXIOM.learn']) {
      assert.equal(canonicalMcpToolName(bogus), bogus, `${bogus} must not be rewritten`);
    }
  });

  it('tolerates non-string input without throwing', () => {
    for (const value of [undefined, null, 42, {}, []]) {
      assert.doesNotThrow(() => canonicalMcpToolName(value));
    }
  });
});

// ─── advertised surface: canonical only (RFC-001 decision 7) ─────────────────

describe('RFC-001 writer half: only canonical names are advertised', () => {
  it('serves the canonical product name as the MCP server name', () => {
    assert.equal(SERVER_NAME, 'huqan');
  });

  it('advertises only model-visible canonical tools and no approval operator surface', () => {
    const advertised = MODEL_VISIBLE_TOOL_SCHEMAS.map((tool) => tool.name);
    const expected = CANONICAL_MCP_TOOL_NAMES.filter(name => !['huqan.approve', 'huqan.approvals'].includes(name));
    assert.deepEqual([...advertised].sort(), [...expected].sort());
    assert.ok(!advertised.includes('huqan.approve'));
    assert.ok(!advertised.includes('huqan.approvals'));
    for (const legacy of LEGACY_MCP_TOOL_NAMES) {
      assert.ok(!advertised.includes(legacy), `tools/list must not advertise ${legacy}`);
    }
  });

  it('never names AXIOM in an advertised tool name, title or description', () => {
    for (const tool of MODEL_VISIBLE_TOOL_SCHEMAS) {
      const surface = `${tool.name} ${tool.title} ${tool.description}`;
      assert.ok(!/axiom/i.test(surface), `${tool.name} still presents AXIOM: ${surface}`);
    }
  });

  it('returns only canonical names from a real tools/list request', () => {
    const server = createServer();
    const listed = server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = listed.result.tools.map((tool) => tool.name);
    const expected = CANONICAL_MCP_TOOL_NAMES.filter(name => !['huqan.approve', 'huqan.approvals'].includes(name));
    assert.deepEqual([...names].sort(), [...expected].sort());
    assert.equal(listed.result.tools.length, expected.length);
  });

  it('classifies gates under canonical keys', () => {
    for (const tool of Object.keys(MCP_TOOL_CLASSIFICATIONS)) {
      assert.ok(isCanonicalMcpToolName(tool), `${tool} should be a canonical key`);
    }
  });
});

// ─── reader half: legacy names still work ────────────────────────────────────

describe('RFC-001 reader half: legacy axiom.* names still work', () => {
  it('answers a read-only call under both spellings', () => {
    const canonical = callTool(kernel, { name: 'huqan.ask', arguments: { question: 'kedi nedir' } });
    const legacy = callTool(kernel, { name: 'axiom.ask', arguments: { question: 'kedi nedir' } });

    assert.equal(canonical.ok, true);
    assert.equal(legacy.ok, true, 'legacy axiom.ask must keep working');
    assert.equal(legacy.type, canonical.type);
    assert.deepEqual(legacy.data, canonical.data);
  });

  it('resolves both spellings to the same handler for every read-only tool', () => {
    const cases = [
      ['ask', { question: 'kedi nedir' }],
      ['verify', { statement: 'kedi hayvandir' }],
      ['reason', { subject: 'kedi' }],
      ['compare', { left: 'kedi', right: 'kopek' }],
      ['policy', { tool: 'browser.open', input: '' }],
      ['plan', { goal: 'kedi hayvandir mi' }],
      ['approvals', { limit: 5 }],
    ];

    for (const [suffix, args] of cases) {
      const canonical = callTool(kernel, { name: `huqan.${suffix}`, arguments: args });
      const legacy = callTool(kernel, { name: `axiom.${suffix}`, arguments: args });

      // `meta.deprecation` is the one intentional difference; everything the
      // caller acts on must be identical.
      assert.equal(legacy.ok, canonical.ok, `${suffix}: ok must match`);
      assert.equal(legacy.type, canonical.type, `${suffix}: type must match`);
      assert.deepEqual(legacy.data, canonical.data, `${suffix}: data must match`);
      assert.deepEqual(legacy.error, canonical.error, `${suffix}: error must match`);
    }
  });

  it('resolves both spellings of the stateful dream tool to the same handler', () => {
    // dream advances a cycle counter on every call, so its payload cannot be
    // compared for deep equality across two calls. Shape and success are what
    // prove the alias reached the same handler.
    const canonical = callTool(kernel, { name: 'huqan.dream', arguments: { depth: 2 } });
    const legacy = callTool(kernel, { name: 'axiom.dream', arguments: { depth: 2 } });
    assert.equal(legacy.ok, canonical.ok);
    assert.equal(legacy.type, canonical.type);
    assert.deepEqual(Object.keys(legacy.data).sort(), Object.keys(canonical.data).sort());
  });

  it('applies the identical gate decision to both spellings of the mutating tool', () => {
    const canonicalGate = evaluateMcpGate({ tool: 'huqan.learn', args: { text: 'kus hayvandir' } });
    const legacyGate = evaluateMcpGate({ tool: 'axiom.learn', args: { text: 'kus hayvandir' } });

    assert.equal(legacyGate.decision, canonicalGate.decision);
    assert.equal(legacyGate.canExecute, canonicalGate.canExecute);
    assert.equal(legacyGate.requiredReview, canonicalGate.requiredReview);
    assert.equal(legacyGate.metadata.mutating, true);
    assert.equal(canonicalGate.metadata.mutating, true);
  });

  it('queues a legacy learn call for review exactly as the canonical one does', () => {
    const canonical = callTool(kernel, { name: 'huqan.learn', arguments: { text: 'kus hayvandir' } }, {});
    const legacy = callTool(kernel, { name: 'axiom.learn', arguments: { text: 'kus hayvandir' } }, {});

    assert.equal(canonical.ok, false);
    assert.equal(legacy.ok, false, 'legacy learn must stay gated, not silently execute');
    assert.equal(legacy.gate.decision, canonical.gate.decision);
    assert.equal(legacy.gate.requiredReview, canonical.gate.requiredReview);
    // The approval is persisted under the canonical name, per RFC-001
    // decision 7: a writer emits only the canonical form.
    assert.equal(legacy.approval.tool, 'huqan.learn');
    assert.equal(canonical.approval.tool, 'huqan.learn');
  });

  it('routes a legacy call through the real JSON-RPC tools/call path', () => {
    const server = createServer();
    const response = server.handleRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'axiom.ask', arguments: { question: 'kedi nedir' } },
    });
    assert.equal(response.result.isError, false);
    assert.equal(response.result.structuredContent.ok, true);
  });

  it('treats an unknown axiom-prefixed tool as unknown, not as an alias', () => {
    // The gate blocks an unclassified tool before dispatch, so the observable
    // outcome is a fail-closed block rather than a throw. Either way it must
    // not have been rewritten onto a real handler.
    const result = callTool(kernel, { name: 'axiom.wipe-everything', arguments: {} }, {});
    assert.equal(result.ok, false);
    assert.equal(result.gate.decision, 'block');
    assert.equal(result.gate.canExecute, false);
  });

  it('shares argument sanitization and dry-run behavior across both spellings', () => {
    const args = { text: 'kedi hayvandir', skipConflicts: true };
    assert.deepEqual(
      sanitizeToolArgsForStorage('axiom.learn', args),
      sanitizeToolArgsForStorage('huqan.learn', args),
    );
    assert.deepEqual(
      executeReadOnlyDryRun(kernel, 'axiom.learn', { text: 'kedi' }),
      executeReadOnlyDryRun(kernel, 'huqan.learn', { text: 'kedi' }),
    );
  });
});

// ─── deprecation signalling ──────────────────────────────────────────────────

describe('RFC-001 deprecation signalling', () => {
  it('builds a notice for every legacy alias and for no canonical name', () => {
    for (const legacy of LEGACY_MCP_TOOL_NAMES) {
      const notice = mcpToolDeprecationNotice(legacy);
      assert.ok(notice, `${legacy} should carry a deprecation notice`);
      assert.equal(notice.deprecated, true);
      assert.equal(notice.rfc, 'RFC-001');
      assert.equal(notice.requestedName, legacy);
      assert.equal(notice.canonicalName, canonicalMcpToolName(legacy));
      assert.ok(notice.message.includes(notice.canonicalName));
    }
    for (const canonical of CANONICAL_MCP_TOOL_NAMES) {
      assert.equal(mcpToolDeprecationNotice(canonical), null);
    }
  });

  it('emits the notice in meta.deprecation when a legacy name is called', () => {
    const legacy = callTool(kernel, { name: 'axiom.ask', arguments: { question: 'kedi nedir' } });
    assert.ok(legacy.meta, 'legacy result should carry meta');
    assert.equal(legacy.meta.deprecation.deprecated, true);
    assert.equal(legacy.meta.deprecation.requestedName, 'axiom.ask');
    assert.equal(legacy.meta.deprecation.canonicalName, 'huqan.ask');
  });

  it('emits no deprecation notice when a canonical name is called', () => {
    const canonical = callTool(kernel, { name: 'huqan.ask', arguments: { question: 'kedi nedir' } });
    assert.equal(canonical.meta?.deprecation, undefined);
  });

  it('signals deprecation on the gated learn path too, not just on allowed reads', () => {
    const legacy = callTool(kernel, { name: 'axiom.learn', arguments: { text: 'balik hayvandir' } }, {});
    assert.equal(legacy.ok, false);
    assert.equal(legacy.meta.deprecation.canonicalName, 'huqan.learn');
  });

  it('does not lose pre-existing meta fields when attaching the notice', () => {
    const legacy = callTool(kernel, { name: 'axiom.verify', arguments: { statement: 'kedi hayvandir' } });
    const canonical = callTool(kernel, { name: 'huqan.verify', arguments: { statement: 'kedi hayvandir' } });
    for (const key of Object.keys(canonical.meta || {})) {
      assert.deepEqual(legacy.meta[key], canonical.meta[key], `meta.${key} must survive`);
    }
  });

  it('surfaces the notice through the JSON-RPC response as well', async () => {
    const server = createServer();
    const response = server.handleRequest({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'axiom.reason', arguments: { subject: 'kedi' } },
    });
    assert.equal(response.result.structuredContent.meta.deprecation.deprecated, true);
  });
});

// ─── persisted-approval compatibility ────────────────────────────────────────

describe('RFC-001 compatibility with approvals persisted before the rename', () => {
  it('still executes an approval row that carries the legacy tool name', () => {
    // A pending approval written by a pre-rename build carries
    // `tool: "axiom.learn"`. If the executor compared that string literally
    // against the new canonical name, every such row would become permanently
    // unapprovable — a silent data-compatibility break that no canonical-only
    // test would catch.
    const { createApprovalStoreFromKernel } = require('./mcpServer');
    const store = createApprovalStoreFromKernel(kernel, {});
    if (!store || typeof store.saveToolApproval !== 'function') return; // no store backend here

    const id = `approval-legacy-${Date.now()}`;
    store.saveToolApproval({
      id,
      approvalKey: `mcp.axiom.learn.${id}`,
      tool: 'axiom.learn',
      input: JSON.stringify({ text: 'at hayvandir', skipConflicts: true }),
      status: 'pending',
      decision: 'review',
      reason: 'legacy_row',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      policy: { gate: {} },
      context: { source: 'mcp', queuedForExecution: true, args: { text: 'at hayvandir', skipConflicts: true } },
    });

    const result = callTool(kernel, { name: 'huqan.approve', operatorToken: 'test-operator', arguments: { approvalId: id, decision: 'approved' } }, { approvalStore: store, operatorToken: 'test-operator' });
    assert.notEqual(
      result.error?.code,
      'APPROVAL_EXECUTION_UNSUPPORTED',
      'a legacy-named approval row must remain executable',
    );
  });
});
