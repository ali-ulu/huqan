'use strict';

// HUQAN DLM - deterministik görev seti.
//
// Her görev bir referans fonksiyonla tanımlanır ve örnekler sabit girdilerden
// türetilir. Rastgelelik yok: aynı dosya her koşuda birebir aynı örnekleri
// üretir, dolayısıyla ölçüm tekrar üretilebilir.
//
// TRAIN kümesi kütüphaneyi indüklemek için, HELDOUT kümesi hızlanmayı ölçmek
// için kullanılır. Held-out görevler eğitim sırasında hiçbir biçimde
// görülmez.

const INPUTS = [
  [3, 1, 4, 1, 5],
  [9, 2, 6, 5, 3, 5],
  [10, 20, 30, 40],
  [7, 7, 8, 2, 9, 1],
  [4, 15, 6, 2, 11],
];

const desc = a => a.slice().sort((p, q) => q - p);
const asc = a => a.slice().sort((p, q) => p - q);

function build(name, ref, returnType, inputs = INPUTS) {
  return {
    name,
    returnType,
    examples: inputs.map(input => ({ input, output: ref(input) })),
  };
}

// --- eğitim görevleri (küçük, taban DSL ile ulaşılabilir) ---
const TRAIN = [
  build('descending', a => desc(a), 'L'),
  build('largest', a => desc(a)[0], 'N'),
  build('second-largest', a => desc(a)[1], 'N'),
  build('top-2', a => desc(a).slice(0, 2), 'L'),
  build('top-3', a => desc(a).slice(0, 3), 'L'),
  build('sum-top-2', a => desc(a).slice(0, 2).reduce((s, v) => s + v, 0), 'N'),
  build('smallest', a => asc(a)[0], 'N'),
  build('all-but-largest', a => desc(a).slice(1), 'L'),
  build('length', a => a.length, 'N'),
  build('total', a => a.reduce((s, v) => s + v, 0), 'N'),
];

// --- probe görevleri (YALNIZCA soyutlama seçimi için) ---
// Bunlar kütüphane indüksiyonuna girmez ve test kümesinde yer almaz.
// Amaç: bir soyutlamanın arama maliyetini gerçekten düşürüp düşürmediğini,
// onu doğuran görevlerin dışında ölçmek. Seçimi eğitim görevleri üzerinde
// yapmak, soyutlamanın türetildiği örneği yeniden çözmesini ödüllendirir;
// bu, arama maliyeti üzerinde ezber demektir.
const PROBE = [
  build('probe-top-1', a => desc(a).slice(0, 1), 'L'),
  build('probe-ascending', a => asc(a), 'L'),
  build('probe-min-of-top-3', a => Math.min(...desc(a).slice(0, 3)), 'N'),
  build('probe-largest-plus-one', a => desc(a)[0] + 1, 'N'),
];

// --- held-out görevler (daha derin; taban DSL'de üstel arama gerektirir) ---
const HELDOUT = [
  build('third-largest', a => desc(a)[2], 'N'),
  build('fourth-largest', a => desc(a)[3], 'N'),
  build('sum-top-3', a => desc(a).slice(0, 3).reduce((s, v) => s + v, 0), 'N'),
  build('range', a => desc(a)[0] - asc(a)[0], 'N'),
  build('second-smallest', a => asc(a)[1], 'N'),
  build('top-3-ascending', a => asc(desc(a).slice(0, 3)), 'L'),
  build('drop-2-descending', a => desc(a).slice(2), 'L'),
];

module.exports = { INPUTS, TRAIN, PROBE, HELDOUT, build };
