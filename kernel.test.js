const { describe, it } = require('node:test');
const assert = require('node:assert');
const Kernel = require('./kernel');
const { isolatedKernelOptions } = require('./test/helpers/isolated-persistence');

const TEST_FIXTURE_LEARN_BYPASS = Kernel.createAdmissionBypassOpts('test_fixture_seed');

// Test için temiz kernel — memory.json yüklemez
function freshKernel(opts = {}) {
  const kernel = new Kernel(isolatedKernelOptions('kernel', opts));
  const learn = kernel.learn.bind(kernel);
  kernel.learn = (text, learnOpts = {}) => learn(text, { ...learnOpts, ...TEST_FIXTURE_LEARN_BYPASS });
  return kernel;
}

describe('Kernel - Öğrenme', () => {
  it('restriction words match exact Turkish forms without wildcard false positives', () => {
    const k = freshKernel();

    assert.strictEqual(k._parsePredicate('yalnızca süt içer').kistlama, true);
    assert.strictEqual(k._parsePredicate('sırf süt içer').kistlama, true);
    assert.strictEqual(k._parsePredicate('yalnXzca süt içer').kistlama, undefined);
    assert.strictEqual(k._parsePredicate('sXrf süt içer').kistlama, undefined);
  });

  it('learn: basit cümleyi parse edip grafiğe ekler', () => {
    const k = freshKernel();
    k.learn('Köpek hayvandır');
    const n = k.graph.getNode('köpek');
    assert.ok(n);
    assert.strictEqual(n.label, 'köpek');
    const edges = k.graph.getEdges('köpek');
    assert.ok(edges.some(e => e.relation === 'tür' && e.to === 'hayvan'));
  });

  it('learn: aynı özne birden fazla yüklem alabilir', () => {
    const k = freshKernel();
    k.learn('Köpek hayvandır');
    k.learn('Köpek havlar');
    const edges = k.graph.getEdges('köpek');
    assert.ok(edges.some(e => e.relation === 'tür'));
    assert.ok(edges.some(e => e.relation === 'yapabilir' && e.to === 'havlar'));
  });

  it('learn: birden fazla kavram bağımsız eklenir', () => {
    const k = freshKernel();
    k.learn('Köpek hayvandır');
    k.learn('Kedi hayvandır');
    k.learn('Kedi miyavlar');
    assert.ok(k.graph.getNode('köpek'));
    assert.ok(k.graph.getNode('kedi'));
    assert.ok(k.graph.getNode('hayvan'));
  });

  it('learn: "bir" artikeli atlanır', () => {
    const k = freshKernel();
    k.learn('Kedi bir memelilerdir');
    const edges = k.graph.getEdges('kedi');
    assert.ok(edges.some(e => e.relation === 'tür'));
  });

  it('learn: çoğul özne normalize edilir', () => {
    const k = freshKernel();
    k.learn('kediler hayvandır');
    // "kediler" → "kedi" normalize edilmeli
    const node = k.graph.getNode('kedi');
    assert.ok(node, 'kedi düğümü oluşmalı');
  });
});

