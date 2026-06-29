const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const Kernel = require('./kernel');
const PluginManager = require('./plugin');
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
});
