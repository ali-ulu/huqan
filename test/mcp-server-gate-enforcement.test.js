'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { callTool } = require('../mcpServer');

const repoRoot = path.resolve(__dirname, '..');

// Spy kernel: records calls so we can prove gated tools never reach the kernel.
function makeSpyKernel() {
  const calls = { learn: 0, ask: 0, verify: 0, reason: 0, compare: 0, dream: 0 };
  return {
    _calls: calls,
    learn(text) { calls.learn++; return { ok: true, type: 'learn', data: { learned: 1 }, evidence: [], error: null, meta: {} }; },
    ask(q) { calls.ask++; return { ok: true, type: 'ask', data: { answer: String(q || '') }, evidence: [], error: null, meta: {} }; },
    verify(s) { calls.verify++; return { ok: true, type: 'verify', data: { status: 'bilinmiyor', confidence: 0 }, evidence: [], error: null, meta: {} }; },
    reason(s) { calls.reason++; return { ok: true, type: 'reason', data: {}, evidence: [], error: null, meta: {} }; },
    compare(l, r) { calls.compare++; return { ok: true, type: 'compare', data: {}, evidence: [], error: null, meta: {} }; },
    dream(opts) { calls.dream++; return { ok: true, type: 'dream', data: {}, evidence: [], error: null, meta: {} }; },
  };
}

describe('SEC-1A MCP direct tool safety matrix', () => {
  let tempDir;
  const rootArtifacts = ['memory.db', 'memory.json', 'memory.agent.json', 'memory.embeddings.json'];
  let rootArtifactBaseline;

  before(() => {
    rootArtifactBaseline = new Map(
      rootArtifacts.map((name) => [name, fs.existsSync(path.join(repoRoot, name))]),
    );
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-gate-test-'));
    process.env.AXIOM_DB_PATH = path.join(tempDir, 'memory.db');
    process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'memory.json');
  });

  after(async () => {
    delete process.env.AXIOM_DB_PATH;
    delete process.env.AXIOM_MEMORY_PATH;
    const cleanupErrors = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (!cleanupErrors.has(error && error.code)) {
          throw error;
        }
        if (attempt === 4) {
          break;
        }
      }
      // Windows file handles can linger briefly after SQLite closes.
      // Best-effort cleanup is enough here; repo-root leak detection stays strict.
      await delay(50);
    }
    for (const name of rootArtifacts) {
      const existedBefore = rootArtifactBaseline.get(name);
      const existsAfter = fs.existsSync(path.join(repoRoot, name));
      assert.equal(
        existedBefore || existsAfter,
        existedBefore,
        `storage artifact must not leak to repo root: ${name}`,
      );
    }
  });

  it('axiom.learn returns a review envelope and never calls kernel.learn()', () => {
    const kernel = makeSpyKernel();
    const res = callTool(kernel, { name: 'axiom.learn', arguments: { text: 'kedi hayvandir' } });
    assert.equal(kernel._calls.learn, 0, 'kernel.learn must NOT be called');
    assert.equal(res.ok, false, 'gated learn must be fail-closed (ok:false)');
    assert.equal(res.type, 'learn');
    assert.equal(res.meta.gate, 'review');
    assert.equal(res.data.decision, 'review');
    assert.equal(res.data.tool, 'axiom.learn');
    assert.equal(res.error.code, 'MUTATING_REQUIRES_REVIEW');
  });

  it('axiom.agent returns a dry_run_only envelope and does not execute the agent loop', () => {
    const kernel = makeSpyKernel();
    const res = callTool(kernel, { name: 'axiom.agent', arguments: { goal: 'do something risky' } });
    assert.equal(res.ok, false, 'gated agent must be fail-closed (ok:false)');
    assert.equal(res.type, 'agent');
    assert.equal(res.meta.gate, 'dry_run_only');
    assert.equal(res.data.decision, 'dry_run_only');
    assert.equal(res.data.tool, 'axiom.agent');
    assert.equal(res.error.code, 'AGENT_LOOP_DRY_RUN_ONLY');
  });

  it('unknown tool returns an explicit block envelope instead of throwing', () => {
    const kernel = makeSpyKernel();
    let res;
    assert.doesNotThrow(() => {
      res = callTool(kernel, { name: 'axiom.delete_everything', arguments: {} });
    });
    assert.equal(res.ok, false);
    assert.equal(res.meta.gate, 'block');
    assert.equal(res.data.decision, 'block');
    assert.equal(res.data.tool, 'axiom.delete_everything');
    assert.equal(res.error.code, 'UNKNOWN_TOOL_BLOCKED');
  });

  it('axiom.ask still responds through the kernel', () => {
    const kernel = makeSpyKernel();
    const res = callTool(kernel, { name: 'axiom.ask', arguments: { question: 'kedi nedir' } });
    assert.equal(kernel._calls.ask, 1, 'kernel.ask must be called');
    assert.equal(res.ok, true);
    assert.equal(res.type, 'ask');
  });

  it('axiom.verify still responds through the kernel', () => {
    const kernel = makeSpyKernel();
    const res = callTool(kernel, { name: 'axiom.verify', arguments: { statement: 'kedi hayvandir' } });
    assert.equal(kernel._calls.verify, 1, 'kernel.verify must be called');
    assert.equal(res.ok, true);
    assert.equal(res.type, 'verify');
  });

  it('a missing tool name is blocked (fail-closed default)', () => {
    const kernel = makeSpyKernel();
    const res = callTool(kernel, { arguments: {} });
    assert.equal(res.ok, false);
    assert.equal(res.meta.gate, 'block');
    assert.equal(res.error.code, 'UNKNOWN_TOOL_BLOCKED');
  });
});