describe('Kernel - Çıkarım', () => {
  it('ask: doğrudan ilişkiyi bulur', () => {
    const k = freshKernel();
    k.learn('Köpek hayvandır');
    k.learn('Köpek havlar');
    const cevap = k.ask('Köpek nedir').data.answer;
    assert.ok(cevap);
    assert.ok(cevap.includes('hayvan'));
  });

  it('ask: bilinmeyen kavram için "Bilmiyorum" döner', () => {
    const k = freshKernel();
    const cevap = k.ask('Uçan fil nedir').data.answer;
    assert.strictEqual(cevap, 'Bilmiyorum');
  });

  it('ask: transitivite ile dolaylı ilişki bulur', () => {
    const k = freshKernel();
    k.learn('Köpek memelidir');
    k.learn('Memeli hayvandır');
    const cevap = k.ask('Köpek nedir').data.answer;
    assert.ok(cevap.includes('hayvan'));
  });

  it('ask: soru kelimesi temizlenir', () => {
    const k = freshKernel();
    k.learn('Kedi hayvandır');
    const cevap = k.ask('kedi nedir').data.answer;
    assert.ok(cevap !== 'Bilmiyorum');
    assert.ok(cevap.includes('hayvan'));
  });

  it('ask: bir afterAsk plugin\'inin cevabı yerinde değiştirmesi asıl yanıta yansır', () => {
    const k = freshKernel();
    k.learn('Köpek hayvandır');
    k.plugins.register({
      name: 'redactor-test',
      requires: [],
      optional: [],
      afterAsk(_kernel, data) {
        data.answer = 'REDACTED';
      },
    });
    const cevap = k.ask('Köpek nedir').data.answer;
    assert.strictEqual(cevap, 'REDACTED');
  });

  it('verify: explicit negation conflicts with known fact', () => {
    const k = freshKernel();
    k.learn('Kedi hayvandır');
    const result = k.verify('Kedi hayvan değildir');
    assert.strictEqual(result.data.status, 'contradicted');
    assert.ok(result.evidence.length > 0);
  });

  it('verify: direct numeric comparisons are evaluated before partial matches', () => {
    const k = freshKernel();
    const trueComparison = k.verify('9 != 8');
    const falseComparison = k.verify('9 = 8');

    assert.strictEqual(trueComparison.data.status, 'verified');
    assert.ok(trueComparison.evidence.length > 0);
    assert.strictEqual(falseComparison.data.status, 'contradicted');
    assert.ok(falseComparison.evidence.length > 0);
  });

  it('contradiction evidence keeps the underlying edge relation', () => {
    const k = freshKernel();
    k.learn('kiraci alt kiralayabilir');
    k.learn('kiraci alt kiralayamaz');
    const contradictionSource = k.detectContradictions().find(item => item.type === 'negasyon');
    const contradiction = k._contradictionEvidence(contradictionSource);
    assert.ok(contradiction);
    assert.ok(contradiction.text.length > 0);
    assert.ok(contradiction.nodes.includes('kiraci'));
    assert.ok(contradiction.edges.some(edge => edge.relation === 'değil' || edge.relation === 'yapabilir'));
  });
});

describe('Kernel - Bağlam Duyarlı Benzerlik', () => {
  it('contextSimilarity: aynı bağlamdaki kavramlar yüksek skor', () => {
    const k = freshKernel();
    k.learn('Köpek havlar');
    k.learn('Kedi miyavlar');
    k.learn('Köpek hayvandır');
    k.learn('Kedi hayvandır');
    k.learn('Köpek memelidir');
    k.learn('Kedi memelidir');
    k.graph.addTag('köpek', 'hayvan', 0.9);
    k.graph.addTag('kedi', 'hayvan', 0.9);
    k.graph.addTag('köpek', 'memeli', 0.8);
    k.graph.addTag('kedi', 'memeli', 0.8);
    k.graph.addTag('köpek', 'evcil', 0.7);
    k.graph.addTag('kedi', 'evcil', 0.7);

    const simHayvan = k.contextSimilarity('köpek', 'kedi', 'hayvan');
    const simRastgele = k.contextSimilarity('köpek', 'masa', 'hayvan');
    assert.ok(simHayvan > simRastgele);
    assert.ok(simHayvan > 0.5);
  });
});

describe('Kernel - Entropi', () => {
  it('entropy: boş graf sıfır entropi', () => {
    const k = freshKernel();
    assert.strictEqual(k.entropy(), 0);
  });

  it('entropy: bağlantılı düğüm pozitif entropi', () => {
    const k = freshKernel();
    // Direkt graph API ile kenar ekle — learn() NLP parsing'e bağımlı değil
    k.graph.addNode('a', 'a');
    k.graph.addNode('b', 'b');
    k.graph.addNode('c', 'c');
    k.graph.addEdge('a', 'b', 'tür');
    k.graph.addEdge('a', 'c', 'yapabilir');
    k.graph.addEdge('b', 'c', 'özellik');
    const s = k.entropy();
    assert.ok(s > 0, `Entropi pozitif olmalı, gelen: ${s}`);
  });
});

describe('Kernel - Boşluk Tespiti', () => {
  it('detectGaps: bağlantısız düğümleri bulur', () => {
    const k = freshKernel();
    k.learn('Köpek hayvandır');
    k.graph.addNode('yalnız', 'tek başına');
    const gaps = k.detectGaps();
    assert.ok(gaps.length > 0);
    assert.ok(gaps.includes('yalnız'));
  });
});

