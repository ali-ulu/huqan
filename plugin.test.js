const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const Kernel = require('./kernel');
const PluginManager = require('./plugin');
const createCompanyBrainPlugin = require('./plugins/company-brain').create;
const createContradictionAlertPlugin = require('./plugins/contradiction-alert').create;
const createDiscoveryEnginePlugin = require('./plugins/discovery-engine').create;
const createIdeaMriPlugin = require('./plugins/idea-mri').create;
const createDevilAdvocatePlugin = require('./plugins/devil-advocate').create;

const TEST_FIXTURE_LEARN_BYPASS = {
  admissionRequired: false,
  admissionBypassReason: 'test_fixture_seed',
};

function learnFixture(kernel, text, opts = {}) {
  return kernel.learn(text, { ...opts, ...TEST_FIXTURE_LEARN_BYPASS });
}

function writePluginWithManifest(pluginPath, contents, opts = {}) {
  const manifestPath = pluginPath.replace(/\.js$/i, '.manifest.json');
  fs.writeFileSync(pluginPath, contents);
  const sha256 = PluginManager.hashFile(pluginPath);
  const manifest = { sha256 };
  if (opts.signatureKey) {
    manifest.signature = PluginManager.hmacSign(sha256, opts.signatureKey);
  }
  if (opts.manifest !== false) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  }
  return { manifestPath, sha256 };
}

