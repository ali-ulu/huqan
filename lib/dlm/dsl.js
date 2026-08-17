'use strict';

// HUQAN DLM - tipli DSL çekirdeği.
//
// Bu katmanın tek işi: program terimlerini temsil etmek ve deterministik
// olarak değerlendirmek. Olasılık yok, örnekleme yok, RNG yok. Aynı terim +
// aynı girdi her zaman aynı çıktıyı verir; bu, üst katmanlardaki
// observational-equivalence budamasının ve tekrar üretilebilir sentezin
// önkoşuludur.
//
// Terim gösterimi:
//   { op: 'rev', args: [term] }   -> ilkel/soyutlama uygulaması
//   { hole: 0 }                   -> yalnızca soyutlama gövdesinde geçen delik
//
// Tipler: 'L' (tamsayı listesi), 'N' (tamsayı).

const ERR = Symbol('dlm.err');

// Değerlendirme sırasında patlamayı önleyen sınırlar. Sınır aşılırsa ERR
// döner; ERR üreten terim hiçbir görevi çözemez ve budamada ayrı bir imza
// olarak ele alınır.
const MAX_ABS_NUMBER = 1e9;
const MAX_LIST_LENGTH = 512;

function isErr(v) {
  return v === ERR;
}

function guardNumber(n) {
  if (!Number.isFinite(n) || Math.abs(n) > MAX_ABS_NUMBER) return ERR;
  return n;
}

function guardList(l) {
  if (l.length > MAX_LIST_LENGTH) return ERR;
  for (let i = 0; i < l.length; i++) {
    if (!Number.isFinite(l[i]) || Math.abs(l[i]) > MAX_ABS_NUMBER) return ERR;
  }
  return l;
}

// İlkeller sabit bir dizide tutulur. Sıra numaralandırma sırasını belirlediği
// için determinizmin parçasıdır: bu diziyi yeniden sıralamak aynı görev için
// farklı (ama yine de doğrulanmış) bir program seçtirebilir.
const PRIMITIVES = [
  // --- terminaller ---
  // Arity 0 olduğu için `evaluate` bunu fn(input) olarak çağırır.
  { name: 'x', args: [], ret: 'L', fn: input => input },
  { name: '0', args: [], ret: 'N', fn: () => 0 },
  { name: '1', args: [], ret: 'N', fn: () => 1 },
  { name: '2', args: [], ret: 'N', fn: () => 2 },
  { name: '3', args: [], ret: 'N', fn: () => 3 },

  // --- L -> L ---
  { name: 'rev', args: ['L'], ret: 'L', fn: a => a.slice().reverse() },
  { name: 'sort', args: ['L'], ret: 'L', fn: a => a.slice().sort((p, q) => p - q) },
  { name: 'tail', args: ['L'], ret: 'L', fn: a => (a.length === 0 ? ERR : a.slice(1)) },

  // --- L -> N ---
  { name: 'head', args: ['L'], ret: 'N', fn: a => (a.length === 0 ? ERR : a[0]) },
  { name: 'len', args: ['L'], ret: 'N', fn: a => a.length },
  { name: 'sum', args: ['L'], ret: 'N', fn: a => guardNumber(a.reduce((s, v) => s + v, 0)) },
  { name: 'max', args: ['L'], ret: 'N', fn: a => (a.length === 0 ? ERR : Math.max(...a)) },
  { name: 'min', args: ['L'], ret: 'N', fn: a => (a.length === 0 ? ERR : Math.min(...a)) },

  // --- N -> N ---
  { name: 'inc', args: ['N'], ret: 'N', fn: n => guardNumber(n + 1) },
  { name: 'dec', args: ['N'], ret: 'N', fn: n => guardNumber(n - 1) },

  // --- N, N -> N ---
  { name: 'add', args: ['N', 'N'], ret: 'N', fn: (a, b) => guardNumber(a + b) },
  { name: 'sub', args: ['N', 'N'], ret: 'N', fn: (a, b) => guardNumber(a - b) },

  // --- N, L -> L ---
  { name: 'take', args: ['N', 'L'], ret: 'L', fn: (n, a) => (n < 0 ? ERR : a.slice(0, n)) },
  { name: 'drop', args: ['N', 'L'], ret: 'L', fn: (n, a) => (n < 0 ? ERR : a.slice(n)) },
  { name: 'cons', args: ['N', 'L'], ret: 'L', fn: (n, a) => guardList([n, ...a]) },
  { name: 'mapAdd', args: ['N', 'L'], ret: 'L', fn: (n, a) => guardList(a.map(v => v + n)) },
  { name: 'mapMul', args: ['N', 'L'], ret: 'L', fn: (n, a) => guardList(a.map(v => v * n)) },
  { name: 'filterGt', args: ['N', 'L'], ret: 'L', fn: (n, a) => a.filter(v => v > n) },
];