describe('Kernel - Çelişki Tespiti', () => {
  it('detectContradictions: çoklu-tür çelişkisini bulur', () => {
    const k = freshKernel();
    k.graph.addNode('a', 'a');
    k.graph.addNode('hayvan', 'hayvan');
    k.graph.addNode('bitki', 'bitki');
    k.graph.addEdge('a', 'hayvan', 'tür');
    k.graph.addEdge('a', 'bitki', 'tür');
    const cons = k.detectContradictions();
    const multiType = cons.find(c => c.type === 'çoklu-tür');
    assert.ok(multiType);
    assert.strictEqual(multiType.node, 'a');
  });

  it('detectContradictions: döngü çelişkisini bulur', () => {
    const k = freshKernel();
    k.graph.addNode('a', 'a');
    k.graph.addNode('b', 'b');
    k.graph.addEdge('a', 'b', 'tür');
    k.graph.addEdge('b', 'a', 'tür');
    const cons = k.detectContradictions();
    const cycle = cons.find(c => c.type === 'döngü');
    assert.ok(cycle);
  });

  it('detectContradictions: çelişkisiz graf boş dizi döndürür', () => {
    const k = freshKernel();
    k.learn('Köpek hayvandır');
    k.learn('Köpek havlar');
    const cons = k.detectContradictions();
    assert.ok(Array.isArray(cons));
    assert.strictEqual(cons.length, 0);
  });

  it('detectContradictions: sayisal contradiction carries concrete edges', () => {
    const k = freshKernel();
    k.learn('depozito en fazla 3 aylik kira bedelidir');
    k.learn('depozito en fazla 6 aylik kira bedelidir');
    const cons = k.detectContradictions();
    const numeric = cons.find(c => c.type === 'sayısal');
    assert.ok(numeric);
    assert.ok(Array.isArray(numeric.edges));
    assert.strictEqual(numeric.edges.length, 2);
  });
});

describe('Kernel - Reason & Compare', () => {
  it('reason: ileri ve geri zincir döner', () => {
    const k = freshKernel();
    k.learn('Köpek memelidir');
    k.learn('Memeli hayvandır');
    const r = k.reason('köpek').data.answer;
    assert.ok(r !== 'Bilmiyorum');
    assert.ok(r.includes('köpek'));
  });

  it('compare: ortak özellikleri bulur', () => {
    const k = freshKernel();
    k.learn('Köpek memelidir');
    k.learn('Kedi memelidir');
    const r = k.compare('köpek', 'kedi').data.answer;
    assert.ok(r.includes('ortak'));
  });
});


