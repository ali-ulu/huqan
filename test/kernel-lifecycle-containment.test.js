'use strict';

// The post-learn maintenance pass runs from setImmediate, outside any caller's
// try/catch. A failure there must be contained and a pass must not re-enter
// itself; otherwise one bad save() takes the whole process down.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-auto-maintain-'));
after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function makeKernel(name) {
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(tempDir, `${name}.json`),
  });
  kernel.maintenanceEvery = 1;
  return kernel;
}

test('a throwing maintenance pass after learn() does not escape as an uncaught exception', async () => {
  const kernel = makeKernel('throwing');
  kernel.selfEvolve = () => { throw new Error('boom from maintenance'); };
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  const listeners = process.listeners('uncaughtException');
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', onUncaught);
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    kernel.learn('cats are animals', Kernel.createAdmissionBypassOpts('test_fixture_seed'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = originalError;
    process.removeListener('uncaughtException', onUncaught);
    for (const listener of listeners) process.on('uncaughtException', listener);
  }
  assert.deepEqual(uncaught.map((error) => error.message), []);
  assert.ok(logged.some((line) => line.includes('boom from maintenance')), 'the failure is still reported');
});

test('a maintenance pass does not start while another one is running', () => {
  const kernel = makeKernel('reentrant');
  let runs = 0;
  kernel.selfEvolve = () => { runs += 1; kernel._autoMaintain(); };
  kernel._autoMaintain();
  assert.equal(runs, 1);
});

test('closing the kernel graph twice closes the memory store once', () => {
  const kernel = makeKernel('double-close');
  let memoryCloses = 0;
  const closeMemory = kernel.memory.close.bind(kernel.memory);
  kernel.memory.close = () => { memoryCloses += 1; closeMemory(); };
  kernel.graph.close();
  kernel.graph.close();
  assert.equal(memoryCloses, 1);
});
