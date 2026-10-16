const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createKernelFromEnv, callTool } = require('./mcpServer');

/**
 * Uses callTool()/createKernelFromEnv() directly rather than spawning
 * mcpServer.js as a child process (mcpServer.test.js's pattern) -- that
 * file's process is shared across its whole describe block via a single
 * before(), so toggling AXIOM_HUMAN_APPROVAL_DISABLED there would leak into
 * unrelated tests that specifically assert a `review` decision. Calling
 * callTool() directly against a fresh in-process kernel keeps this
 * self-contained.
 */
function freshKernel() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-approval-toggle-'));
  const savedMemoryPath = process.env.AXIOM_MEMORY_PATH;
  const savedDbPath = process.env.AXIOM_DB_PATH;
  process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'memory.json');
  process.env.AXIOM_DB_PATH = path.join(tempDir, 'memory.db');
  const kernel = createKernelFromEnv();
  process.env.AXIOM_MEMORY_PATH = savedMemoryPath;
  process.env.AXIOM_DB_PATH = savedDbPath;
  return { kernel, tempDir };
}

describe('MCP human-approval toggle (#321)', () => {
  it('without the toggle, huqan.learn is queued for review and nothing is written', () => {
    const { kernel, tempDir } = freshKernel();
    delete process.env.AXIOM_HUMAN_APPROVAL_DISABLED;
    try {
      const result = callTool(kernel, { name: 'huqan.learn', arguments: { text: 'kedi hayvandir' } }, {});
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.gate.decision, 'review');
      assert.strictEqual(result.gate.canExecute, false);
      assert.strictEqual(kernel.graph.getNode('kedi'), null);
    } finally {
      kernel.graph.close?.();
      try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) { /* Windows may still hold a SQLite file lock briefly; scratch temp dir, not worth failing the test over */ }
    }
  });

  it('with the toggle enabled, huqan.learn executes immediately and the claim is admitted', () => {
    const { kernel, tempDir } = freshKernel();
    process.env.AXIOM_HUMAN_APPROVAL_DISABLED = 'true';
    try {
      const result = callTool(kernel, { name: 'huqan.learn', arguments: { text: 'köpek hayvandır' } }, {});
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.learned, 1);
      assert.strictEqual(result.data.admission.outcome, 'allow');
      assert.ok(kernel.graph.getNode('köpek'));
    } finally {
      delete process.env.AXIOM_HUMAN_APPROVAL_DISABLED;
      kernel.graph.close?.();
      try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) { /* Windows may still hold a SQLite file lock briefly; scratch temp dir, not worth failing the test over */ }
    }
  });

  it('the toggle does not affect a hard block (unknown tool stays blocked)', () => {
    const { kernel, tempDir } = freshKernel();
    process.env.AXIOM_HUMAN_APPROVAL_DISABLED = 'true';
    try {
      const result = callTool(kernel, { name: 'axiom.definitely-not-a-real-tool', arguments: {} }, {});
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.gate.decision, 'block');
    } finally {
      delete process.env.AXIOM_HUMAN_APPROVAL_DISABLED;
      kernel.graph.close?.();
      try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) { /* Windows may still hold a SQLite file lock briefly; scratch temp dir, not worth failing the test over */ }
    }
  });

  it('an explicit caller-supplied approvalRequired still wins over the toggle', () => {
    const { kernel, tempDir } = freshKernel();
    process.env.AXIOM_HUMAN_APPROVAL_DISABLED = 'true';
    try {
      const result = kernel.learn('balık yüzer', { approvalRequired: true });
      assert.strictEqual(result.data.admission.outcome, 'review');
      assert.strictEqual(result.data.learned, 0);
    } finally {
      delete process.env.AXIOM_HUMAN_APPROVAL_DISABLED;
      kernel.graph.close?.();
      try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) { /* Windows may still hold a SQLite file lock briefly; scratch temp dir, not worth failing the test over */ }
    }
  });
});