describe('Kernel - Core API Contract', () => {
  function assertEnvelope(result, type) {
    assert.strictEqual(typeof result.ok, 'boolean');
    assert.strictEqual(result.type, type);
    assert.ok('data' in result);
    assert.ok(Array.isArray(result.evidence));
    assert.ok('error' in result);
    assert.ok(result.meta && typeof result.meta === 'object');
  }

  it('public methods return the structured envelope', () => {
    const k = freshKernel();
    k.learn('kedi hayvandir');
    assertEnvelope(k.learn('kopek hayvandir'), 'learn');
    const askResult = k.ask('kedi nedir');
    const verifyResult = k.verify('kedi hayvandir');
    assertEnvelope(askResult, 'ask');
    assertEnvelope(verifyResult, 'verify');
    assertEnvelope(k.reason('kedi'), 'reason');
    assertEnvelope(k.compare('kedi', 'kopek'), 'compare');
    assertEnvelope(k.dream(), 'dream');
    assert.strictEqual(askResult.meta.contractVersion, Kernel.CONTRACT_VERSION);
    assert.strictEqual(verifyResult.meta.contractVersion, Kernel.CONTRACT_VERSION);
    assert.strictEqual(verifyResult.meta.paranoidMode, false);
  });

  it('validateResult catches invalid result shapes', () => {
    const k = freshKernel();
    assert.throws(() => k._validateResult({ ok: 'yes', evidence: [] }), /ok must be boolean/);
    assert.throws(() => k._validateResult({ ok: true, evidence: null }), /evidence must be array/);
    assert.throws(() => k._validateResult({ ok: true, type: 'verify', data: { status: 'bad', confidence: 0 }, evidence: [] }), /Invalid verify status/);
    assert.throws(() => k._validateResult({ ok: true, type: 'verify', data: { status: 'verified', confidence: 2 }, evidence: [] }), /Invalid confidence/);
  });

  it('normalizes Istanbul dotted and dotless variants to one node', () => {
    const k = freshKernel();
    k.learn('\u0130STANBUL sehirdir');
    k.learn('\u0131stanbul buyuktur');
    k.learn('istanbul kalabaliktir');
    assert.ok(k.graph.getNode('istanbul'));
    assert.strictEqual(k.graph.getNode('\u0131stanbul'), null);
    assert.ok(k.graph.getEdges('istanbul').length >= 3);
  });

  it('keeps other Turkish letters instead of transliterating them', () => {
    const k = freshKernel();
    k.learn('k\u00f6pek hayvandir');
    k.learn('\u00e7ocuk insandir');
    k.learn('\u00f6\u011frenme surectir');
    assert.ok(k.graph.getNode('k\u00f6pek'));
    assert.ok(k.graph.getNode('\u00e7ocuk'));
    assert.ok(k.graph.getNode('\u00f6\u011frenme'));
    assert.strictEqual(k.graph.getNode('kopek'), null);
    assert.strictEqual(k.graph.getNode('cocuk'), null);
    assert.strictEqual(k.graph.getNode('ogrenme'), null);
  });

  it('paranoidMode blocks learnFromLLM with a typed error', () => {
    const k = freshKernel({ paranoidMode: true });
    const result = k.learnFromLLM('kedi hayvandir');
    assert.strictEqual(
      result.error.message,
      'Paranoid mode is active: outbound LLM calls and automatic learning are blocked.',
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, Kernel.AXIOM_ERROR.LLM_DISABLED);
    assert.strictEqual(result.learned, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.meta.contractVersion, Kernel.CONTRACT_VERSION);
    assert.strictEqual(result.meta.paranoidMode, true);
  });

  it('exports error catalog and contract version on the class', () => {
    assert.strictEqual(Kernel.CONTRACT_VERSION, '1.0.0');
    assert.ok(Kernel.AXIOM_ERROR);
    assert.strictEqual(Kernel.AXIOM_ERROR.LLM_DISABLED, 'LLM_DISABLED');
  });
});

describe('Kernel - Capability System', () => {
  it('defaults expose the planned core capability set', () => {
    const k = freshKernel();
    assert.strictEqual(k.hasCapability('graph'), true);
    assert.strictEqual(k.hasCapability('llm'), true);
    assert.strictEqual(k.hasCapability('contradictionDetection'), true);
    assert.strictEqual(k.hasCapability('temporal'), false);
    assert.strictEqual(k.hasCapability('pluginCapabilities'), false);
    assert.strictEqual(k.hasCapability('evidenceRanking'), false);
  });

  it('enableCapability: toggles a capability on', () => {
    const k = freshKernel();
    assert.strictEqual(k.hasCapability('temporal'), false);
    assert.strictEqual(k.enableCapability('temporal'), true);
    assert.strictEqual(k.hasCapability('temporal'), true);
  });

  it('requireCapability: throws for missing capabilities', () => {
    const k = freshKernel();
    assert.throws(() => k.requireCapability('temporal'), /Required capability is not enabled: temporal/);
    k.enableCapability('temporal');
    assert.strictEqual(k.requireCapability('temporal'), true);
  });
});

