'use strict';

/**
 * FAZ2-PR5 — MCP Shared State + Approval Persistence Contract (F-005/F-006)
 *
 * Closes the FAZ2-PR1 evidence gaps:
 *
 *   F-005: MCP must not be an isolated state island. The MCP server can accept
 *          an injected shared kernel and, by default, uses the same env-backed
 *          graph/SQLite persistence paths as REST/CLI.
 *
 *   F-006: MCP approval requests must not live in a process-local array.
 *          Pending approvals are stored in the existing SQLite tool_approvals
 *          queue and axiom.approve provides an approve/reject execution path.
 *
 * This contract intentionally does NOT require kernel._commitMutation or a
 * Universal Mutation Boundary. Approved MCP learn execution must go through the
 * admission-aware kernel.learn path with approvalStatus:'approved'.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Kernel = require('../kernel');
const {
  TOOL_SCHEMAS,
  callTool,
  createKernelFromEnv,
  createServer,
} = require('../mcpServer');

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function withTempAxiomEnv(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-faz2-mcp-contract-'));
  const saved = {
    AXIOM_MEMORY_PATH: process.env.AXIOM_MEMORY_PATH,
    AXIOM_DB_PATH: process.env.AXIOM_DB_PATH,
    AXIOM_KERNEL_VERSION: process.env.AXIOM_KERNEL_VERSION,
    AXIOM_USE_SQLITE: process.env.AXIOM_USE_SQLITE,
  };
  process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'memory.json');
  process.env.AXIOM_DB_PATH = path.join(tempDir, 'memory.db');
  process.env.AXIOM_KERNEL_VERSION = '';
  delete process.env.AXIOM_USE_SQLITE;

  try {
    return fn({ tempDir });
  } finally {
    restoreEnv(saved);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

function approvedAdmissionOpts() {
  return {
    workspaceId: 'default',
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: 'apr-faz2-mcp-contract',
    provenance: {
      provenanceId: 'prov-faz2-mcp-contract',
      sourceType: 'test',
      sourceRef: 'faz2-mcp-contract',
      actor: 'contract-test',
      workspaceId: 'default',
      timestamp: '2026-06-30T00:00:00.000Z',
      trustPolicyVersion: 'contract',
    },
  };
}

describe('FAZ2-PR5 contract: MCP harness', () => {
  it('mcpServer.js exports the MCP construction and dispatch hooks', () => {
    assert.equal(typeof createKernelFromEnv, 'function');
    assert.equal(typeof createServer, 'function');
    assert.equal(typeof callTool, 'function');
  });

  it('createServer accepts an injected shared kernel instance', () => {
    const injectedKernel = {
      ask() {
        return { ok: true, type: 'ask', data: { answer: 'shared' }, evidence: [], error: null, meta: {} };
      },
      verify() {
        return { ok: true, type: 'verify', data: { status: 'bilinmiyor', confidence: 0 }, evidence: [], error: null, meta: {} };
      },
      learn() {
        return { ok: true, type: 'learn', data: {}, evidence: [], error: null, meta: {} };
      },
    };

    const server = createServer(injectedKernel);
    assert.equal(server.kernel, injectedKernel);
  });
});

describe('FAZ2-PR5 contract: F-005 MCP shared state', () => {
  it('MCP kernel sees graph facts written through the same env-backed SQLite backend', () => {
    withTempAxiomEnv(() => {
      const restKernel = new Kernel({
        memoryPath: process.env.AXIOM_MEMORY_PATH,
        dbPath: process.env.AXIOM_DB_PATH,
        loadPlugins: false,
      });
      const text = 'faz2 mcp shared backend sentinel hayvandir';
      const learn = restKernel.learn(text, approvedAdmissionOpts());
      assert.equal(learn.ok, true);
      assert.ok(learn.data.learned > 0);
      restKernel.graph.close?.();

      const mcpKernel = createKernelFromEnv();
      const verify = mcpKernel.verify(text);
      assert.equal(verify.ok, true);
      assert.equal(verify.data.status, 'dogrulandi');
      mcpKernel.graph.close?.();
    });
  });
});

describe('FAZ2-PR5 contract: F-006 MCP approval persistence and execution path', () => {
  it('mcpServer.js no longer declares _pendingApprovals as a plain array', () => {
    const src = fs.readFileSync(require.resolve('../mcpServer'), 'utf8');
    assert.equal(src.includes('const _pendingApprovals = []'), false);
  });

  it('axiom.approve is exposed as the MCP approval execution handler', () => {
    const approveTool = TOOL_SCHEMAS.find((tool) => tool.name === 'axiom.approve');
    assert.ok(approveTool, 'axiom.approve must be present in tools/list schema');
    assert.equal(approveTool.annotations.idempotentHint, true);
  });

  it('approving a pending MCP learn uses approved admission instead of a bypass', () => {
    withTempAxiomEnv(() => {
      const server = createServer();
      const queued = callTool(server.kernel, {
        name: 'axiom.learn',
        arguments: { text: 'faz2 contract approved mcp sentinel hayvandir' },
      }, { approvalStore: server.approvalStore });
      assert.equal(queued.ok, false);
      assert.equal(queued.approval.status, 'pending');

      const approved = callTool(server.kernel, {
        name: 'axiom.approve',
        arguments: { approvalId: queued.approval.id, decision: 'approved' },
      }, { approvalStore: server.approvalStore });
      assert.equal(approved.ok, true);
      assert.equal(approved.data.executed, true);
      assert.equal(approved.data.result.data.admission.outcome, 'allow');
      assert.equal(approved.data.result.data.admission.approvalStatus, 'approved');
      server.kernel.graph.close?.();
      server.approvalStore?.close?.();
    });
  });
});
