const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Graph = require('../graph');
const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');

function isolatedKernelOptions(root, extra = {}) {
  return {
    loadPlugins: false,
    useSQLite: false,
    memoryStoreUseSQLite: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
    ...extra,
  };
}

function closeKernel(kernel) {
  kernel?.graph?.close?.();
  kernel?.memory?.close?.();
}

test('Kernel constructor performs exactly one default graph load', { concurrency: false }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-kernel-load-'));
  const originalLoad = Graph.prototype.load;
  let loadCalls = 0;
  let kernel;
  Graph.prototype.load = function loadSpy() {
    loadCalls += 1;
    return originalLoad.call(this);
  };
  try {
    kernel = new Kernel(isolatedKernelOptions(root));
    assert.equal(loadCalls, 1);
    assert.ok(kernel.graph);
    assert.ok(kernel.memory);
    assert.ok(kernel.plugins);
  } finally {
    Graph.prototype.load = originalLoad;
    closeKernel(kernel);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Kernel noLoad constructor skips graph load without skipping initialization', { concurrency: false }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-kernel-no-load-'));
  const originalLoad = Graph.prototype.load;
  let loadCalls = 0;
  let kernel;
  Graph.prototype.load = function loadSpy() {
    loadCalls += 1;
    return originalLoad.call(this);
  };
  try {
    kernel = new Kernel(isolatedKernelOptions(root, { noLoad: true }));
    assert.equal(loadCalls, 0);
    assert.ok(kernel.graph);
    assert.ok(kernel.memory);
    assert.ok(kernel.plugins);
  } finally {
    Graph.prototype.load = originalLoad;
    closeKernel(kernel);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function withKernel(extra, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-kernel-seam-'));
  let kernel;
  try {
    kernel = new Kernel(isolatedKernelOptions(root, { noLoad: true, ...extra }));
    return run(kernel, root);
  } finally {
    closeKernel(kernel);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withMethods(target, replacements, run) {
  const descriptors = new Map();
  for (const [name, replacement] of Object.entries(replacements)) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(target, name));
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      value: replacement,
    });
  }

  try {
    return run();
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) {
        Object.defineProperty(target, name, descriptor);
      } else {
        delete target[name];
      }
    }
  }
}

test('persistence descriptor is fresh, frozen, exact, and ignores independent dbPath', { concurrency: false }, () => {
  withKernel({
    memoryPath: 'relative/State.JSON',
    dbPath: 'independent.db',
  }, kernel => {
    const first = kernel.getPersistenceDescriptor();
    const second = kernel.getPersistenceDescriptor();

    assert.notStrictEqual(first, second);
    assert.strictEqual(Object.isFrozen(first), true);
    assert.strictEqual(Object.isFrozen(second), true);
    assert.strictEqual(Object.getPrototypeOf(first), Object.prototype);
    assert.deepStrictEqual(Object.keys(first), ['memoryPath', 'dbPath']);
    assert.deepStrictEqual(first, {
      memoryPath: 'relative/State.JSON',
      dbPath: 'relative/State.db',
    });
    assert.strictEqual(Object.hasOwn(first, 'graph'), false);
    assert.strictEqual(Object.hasOwn(first, 'memory'), false);
  });
});

test('persistence descriptor preserves non-json path derivation behavior', { concurrency: false }, () => {
  withKernel({ memoryPath: 'relative/state.data' }, kernel => {
    assert.deepStrictEqual(kernel.getPersistenceDescriptor(), {
      memoryPath: 'relative/state.data',
      dbPath: 'relative/state.data',
    });
  });
});

test('reload delegates once with no arguments and returns the exact value', { concurrency: false }, () => {
  withKernel({}, kernel => {
    const calls = [];
    const expected = undefined;
    withMethods(kernel.graph, {
      load: (...args) => {
        calls.push(args);
        return expected;
      },
    }, () => {
      assert.strictEqual(kernel.reload(), expected);
      assert.deepStrictEqual(calls, [[]]);
    });
  });
});