describe('Kernel - Dream hypothesis regressions', () => {
  it('auto-think reports the exact UTF-8 connection summary', () => {
    const kernel = freshKernel({ useSQLite: false, loadPlugins: false });
    const logs = [];
    kernel.graph.addNode('kaynak', 'kaynak', null, { workspaceId: 'default' });
    kernel.graph.addNode('hedef', 'hedef', null, { workspaceId: 'default' });
    kernel._dreamer = {
      dream: () => [{ from: 'kaynak', to: 'hedef', type: 'benzerlik', confidence: 0.9 }],
    };
    kernel._commitBackgroundEdge = () => ({ decision: 'allow', edge: {} });
    kernel._autoThinkLog = message => logs.push(message);

    kernel._autoThinkTick();

    assert.deepStrictEqual(logs, ['1 new connections - 2 nodes total']);
  });

  it('selfEvolve maps vektör-benzerlik to benzer without a relation field', () => {
    const kernel = freshKernel({ useSQLite: false, loadPlugins: false });
    const Dream = require('./dream');
    const originalDream = Dream.prototype.dream;
    const originalCommit = kernel._commitBackgroundEdge;
    const proposedRelations = [];

    Dream.prototype.dream = function () {
      return [{
        from: 'kaynak',
        to: 'hedef',
        type: 'vektör-benzerlik',
        confidence: 0.9,
      }];
    };
    kernel._commitBackgroundEdge = function (from, to, relation) {
      proposedRelations.push({ from, to, relation });
      return { decision: 'review', edge: null };
    };

    try {
      const result = kernel.selfEvolve();
      assert.deepStrictEqual(proposedRelations, [{
        from: 'kaynak',
        to: 'hedef',
        relation: 'benzer',
      }]);
      assert.strictEqual(result.deferred, 1);
      assert.strictEqual(result.deferredDetails[0].relation, 'benzer');
    } finally {
      Dream.prototype.dream = originalDream;
      kernel._commitBackgroundEdge = originalCommit;
    }
  });

  it('introspect recognizes the canonical rüya self node', () => {
    const kernel = freshKernel({ useSQLite: false, loadPlugins: false });
    kernel.graph.addNode('rüya', null, 'default');

    const result = kernel.introspect();

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.data.ozBilgi.rüya, { var: true, kenar: 0 });
    assert.strictEqual(Object.hasOwn(result.data.ozBilgi, 'r?ya'), false);
  });

  it('introspect returns exact UTF-8 weak and strong point strings', () => {
    const isolatedKernel = freshKernel({ useSQLite: false, loadPlugins: false });
    isolatedKernel.graph.addNode('yalnız', 'yalnız', null, { workspaceId: 'default' });
    const isolated = isolatedKernel.introspect();
    assert.ok(isolated.data.zayifNoktalar.includes('1 isolated nodes'));

    const connectedKernel = freshKernel({ useSQLite: false, loadPlugins: false });
    for (let index = 0; index < 7; index++) {
      connectedKernel.graph.addNode(`n${index}`, `n${index}`, null, { workspaceId: 'default' });
    }
    for (let index = 1; index < 7; index++) {
      connectedKernel.graph.addEdge('n0', `n${index}`, 'benzer', { workspaceId: 'default' });
    }
    const connected = connectedKernel.introspect();
    assert.ok(connected.data.gucluNoktalar.includes('an active similarity network'));
  });
});

describe('Kernel - admission bypass unforgeability (#357)', () => {
  // The admission bypass used to be gated on two plain, string-keyed opts
  // fields (`admissionRequired === false` + a non-empty
  // `admissionBypassReason`). Any caller of the public learn() method --
  // including code that spreads decoded, untrusted JSON straight into opts
  // -- could produce that exact shape and walk past the memory-admission
  // gate entirely. It is now gated on a module-private Symbol that only
  // kernel.js can mint, exposed exclusively through
  // Kernel.createAdmissionBypassOpts(reason).

  it('the exact pre-fix literal shape no longer bypasses admission', () => {
    const kernel = new Kernel({ noLoad: true, loadPlugins: false });
    const result = kernel.learn('kopek hayvandir', {
      workspaceId: 'default',
      admissionRequired: false,
      admissionBypassReason: 'anything, even a very convincing reason',
    });

    assert.strictEqual(result.data.learned, 0);
    assert.strictEqual(result.data.admission.outcome, 'review');
    assert.deepStrictEqual(Object.keys(kernel.graph.getNodes('default')), []);
  });

  it('an object claiming a different Symbol under the same key name does not bypass', () => {
    // Guards against a caller trying to defeat the check by shipping its own
    // Symbol('...') with a similar description string. Symbol identity, not
    // description text, is what the check requires.
    const kernel = new Kernel({ noLoad: true, loadPlugins: false });
    const forgedToken = Symbol('huqan-kernel-internal-admission-bypass');
    const result = kernel.learn('kus ucmaz', {
      workspaceId: 'default',
      [forgedToken]: true,
      admissionBypassReason: 'forged',
    });

    assert.strictEqual(result.data.learned, 0);
    assert.strictEqual(result.data.admission.outcome, 'review');
  });

  it('surviving a JSON round-trip strips the bypass authority', () => {
    const kernel = new Kernel({ noLoad: true, loadPlugins: false });
    const genuine = Kernel.createAdmissionBypassOpts('genuinely internal');
    const overWire = JSON.parse(JSON.stringify({ workspaceId: 'default', ...genuine }));

    const result = kernel.learn('balik yuzer', overWire);

    assert.strictEqual(result.data.learned, 0);
    assert.strictEqual(result.data.admission.outcome, 'review');
  });

  it('Object.assign/spread of a genuine bypass object still bypasses (own callers keep working)', () => {
    const kernel = new Kernel({ noLoad: true, loadPlugins: false });
    const genuine = Kernel.createAdmissionBypassOpts('legit internal caller');
    const result = kernel.learn('deniz mavidir', { workspaceId: 'default', ...genuine });

    assert.strictEqual(result.ok, true);
    assert.ok(result.data.learned > 0);
    assert.strictEqual(result.data.admission, null);
  });

  it('createAdmissionBypassOpts requires a non-empty string reason', () => {
    assert.throws(() => Kernel.createAdmissionBypassOpts(), TypeError);
    assert.throws(() => Kernel.createAdmissionBypassOpts(''), TypeError);
    assert.throws(() => Kernel.createAdmissionBypassOpts('   '), TypeError);
    assert.throws(() => Kernel.createAdmissionBypassOpts(42), TypeError);
    assert.throws(() => Kernel.createAdmissionBypassOpts(null), TypeError);
  });

  it('reasonSandbox (the one legitimate internal-bootstrap bypass) still works', async () => {
    const kernel = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
    const { backend, answers } = await kernel.reasonSandbox({
      learn: ['kedi hayvandir'],
      ask: ['kedi nedir'],
    });
    assert.ok(['rust', 'js'].includes(backend));
    assert.strictEqual(answers.length, 1);
    // The sandbox graph is ephemeral and never touches kernel.graph, so this
    // only proves the bypass still functions for its one legitimate
    // caller -- not that anything was written to the canonical graph.
  });
});

