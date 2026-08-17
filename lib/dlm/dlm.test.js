'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { HuqanDLM } = require('./index');
const { BASE_LIBRARY, makeLibrary, evaluate, expand, format, isErr } = require('./dsl');
const { lgg, induceLibrary } = require('./antiunify');
const { synthesize } = require('./enumerate');
const { TRAIN, PROBE, HELDOUT, build } = require('./tasks');

const OPTS = { maxSize: 9, maxEnumerated: 3000000 };

// Eğitim birkaç saniye sürüyor; tek sefer koşup tüm testlerde paylaşıyoruz.
let trained = null;
function getTrained() {
  if (!trained) {
    const engine = new HuqanDLM(OPTS);
    const report = engine.train(TRAIN, OPTS);
    trained = { engine, report };
  }
  return trained;
}

test('anti-unification iki somut terimden en özel genellemeyi çıkarır', () => {
  const t1 = { op: 'take', args: [{ op: '2', args: [] }, { op: 'x', args: [] }] };
  const t2 = { op: 'take', args: [{ op: '3', args: [] }, { op: 'x', args: [] }] };
  assert.strictEqual(format(lgg(t1, t2)), 'take(?0, x)');
});

test('aynı alt-terim çifti tekrar ederse aynı deliğe bağlanır (doğrusal olmayan lgg)', () => {
  const a = { op: 'add', args: [{ op: '1', args: [] }, { op: '1', args: [] }] };
  const b = { op: 'add', args: [{ op: '2', args: [] }, { op: '2', args: [] }] };
  assert.strictEqual(format(lgg(a, b)), 'add(?0, ?0)');
});

test('kütüphane indüksiyonu taban DSLde bulunmayan YENİ bileşenler üretir', () => {
  const { report } = getTrained();
  assert.ok(report.abstractions.length > 0, 'en az bir soyutlama indüklenmeli');
  const baseNames = new Set(BASE_LIBRARY.components.map(c => c.name));
  for (const abs of report.abstractions) {
    assert.ok(!baseNames.has(abs.name), `${abs.name} taban DSLde olmamalı`);
    assert.ok(abs.body, 'soyutlamanın gövdesi olmalı');
  }
  assert.ok(report.corpusSizeAfter < report.corpusSizeBefore, 'korpus sıkışmalı');
});

test('determinizm: iki bağımsız eğitim birebir aynı kütüphaneyi verir', () => {
  const a = new HuqanDLM(OPTS).train(TRAIN, OPTS);
  const b = new HuqanDLM(OPTS).train(TRAIN, OPTS);
  assert.deepStrictEqual(
    a.abstractions.map(x => ({ name: x.name, body: x.body, args: x.args, ret: x.ret })),
    b.abstractions.map(x => ({ name: x.name, body: x.body, args: x.args, ret: x.ret })),
  );
  assert.deepStrictEqual(
    a.solutions.map(s => [s.task, s.program, s.enumerated]),
    b.solutions.map(s => [s.task, s.program, s.enumerated]),
  );
});

test('determinizm: aynı görev aynı kütüphaneyle her zaman aynı programı verir', () => {
  const { engine, report } = getTrained();
  for (const task of HELDOUT) {
    const r1 = engine.solve(task, { library: report.library, ...OPTS });
    const r2 = engine.solve(task, { library: report.library, ...OPTS });
    assert.strictEqual(r1.program, r2.program, `${task.name} kararsız`);
    assert.strictEqual(r1.enumerated, r2.enumerated, `${task.name} arama maliyeti kararsız`);
  }
});

test('doğrulama kapısı: dönen her program taban DSLde yeniden doğrulanır', () => {
  const { engine, report } = getTrained();
  for (const task of HELDOUT) {
    const r = engine.solve(task, { library: report.library, ...OPTS });
    if (!r.solved) continue;
    assert.strictEqual(r.verified, true, `${task.name} doğrulanamadı`);
  }
});

test('soyutlama açılımı anlamı korur: kütüphane biçimi ile çekirdek biçim aynı sonucu verir', () => {
  const { engine, report } = getTrained();
  for (const task of HELDOUT) {
    const r = engine.solve(task, { library: report.library, ...OPTS });
    if (!r.solved) continue;
    const core = expand(r.term, report.library);
    for (const ex of task.examples) {
      const viaLibrary = evaluate(r.term, ex.input, report.library);
      const viaCore = evaluate(core, ex.input, BASE_LIBRARY);
      assert.deepStrictEqual(viaCore, viaLibrary, `${task.name}: açılım anlamı bozdu`);
    }
  }
});

test('uydurmaz: çözülemeyen spesifikasyonda program değil, ret döner', () => {
  // Taban DSLde ifade edilemeyen bir hedef (listenin karelerinin toplamı).
  const impossible = build('sum-of-squares', a => a.reduce((s, v) => s + v * v, 0), 'N');
  const engine = new HuqanDLM(OPTS);
  const r = engine.solve(impossible, { library: BASE_LIBRARY, maxSize: 5, maxEnumerated: 200000 });
  assert.strictEqual(r.solved, false);
  assert.strictEqual(r.program, null);
  assert.ok(r.reason, 'ret gerekçesi bulunmalı');
});

test('kütüphane hızı: en az bir held-out görevde arama maliyeti düşer', () => {
  const { engine, report } = getTrained();
  let improved = 0;
  for (const task of HELDOUT) {
    const base = engine.solve(task, { library: BASE_LIBRARY, ...OPTS });
    const lib = engine.solve(task, { library: report.library, ...OPTS });
    if (base.solved && lib.solved && lib.enumerated < base.enumerated) improved++;
  }
  assert.ok(improved > 0, 'hiçbir görevde kazanç yok');
});

test('MDL cezalı seçim, cezasız seçimden daha küçük veya eşit kütüphane seçer', () => {
  const { engine, report } = getTrained();
  const penalized = engine.selectAbstractions(report.abstractions, PROBE, { ...OPTS, lambda: 1 });
  const unpenalized = engine.selectAbstractions(report.abstractions, PROBE, { ...OPTS, lambda: 0 });
  assert.ok(
    penalized.abstractions.length <= unpenalized.abstractions.length,
    'ceza kütüphaneyi büyütmemeli',
  );
});

test('gözlemsel denklik budaması sentezi bozmaz: bulunan program örnekleri sağlar', () => {
  const task = build('second-largest-check', a => a.slice().sort((p, q) => q - p)[1], 'N');
  const res = synthesize(task, { library: BASE_LIBRARY, maxSize: 6, maxEnumerated: 500000 });
  assert.strictEqual(res.solved, true);
  for (const ex of task.examples) {
    const got = evaluate(res.term, ex.input, BASE_LIBRARY);
    assert.ok(!isErr(got));
    assert.deepStrictEqual(got, ex.output);
  }
});

test('bozuk bağımlılıklı kütüphane sessizce yanlış cevap üretmez', () => {
  // f1in gövdesi f0a atıfta bulunuyor ama f0 kütüphanede yok.
  const orphan = makeLibrary([
    { name: 'f1', args: [], ret: 'L', body: { op: 'f0', args: [] } },
  ]);
  assert.throws(() => evaluate({ op: 'f1', args: [] }, [1, 2], orphan), /bilinmeyen bileşen/);
});