test('reload propagates the exact graph error', { concurrency: false }, () => {
  withKernel({}, kernel => {
    const expected = new Error('reload failed');
    withMethods(kernel.graph, {
      load: () => { throw expected; },
    }, () => {
      assert.throws(() => kernel.reload(), error => error === expected);
    });
  });
});

test('persist delegates once with no arguments and returns the exact value', { concurrency: false }, () => {
  withKernel({}, kernel => {
    const calls = [];
    const expected = undefined;
    withMethods(kernel.graph, {
      save: (...args) => {
        calls.push(args);
        return expected;
      },
    }, () => {
      assert.strictEqual(kernel.persist(), expected);
      assert.deepStrictEqual(calls, [[]]);
    });
  });
});

test('persist propagates the exact graph error', { concurrency: false }, () => {
  withKernel({}, kernel => {
    const expected = new Error('persist failed');
    withMethods(kernel.graph, {
      save: () => { throw expected; },
    }, () => {
      assert.throws(() => kernel.persist(), error => error === expected);
    });
  });
});

test('optimize directly returns graph result without forbidden side effects', { concurrency: false }, () => {
  withKernel({}, kernel => {
    const expected = { pruned: 7, removedNodes: 4 };
    const calls = [];
    const unexpected = () => { throw new Error('unexpected side effect'); };

    withMethods(kernel.graph, {
      optimize: (...args) => {
        calls.push(args);
        return expected;
      },
      save: unexpected,
    }, () => withMethods(kernel, {
      dream: unexpected,
      consolidate: unexpected,
      selfEvolve: unexpected,
      _appendAuditEvent: unexpected,
    }, () => {
      assert.strictEqual(kernel.optimize(), expected);
      assert.deepStrictEqual(calls, [[]]);
    }));
  });
});

test('optimize propagates the exact graph error', { concurrency: false }, () => {
  withKernel({}, kernel => {
    const expected = new Error('optimize failed');
    withMethods(kernel.graph, {
      optimize: () => { throw expected; },
    }, () => {
      assert.throws(() => kernel.optimize(), error => error === expected);
    });
  });
});

test('KernelV2 delegates every lifecycle seam only to wrapped Kernel', { concurrency: false }, () => {
  withKernel({}, wrapped => {
    const kernelV2 = new KernelV2({ kernel: wrapped });
    const descriptor = Object.freeze({ memoryPath: 'wrapped.json', dbPath: 'wrapped.db' });
    const reloadResult = Symbol('reload');
    const persistResult = Symbol('persist');
    const optimizeResult = { pruned: 2, removedNodes: 1 };
    const calls = {
      descriptor: [],
      reload: [],
      persist: [],
      optimize: [],
    };
    const unexpected = () => { throw new Error('KernelV2 accessed Graph directly'); };

    withMethods(wrapped.graph, {
      load: unexpected,
      save: unexpected,
      optimize: unexpected,
    }, () => withMethods(wrapped, {
      getPersistenceDescriptor: (...args) => {
        calls.descriptor.push(args);
        return descriptor;
      },
      reload: (...args) => {
        calls.reload.push(args);
        return reloadResult;
      },
      persist: (...args) => {
        calls.persist.push(args);
        return persistResult;
      },
      optimize: (...args) => {
        calls.optimize.push(args);
        return optimizeResult;
      },
    }, () => {
      assert.strictEqual(kernelV2.getPersistenceDescriptor(), descriptor);
      assert.strictEqual(kernelV2.reload(), reloadResult);
      assert.strictEqual(kernelV2.persist(), persistResult);
      assert.strictEqual(kernelV2.optimize(), optimizeResult);
      assert.deepStrictEqual(calls, {
        descriptor: [[]],
        reload: [[]],
        persist: [[]],
        optimize: [[]],
      });
    }));
  });
});

test('KernelV2 preserves wrapped lifecycle seam error identity', { concurrency: false }, () => {
  withKernel({}, wrapped => {
    const kernelV2 = new KernelV2({ kernel: wrapped });
    for (const method of ['reload', 'persist', 'optimize']) {
      const expected = new Error(`${method} failed`);
      withMethods(wrapped, {
        [method]: () => { throw expected; },
      }, () => {
        assert.throws(() => kernelV2[method](), error => error === expected);
      });
    }
  });
});
