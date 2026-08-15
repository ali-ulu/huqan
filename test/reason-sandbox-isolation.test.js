const { describe, it } = require('node:test');
const assert = require('node:assert');
const Kernel = require('../kernel');
const { runRustSandbox, rustBinaryAvailable } = require('../lib/reason-sandbox');

const CAT = 'kedi bir hayvandir';
const DOG = 'kopek bir hayvandir';

/**
 * A stand-in for one axiom-core process.
 *
 * It reproduces the property that matters: the graph belongs to the *instance*,
 * and `batch` runs its child commands against that graph rather than isolating
 * them. So an implementation that reuses a single backend across calls sees
 * leakage here exactly as the real process leaks it, and one that builds a
 * backend per call does not.
 */
function fakeAxiomCoreFactory() {
  const instances = [];
  const factory = (opts) => {
    const facts = new Set();
    const instance = {
      opts,
      destroyed: false,
      batches: [],
      _fallback: null,
      async _send(cmd) {
        assert.strictEqual(instance.destroyed, false, 'a destroyed sandbox backend was reused');
        instance.batches.push(cmd);
        const results = (cmd.commands || []).map((child) => {
          if (child.cmd === 'learn') {
            facts.add(child.text);
            return { ok: true };
          }
          return { ok: true, answer: facts.has(child.question) ? 'biliyorum' : 'Bilmiyorum' };
        });
        return { ok: true, results };
      },
      destroy() { instance.destroyed = true; },
    };
    instances.push(instance);
    return instance;
  };
  factory.instances = instances;
  return factory;
}

describe('reasonSandbox gets a request-scoped Rust graph (#758)', () => {
  it('builds one backend per call and tears it down', async () => {
    const createRustGraph = fakeAxiomCoreFactory();
    await runRustSandbox({ learn: [CAT], ask: [CAT], createRustGraph });
    await runRustSandbox({ learn: [DOG], ask: [DOG], createRustGraph });

    assert.strictEqual(createRustGraph.instances.length, 2, 'the two calls shared a backend');
    for (const instance of createRustGraph.instances) {
      assert.strictEqual(instance.destroyed, true, 'a sandbox backend outlived its call');
    }
  });

  it('a later call cannot see facts learned by an earlier one', async () => {
    const createRustGraph = fakeAxiomCoreFactory();
    const first = await runRustSandbox({ learn: [CAT], ask: [CAT], createRustGraph });
    const second = await runRustSandbox({ learn: [], ask: [CAT], createRustGraph });

    assert.deepStrictEqual(first, ['biliyorum']);
    assert.deepStrictEqual(second, ['Bilmiyorum'], 'the sandbox answered from a previous call state');
  });

  it('concurrent calls cannot influence one another', async () => {
    const createRustGraph = fakeAxiomCoreFactory();
    const [a, b] = await Promise.all([
      runRustSandbox({ learn: [CAT], ask: [CAT, DOG], createRustGraph }),
      runRustSandbox({ learn: [DOG], ask: [DOG, CAT], createRustGraph }),
    ]);

    assert.deepStrictEqual(a, ['biliyorum', 'Bilmiyorum']);
    assert.deepStrictEqual(b, ['biliyorum', 'Bilmiyorum']);
    assert.strictEqual(createRustGraph.instances.length, 2);
  });

  it('learning with nothing to ask still runs, and still tears down', async () => {
    const createRustGraph = fakeAxiomCoreFactory();
    const answers = await runRustSandbox({ learn: [CAT], ask: [], createRustGraph });

    assert.deepStrictEqual(answers, []);
    assert.strictEqual(createRustGraph.instances[0].destroyed, true);
  });

  it('destroys the backend even when the batch fails', async () => {
    const instances = [];
    const createRustGraph = () => {
      const instance = {
        destroyed: false,
        _fallback: null,
        async _send() { return { ok: false, error: 'process_exited' }; },
        destroy() { instance.destroyed = true; },
      };
      instances.push(instance);
      return instance;
    };

    const answers = await runRustSandbox({ learn: [CAT], ask: [CAT], createRustGraph });
    assert.strictEqual(answers, null, 'a failed Rust batch must not be reported as sandbox answers');
    assert.strictEqual(instances[0].destroyed, true, 'the backend leaked after a failed batch');
  });

  it('treats a backend that degraded into its JS fallback as unusable', async () => {
    // RustGraph resolves _send with the fallback object itself when the binary
    // is missing or the spawn failed. That object is a Graph, not a reply.
    let destroyed = false;
    const createRustGraph = () => {
      const fallback = { iAmAGraph: true };
      return {
        _fallback: fallback,
        async _send() { return fallback; },
        destroy() { destroyed = true; },
      };
    };

    const answers = await runRustSandbox({ learn: [CAT], ask: [CAT], createRustGraph });
    assert.strictEqual(answers, null, 'the JS fallback object was mistaken for a Rust reply');
    assert.strictEqual(destroyed, true);
  });
});

describe('Kernel#reasonSandbox never routes through the shared bridge (#758)', () => {
  it('leaves the kernel-wide RustGraph untouched and alive', async () => {
    const kernel = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
    let sharedSends = 0;
    let sharedDestroyed = false;
    kernel._rust = {
      _send: async () => { sharedSends += 1; return { ok: true, results: [{ answer: 'leaked' }] }; },
      destroy: () => { sharedDestroyed = true; },
    };

    const result = await kernel.reasonSandbox({ learn: [CAT], ask: [CAT] });

    assert.strictEqual(sharedSends, 0, 'sandbox work was sent to the kernel-wide Rust graph');
    assert.strictEqual(sharedDestroyed, false, 'sandbox teardown destroyed a non-sandbox consumer');
    assert.ok(result.answers.length === 1, 'the sandbox still answered');
    assert.notStrictEqual(result.answers[0], 'leaked');
  });

  it('the JS backend has the same isolation semantics', async () => {
    const kernel = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
    kernel._rust = null;

    const first = await kernel.reasonSandbox({ learn: [CAT], ask: ['kedi nedir'] });
    const second = await kernel.reasonSandbox({ learn: [], ask: ['kedi nedir'] });

    assert.strictEqual(first.backend, 'js');
    assert.strictEqual(second.backend, 'js');
    assert.notStrictEqual(first.answers[0], 'Bilmiyorum', 'the JS sandbox failed to learn at all');
    assert.strictEqual(second.answers[0], 'Bilmiyorum', 'the JS sandbox carried a fact between calls');
  });
});

describe('reasonSandbox against a real axiom-core process (#758)', () => {
  // CI does not build the Rust binary, so this runs only where it exists
  // (`cargo build --release` in axiom-core/). It is reported as skipped, never
  // as a pass, when the binary is absent.
  const skip = rustBinaryAvailable() ? false : 'axiom-core release binary not built';

  it('a second call does not answer from the first call\'s facts', { skip }, async () => {
    const kernel = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
    assert.ok(kernel._rust, 'the binary exists but the kernel did not enable the Rust backend');

    const first = await kernel.reasonSandbox({ learn: [CAT], ask: ['kedi nedir'] });
    const second = await kernel.reasonSandbox({ learn: [], ask: ['kedi nedir'] });

    assert.strictEqual(first.backend, 'rust');
    assert.strictEqual(second.backend, 'rust');
    assert.notStrictEqual(first.answers[0], 'Bilmiyorum', 'the Rust sandbox failed to learn at all');
    assert.strictEqual(second.answers[0], 'Bilmiyorum', 'the Rust sandbox leaked state across calls');

    kernel._rust.destroy();
  });
});