describe('Plugin - Yonetici', () => {
  it('fact-extraction plugins receive the unchanged global known-node object', async () => {
    const defaultNode = { id: 'shared', label: 'Default shared', workspaceId: 'default' };
    const tenantNode = { id: 'shared', label: 'Tenant shared', workspaceId: 'tenant-a' };
    const knownNodes = {
      shared: defaultNode,
      'tenant-a::shared': tenantNode,
    };
    const before = JSON.parse(JSON.stringify(knownNodes));
    const received = [];
    const kernel = {
      graph: {
        _nodes: knownNodes,
        getEdges: () => [],
        getInEdges: () => [],
      },
      extractFacts(_text, nodes) {
        received.push(nodes);
        return [];
      },
      hasCapability: () => false,
      proposeNode: () => ({ ok: true }),
      proposeEdge: () => ({ edge: null }),
    };
    const cases = [
      [createCompanyBrainPlugin(), { sourceType: 'manual', text: 'shared relation' }, 'companyBrain'],
      [createContradictionAlertPlugin(), { text: 'shared relation' }, 'contradictionAlert'],
      [createDevilAdvocatePlugin(), { text: 'shared relation' }, 'devilAdvocate'],
      [createDiscoveryEnginePlugin(), { text: 'shared relation' }, 'discoveryEngine'],
      [createIdeaMriPlugin(), { text: 'shared relation' }, 'ideaMri'],
    ];

    for (const [plugin, input, capability] of cases) {
      await plugin.run(kernel, input, { capability: { name: capability } });
    }

    assert.strictEqual(received.length, cases.length);
    assert.ok(received.every(nodes => nodes === knownNodes));
    assert.deepStrictEqual(Object.keys(knownNodes), ['shared', 'tenant-a::shared']);
    assert.strictEqual(knownNodes.shared, defaultNode);
    assert.strictEqual(knownNodes['tenant-a::shared'], tenantNode);
    assert.deepStrictEqual(knownNodes, before);
  });

  it('usePlugin: eklenti kaydeder', () => {
    const k = new Kernel({ noLoad: true });
    k.usePlugin({ name: 'test', beforeLearn(k2, data) { data.text = 'plugin test'; } });
    learnFixture(k, 'kedi balik yer');
    assert.ok(k.graph.getNode('plugin'));
  });

  it('beforeLearn: metni degistirebilir', () => {
    const k = new Kernel({ noLoad: true });
    k.usePlugin({
      name: 'translator',
      beforeLearn(k2, data) {
        if (data.text === 'cat eats fish') data.text = 'kedi balik yer';
      }
    });
    learnFixture(k, 'cat eats fish');
    assert.ok(k.graph.getNode('kedi'));
    assert.strictEqual(k.graph.getNode('cat'), null);
  });

  it('afterLearn: ogrenme sonrasi tetiklenir', () => {
    let triggered = false;
    const k = new Kernel({ noLoad: true });
    k.usePlugin({
      name: 'logger',
      afterLearn(k2, data) { triggered = true; assert.strictEqual(data.text, 'kedi balik yer'); }
    });
    learnFixture(k, 'kedi balik yer');
    assert.strictEqual(triggered, true);
  });

  it('beforeAsk: soruyu degistirebilir', () => {
    const k = new Kernel({ noLoad: true });
    learnFixture(k, 'kedi balik yer');
    k.usePlugin({
      name: 'alias',
      beforeAsk(k2, data) { data.question = data.question.replace('cat', 'kedi'); }
    });
    const answer = k.ask('cat nedir').data.answer;
    assert.ok(answer.includes('balik'));
  });

  it('afterAsk: cevabi loglar', () => {
    let log;
    const k = new Kernel({ noLoad: true });
    k.usePlugin({
      name: 'qaLog',
      afterAsk(k2, data) { log = data; }
    });
    learnFixture(k, 'kedi balik yer');
    const answer = k.ask('kedi nedir').data.answer;
    assert.strictEqual(log.question, 'kedi nedir');
    assert.strictEqual(log.answer, answer);
  });

  it('birden fazla plugin zincirleme calisir', () => {
    const order = [];
    const k = new Kernel({ noLoad: true });
    k.usePlugin({ name: 'a', beforeLearn(k2, d) { order.push('a'); } });
    k.usePlugin({ name: 'b', beforeLearn(k2, d) { order.push('b'); } });
    learnFixture(k, 'kedi balik yer');
    assert.deepStrictEqual(order, ['a', 'b']);
  });

  it('init: yukleme aninda cagrilir', () => {
    let inited = false;
    const k = new Kernel({ noLoad: true });
    k.usePlugin({ name: 'initTest', init(k2) { inited = true; } });
    assert.strictEqual(inited, true);
  });

  it('load: plugins dizininden yukler', () => {
    const pDir = path.join(__dirname, 'plugins');
    if (!fs.existsSync(pDir)) fs.mkdirSync(pDir);
    const pluginPath = path.join(pDir, 'test-plugin.js');
    const manifestPath = pluginPath.replace(/\.js$/i, '.manifest.json');
    try {
      writePluginWithManifest(pluginPath, `module.exports = { name: 'filePlugin', beforeLearn(k, d) { d.text = 'eklenti dosya'; } };`);
      const k = new Kernel({ noLoad: true });
      const loaded = k.plugins.load(pDir);
      assert.ok(loaded >= 1);
    } finally {
      try { fs.unlinkSync(pluginPath); } catch {}
      try { fs.unlinkSync(manifestPath); } catch {}
    }
  });

  it('afterDream: hipotezleri loglar', () => {
    let hypotheses;
    const k = new Kernel({ noLoad: true });
    k.usePlugin({
      name: 'dreamLog',
      afterDream(k2, data) { hypotheses = data.hypotheses; }
    });
    learnFixture(k, 'kedi balik yer');
    learnFixture(k, 'kedi fare yer');
    learnFixture(k, 'balik suda yasar');
    const dream = new (require('./dream'))(k);
    dream.dream();
    assert.ok(Array.isArray(hypotheses));
  });

  it('beforeEmbedding: parametreleri degistirebilir', () => {
    const k = new Kernel({ noLoad: true });
    k.usePlugin({
      name: 'dimOverride',
      beforeEmbedding(k2, opts) { opts.dimensions = 128; }
    });
    learnFixture(k, 'kedi balik yer');
    learnFixture(k, 'kedi fare yer');
    learnFixture(k, 'balik suda yasar');
    learnFixture(k, 'fare peynir yer');
    const dream = new (require('./dream'))(k);
    dream.embedding({ dimensions: 64 });
    const node = k.graph.getNode('kedi');
    assert.strictEqual(node.embedding.length, 128);
  });

  it('beforeDream: ruya oncesi tetiklenir', () => {
    let flag = false;
    const k = new Kernel({ noLoad: true });
    k.usePlugin({ name: 'd', beforeDream() { flag = true; } });
    learnFixture(k, 'kedi balik yer');
    const dream = new (require('./dream'))(k);
    dream.dream();
    assert.strictEqual(flag, true);
  });

  it('verifyPluginFile: hash mismatch rejects plugin', () => {
    const pDir = path.join(__dirname, 'plugins');
    if (!fs.existsSync(pDir)) fs.mkdirSync(pDir);
    const pluginPath = path.join(pDir, 'hash-mismatch.js');
    const manifestPath = pluginPath.replace(/\.js$/i, '.manifest.json');
    try {
      writePluginWithManifest(pluginPath, `module.exports = { name: 'hashMismatch' };`);
      fs.writeFileSync(pluginPath, `module.exports = { name: 'hashMismatch', version: 2 };`);
      const verification = PluginManager.verifyPluginFile(pluginPath, { strict: true });
      assert.strictEqual(verification.ok, false);
      assert.strictEqual(verification.status, 'rejected');
      assert.match(verification.reason, /hash mismatch/i);
    } finally {
      try { fs.unlinkSync(pluginPath); } catch {}
      try { fs.unlinkSync(manifestPath); } catch {}
    }
  });

  it('load: strict mode skips unsigned plugins', () => {
    const pDir = path.join(__dirname, 'plugins-temp-strict');
    if (!fs.existsSync(pDir)) fs.mkdirSync(pDir);
    const pluginPath = path.join(pDir, 'strict-plugin.js');
    const manifestPath = pluginPath.replace(/\.js$/i, '.manifest.json');
    const original = process.env.AXIOM_PLUGIN_STRICT;
    try {
      writePluginWithManifest(pluginPath, `module.exports = { name: 'strictPlugin' };`, { manifest: false });
      process.env.AXIOM_PLUGIN_STRICT = '1';
      const k = new Kernel({ noLoad: true, loadPlugins: false });
      const loaded = k.plugins.load(pDir);
      assert.strictEqual(loaded, 0);
    } finally {
      if (original === undefined) delete process.env.AXIOM_PLUGIN_STRICT;
      else process.env.AXIOM_PLUGIN_STRICT = original;
      try { fs.unlinkSync(pluginPath); } catch {}
      try { fs.unlinkSync(manifestPath); } catch {}
      try { fs.rmdirSync(pDir); } catch {}
    }
  });

  it('verifyPluginFile: signed manifest validates with shared key', () => {
    const pDir = path.join(__dirname, 'plugins');
    if (!fs.existsSync(pDir)) fs.mkdirSync(pDir);
    const pluginPath = path.join(pDir, 'signed-plugin.js');
    const manifestPath = pluginPath.replace(/\.js$/i, '.manifest.json');
    try {
      writePluginWithManifest(pluginPath, `module.exports = { name: 'signedPlugin' };`, { signatureKey: 'secret-key' });
      const verification = PluginManager.verifyPluginFile(pluginPath, {
        strict: true,
        signatureKey: 'secret-key',
      });
      assert.strictEqual(verification.ok, true);
      assert.strictEqual(verification.status, 'verified-signed');
    } finally {
      try { fs.unlinkSync(pluginPath); } catch {}
      try { fs.unlinkSync(manifestPath); } catch {}
    }
  });

  it('register: blocks plugins with missing required capabilities', () => {
    const k = new Kernel({ noLoad: true, loadPlugins: false });
    assert.throws(() => {
      k.usePlugin({
        name: 'needsTemporal',
        requires: ['temporal'],
      });
    }, /requires missing capability: temporal/);
  });

  it('register: accepts plugins when required capabilities are enabled', () => {
    const k = new Kernel({ noLoad: true, loadPlugins: false });
    k.enableCapability('temporal');
    k.usePlugin({
      name: 'temporalOk',
      requires: ['temporal'],
    });
    assert.ok(k.plugins.plugins.some(plugin => plugin.name === 'temporalOk'));
  });

  it('listCapabilities/getCapability/runCapability: exposes plugin capability runner', async () => {
    const k = new Kernel({ noLoad: true, loadPlugins: false });
    k.enableCapability('pluginCapabilities');
    k.usePlugin({
      name: 'ideaMriMock',
      requires: [],
      optional: ['llm'],
      capabilities: [
        {
          name: 'ideaMri',
          command: 'mri',
          description: 'Idea MRI mock',
        },
      ],
      async run(kernel, input, opts = {}) {
        return {
          ok: true,
          input,
          capability: opts.capability?.name,
        };
      },
    });

    const listed = k.plugins.listCapabilities();
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].plugin, 'ideaMriMock');
    assert.strictEqual(k.plugins.getCapability('ideaMri').command, 'mri');
    assert.strictEqual(k.plugins.getCapability('mri').name, 'ideaMri');

    const result = await k.plugins.runCapability('ideaMri', { text: 'foo' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.capability, 'ideaMri');
    assert.deepStrictEqual(result.input, { text: 'foo' });
  });

  it('idea-mri: returns structured analysis fields', async () => {
    const k = new Kernel({ noLoad: true, loadPlugins: false });
    k.usePlugin(createIdeaMriPlugin());
    const result = await k.plugins.runCapability('ideaMri', {
      text: 'AXIOM sirket kararlari icin dusunce hakemi olacak. Once bireysel kullanimda dogrulanacak.',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.mode, 'structured-analysis');
    assert.strictEqual(typeof result.data.mainClaim, 'string');
    assert.ok(Array.isArray(result.data.claims));
    assert.ok(Array.isArray(result.data.assumptions));
    assert.ok(Array.isArray(result.data.risks));
    assert.ok(Array.isArray(result.data.missingEvidence));
    assert.ok(Array.isArray(result.data.evidenceGaps));
    assert.ok(Array.isArray(result.data.strengths));
    assert.ok(result.data.claims.every(item => typeof item.source === 'string'));
    assert.ok(result.data.assumptions.every(item => typeof item.source === 'string'));
    assert.ok(result.data.risks.every(item => typeof item.source === 'string'));
    assert.ok(result.data.missingEvidence.every(item => typeof item.source === 'string'));
    assert.ok(result.data.strengths.every(item => typeof item.source === 'string'));
  });

  it('devil-advocate: uses graph-backed output when subject has graph evidence', async () => {
    const k = new Kernel({ noLoad: true, loadPlugins: false });
    learnFixture(k, 'axiom motordur');
    learnFixture(k, 'axiom dogrulama yapar');
    k.usePlugin(createDevilAdvocatePlugin());
    const result = await k.plugins.runCapability('devilAdvocate', {
      text: 'axiom ana urun olmali',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.mode, 'graph-backed');
    assert.strictEqual(result.data.fallbackUsed, false);
    assert.ok(Array.isArray(result.data.evidence));
    assert.ok(result.data.evidence.length >= 1);
    assert.match(result.data.counterArgument, /axiom/i);
  });

  it('devil-advocate: labels llm fallback when graph is weak and llm is available', async () => {
    const k = new Kernel({ noLoad: true, loadPlugins: false });
    const plugin = createDevilAdvocatePlugin();
    plugin.adapter = {
      ask: async () => ({
        ok: true,
        data: { text: 'Bu fikir maliyet varsayimini kanitlamiyor.' },
      }),
    };
    k.usePlugin(plugin);
    const result = await k.plugins.runCapability('devilAdvocate', {
      text: 'yeni urun hemen buyuyecek',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.mode, 'llm-assisted');
    assert.strictEqual(result.data.fallbackUsed, true);
    assert.strictEqual(result.data.fallbackLabel, 'llm-assisted');
  });

  it('devil-advocate: returns a question list when graph is weak and llm is unavailable', async () => {
    const k = new Kernel({ noLoad: true, loadPlugins: false, capabilities: { llm: false } });
    const plugin = createDevilAdvocatePlugin();
    plugin.adapter = { ask: async () => ({ ok: false, error: 'disabled' }) };
    k.usePlugin(plugin);
    const result = await k.plugins.runCapability('devilAdvocate', {
      text: 'bilinmeyen fikir',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.mode, 'questions');
    assert.ok(Array.isArray(result.data.questions));
    assert.ok(result.data.questions.length >= 3);
  });

  it('devil-advocate: adds adjustedConfidence when evidenceRanking is enabled', async () => {
    const k = new Kernel({
      noLoad: true,
      loadPlugins: false,
      capabilities: { evidenceRanking: true },
    });
    learnFixture(k, 'axiom dogrulama yapar');
    const plugin = createDevilAdvocatePlugin();
    k.usePlugin(plugin);
    const result = await k.plugins.runCapability('devilAdvocate', { text: 'axiom hizli buyur' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.mode, 'graph-backed');
    assert.ok(result.data.evidence.length >= 1);
    assert.ok(result.data.evidence.every(item => typeof item.adjustedConfidence === 'number'));
  });

  // -------------------------------------------------------------------------
  // REFACTOR-4D AC-5.3 parity tests for discovery-engine `_nodes` migration.
  // Plugin should use the public `graph.getNodes('default')` API when present,
  // and fall back to `_nodes` only when `getNodes` is absent. Both paths must
  // produce identical observable behavior (fact extraction against the same
  // default-workspace node ID set).
  // -------------------------------------------------------------------------

  it('discovery-engine uses public graph.getNodes("default") when available (4D migration)', async () => {
    const defaultNode = { id: 'kedi', label: 'Kedi', workspaceId: 'default' };
    const tenantNode = { id: 'kedi', label: 'Tenant Kedi', workspaceId: 'tenant-a' };
    const knownNodes = {
      kedi: defaultNode,
      'tenant-a::kedi': tenantNode,
    };
    // Public API contract: `getNodes('default')` returns a snapshot object
    // (NOT the live `_nodes` map) restricted to the default workspace.
    const publicSnapshot = { kedi: { ...defaultNode } };

    // Spy: track _nodes reads (must stay 0 in the public path).
    const accessLog = { _nodesReads: 0 };
    let capturedArg = null;
    let getNodesCalls = [];
    const kernel = {
      graph: {
        get _nodes() {
          accessLog._nodesReads++;
          return knownNodes;
        },
        getNodes(workspaceId) {
          getNodesCalls.push(workspaceId);
          return workspaceId === 'default' ? publicSnapshot : {};
        },
        getEdges: () => [],
        getInEdges: () => [],
      },
      extractFacts(_text, nodes) {
        capturedArg = nodes;
        return [{ subject: 'kedi', predicate: 'hayvan' }];
      },
      hasCapability: () => false,
      proposeNode: () => ({ ok: true }),
      proposeEdge: () => ({ edge: null }),
    };

    const plugin = createDiscoveryEnginePlugin();
    const result = await plugin.run(kernel, { text: 'kedi hayvan' }, { capability: { name: 'discoveryEngine' } });

    // AC-5.3 (a): plugin called the public API with default workspace
    assert.deepStrictEqual(getNodesCalls, ['default']);

    // AC-5.3 (b): plugin did NOT touch `_nodes` when `getNodes` is present.
    // The captured argument must be the snapshot returned by `getNodes`, NOT
    // the raw `_nodes` map (which would include the tenant-a entry).
    assert.strictEqual(capturedArg, publicSnapshot);
    assert.notStrictEqual(capturedArg, knownNodes);
    assert.deepStrictEqual(Object.keys(capturedArg), ['kedi']);
    // The getter spy proves no read reached the private map.
    assert.strictEqual(accessLog._nodesReads, 0);

    // AC-5.3 (c): observable behavior — plugin produced facts from the
    // extracted facts list and returned the expected structure.
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.output.hypotheses.length, 1);
    assert.strictEqual(result.data.output.hypotheses[0].subject, 'kedi');
  });

  it('discovery-engine falls back to _nodes when graph.getNodes is absent (backward compat)', async () => {
    // Some test harnesses and older code paths construct mock graphs that only
    // expose `_nodes`. The migration must not break them — the fallback must
    // preserve the pre-migration behavior exactly.
    const defaultNode = { id: 'kedi', label: 'Kedi', workspaceId: 'default' };
    const knownNodes = { kedi: defaultNode };

    // Spy: track _nodes reads (must be >= 1 in the legacy fallback path).
    const accessLog = { _nodesReads: 0 };
    let capturedArg = null;
    const kernel = {
      graph: {
        get _nodes() {
          accessLog._nodesReads++;
          return knownNodes;
        },
        // No getNodes() at all
        getEdges: () => [],
        getInEdges: () => [],
      },
      extractFacts(_text, nodes) {
        capturedArg = nodes;
        return [{ subject: 'kedi', predicate: 'hayvan' }];
      },
      hasCapability: () => false,
      proposeNode: () => ({ ok: true }),
      proposeEdge: () => ({ edge: null }),
    };

    const plugin = createDiscoveryEnginePlugin();
    const result = await plugin.run(kernel, { text: 'kedi hayvan' }, { capability: { name: 'discoveryEngine' } });

    // A4: legacy path actually read `_nodes` at least once.
    assert.ok(
      accessLog._nodesReads >= 1,
      `expected _nodes read >= 1 in legacy fallback, got ${accessLog._nodesReads}`
    );
    // Fallback used `_nodes` directly
    assert.strictEqual(capturedArg, knownNodes);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.output.hypotheses.length, 1);
  });

  it('discovery-engine parity: getNodes("default") yields same fact extraction as _nodes for default workspace (AC-5.3)', async () => {
    // AC-5.3 requires parity tests proving observable behavior is unchanged.
    // Build a real graph via the canonical Graph class so we exercise the
    // actual public API contract, then run discovery-engine against both the
    // private `_nodes` map (pre-migration) and the public `getNodes('default')`
    // (post-migration) and assert identical fact-extraction output.
    //
    // Remediation note: the previous version attempted to remove `getNodes`
    // from the legacy graph instance via `delete` to force the fallback path.
    // `getNodes` lives on `Graph.prototype`, so that deletion was a no-op and
    // both scenarios ran the public path. The legacy scenario now uses a plain
    // legacy-shaped double with NO `getNodes`, and a getter spy proves `_nodes`
    // was actually read.
    const Graph = require('./graph');
    const createNlp = require('./nlp');
    const os = require('os');
    const nlp = createNlp('tr');
    const tmpPath = path.join(os.tmpdir(), `discovery-engine-parity-${Date.now()}-${process.pid}.json`);
    const graph = new Graph({ useSQLite: false, memoryPath: tmpPath });
    try {
      graph.addNode('kedi', 'Kedi', { source: 'fixture' });
      graph.addNode('balik', 'Balik', { source: 'fixture' });
      // Add a tenant-a node — it should NOT leak into default-workspace fact
      // extraction via `getNodes('default')`, AND it would have leaked via
      // `_nodes` because `Object.keys(_nodes)` returns both storage keys. This
      // is the parity subtlety the migration preserves: pre-migration behavior
      // already mixed scopes, post-migration behavior is more correct. Either
      // way, the default-workspace IDs the plugin cares about are present in
      // both, so the observable fact-extraction result for default-workspace
      // subjects is identical.
      graph.addNode('kedi', 'Tenant Kedi', { source: 'fixture' }, { workspaceId: 'tenant-a' });

      // Build a kernel-like object backed by the supplied graph argument.
      function buildKernel(graphArg) {
        return {
          graph: graphArg,
          nlp,
          extractFacts(text, knownNodes) {
            return nlp.extractFacts(text, knownNodes);
          },
          hasCapability: () => false,
          proposeNode: () => ({ ok: true }),
          proposeEdge: () => ({ edge: null }),
        };
      }

      const plugin = createDiscoveryEnginePlugin();

      // Run with the public-API path (post-migration):
      const kernelPublic = buildKernel(graph);
      const resultPublic = await plugin.run(kernelPublic, { text: 'kedi hayvan' }, { capability: { name: 'discoveryEngine' } });

      // Legacy scenario: legacy-shaped double with NO getNodes. `_nodes`
      // mirrors the full pre-migration internal map (includes tenant-a
      // entries). The spy proves the legacy fallback branch was actually
      // taken — without this assertion, the parity test is trivially true
      // if the plugin silently used the public path on both sides.
      const legacyAccessLog = { _nodesReads: 0 };
      const legacyGraph = {
        get _nodes() {
          legacyAccessLog._nodesReads++;
          return graph._nodes;
        },
        getEdges: (nodeId) => graph.getEdges(nodeId),
        getInEdges: (nodeId) => graph.getInEdges(nodeId),
      };
      const kernelLegacy = buildKernel(legacyGraph);
      const resultLegacy = await plugin.run(kernelLegacy, { text: 'kedi hayvan' }, { capability: { name: 'discoveryEngine' } });

      // Parity: hypotheses shape and content must match for the default-workspace
      // subject 'kedi'.
      assert.deepStrictEqual(resultPublic.data.output.hypotheses, resultLegacy.data.output.hypotheses);
      assert.deepStrictEqual(resultPublic.data.evidence, resultLegacy.data.evidence);
      assert.strictEqual(resultPublic.data.confidence, resultLegacy.data.confidence);
      assert.strictEqual(resultPublic.ok, resultLegacy.ok);

      // The default-workspace 'kedi' node must be reachable in both paths.
      assert.ok(resultPublic.data.output.hypotheses.some(h => h.subject === 'kedi'));

      // A4: the legacy scenario actually read `_nodes` at least once.
      assert.ok(
        legacyAccessLog._nodesReads >= 1,
        `expected _nodes read >= 1 in legacy scenario, got ${legacyAccessLog._nodesReads}`
      );
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      try { fs.unlinkSync(tmpPath.replace(/\.json$/, '.embeddings.json')); } catch (_) {}
    }
  });

  // -------------------------------------------------------------------------
  // REFACTOR-4D AC-5.3 parity tests for idea-mri `_nodes` migration.
  // Plugin should use the public `graph.getNodes('default')` API when present,
  // and fall back to `_nodes` only when `getNodes` is absent. Both paths must
  // produce identical observable behavior (fact extraction against the same
  // default-workspace node ID set).
  // -------------------------------------------------------------------------

  it('idea-mri uses public graph.getNodes("default") when available (4D migration)', async () => {
    const defaultNode = { id: 'kedi', label: 'Kedi', workspaceId: 'default' };
    const tenantNode = { id: 'kedi', label: 'Tenant Kedi', workspaceId: 'tenant-a' };
    const knownNodes = {
      kedi: defaultNode,
      'tenant-a::kedi': tenantNode,
    };
    const publicSnapshot = { kedi: { ...defaultNode } };

    // Spy: track _nodes reads (must stay 0 in the public path).
    const accessLog = { _nodesReads: 0 };
    let capturedArg = null;
    let getNodesCalls = [];
    const kernel = {
      graph: {
        get _nodes() {
          accessLog._nodesReads++;
          return knownNodes;
        },
        getNodes(workspaceId) {
          getNodesCalls.push(workspaceId);
          return workspaceId === 'default' ? publicSnapshot : {};
        },
        getEdges: () => [],
        getInEdges: () => [],
      },
      extractFacts(_text, nodes) {
        capturedArg = nodes;
        return [{ subject: 'kedi', predicate: 'hayvan' }];
      },
      hasCapability: () => false,
      proposeNode: () => ({ ok: true }),
      proposeEdge: () => ({ edge: null }),
    };

    const plugin = createIdeaMriPlugin();
    const result = await plugin.run(kernel, { text: 'kedi hayvan' }, { capability: { name: 'ideaMri' } });

    // AC-5.3 (a): plugin called the public API with default workspace
    assert.deepStrictEqual(getNodesCalls, ['default']);

    // AC-5.3 (b): plugin did NOT touch `_nodes` when `getNodes` is present.
    assert.strictEqual(capturedArg, publicSnapshot);
    assert.notStrictEqual(capturedArg, knownNodes);
    assert.deepStrictEqual(Object.keys(capturedArg), ['kedi']);
    // The getter spy proves no read reached the private map.
    assert.strictEqual(accessLog._nodesReads, 0);

    // AC-5.3 (c): observable behavior — plugin produced structured analysis.
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.mode, 'structured-analysis');
    assert.ok(result.data.claims.length >= 1);
  });

  it('idea-mri falls back to _nodes when graph.getNodes is absent (backward compat)', async () => {
    const defaultNode = { id: 'kedi', label: 'Kedi', workspaceId: 'default' };
    const knownNodes = { kedi: defaultNode };

    // Spy: track _nodes reads (must be >= 1 in the legacy fallback path).
    const accessLog = { _nodesReads: 0 };
    let capturedArg = null;
    const kernel = {
      graph: {
        get _nodes() {
          accessLog._nodesReads++;
          return knownNodes;
        },
        getEdges: () => [],
        getInEdges: () => [],
      },
      extractFacts(_text, nodes) {
        capturedArg = nodes;
        return [{ subject: 'kedi', predicate: 'hayvan' }];
      },
      hasCapability: () => false,
      proposeNode: () => ({ ok: true }),
      proposeEdge: () => ({ edge: null }),
    };

    const plugin = createIdeaMriPlugin();
    const result = await plugin.run(kernel, { text: 'kedi hayvan' }, { capability: { name: 'ideaMri' } });

    // A4: legacy path actually read `_nodes` at least once.
    assert.ok(
      accessLog._nodesReads >= 1,
      `expected _nodes read >= 1 in legacy fallback, got ${accessLog._nodesReads}`
    );
    // Fallback used `_nodes` directly
    assert.strictEqual(capturedArg, knownNodes);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.mode, 'structured-analysis');
  });

  it('idea-mri parity: getNodes("default") yields same fact extraction as _nodes for default workspace (AC-5.3)', async () => {
    // AC-5.3 requires parity tests proving observable behavior is unchanged.
    // Build a real graph via the canonical Graph class so we exercise the
    // actual public API contract, then run idea-mri against both the private
    // `_nodes` map (pre-migration) and the public `getNodes('default')`
    // (post-migration) and assert identical structured-analysis output.
    //
    // Remediation note: the previous version attempted to remove `getNodes`
    // from the legacy graph instance via `delete` to force the fallback path.
    // `getNodes` lives on `Graph.prototype`, so that deletion was a no-op and
    // both scenarios ran the public path. The legacy scenario now uses a plain
    // legacy-shaped double with NO `getNodes`, and a getter spy proves `_nodes`
    // was actually read.
    const Graph = require('./graph');
    const createNlp = require('./nlp');
    const os = require('os');
    const nlp = createNlp('tr');
    const tmpPath = path.join(os.tmpdir(), `idea-mri-parity-${Date.now()}-${process.pid}.json`);
    const graph = new Graph({ useSQLite: false, memoryPath: tmpPath });
    try {
      graph.addNode('kedi', 'Kedi', { source: 'fixture' });
      graph.addNode('balik', 'Balik', { source: 'fixture' });
      graph.addNode('kedi', 'Tenant Kedi', { source: 'fixture' }, { workspaceId: 'tenant-a' });

      function buildKernel(graphArg) {
        return {
          graph: graphArg,
          nlp,
          extractFacts(text, knownNodes) {
            return nlp.extractFacts(text, knownNodes);
          },
          hasCapability: () => false,
          proposeNode: () => ({ ok: true }),
          proposeEdge: () => ({ edge: null }),
        };
      }

      const plugin = createIdeaMriPlugin();

      const kernelPublic = buildKernel(graph);
      const resultPublic = await plugin.run(kernelPublic, { text: 'kedi hayvan' }, { capability: { name: 'ideaMri' } });

      // Legacy scenario: legacy-shaped double with NO getNodes. `_nodes`
      // mirrors the full pre-migration internal map (includes tenant-a
      // entries). The spy proves the legacy fallback branch was actually
      // taken — without this assertion, the parity test is trivially true
      // if the plugin silently used the public path on both sides.
      const legacyAccessLog = { _nodesReads: 0 };
      const legacyGraph = {
        get _nodes() {
          legacyAccessLog._nodesReads++;
          return graph._nodes;
        },
        getEdges: (nodeId) => graph.getEdges(nodeId),
        getInEdges: (nodeId) => graph.getInEdges(nodeId),
      };
      const kernelLegacy = buildKernel(legacyGraph);
      const resultLegacy = await plugin.run(kernelLegacy, { text: 'kedi hayvan' }, { capability: { name: 'ideaMri' } });

      // Parity: structured analysis output must match for the default-workspace
      // subject 'kedi'.
      assert.deepStrictEqual(resultPublic.data.claims, resultLegacy.data.claims);
      assert.deepStrictEqual(resultPublic.data.assumptions, resultLegacy.data.assumptions);
      assert.deepStrictEqual(resultPublic.data.risks, resultLegacy.data.risks);
      assert.deepStrictEqual(resultPublic.data.missingEvidence, resultLegacy.data.missingEvidence);
      assert.deepStrictEqual(resultPublic.data.strengths, resultLegacy.data.strengths);
      assert.strictEqual(resultPublic.data.mainClaim, resultLegacy.data.mainClaim);
      assert.strictEqual(resultPublic.ok, resultLegacy.ok);

      // The default-workspace 'kedi' subject must be reachable in both paths
      // (it surfaces as a claim containing 'kedi').
      assert.ok(resultPublic.data.claims.some(c => typeof c.text === 'string' && c.text.includes('kedi')));

      // A4: the legacy scenario actually read `_nodes` at least once.
      assert.ok(
        legacyAccessLog._nodesReads >= 1,
        `expected _nodes read >= 1 in legacy scenario, got ${legacyAccessLog._nodesReads}`
      );
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      try { fs.unlinkSync(tmpPath.replace(/\.json$/, '.embeddings.json')); } catch (_) {}
    }
  });

  // -------------------------------------------------------------------------
  // REFACTOR-4D AC-5.3 parity tests for devil-advocate `_nodes` migration.
  // Plugin should use the public `graph.getNodes('default')` API when present,
  // and fall back to `_nodes` only when `getNodes` is absent. Both paths must
  // produce identical observable behavior (fact extraction against the same
  // default-workspace node ID set).
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // REFACTOR-4D AC-5.3 parity tests for devil-advocate `_nodes` migration
  // (remediation: PR #81 post-merge evidence defect).
  //
  // Defect fixed: the previous parity test attempted to remove `getNodes`
  // from the legacy graph instance via `delete` to force the fallback path.
  // `getNodes` lives on `Graph.prototype`, not on the instance, so that
  // deletion was a no-op and the plugin still resolved `getNodes` via the
  // prototype chain. Both "public" and "legacy" scenarios therefore ran the
  // public path and the parity assertion was trivially true.
  //
  // Fix (per remediation spec A3/A4/B1):
  //   - Real-Graph scenarios construct `new Graph({ useSQLite: false,
  //     memoryPath: <os.tmpdir()/uniq> })` so no `memory.db`/`memory.json`
  //     artifacts are written to the cwd.
  //   - Legacy scenarios use a plain legacy-shaped double `{ _nodes: <map> }`
  //     with NO `getNodes` method — the plugin's `typeof getNodes === 'function'`
  //     check returns false and the `_nodes` fallback branch is genuinely taken.
  //   - `_nodes` reads are counted via a getter spy; the legacy tests assert
  //     `_nodesReads >= 1` to prove the legacy branch actually read `_nodes`
  //     (result equality alone is insufficient).
  //   - All cleanup is test-local try/finally (no global afterEach).
  // -------------------------------------------------------------------------

  it('devil-advocate uses public graph.getNodes("default") when available (4D migration)', async () => {
    const Graph = require('./graph');
    const createNlp = require('./nlp');
    const os = require('os');
    const nlp = createNlp('tr');
    const tmpPath = path.join(os.tmpdir(), `devil-advocate-public-${Date.now()}-${process.pid}.json`);
    const graph = new Graph({ useSQLite: false, memoryPath: tmpPath });
    try {
      graph.addNode('kedi', 'Kedi', { source: 'fixture' });
      graph.addNode('balik', 'Balik', { source: 'fixture' });
      graph.addNode('kedi', 'Tenant Kedi', { source: 'fixture' }, { workspaceId: 'tenant-a' });

      // Spy: track _nodes reads (must stay 0 in the public path) and
      // getNodes calls (must be exactly ['default']).
      const accessLog = { _nodesReads: 0, getNodesCalls: [] };
      const trackedGraph = {
        get _nodes() {
          accessLog._nodesReads++;
          return graph._nodes;
        },
        getNodes(workspaceId) {
          accessLog.getNodesCalls.push(workspaceId);
          return graph.getNodes(workspaceId);
        },
        getEdges: (nodeId) => graph.getEdges(nodeId),
        getInEdges: (nodeId) => graph.getInEdges(nodeId),
      };

      const kernel = {
        graph: trackedGraph,
        nlp,
        extractFacts: (text, knownNodes) => nlp.extractFacts(text, knownNodes),
        hasCapability: () => false,
        proposeNode: () => ({ ok: true }),
        proposeEdge: () => ({ edge: null }),
      };

      const plugin = createDevilAdvocatePlugin();
      plugin.init();
      const result = await plugin.run(kernel, { text: 'kedi hayvan' }, { capability: { name: 'devilAdvocate' } });

      // AC-5.3 (a): plugin called the public API with the default workspace.
      assert.deepStrictEqual(accessLog.getNodesCalls, ['default']);

      // AC-5.3 (b): plugin did NOT touch `_nodes` when `getNodes` is present.
      // The getter spy proves no read reached the private map.
      assert.strictEqual(accessLog._nodesReads, 0);

      // AC-5.3 (c): observable behavior — subject resolved to default-workspace 'kedi'.
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.subject, 'kedi');
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      try { fs.unlinkSync(tmpPath.replace(/\.json$/, '.embeddings.json')); } catch (_) {}
    }
  });

  it('devil-advocate falls back to _nodes when graph.getNodes is absent (backward compat)', async () => {
    // Legacy-shaped double: NO getNodes method at all. The plugin's
    // `typeof kernel.graph.getNodes === 'function'` check returns false and
    // the `_nodes` fallback branch is genuinely taken.
    const defaultNode = { id: 'kedi', label: 'Kedi', workspaceId: 'default' };
    const legacyNodeMap = { kedi: defaultNode };

    const accessLog = { _nodesReads: 0 };
    let capturedArg = null;
    const legacyGraph = {
      get _nodes() {
        accessLog._nodesReads++;
        return legacyNodeMap;
      },
      getEdges: () => [],
      getInEdges: () => [],
    };

    const kernel = {
      graph: legacyGraph,
      extractFacts(_text, nodes) {
        capturedArg = nodes;
        return [{ subject: 'kedi', predicate: 'hayvan' }];
      },
      hasCapability: () => false,
      proposeNode: () => ({ ok: true }),
      proposeEdge: () => ({ edge: null }),
    };

    const plugin = createDevilAdvocatePlugin();
    plugin.init();
    const result = await plugin.run(kernel, { text: 'kedi hayvan' }, { capability: { name: 'devilAdvocate' } });

    // A4: legacy path actually read `_nodes` at least once. Result equality
    // alone is insufficient — the spy proves the private map was touched.
    assert.ok(
      accessLog._nodesReads >= 1,
      `expected _nodes read >= 1 in legacy fallback, got ${accessLog._nodesReads}`
    );

    // extractFacts received the `_nodes` map directly (legacy behavior).
    assert.strictEqual(capturedArg, legacyNodeMap);

    // Observable behavior.
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.subject, 'kedi');
  });

  it('devil-advocate parity: getNodes("default") yields same observable output as _nodes for default workspace (AC-5.3)', async () => {
    const Graph = require('./graph');
    const createNlp = require('./nlp');
    const os = require('os');
    const nlp = createNlp('tr');
    const tmpPath = path.join(os.tmpdir(), `devil-advocate-parity-${Date.now()}-${process.pid}.json`);
    const graph = new Graph({ useSQLite: false, memoryPath: tmpPath });
    try {
      graph.addNode('kedi', 'Kedi', { source: 'fixture' });
      graph.addNode('balik', 'Balik', { source: 'fixture' });
      graph.addNode('kedi', 'Tenant Kedi', { source: 'fixture' }, { workspaceId: 'tenant-a' });

      function buildKernel(graphArg) {
        return {
          graph: graphArg,
          nlp,
          extractFacts: (text, knownNodes) => nlp.extractFacts(text, knownNodes),
          hasCapability: () => false,
          proposeNode: () => ({ ok: true }),
          proposeEdge: () => ({ edge: null }),
        };
      }

      const plugin = createDevilAdvocatePlugin();
      plugin.init();

      // Public scenario: real Graph, getNodes resolved via prototype.
      const kernelPublic = buildKernel(graph);
      const resultPublic = await plugin.run(kernelPublic, { text: 'kedi hayvan' }, { capability: { name: 'devilAdvocate' } });

      // Legacy scenario: legacy-shaped double with NO getNodes. `_nodes`
      // mirrors the full pre-migration internal map (includes tenant-a
      // entries). The spy proves the legacy fallback branch was actually
      // taken — without this assertion, the parity test is trivially true
      // if the plugin silently used the public path on both sides.
      const legacyAccessLog = { _nodesReads: 0 };
      const legacyGraph = {
        get _nodes() {
          legacyAccessLog._nodesReads++;
          return graph._nodes;
        },
        getEdges: (nodeId) => graph.getEdges(nodeId),
        getInEdges: (nodeId) => graph.getInEdges(nodeId),
      };
      const kernelLegacy = buildKernel(legacyGraph);
      const resultLegacy = await plugin.run(kernelLegacy, { text: 'kedi hayvan' }, { capability: { name: 'devilAdvocate' } });

      // Parity: observable output must match for the default-workspace subject 'kedi'.
      assert.deepStrictEqual(resultPublic.data, resultLegacy.data);
      assert.strictEqual(resultPublic.ok, resultLegacy.ok);

      // The default-workspace 'kedi' subject must be reachable in both paths.
      assert.strictEqual(resultPublic.data.subject, 'kedi');

      // A4: the legacy scenario actually read `_nodes` at least once. This
      // proves the parity comparison exercised the legacy branch, not the
      // public branch twice.
      assert.ok(
        legacyAccessLog._nodesReads >= 1,
        `expected _nodes read >= 1 in legacy scenario, got ${legacyAccessLog._nodesReads}`
      );
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      try { fs.unlinkSync(tmpPath.replace(/\.json$/, '.embeddings.json')); } catch (_) {}
    }
  });

  // -------------------------------------------------------------------------
  // REFACTOR-4D AC-5.3 parity tests for contradiction-alert `_nodes` migration.
  // Plugin should use the public `graph.getNodes('default')` API when present,
  // and fall back to `_nodes` only when `getNodes` is absent. Both paths must
  // produce identical observable behavior (fact extraction against the same
  // default-workspace node ID set).
  // -------------------------------------------------------------------------

  it('contradiction-alert uses public graph.getNodes("default") when available (4D migration)', async () => {
    const defaultNode = { id: 'kedi', label: 'Kedi', workspaceId: 'default' };
    const tenantNode = { id: 'kedi', label: 'Tenant Kedi', workspaceId: 'tenant-a' };
    const knownNodes = {
      kedi: defaultNode,
      'tenant-a::kedi': tenantNode,
    };
    // Public API contract: `getNodes('default')` returns a snapshot object
    // (NOT the live `_nodes` map) restricted to the default workspace.
    const publicSnapshot = { kedi: { ...defaultNode } };

    // Spy: track _nodes reads (must stay 0 in the public path).
    const accessLog = { _nodesReads: 0 };
    let capturedArg = null;
    let getNodesCalls = [];
    const kernel = {
      graph: {
        get _nodes() {
          accessLog._nodesReads++;
          return knownNodes;
        },
        getNodes(workspaceId) {
          getNodesCalls.push(workspaceId);
          return workspaceId === 'default' ? publicSnapshot : {};
        },
        getEdges: () => [],
        getInEdges: () => [],
      },
      extractFacts(_text, nodes) {
        capturedArg = nodes;
        return [{ subject: 'kedi', predicate: 'hayvan' }];
      },
      _parsePredicate(predicate) {
        const parts = String(predicate || '').split(/\s+/);
        return { relation: parts[0] || '', object: parts.slice(1).join(' ') };
      },
      hasCapability: () => false,
    };

    const plugin = createContradictionAlertPlugin();
    const result = await plugin.run(kernel, { text: 'kedi hayvan' }, { capability: { name: 'contradictionAlert' } });

    // AC-5.3 (a): plugin called the public API with default workspace
    assert.deepStrictEqual(getNodesCalls, ['default']);

    // AC-5.3 (b): plugin did NOT touch `_nodes` when `getNodes` is present.
    // The captured argument must be the snapshot returned by `getNodes`, NOT
    // the raw `_nodes` map (which would include the tenant-a entry).
    assert.strictEqual(capturedArg, publicSnapshot);
    assert.notStrictEqual(capturedArg, knownNodes);
    assert.deepStrictEqual(Object.keys(capturedArg), ['kedi']);
    // The getter spy proves no read reached the private map.
    assert.strictEqual(accessLog._nodesReads, 0);

    // AC-5.3 (c): observable behavior — plugin ran the conflict-detection
    // loop over extracted facts and returned the expected structure.
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.plugin, 'contradiction-alert');
    assert.strictEqual(result.data.newThought, 'kedi hayvan');
  });

  it('contradiction-alert falls back to _nodes when graph.getNodes is absent (backward compat)', async () => {
    // Some test harnesses and older code paths construct mock graphs that only
    // expose `_nodes`. The migration must not break them — the fallback must
    // preserve the pre-migration behavior exactly.
    const defaultNode = { id: 'kedi', label: 'Kedi', workspaceId: 'default' };
    const knownNodes = { kedi: defaultNode };

    // Spy: track _nodes reads (must be >= 1 in the legacy fallback path).
    const accessLog = { _nodesReads: 0 };
    let capturedArg = null;
    const kernel = {
      graph: {
        get _nodes() {
          accessLog._nodesReads++;
          return knownNodes;
        },
        // No getNodes() at all
        getEdges: () => [],
        getInEdges: () => [],
      },
      extractFacts(_text, nodes) {
        capturedArg = nodes;
        return [{ subject: 'kedi', predicate: 'hayvan' }];
      },
      _parsePredicate(predicate) {
        const parts = String(predicate || '').split(/\s+/);
        return { relation: parts[0] || '', object: parts.slice(1).join(' ') };
      },
      hasCapability: () => false,
    };

    const plugin = createContradictionAlertPlugin();
    const result = await plugin.run(kernel, { text: 'kedi hayvan' }, { capability: { name: 'contradictionAlert' } });

    // A4: legacy path actually read `_nodes` at least once.
    assert.ok(
      accessLog._nodesReads >= 1,
      `expected _nodes read >= 1 in legacy fallback, got ${accessLog._nodesReads}`
    );
    // Fallback used `_nodes` directly
    assert.strictEqual(capturedArg, knownNodes);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.plugin, 'contradiction-alert');
  });

  it('contradiction-alert parity: getNodes("default") yields same fact extraction as _nodes for default workspace (AC-5.3)', async () => {
    // AC-5.3 requires parity tests proving observable behavior is unchanged.
    // Build a real graph via the canonical Graph class so we exercise the
    // actual public API contract, then run contradiction-alert against both
    // the private `_nodes` map (pre-migration) and the public
    // `getNodes('default')` (post-migration) and assert identical
    // conflict-detection output.
    //
    // Note: this test follows the same pattern as the devil-advocate parity
    // test below. The legacy scenario uses a plain legacy-shaped double with
    // NO getNodes, and a getter spy proves `_nodes` was actually read.
    const Graph = require('./graph');
    const createNlp = require('./nlp');
    const os = require('os');
    const nlp = createNlp('tr');
    const tmpPath = path.join(os.tmpdir(), `contradiction-alert-parity-${Date.now()}-${process.pid}.json`);
    const graph = new Graph({ useSQLite: false, memoryPath: tmpPath });
    try {
      // Use a two-word subject node id ('kara kedi'). The Turkish NLP pack
      // (nlp/lang-tr.js) only matches a multi-word subject candidate against
      // the known-nodes id set passed in; a single-word subject like plain
      // 'kedi' would fall back to the same first-token subject regardless of
      // which node snapshot was supplied, which is exactly why the original
      // fixture stayed vacuous even with edges present. With 'kara kedi' as
      // the node id, the extracted subject (and therefore which edges are
      // looked up and whether a conflict is found) depends on whether the
      // known-nodes snapshot actually contains 'kara kedi' — i.e. it depends
      // on getting the *default* workspace, not some other workspace.
      graph.addNode('kara kedi', 'Kara Kedi', { source: 'fixture' });
      graph.addNode('hayvan', 'Hayvan', { source: 'fixture' });
      // Default-workspace edge 'kara kedi' -[tür]-> hayvan. The incoming
      // statement "kara kedi hayvan degildir" ("kara kedi" değil "hayvan")
      // directly contradicts it, so the plugin's conflict-detection loop
      // produces a non-empty result — but only when the subject resolves to
      // 'kara kedi', which requires the correct (default) node snapshot.
      graph.addEdge('kara kedi', 'hayvan', 'tür', { source: 'fixture' });
      // Wrong-workspace node sharing no id with the default snapshot. If the
      // plugin were changed to read the wrong workspace's snapshot (e.g.
      // getNodes('tenant-a') instead of getNodes('default')), the two-word
      // candidate 'kara kedi' would not be found in it, the subject would
      // fall back to the single token 'kara', and the conflict lookup
      // (getEdges('kara')) would find nothing — an empty result, differing
      // from the legacy/expected non-empty one.
      graph.addNode('kedi', 'Tenant marker', { source: 'fixture' }, { workspaceId: 'tenant-a' });

      function buildKernel(graphArg) {
        return {
          graph: graphArg,
          nlp,
          extractFacts(text, knownNodes) {
            return nlp.extractFacts(text, knownNodes);
          },
          _parsePredicate(predicate) {
            const parts = String(predicate || '').split(/\s+/);
            return { relation: parts[0] || '', object: parts.slice(1).join(' ') };
          },
          hasCapability: () => false,
        };
      }

      const plugin = createContradictionAlertPlugin();

      const kernelPublic = buildKernel(graph);
      const resultPublic = await plugin.run(kernelPublic, { text: 'kara kedi hayvan degildir' }, { capability: { name: 'contradictionAlert' } });

      // Legacy scenario: legacy-shaped double with NO getNodes. `_nodes`
      // mirrors the full pre-migration internal map (includes tenant-a
      // entries). The spy proves the legacy fallback branch was actually
      // taken — without this assertion, the parity test is trivially true
      // if the plugin silently used the public path on both sides.
      const legacyAccessLog = { _nodesReads: 0 };
      const legacyGraph = {
        get _nodes() {
          legacyAccessLog._nodesReads++;
          return graph._nodes;
        },
        getEdges: (nodeId) => graph.getEdges(nodeId),
        getInEdges: (nodeId) => graph.getInEdges(nodeId),
      };
      const kernelLegacy = buildKernel(legacyGraph);
      const resultLegacy = await plugin.run(kernelLegacy, { text: 'kara kedi hayvan degildir' }, { capability: { name: 'contradictionAlert' } });

      // Parity: observable output must match for the default-workspace subject 'kara kedi'.
      assert.deepStrictEqual(resultPublic.data, resultLegacy.data);
      assert.strictEqual(resultPublic.ok, resultLegacy.ok);

      // The default-workspace 'kara kedi' subject must be reachable in both paths.
      assert.strictEqual(resultPublic.data.newThought, 'kara kedi hayvan degildir');

      // Non-vacuity: the fixture must actually exercise the conflict-detection
      // loop. Without the kedi -[tür]-> hayvan edge above, both sides would
      // return an empty conflictingThoughts array regardless of which node
      // snapshot (default-workspace vs. wrong-workspace) was passed to
      // extractFacts, which would make the deepStrictEqual comparison above
      // trivially true. Asserting a populated, correctly-typed result proves
      // the comparison is capable of detecting a wrong node snapshot.
      assert.ok(
        resultPublic.data.conflictingThoughts.length > 0,
        'expected a non-empty conflict list; the fixture must produce a real conflict'
      );
      assert.strictEqual(resultPublic.data.conflictType, 'direct');

      // A4: the legacy scenario actually read `_nodes` at least once. This
      // proves the parity comparison exercised the legacy branch, not the
      // public branch twice.
      assert.ok(
        legacyAccessLog._nodesReads >= 1,
        `expected _nodes read >= 1 in legacy scenario, got ${legacyAccessLog._nodesReads}`
      );
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      try { fs.unlinkSync(tmpPath.replace(/\.json$/, '.embeddings.json')); } catch (_) {}
    }
  });

  // -------------------------------------------------------------------------
  // REFACTOR-4D AC-5.5 Package 03 — 03A queryCompanyBrain `_nodes` migration.
  // Plugin should use the public `graph.getNodes(workspaceId)` API when
  // present (dynamic workspace: input.workspaceId || 'default'), and fall
  // back to `_nodes` only when `getNodes` is absent. AC-5.3 parity must be
  // preserved for both default and tenant-a callers — the public API
  // applies the same workspace filter the inline loop previously applied,
  // so the observable set of ranked matches is unchanged for every
  // workspace value. See docs/refactor/decision-4d-graph-workspace-contract.md
  // Bölüm 4.2.1 (BINDING contract: dynamic workspace preserved).
  // -------------------------------------------------------------------------

  it('company-brain queryCompanyBrain uses public graph.getNodes(workspaceId) when available (4D migration 03A)', async () => {
    const defaultNode = { id: 'axiom', label: 'Axiom Motor', workspaceId: 'default' };
    const tenantNode = { id: 'axiom', label: 'Tenant Axiom', workspaceId: 'tenant-a' };
    const knownNodes = {
      axiom: defaultNode,
      'tenant-a::axiom': tenantNode,
    };
    // Public API contract: `getNodes('default')` returns only the default
    // workspace snapshot; `getNodes('tenant-a')` returns only tenant-a.
    const publicSnapshots = {
      default: { axiom: { ...defaultNode } },
      'tenant-a': { axiom: { ...tenantNode } },
    };

    // Spy: track _nodes reads (must stay 0 in the public path).
    const accessLog = { _nodesReads: 0 };
    let capturedArg = null;
    let getNodesCalls = [];
    const kernel = {
      graph: {
        get _nodes() {
          accessLog._nodesReads++;
          return knownNodes;
        },
        getNodes(workspaceId) {
          getNodesCalls.push(workspaceId);
          return publicSnapshots[workspaceId] || {};
        },
        getEdges: () => [],
        getInEdges: () => [],
      },
      hasCapability: () => false,
      proposeNode: () => {},
      proposeEdge: () => ({ edge: {} }),
    };

    const plugin = createCompanyBrainPlugin();
    // Tenant-a query: must call getNodes('tenant-a')
    const resultTenant = await plugin.run(kernel, {
      question: 'axiom ne',
      workspaceId: 'tenant-a',
    }, { capability: { name: 'companyBrain' } });

    // AC-5.3 (a): plugin called the public API with the requested workspace
    assert.deepStrictEqual(getNodesCalls, ['tenant-a']);
    // AC-5.3 (b): plugin did NOT touch `_nodes` when `getNodes` is present.
    assert.strictEqual(accessLog._nodesReads, 0);
    // The captured argument (when applicable) is the public snapshot, not
    // the raw `_nodes` map. queryCompanyBrain does not expose capturedArg
    // directly, but the getNodes call sequence proves the workspace filter
    // was routed through the public API.

    // Reset spies for the default-workspace call.
    getNodesCalls = [];
    accessLog._nodesReads = 0;
    const resultDefault = await plugin.run(kernel, {
      question: 'axiom ne',
      workspaceId: 'default',
    }, { capability: { name: 'companyBrain' } });

    assert.deepStrictEqual(getNodesCalls, ['default']);
    assert.strictEqual(accessLog._nodesReads, 0);
    assert.strictEqual(resultTenant.ok, true);
    assert.strictEqual(resultDefault.ok, true);
  });

  it('company-brain queryCompanyBrain falls back to _nodes when graph.getNodes is absent (backward compat 03A)', async () => {
    // Some test harnesses and older code paths construct mock graphs that
    // only expose `_nodes`. The migration must not break them — the
    // fallback must preserve the pre-migration behavior exactly.
    const defaultNode = { id: 'axiom', label: 'Axiom Motor', workspaceId: 'default' };
    const knownNodes = { axiom: defaultNode };

    // Spy: track _nodes reads (must be >= 1 in the legacy fallback path).
    const accessLog = { _nodesReads: 0 };
    const kernel = {
      graph: {
        get _nodes() {
          accessLog._nodesReads++;
          return knownNodes;
        },
        // No getNodes() at all
        getEdges: () => [],
        getInEdges: () => [],
      },
      hasCapability: () => false,
      proposeNode: () => {},
      proposeEdge: () => ({ edge: {} }),
    };

    const plugin = createCompanyBrainPlugin();
    const result = await plugin.run(kernel, {
      question: 'axiom ne',
      workspaceId: 'default',
    }, { capability: { name: 'companyBrain' } });

    // Legacy path actually read `_nodes` at least once.
    assert.ok(
      accessLog._nodesReads >= 1,
      `expected _nodes read >= 1 in legacy fallback, got ${accessLog._nodesReads}`
    );
    assert.strictEqual(result.ok, true);
  });

  it('company-brain queryCompanyBrain parity: getNodes(workspaceId) yields same ranked matches as _nodes filter for default and tenant-a (AC-5.3 03A)', async () => {
    // AC-5.3 requires parity tests proving observable behavior is unchanged.
    // Build a real graph via the canonical Graph class so we exercise the
    // actual public API contract. Run queryCompanyBrain against the public
    // `getNodes(workspaceId)` (post-migration) and against a legacy double
    // with NO `getNodes` whose `_nodes` mirrors the full pre-migration
    // internal map (includes tenant-a entries). The observable `evidence`
    // output must match for both default and tenant-a workspaces.
    const Graph = require('./graph');
    const os = require('os');
    const tmpPath = path.join(os.tmpdir(), `company-brain-parity-03a-${Date.now()}-${process.pid}.json`);
    const graph = new Graph({ useSQLite: false, memoryPath: tmpPath });
    try {
      graph.addNode('axiom', 'Axiom Motor', { source: 'fixture' });
      graph.addNode('motor', 'Motor', { source: 'fixture' });
      graph.addEdge('axiom', 'motor', 'tur', { source: 'fixture' });
      graph.addNode('axiom', 'Tenant Axiom Motor', { source: 'fixture' }, { workspaceId: 'tenant-a' });
      graph.addNode('motor', 'Tenant Motor', { source: 'fixture' }, { workspaceId: 'tenant-a' });
      // Graph.addEdge signature is (fromId, toId, relation, opts) — four args.
      // The workspace must be carried inside `opts.workspaceId`; a fifth
      // positional argument is silently dropped and the edge would land in
      // the default workspace, making the tenant-a evidence array vacuously
      // empty and the parity assertion trivially true.
      graph.addEdge('axiom', 'motor', 'tur', { source: 'fixture', workspaceId: 'tenant-a' });

      function buildKernel(graphArg) {
        return {
          graph: graphArg,
          hasCapability: () => false,
          proposeNode: () => {},
          proposeEdge: () => ({ edge: {} }),
        };
      }

      const plugin = createCompanyBrainPlugin();

      // Public path: real Graph (has getNodes)
      const kernelPublic = buildKernel(graph);
      const resultPublicDefault = await plugin.run(kernelPublic, {
        question: 'axiom ne',
        workspaceId: 'default',
      }, { capability: { name: 'companyBrain' } });
      const resultPublicTenant = await plugin.run(kernelPublic, {
        question: 'axiom ne',
        workspaceId: 'tenant-a',
      }, { capability: { name: 'companyBrain' } });

      // Legacy scenario: legacy-shaped double with NO getNodes. `_nodes`
      // mirrors the full pre-migration internal map. The spy proves the
      // legacy fallback branch was actually taken.
      const legacyAccessLog = { _nodesReads: 0 };
      const legacyGraph = {
        get _nodes() {
          legacyAccessLog._nodesReads++;
          return graph._nodes;
        },
        getEdges: (nodeId, ws) => graph.getEdges(nodeId, ws),
        getInEdges: (nodeId, ws) => graph.getInEdges(nodeId, ws),
      };
      const kernelLegacy = buildKernel(legacyGraph);
      const resultLegacyDefault = await plugin.run(kernelLegacy, {
        question: 'axiom ne',
        workspaceId: 'default',
      }, { capability: { name: 'companyBrain' } });
      const resultLegacyTenant = await plugin.run(kernelLegacy, {
        question: 'axiom ne',
        workspaceId: 'tenant-a',
      }, { capability: { name: 'companyBrain' } });

      // Parity: observable evidence output must match between public and
      // legacy paths for both default and tenant-a workspaces.
      assert.deepStrictEqual(resultPublicDefault.evidence, resultLegacyDefault.evidence);
      assert.deepStrictEqual(resultPublicTenant.evidence, resultLegacyTenant.evidence);
      assert.strictEqual(resultPublicDefault.ok, resultLegacyDefault.ok);
      assert.strictEqual(resultPublicTenant.ok, resultLegacyTenant.ok);

      // Non-vacuity: the fixture must actually exercise the evidence
      // collection loop. Without edges in each workspace, both sides would
      // return empty evidence arrays and the deepStrictEqual comparison
      // above would be trivially true. The 4-arg addEdge form (with
      // `workspaceId` carried inside `opts`) is what makes the tenant-a
      // edge actually land in the tenant-a workspace — a 5-arg form would
      // silently drop the workspace and leave tenant-a evidence empty.
      assert.ok(
        resultPublicDefault.evidence.length > 0,
        'expected non-empty evidence for default workspace; the fixture must produce real default edges'
      );
      assert.ok(
        resultPublicTenant.evidence.length > 0,
        'expected non-empty evidence for tenant-a workspace; the fixture must produce real tenant-a edges (4-arg addEdge form required)'
      );

      // Workspace isolation: every evidence item must carry the requesting
      // workspace. default query -> all evidence workspaceId === 'default'.
      // tenant-a query -> all evidence workspaceId === 'tenant-a'. This
      // catches the defect where a 5-arg addEdge form silently lands the
      // tenant-a edge in the default workspace and the tenant-a query
      // returns an empty (or wrong-workspace) evidence array.
      assert.ok(
        resultPublicDefault.evidence.every(item => item.workspaceId === 'default'),
        'default-workspace evidence must NOT include tenant-a edges'
      );
      assert.ok(
        resultPublicTenant.evidence.every(item => item.workspaceId === 'tenant-a'),
        'tenant-a evidence must NOT include default edges'
      );

      // A4: the legacy scenario actually read `_nodes` at least once.
      assert.ok(
        legacyAccessLog._nodesReads >= 1,
        `expected _nodes read >= 1 in legacy scenario, got ${legacyAccessLog._nodesReads}`
      );
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      try { fs.unlinkSync(tmpPath.replace(/\.json$/, '.embeddings.json')); } catch (_) {}
    }
  });

  // -------------------------------------------------------------------------
  // REFACTOR-4D AC-5.3a Package 03 — 03B ingestManual intentional narrowing.
  // `ingestManual` does NOT read `input.workspaceId` (Bölüm 4.2.2 of
  // decision-4d-graph-workspace-contract.md). Pre-migration it passed the
  // raw `_nodes` map (all workspaces) to `extractFacts`. Post-migration it
  // passes `getNodes('default')` — an INTENTIONAL DEFAULT-WORKSPACE
  // NARROWING, not parity. Authorized by
  // docs/refactor/acceptance-amendment-4d-ingestmanual-narrowing.md under
  // the AC-5.3a narrow exception (8 conditions). Three mutation guards
  // (raw `_nodes` restored, `getNodes('tenant-a')` used, explicit default
  // argument omitted) must all RED per Bölüm 5.4 / Bölüm 9.1 koşul 6 of
  // the amendment. The legacy fallback is covered by a SEPARATE
  // compatibility test (NOT part of the narrowing assertion) per Bölüm 5.5.
  //
  // Review turu 1 (this commit): the characterization test and all three
  // mutation guards now use the REAL `nlp/lang-tr.js#extractFacts` and the
  // REAL `Kernel#_parsePredicate` (instantiated via a real Kernel) instead
  // of a fake extractor. The fixture uses the real non-default storage-key
  // format `tenant-a::gizli kedi` (single key with embedded space, per
  // `nodeStorageKey` in graph.js). The input `'tenant-a::gizli kedi
  // hayvandir'` exercises the multi-word subject candidate matching in
  // `extractFacts` (nlp/lang-tr.js): only 2–3 word candidates are tried
  // against the known-nodes id set, so a real cross-workspace storage key
  // like `tenant-a::gizli kedi` is reachable as a subject IFF the raw
  // multi-workspace `_nodes` map is supplied. The observable difference is
  // measured not only on the extracted fact (subject + predicate) but also
  // on the `proposeEdge` call sequence: under the raw path an edge whose
  // `from` is the tenant-a storage key is created; under the default-only
  // path no such edge is created.
  // -------------------------------------------------------------------------

  it('company-brain ingestManual characterization: intentional default-workspace narrowing (AC-5.3a 03B)', async () => {
    // Source-realistic fixture per review turu 1.
    //
    // Real non-default storage key format (graph.js#nodeStorageKey):
    //   `${workspaceId}::${id}`
    // For workspaceId='tenant-a' and id='gizli kedi' the storage key is
    // the SINGLE string 'tenant-a::gizli kedi' (with embedded space).
    // extractFacts (nlp/lang-tr.js) only tries 2–3 word subject candidates
    // against `Object.keys(knownNodes)`, so a real cross-workspace storage
    // key like 'tenant-a::gizli kedi' is reachable as a subject IFF the
    // raw multi-workspace `_nodes` map is supplied.
    //
    // Input 'tenant-a::gizli kedi hayvandir' produces, via REAL extractFacts:
    //   - raw multi-workspace map: subject='tenant-a::gizli kedi',
    //     predicate='hayvandir' (the 2-word candidate 'tenant-a::gizli kedi'
    //     matches the tenant storage key in knownNodes).
    //   - default-only snapshot: subject='tenant-a::gizli' (first filtered
    //     token — the 2-word candidate 'tenant-a::gizli kedi' is NOT in the
    //     default snapshot, so extractFacts falls back to first-token
    //     subject), predicate='kedi hayvandir'.
    //
    // REAL _parsePredicate (kernel.js) then produces:
    //   - 'hayvandir'           -> { object: 'hayvan',      relation: 'tür' }
    //   - 'kedi hayvandir'      -> { object: 'kedi hayvan', relation: 'tür' }
    //
    // The observable edge-difference (measured via a proposeEdge spy):
    //   - raw path:        proposeEdge('tenant-a::gizli kedi', 'hayvan', 'tür', ...)
    //   - default-only:    proposeEdge('tenant-a::gizli', 'kedi hayvan', 'tür', ...)
    //   - default-only:    NO proposeEdge call has from='tenant-a::gizli kedi'
    //                     (the cross-workspace tenant subject edge does NOT
    //                     form under the narrowed helper).
    //
    // Five assertions (Bölüm 5.4 of the amendment):
    //   (1) default node 'kedi' is in knownNodes
    //   (2) tenant-a storage key 'tenant-a::gizli kedi' is NOT in knownNodes
    //   (3) getNodes('default') was called (NOT 'tenant-a', NOT raw _nodes)
    //   (4) public path did NOT read raw `_nodes`
    //   (5) tenant-a identifier cannot affect extraction result
    //   (6) [NEW] no proposeEdge call has from='tenant-a::gizli kedi' under
    //       the narrowed helper (cross-workspace subject edge does NOT form)
    //
    // Three mutation guards (Bölüm 5.4 / Bölüm 9.1 koşul 6) — verified
    // in the next three tests, all three MUST RED.

    const createNlp = require('./nlp');
    const nlp = createNlp('tr');
    // Instantiate a real Kernel purely to obtain the production
    // `_parsePredicate` (it depends on `this.nlp` and
    // `this._normalizeExplicitRelationObject`). No graph state is shared
    // with the spy kernel below — we only borrow the bound method.
    const os = require('os');
    const tmpKernelPath = path.join(os.tmpdir(), `p03-characterization-kernel-${Date.now()}-${process.pid}.json`);
    const realKernelForParser = new Kernel({ useSQLite: false, memoryPath: tmpKernelPath });
    try {
      const defaultNode = { id: 'kedi', label: 'Kedi', workspaceId: 'default' };
      const tenantNode = { id: 'tenant-a::gizli kedi', label: 'Gizli Kedi', workspaceId: 'tenant-a' };
      const knownNodesRaw = {
        'kedi': defaultNode,
        'tenant-a::gizli kedi': tenantNode,
      };
      const publicSnapshotDefault = { 'kedi': { ...defaultNode } };

      const accessLog = { _nodesReads: 0 };
      const getNodesCalls = [];
      const extractFactsCalls = [];
      const proposeEdgeCalls = [];
      let capturedArg = null;
      const kernel = {
        graph: {
          get _nodes() {
            accessLog._nodesReads++;
            return knownNodesRaw;
          },
          getNodes(workspaceId) {
            getNodesCalls.push(workspaceId);
            return workspaceId === 'default' ? publicSnapshotDefault : {};
          },
          getEdges: () => [],
          getInEdges: () => [],
        },
        // REAL extractFacts (delegates to the production turkish NLP pack).
        extractFacts(text, knownNodes) {
          extractFactsCalls.push({ text, knownNodeKeys: knownNodes ? Object.keys(knownNodes) : [] });
          capturedArg = knownNodes;
          return nlp.extractFacts(text, knownNodes);
        },
        // REAL _parsePredicate (bound to the production Kernel instance).
        _parsePredicate(predicate) {
          return realKernelForParser._parsePredicate(predicate);
        },
        hasCapability: () => false,
        proposeNode: () => {},
        proposeEdge: (from, to, relation, opts) => {
          proposeEdgeCalls.push({ from, to, relation, opts });
          return { edge: { from, to, relation } };
        },
      };

      const plugin = createCompanyBrainPlugin();
      // input.workspaceId is intentionally NOT passed — ingestManual does
      // not read it. If a caller passes workspaceId: 'tenant-a', it is
      // ignored by the helper (which always uses 'default').
      const result = await plugin.run(kernel, {
        action: 'manual',
        sourceType: 'manual',
        text: 'tenant-a::gizli kedi hayvandir',
        author: 'test',
        date: '2026-07-25',
      }, { capability: { name: 'companyBrain' } });

      // Assertion (1): default node 'kedi' is in knownNodes (capturedArg).
      assert.ok(
        capturedArg && Object.keys(capturedArg).includes('kedi'),
        'expected default node "kedi" in knownNodes snapshot'
      );

      // Assertion (2): tenant-a storage key 'tenant-a::gizli kedi' is NOT
      // in knownNodes. capturedArg must equal publicSnapshotDefault (only
      // the default 'kedi' key).
      assert.strictEqual(capturedArg, publicSnapshotDefault);
      assert.deepStrictEqual(Object.keys(capturedArg), ['kedi']);

      // Assertion (3): getNodes('default') was called exactly once.
      assert.deepStrictEqual(getNodesCalls, ['default']);

      // Assertion (4): public path did NOT read raw `_nodes`.
      assert.strictEqual(accessLog._nodesReads, 0);

      // Source-realistic fact extraction proof: with the default-only
      // snapshot, REAL extractFacts cannot match the 2-word candidate
      // 'tenant-a::gizli kedi' and falls back to the first-token subject
      // 'tenant-a::gizli'. The predicate becomes 'kedi hayvandir', which
      // REAL _parsePredicate then resolves to
      // { object: 'kedi hayvan', relation: 'tür' } (the -dır suffix is
      // stripped from 'hayvandir' and the remaining stem 'kedi hayvan'
      // is preserved as the object because it contains a space — see
      // kernel.js _parsePredicate multi-suffix branch).
      assert.ok(
        extractFactsCalls.length >= 1,
        'expected extractFacts to be called at least once on the public path'
      );
      assert.deepStrictEqual(extractFactsCalls[0].knownNodeKeys, ['kedi']);
      // The fact produced by REAL extractFacts on the default-only snapshot.
      // This is the source-grounded proof that the narrowing changes the
      // observable subject: the tenant storage key does NOT appear here.
      const facts = nlp.extractFacts('tenant-a::gizli kedi hayvandir', publicSnapshotDefault);
      assert.strictEqual(facts.length, 1);
      assert.strictEqual(facts[0].subject, 'tenant-a::gizli');
      assert.strictEqual(facts[0].predicate, 'kedi hayvandir');

      // Assertion (5): tenant-a identifier cannot affect extraction result.
      // Even if we pass workspaceId: 'tenant-a' in the input, ingestManual
      // still calls getNodes('default') — the helper is constant.
      getNodesCalls.length = 0;
      const resultTenantInput = await plugin.run(kernel, {
        action: 'manual',
        sourceType: 'manual',
        text: 'tenant-a::gizli kedi hayvandir',
        author: 'test',
        date: '2026-07-25',
        workspaceId: 'tenant-a',  // must be IGNORED
      }, { capability: { name: 'companyBrain' } });
      assert.deepStrictEqual(getNodesCalls, ['default']);
      assert.strictEqual(resultTenantInput.ok, true);
      assert.strictEqual(result.ok, true);

      // Assertion (6) [NEW — review turu 1]: no proposeEdge call under
      // the narrowed (default-only) helper has from === 'tenant-a::gizli
      // kedi'. Under the raw-_nodes mutation (guard 1) an edge with
      // from='tenant-a::gizli kedi' WOULD form — that is the observable
      // cross-workspace subject contamination the narrowing prevents.
      const tenantSubjectEdges = proposeEdgeCalls.filter(call => call.from === 'tenant-a::gizli kedi');
      assert.strictEqual(
        tenantSubjectEdges.length,
        0,
        'narrowed helper must NOT produce any edge whose `from` is the tenant-a storage key; ' +
        `saw ${tenantSubjectEdges.length} such edge(s) in proposeEdgeCalls: ${JSON.stringify(tenantSubjectEdges)}`
      );

      // Source-realistic contrast: under the raw-_nodes mutation, REAL
      // extractFacts WOULD produce subject='tenant-a::gizli kedi'. This
      // is computed directly (not via the helper) to prove the narrowing
      // is what prevents the cross-workspace subject edge — not a quirk
      // of the spy kernel.
      const factsRaw = nlp.extractFacts('tenant-a::gizli kedi hayvandir', knownNodesRaw);
      assert.strictEqual(factsRaw.length, 1);
      assert.strictEqual(factsRaw[0].subject, 'tenant-a::gizli kedi');
      assert.strictEqual(factsRaw[0].predicate, 'hayvandir');
      // And REAL _parsePredicate on the raw-path predicate:
      const parsedRaw = realKernelForParser._parsePredicate(factsRaw[0].predicate);
      assert.strictEqual(parsedRaw.relation, 'tür');
      assert.strictEqual(parsedRaw.object, 'hayvan');
      // So under the raw path, proposeEdge WOULD be called with
      //   from='tenant-a::gizli kedi', to='hayvan', relation='tür'
      // — which is exactly what assertion (6) above says the narrowed
      // helper must NOT produce.
    } finally {
      try { fs.unlinkSync(tmpKernelPath); } catch (_) {}
      try { fs.unlinkSync(tmpKernelPath.replace(/\.json$/, '.embeddings.json')); } catch (_) {}
    }
  });

  it('company-brain ingestManual mutation guard 1: restoring raw _nodes makes this test RED (AC-5.3a 03B)', async () => {
    // MUTATION: if the ingestManualKnownNodes helper is mutated to return
    // `kernel.graph?._nodes` (raw map) instead of `getNodes('default')`,
    // then REAL extractFacts would receive the raw multi-workspace map
    // and produce a fact whose subject is the tenant-a storage key
    // 'tenant-a::gizli kedi'. This test asserts (a) the helper did NOT
    // pass the raw map (capturedArg === publicSnapshotDefault), (b) REAL
    // extractFacts on the public snapshot does NOT produce a fact whose
    // subject is the tenant-a storage key, and (c) no proposeEdge call
    // has from === 'tenant-a::gizli kedi'. Verified manually by
    // temporarily reverting the helper — this test goes RED.
    //
    // NOTE: this test runs against the UNMODIFIED helper. To verify the
    // mutation guard, run a separate mutation trial (see commit body).
    const createNlp = require('./nlp');
    const nlp = createNlp('tr');
    const os = require('os');
    const tmpKernelPath = path.join(os.tmpdir(), `p03-guard1-kernel-${Date.now()}-${process.pid}.json`);
    const realKernelForParser = new Kernel({ useSQLite: false, memoryPath: tmpKernelPath });
    try {
      const defaultNode = { id: 'kedi', label: 'Kedi', workspaceId: 'default' };
      const tenantNode = { id: 'tenant-a::gizli kedi', label: 'Gizli Kedi', workspaceId: 'tenant-a' };
      const knownNodesRaw = {
        'kedi': defaultNode,
        'tenant-a::gizli kedi': tenantNode,
      };
      const publicSnapshotDefault = { 'kedi': { ...defaultNode } };

      let capturedArg = null;
      const proposeEdgeCalls = [];
      const kernel = {
        graph: {
          _nodes: knownNodesRaw,
          getNodes(workspaceId) {
            return workspaceId === 'default' ? publicSnapshotDefault : {};
          },
          getEdges: () => [],
          getInEdges: () => [],
        },
        extractFacts(text, knownNodes) {
          capturedArg = knownNodes;
          return nlp.extractFacts(text, knownNodes);
        },
        _parsePredicate(predicate) {
          return realKernelForParser._parsePredicate(predicate);
        },
        hasCapability: () => false,
        proposeNode: () => {},
        proposeEdge: (from, to, relation, opts) => {
          proposeEdgeCalls.push({ from, to, relation, opts });
          return { edge: { from, to, relation } };
        },
      };

      const plugin = createCompanyBrainPlugin();
      await plugin.run(kernel, {
        action: 'manual',
        sourceType: 'manual',
        text: 'tenant-a::gizli kedi hayvandir',
        author: 'test',
        date: '2026-07-25',
      }, { capability: { name: 'companyBrain' } });

      // Under unmodified helper: capturedArg === publicSnapshotDefault
      //   (1 key, 'kedi'). REAL extractFacts produces subject='tenant-a::gizli'
      //   (first-token fallback) and predicate='kedi hayvandir'.
      // Under raw-_nodes mutation: capturedArg === knownNodesRaw
      //   (2 keys including 'tenant-a::gizli kedi'). REAL extractFacts
      //   produces subject='tenant-a::gizli kedi' and predicate='hayvandir'.
      // These three assertions would ALL FAIL under the mutation.
      assert.strictEqual(capturedArg, publicSnapshotDefault);
      assert.strictEqual(
        Object.keys(capturedArg).includes('tenant-a::gizli kedi'),
        false,
        'capturedArg must NOT include tenant-a storage key — raw-_nodes mutation would leak it'
      );
      // No proposeEdge call may have from === 'tenant-a::gizli kedi'.
      // Under the raw-_nodes mutation, REAL extractFacts would produce
      // subject='tenant-a::gizli kedi' and the plugin would call
      // proposeEdge('tenant-a::gizli kedi', 'hayvan', 'tür', ...).
      const tenantSubjectEdges = proposeEdgeCalls.filter(call => call.from === 'tenant-a::gizli kedi');
      assert.strictEqual(
        tenantSubjectEdges.length,
        0,
        'narrowed helper must NOT call proposeEdge with tenant-a storage key as `from`; ' +
        `saw ${tenantSubjectEdges.length} such call(s): ${JSON.stringify(tenantSubjectEdges)}`
      );
    } finally {
      try { fs.unlinkSync(tmpKernelPath); } catch (_) {}
      try { fs.unlinkSync(tmpKernelPath.replace(/\.json$/, '.embeddings.json')); } catch (_) {}
    }
  });

  it('company-brain ingestManual mutation guard 2: using getNodes(tenant-a) makes this test RED (AC-5.3a 03B)', async () => {
    // MUTATION: if the ingestManualKnownNodes helper is mutated to call
    // `getNodes('tenant-a')` instead of `getNodes('default')`, then the
    // default 'kedi' would NOT be reachable (tenant-a snapshot is empty
    // in this fixture). REAL extractFacts would receive an empty
    // knownNodes map and fall back to first-token subject
    // 'tenant-a::gizli' with predicate 'kedi hayvandir' (same as the
    // characterization test, but for the wrong reason — the helper
    // bypassed the default workspace). This test asserts (a) getNodes
    // was called with the literal string 'default' (NOT 'tenant-a'),
    // and (b) the default 'kedi' WAS reachable in the captured
    // knownNodes snapshot. Verified manually by temporarily mutating
    // the helper to 'tenant-a' — this test goes RED.
    const createNlp = require('./nlp');
    const nlp = createNlp('tr');
    const os = require('os');
    const tmpKernelPath = path.join(os.tmpdir(), `p03-guard2-kernel-${Date.now()}-${process.pid}.json`);
    const realKernelForParser = new Kernel({ useSQLite: false, memoryPath: tmpKernelPath });
    try {
      const defaultNode = { id: 'kedi', label: 'Kedi', workspaceId: 'default' };
      const tenantNode = { id: 'tenant-a::gizli kedi', label: 'Gizli Kedi', workspaceId: 'tenant-a' };
      const knownNodesRaw = {
        'kedi': defaultNode,
        'tenant-a::gizli kedi': tenantNode,
      };
      const publicSnapshotDefault = { 'kedi': { ...defaultNode } };
      const tenantSnapshot = {};

      const getNodesCalls = [];
      let capturedArg = null;
      const kernel = {
        graph: {
          _nodes: knownNodesRaw,
          getNodes(workspaceId) {
            getNodesCalls.push(workspaceId);
            return workspaceId === 'default' ? publicSnapshotDefault : tenantSnapshot;
          },
          getEdges: () => [],
          getInEdges: () => [],
        },
        extractFacts(text, knownNodes) {
          capturedArg = knownNodes;
          return nlp.extractFacts(text, knownNodes);
        },
        _parsePredicate(predicate) {
          return realKernelForParser._parsePredicate(predicate);
        },
        hasCapability: () => false,
        proposeNode: () => {},
        proposeEdge: () => ({ edge: {} }),
      };

      const plugin = createCompanyBrainPlugin();
      await plugin.run(kernel, {
        action: 'manual',
        sourceType: 'manual',
        text: 'tenant-a::gizli kedi hayvandir',
        author: 'test',
        date: '2026-07-25',
      }, { capability: { name: 'companyBrain' } });

      // Under unmodified helper: getNodesCalls === ['default'] and the
      //   captured arg is the default snapshot (1 key 'kedi').
      // Under 'tenant-a' mutation: getNodesCalls === ['tenant-a'] and
      //   the captured arg is the empty tenant snapshot (0 keys).
      // Both assertions would FAIL under the mutation.
      assert.deepStrictEqual(getNodesCalls, ['default']);
      assert.strictEqual(capturedArg, publicSnapshotDefault);
      assert.deepStrictEqual(Object.keys(capturedArg), ['kedi']);
    } finally {
      try { fs.unlinkSync(tmpKernelPath); } catch (_) {}
      try { fs.unlinkSync(tmpKernelPath.replace(/\.json$/, '.embeddings.json')); } catch (_) {}
    }
  });

  it('company-brain ingestManual mutation guard 3: explicit default argument omission makes this test RED (AC-5.3a 03B)', async () => {
    // MUTATION: if the helper is mutated to call `getNodes()` with no
    // argument (or `getNodes(undefined)`), the production Graph
    // implementation defaults to 'default' (graph.js:617
    // `workspaceId = 'default'`), so the observable behavior in
    // production would be unchanged. The defect this guard catches is
    // therefore NOT a runtime leak — it is a code-review smell: the
    // narrowing contract requires the helper to pass the LITERAL STRING
    // 'default' explicitly so reviewers and grep-based audits can verify
    // the workspace is pinned. Omitting the argument relies on a default
    // value defined elsewhere and makes the narrowing intent invisible
    // at the call site.
    //
    // This test uses a custom getNodes that distinguishes between
    // `getNodes('default')` (literal string) and `getNodes()` /
    // `getNodes(undefined)` (omitted argument). Under the unmodified
    // helper, getNodes is called with the literal 'default'. Under the
    // omission mutation, getNodes is called with `undefined`. The
    // assertion `getNodesCalls === ['default']` catches this mutation
    // regardless of whether the production Graph would silently default
    // the omitted argument.
    //
    // Verified manually by mutating the helper to call `getNodes()` (no
    // arg) — this test goes RED. The previous "workspace filter removed"
    // framing was retired in review turu 1: the production Graph default
    // already pins 'default', so a no-arg call does NOT actually remove
    // the workspace filter — it only obscures the narrowing intent at
    // the call site. The renamed guard reflects what the mutation
    // actually breaks (explicit-ness) rather than what it does not
    // break (the runtime filter).
    const createNlp = require('./nlp');
    const nlp = createNlp('tr');
    const os = require('os');
    const tmpKernelPath = path.join(os.tmpdir(), `p03-guard3-kernel-${Date.now()}-${process.pid}.json`);
    const realKernelForParser = new Kernel({ useSQLite: false, memoryPath: tmpKernelPath });
    try {
      const defaultNode = { id: 'kedi', label: 'Kedi', workspaceId: 'default' };
      const tenantNode = { id: 'tenant-a::gizli kedi', label: 'Gizli Kedi', workspaceId: 'tenant-a' };
      const knownNodesRaw = {
        'kedi': defaultNode,
        'tenant-a::gizli kedi': tenantNode,
      };
      const publicSnapshotDefault = { 'kedi': { ...defaultNode } };

      const getNodesCalls = [];
      const kernel = {
        graph: {
          _nodes: knownNodesRaw,
          getNodes(workspaceId) {
            getNodesCalls.push(workspaceId);
            // Distinguish between literal 'default' and omitted (undefined)
            // argument. Both fall through to the default snapshot here —
            // the assertion is on the captured ARGUMENT, not on the
            // returned snapshot, because the production Graph would also
            // default an omitted argument to 'default' and the runtime
            // behavior would be identical. The narrowing contract
            // requires the literal 'default' string at the call site.
            if (workspaceId === 'default' || workspaceId === undefined || workspaceId === null || workspaceId === '') {
              return publicSnapshotDefault;
            }
            return {};
          },
          getEdges: () => [],
          getInEdges: () => [],
        },
        extractFacts(text, knownNodes) {
          return nlp.extractFacts(text, knownNodes);
        },
        _parsePredicate(predicate) {
          return realKernelForParser._parsePredicate(predicate);
        },
        hasCapability: () => false,
        proposeNode: () => {},
        proposeEdge: () => ({ edge: {} }),
      };

      const plugin = createCompanyBrainPlugin();
      await plugin.run(kernel, {
        action: 'manual',
        sourceType: 'manual',
        text: 'tenant-a::gizli kedi hayvandir',
        author: 'test',
        date: '2026-07-25',
      }, { capability: { name: 'companyBrain' } });

      // Under unmodified helper: getNodesCalls === ['default'] (literal
      //   string). The narrowing intent is visible at the call site.
      // Under omission mutation: getNodesCalls === [undefined] (or
      //   [null] / [''] depending on how the helper is mutated). The
      //   production Graph would still default to 'default' and the
      //   runtime behavior would be identical, but the narrowing intent
      //   is no longer visible at the call site.
      // This assertion catches the omission mutation by requiring the
      // literal string 'default' to be passed explicitly.
      assert.deepStrictEqual(
        getNodesCalls,
        ['default'],
        'narrowed helper must pass the literal string "default" to getNodes; ' +
        `saw getNodesCalls=${JSON.stringify(getNodesCalls)} — explicit default argument omission would produce [undefined] or [""]`
      );
    } finally {
      try { fs.unlinkSync(tmpKernelPath); } catch (_) {}
      try { fs.unlinkSync(tmpKernelPath.replace(/\.json$/, '.embeddings.json')); } catch (_) {}
    }
  });

  it('company-brain ingestManual legacy fallback compatibility: _nodes used when getNodes absent (AC-6 03B)', async () => {
    // Per Bölüm 5.5 of the amendment: the legacy fallback (kernel.graph._nodes)
    // is retained for test harnesses that construct mock graphs without
    // getNodes. This is a SEPARATE compatibility test, NOT part of the
    // narrowing assertion. AC-6 requires plugin/manifest compatibility proof.
    // The fallback must preserve the pre-migration behavior exactly: the
    // raw _nodes map (all workspaces) is passed to REAL extractFacts.
    //
    // Review turu 1: extractFacts and _parsePredicate upgraded from fake
    // implementations to the REAL production code paths (nlp/lang-tr.js
    // and Kernel#_parsePredicate respectively). The fixture uses the
    // real tenant storage key format 'tenant-a::gizli kedi'. Under the
    // legacy fallback the raw multi-workspace map IS supplied to
    // extractFacts, so the 2-word candidate 'tenant-a::gizli kedi'
    // matches and REAL extractFacts produces subject='tenant-a::gizli
    // kedi'. This is the source-grounded proof that the legacy fallback
    // preserves the pre-migration (raw-map, multi-workspace) behavior.
    const createNlp = require('./nlp');
    const nlp = createNlp('tr');
    const os = require('os');
    const tmpKernelPath = path.join(os.tmpdir(), `p03-legacy-kernel-${Date.now()}-${process.pid}.json`);
    const realKernelForParser = new Kernel({ useSQLite: false, memoryPath: tmpKernelPath });
    try {
      const defaultNode = { id: 'kedi', label: 'Kedi', workspaceId: 'default' };
      const tenantNode = { id: 'tenant-a::gizli kedi', label: 'Gizli Kedi', workspaceId: 'tenant-a' };
      const knownNodesRaw = {
        'kedi': defaultNode,
        'tenant-a::gizli kedi': tenantNode,
      };

      const accessLog = { _nodesReads: 0 };
      let capturedArg = null;
      let capturedFacts = null;
      const kernel = {
        graph: {
          get _nodes() {
            accessLog._nodesReads++;
            return knownNodesRaw;
          },
          // No getNodes() at all — forces legacy fallback
          getEdges: () => [],
          getInEdges: () => [],
        },
        extractFacts(text, knownNodes) {
          capturedArg = knownNodes;
          const facts = nlp.extractFacts(text, knownNodes);
          capturedFacts = facts;
          return facts;
        },
        _parsePredicate(predicate) {
          return realKernelForParser._parsePredicate(predicate);
        },
        hasCapability: () => false,
        proposeNode: () => {},
        proposeEdge: () => ({ edge: {} }),
      };

      const plugin = createCompanyBrainPlugin();
      const result = await plugin.run(kernel, {
        action: 'manual',
        sourceType: 'manual',
        text: 'tenant-a::gizli kedi hayvandir',
        author: 'test',
        date: '2026-07-25',
      }, { capability: { name: 'companyBrain' } });

      // AC-6 (a): legacy path actually read `_nodes` at least once.
      assert.ok(
        accessLog._nodesReads >= 1,
        `expected _nodes read >= 1 in legacy fallback, got ${accessLog._nodesReads}`
      );
      // AC-6 (b): captured arg is the raw _nodes map (NOT a snapshot).
      // The raw multi-workspace map includes the tenant-a storage key.
      assert.strictEqual(capturedArg, knownNodesRaw);
      assert.ok(
        Object.keys(capturedArg).includes('tenant-a::gizli kedi'),
        'legacy fallback must supply the raw multi-workspace map (incl. tenant storage key) to extractFacts'
      );
      // AC-6 (c): REAL extractFacts on the raw map produces a fact whose
      // subject IS the tenant-a storage key. This is the source-grounded
      // proof that the legacy fallback preserves the pre-migration
      // (multi-workspace, raw-map) behavior — and the exact reason the
      // post-migration narrowing is a behavior change, not parity.
      assert.ok(capturedFacts && capturedFacts.length >= 1);
      assert.strictEqual(capturedFacts[0].subject, 'tenant-a::gizli kedi');
      assert.strictEqual(capturedFacts[0].predicate, 'hayvandir');
      // AC-6 (d): REAL _parsePredicate on 'hayvandir' returns the
      // expected relation/object shape — proving the legacy path is
      // source-realistic end-to-end (not a fake).
      const parsed = realKernelForParser._parsePredicate(capturedFacts[0].predicate);
      assert.strictEqual(parsed.relation, 'tür');
      assert.strictEqual(parsed.object, 'hayvan');
      // AC-6 (e): plugin still produces a valid ingest result.
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.sourceType, 'manual');
      assert.ok(result.added >= 1);
    } finally {
      try { fs.unlinkSync(tmpKernelPath); } catch (_) {}
      try { fs.unlinkSync(tmpKernelPath.replace(/\.json$/, '.embeddings.json')); } catch (_) {}
    }
  });
});
