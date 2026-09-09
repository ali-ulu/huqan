'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Agent = require('../agent');
const KernelV2 = require('../kernel.v2');
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');
const { attachStepErrorSummary, runEnvelopeMeta, summarizeStepErrors } = require('../lib/agent-memory-persistence');

function throwingStorage() {
  const err = (op) => Object.assign(new Error(`${op} denied`), { code: 'EACCES' });
  return {
    saveGoalMemory: () => { throw err('saveGoalMemory'); },
    saveRun: () => { throw err('saveRun'); },
  };
}

function freshAgent(storage) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-agent-mem-'));
  const kernel = new KernelV2(isolatedKernelOptions('agent-mem', { noLoad: true, useSQLite: false, loadPlugins: false }));
  const agent = new Agent({ kernel, memoryPath: path.join(tmpDir, 'agent.memory.json'), storage, maxSteps: 1 });
  return { agent, tmpDir };
}

describe('agent memory-write failures surface in the envelope (#1985)', () => {
  it('run() reports memoryPersisted:false when storage writes throw', () => {
    const { agent, tmpDir } = freshAgent(throwingStorage());
    try {
      const result = agent.run('kendini test et', { resume: false });
      assert.equal(result.ok, true);
      assert.equal(result.meta.memoryPersisted, false);
      assert.ok(Array.isArray(result.meta.memoryErrors));
      assert.ok(result.meta.memoryErrors.length >= 2);
      assert.ok(result.meta.memoryErrors.some((e) => e.operation === 'saveRun'));
      assert.ok(result.meta.memoryErrors.some((e) => e.operation === 'saveGoalMemory'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('run() reports memoryPersisted:true when storage writes succeed', () => {
    const { agent, tmpDir } = freshAgent({ saveGoalMemory: () => {}, saveRun: () => {} });
    try {
      const result = agent.run('kendini test et', { resume: false });
      assert.equal(result.ok, true);
      assert.equal(result.meta.memoryPersisted, true);
      assert.deepEqual(result.meta.memoryErrors, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('intermediate step errors survive in the envelope (#1987)', () => {
  it('summarizeStepErrors counts error-status and ok:false steps', () => {
    assert.deepEqual(summarizeStepErrors([]), { hasStepErrors: false, stepErrorCount: 0 });
    assert.deepEqual(summarizeStepErrors(null), { hasStepErrors: false, stepErrorCount: 0 });
    const steps = [
      { status: 'error', result: { ok: false } },
      { status: 'done', result: { ok: true } },
      { status: 'done', result: { ok: false } },
    ];
    assert.deepEqual(summarizeStepErrors(steps), { hasStepErrors: true, stepErrorCount: 2 });
  });

  it('attachStepErrorSummary stamps state without touching status', () => {
    const state = { status: 'completed', steps: [{ status: 'error', result: { ok: false } }] };
    attachStepErrorSummary(state);
    assert.equal(state.hasStepErrors, true);
    assert.equal(state.stepErrorCount, 1);
    assert.equal(state.status, 'completed');
  });

  it('v1 run() meta carries hasStepErrors:false on a clean run', () => {
    const { agent, tmpDir } = freshAgent({ saveGoalMemory: () => {}, saveRun: () => {} });
    try {
      const result = agent.run('kendini test et', { resume: false });
      assert.equal(result.ok, true);
      assert.equal(result.meta.hasStepErrors, false);
      assert.equal(result.meta.stepErrorCount, 0);
      // #1985 envelope still intact.
      assert.equal(result.meta.memoryPersisted, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('runEnvelopeMeta merges persistence health and step errors', () => {
    const meta = runEnvelopeMeta({ _memoryPersisted: false, _memoryErrors: [{ operation: 'saveRun' }] }, [
      { status: 'error', result: { ok: false } },
    ]);
    assert.equal(meta.memoryPersisted, false);
    assert.equal(meta.hasStepErrors, true);
    assert.equal(meta.stepErrorCount, 1);
  });
});