const PRIMITIVE_BY_NAME = new Map(PRIMITIVES.map(p => [p.name, p]));

// Bir kütüphane, temel ilkellerin üstüne indüklenmiş soyutlamaları ekler.
// Soyutlama = delikli gövde + arity. Yeni bir *düğüm*tür: DSL'de daha önce
// var olmayan bir bileşen.
function makeLibrary(abstractions = []) {
  const byName = new Map(PRIMITIVE_BY_NAME);
  for (const abs of abstractions) byName.set(abs.name, abs);
  return {
    abstractions,
    components: [...PRIMITIVES, ...abstractions],
    byName,
  };
}

const BASE_LIBRARY = makeLibrary([]);

function lookup(library, name) {
  const c = (library || BASE_LIBRARY).byName.get(name);
  if (!c) throw new Error(`DLM: bilinmeyen bileşen "${name}"`);
  return c;
}

// Terimi verilen girdi üzerinde değerlendirir. `holeValues` yalnızca bir
// soyutlama gövdesi değerlendirilirken doludur.
function evaluate(term, input, library = BASE_LIBRARY, holeValues = null) {
  if (term.hole !== undefined) {
    if (!holeValues) return ERR;
    const v = holeValues[term.hole];
    return v === undefined ? ERR : v;
  }

  const comp = lookup(library, term.op);
  const argv = [];
  for (let i = 0; i < term.args.length; i++) {
    const v = evaluate(term.args[i], input, library, holeValues);
    if (isErr(v)) return ERR;
    argv.push(v);
  }

  if (comp.body) {
    // Soyutlama: gövdeyi, argümanları delik değerleri olarak bağlayıp koştur.
    return evaluate(comp.body, input, library, argv);
  }

  try {
    const out = comp.fn(...argv, input);
    if (isErr(out)) return ERR;
    if (Array.isArray(out)) return guardList(out) === ERR ? ERR : out;
    return guardNumber(out) === ERR ? ERR : out;
  } catch (_) {
    return ERR;
  }
}

function size(term) {
  if (term.hole !== undefined) return 1;
  let s = 1;
  for (const a of term.args) s += size(a);
  return s;
}

function format(term) {
  if (term.hole !== undefined) return `?${term.hole}`;
  if (term.args.length === 0) return term.op;
  return `${term.op}(${term.args.map(format).join(', ')})`;
}

// Soyutlamaları temel ilkellere kadar açar. Üretilen kodun her zaman
// denetlenebilir bir çekirdek biçimi olmasını sağlar: kütüphane bir kısayol,
// bir kara kutu değil.
function expand(term, library) {
  if (term.hole !== undefined) return term;
  const comp = lookup(library, term.op);
  const args = term.args.map(a => expand(a, library));
  if (!comp.body) return { op: term.op, args };
  return substitute(expand(comp.body, library), args);
}

function substitute(body, args) {
  if (body.hole !== undefined) return args[body.hole];
  return { op: body.op, args: body.args.map(a => substitute(a, args)) };
}

function equalTerms(a, b) {
  if (a.hole !== undefined || b.hole !== undefined) return a.hole === b.hole;
  if (a.op !== b.op || a.args.length !== b.args.length) return false;
  for (let i = 0; i < a.args.length; i++) {
    if (!equalTerms(a.args[i], b.args[i])) return false;
  }
  return true;
}

module.exports = {
  ERR,
  isErr,
  PRIMITIVES,
  BASE_LIBRARY,
  makeLibrary,
  lookup,
  evaluate,
  size,
  format,
  expand,
  substitute,
  equalTerms,
};