// ---------------------------------------------------------------------------
// #368: the async wrappers are not the "concurrency-safe" variants
// ---------------------------------------------------------------------------
// learnAsync()/verifyAsync() were documented as adding a lock the synchronous
// forms lacked. They never did -- learn() and verify() enter the critical
// section themselves, and the wrappers just delegate. These tests pin the
// real contract so the comments cannot drift back into the old claim.
describe('Kernel - concurrency contract (#368)', () => {
  it('learn() is guarded on its own, not only via learnAsync()', () => {
    const kernel = freshKernel();
    kernel._lockAcquired = true;
    assert.throws(
      () => kernel.learn('Kedi hayvandır'),
      (err) => err.code === 'LOCK_BUSY'
    );
  });

  it('learnAsync() offers exactly the same guard, no stronger', async () => {
    const kernel = freshKernel();
    kernel._lockAcquired = true;
    await assert.rejects(
      () => kernel.learnAsync('Kedi hayvandır', TEST_FIXTURE_LEARN_BYPASS),
      (err) => err.code === 'LOCK_BUSY'
    );
  });

  it('verify() and verifyAsync() are likewise equally guarded', async () => {
    const kernel = freshKernel();
    kernel._lockAcquired = true;
    assert.throws(
      () => kernel.verify('Kedi hayvandır'),
      (err) => err.code === 'LOCK_BUSY'
    );
    await assert.rejects(
      () => kernel.verifyAsync('Kedi hayvandır'),
      (err) => err.code === 'LOCK_BUSY'
    );
  });

  it('the busy-wait lock helpers #368 called dead are in fact gone', () => {
    const kernel = freshKernel();
    for (const symbol of ['_acquireLock', '_lockQueue', '_lockTimeoutMs']) {
      assert.equal(
        kernel[symbol],
        undefined,
        `${symbol} was removed as dead code; reintroducing it means there are two lock mechanisms again`
      );
    }
  });
});

describe('Kernel - Türkçe durum ekli ask özneleri (#1206)', () => {
  it('resolves case-marked subjects instead of returning Bilmiyorum', () => {
    const k = freshKernel({ useSQLite: false });
    k.learn('kedi hayvandır');

    const questions = [
      'kedinin özelliği nedir',
      'kediyi anlat',
      'kediye ne olur',
      'kedide ne var',
      'kediden ne çıkar',
    ];

    for (const question of questions) {
      const result = k.ask(question);
      assert.equal(result.ok, true, question);
      assert.equal(result.data.subject, 'kedi', question);
      assert.equal(result.data.unknown, false, question);
      assert.match(result.data.answer, /hayvan/, question);
    }
  });
});
