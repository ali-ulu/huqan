'use strict';

/**
 * The container bootstrap must not manufacture a runtime selector the factory
 * refuses (#774).
 *
 * prepareContainerEnvironment defaulted HUQAN_AGENT_VERSION to 'v2', but
 * agentRuntime pins AgentV3 as canonical and rejects every non-empty selector
 * other than 'v3' with HUQAN_AGENT_VERSION_UNSUPPORTED. So a default container
 * deployment -- one where the operator configured no agent version at all --
 * failed on every agent-backed path, because bootstrap had injected a legacy
 * value on their behalf.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { main, prepareContainerEnvironment } = require('../scripts/container-server');
const { createAgent, resolveAgentVersion, CANONICAL_AGENT_VERSION } = require('../agentRuntime');
const Kernel = require('../kernel');

function containerEnv(extra = {}) {
  const platformEnv = Object.fromEntries(
    ['PATH', 'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'WINDIR']
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  return { ...platformEnv, HUQAN_API_KEY: 'container-bootstrap-test-key', ...extra };
}

/** agentRuntime reads process.env, so a case that depends on it swaps it. */
function withProcessEnv(environment, run) {
  const saved = process.env;
  process.env = environment;
  try {
    return run();
  } finally {
    process.env = saved;
  }
}

test('bootstrap creates no agent version selector at all', () => {
  const environment = prepareContainerEnvironment(containerEnv());

  assert.equal(Object.hasOwn(environment, 'HUQAN_AGENT_VERSION'), false,
    'bootstrap invented an agent version the operator did not ask for');
  assert.equal(Object.hasOwn(environment, 'AXIOM_AGENT_VERSION'), false);
});

test('the other container defaults are still applied', () => {
  const environment = prepareContainerEnvironment(containerEnv());

  assert.equal(environment.HUQAN_HOST, '0.0.0.0');
  assert.equal(environment.HUQAN_MEMORY_PATH, '/app/data/memory.json');
  assert.equal(environment.HUQAN_DB_PATH, '/app/data/memory.db');
  assert.equal(environment.HUQAN_BACKUP_DIR, '/app/data/backups');
  assert.equal(environment.HUQAN_TRUST_PROXY, '0');
});

test('after bootstrap, the canonical agent resolves and can be created', () => {
  const environment = prepareContainerEnvironment(containerEnv());

  withProcessEnv(environment, () => {
    assert.equal(resolveAgentVersion(), CANONICAL_AGENT_VERSION);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-container-agent-'));
    const kernel = new Kernel({
      noLoad: true,
      loadPlugins: false,
      useSQLite: false,
      memoryPath: path.join(dir, 'memory.json'),
      dbPath: path.join(dir, 'memory.db'),
    });
    let agent;
    try {
      agent = createAgent({ kernel, memoryPath: path.join(dir, 'agent.json') });
      assert.ok(agent, 'a default container could not create its agent');
      assert.equal(agent.constructor.name, 'AgentV3');
    } finally {
      try { agent?.storage?.close(); } catch (_) {}
      try { kernel.graph.close(); } catch (_) {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('an agent-backed operation runs under the bootstrapped environment', () => {
  // Not just construction: the container smoke has to reach a real agent call,
  // which is where the injected selector used to surface (#774).
  const environment = prepareContainerEnvironment(containerEnv());

  withProcessEnv(environment, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-container-plan-'));
    const kernel = new Kernel({
      noLoad: true,
      loadPlugins: false,
      useSQLite: false,
      memoryPath: path.join(dir, 'memory.json'),
      dbPath: path.join(dir, 'memory.db'),
    });
    let agent;
    try {
      agent = createAgent({ kernel, memoryPath: path.join(dir, 'agent.json') });
      const plan = agent.plan('kedi hakkinda arastir');
      assert.ok(plan, 'the agent produced no plan under container defaults');
    } finally {
      try { agent?.storage?.close(); } catch (_) {}
      try { kernel.graph.close(); } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });
});

test('an explicit legacy selector still fails fast', () => {
  // Removing the default must not soften the rejection: an operator who asks
  // for v2 on purpose is still told it is gone.
  const environment = prepareContainerEnvironment(containerEnv({ HUQAN_AGENT_VERSION: 'v2' }));
  assert.equal(environment.HUQAN_AGENT_VERSION, 'v2', 'an explicit value must be preserved');

  withProcessEnv(environment, () => {
    assert.throws(() => resolveAgentVersion(), (error) => error.code === 'HUQAN_AGENT_VERSION_UNSUPPORTED');
    assert.throws(() => createAgent({ kernel: {} }), (error) => error.code === 'HUQAN_AGENT_VERSION_UNSUPPORTED');
  });
});

test('an explicit canonical selector is accepted', () => {
  const environment = prepareContainerEnvironment(containerEnv({ HUQAN_AGENT_VERSION: CANONICAL_AGENT_VERSION }));

  withProcessEnv(environment, () => {
    assert.equal(resolveAgentVersion(), CANONICAL_AGENT_VERSION);
  });
});

test('the canonical version literal is not duplicated in the bootstrap', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'container-server.js'), 'utf8');
  const defaultsBlock = source.slice(source.indexOf('const defaults'), source.indexOf('});', source.indexOf('const defaults')));

  assert.doesNotMatch(defaultsBlock, /AGENT_VERSION/,
    'the bootstrap must not carry its own copy of the agent version');
});

test('production bootstrap binds graceful shutdown before listening', () => {
  const calls = [];
  main({
    environment: containerEnv(),
    loadServer: () => ({
      bindGracefulShutdown() { calls.push('bind'); },
      startServer() { calls.push('listen'); },
    }),
  });
  assert.deepEqual(calls, ['bind', 'listen']);
});
