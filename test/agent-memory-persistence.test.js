'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Agent = require('../agent');
const KernelV2 = require('../kernel.v2');
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');

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
