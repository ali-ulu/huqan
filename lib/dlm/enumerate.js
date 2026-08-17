'use strict';

// HUQAN DLM - aşağıdan-yukarı (bottom-up) sayımlı sentez.
//
// Klasik SyGuS/DreamCoder hattı: boyutu artan program bankaları kur, her yeni
// programı örnek girdilerde koştur, çıktı imzası daha önce görülmüş bir
// programınkiyle aynıysa at (observational equivalence budaması). Kalan her
// program gözlemsel olarak farklıdır, dolayısıyla arama uzayı üstel yerine
// "ayırt edilebilir davranış sayısı" kadar büyür.
//
// Determinizm sözleşmesi:
//   - bileşenler sabit sırada taranır,
//   - bankalar dizi olarak tutulur (Map iterasyon sırasına bağımlılık yok),
//   - bir imzayı ilk dolduran program kazanır,
//   - RNG yok, zaman/ortam bağımlılığı yok.
// Aynı görev + aynı kütüphane => aynı program.

const { BASE_LIBRARY, evaluate, isErr, size } = require('./dsl');

const DEFAULT_MAX_SIZE = 9;
const DEFAULT_MAX_ENUMERATED = 400000;

// Bir programın örnek girdiler üzerindeki davranış imzası. ERR ayrı bir
// değer olarak kodlanır; böylece "patlayan" programlar birbirine denk sayılır
// ama geçerli programlarla karışmaz.
function signature(term, examples, library) {
  const out = [];
  for (const ex of examples) {
    const v = evaluate(term, ex.input, library);
    out.push(isErr(v) ? '!' : JSON.stringify(v));
  }
  return out.join('|');
}

function targetSignature(examples) {
  return examples.map(ex => JSON.stringify(ex.output)).join('|');
}

// size-1 birimini `n` parçaya bölen tüm kompozisyonlar (her parça >= 1).
// Sıra deterministiktir.
function compositions(total, parts) {
  if (parts === 1) return total >= 1 ? [[total]] : [];
  const out = [];
  for (let first = 1; first <= total - (parts - 1); first++) {
    for (const rest of compositions(total - first, parts - 1)) {
      out.push([first, ...rest]);
    }
  }
  return out;
}

/**
 * Tek bir görevi çözer.
 *
 * @param {{examples: Array<{input:any, output:any}>, returnType?: string}} task
 * @param {object} [options]
 * @returns {{solved:boolean, term:object|null, enumerated:number, maxSizeReached:number, reason?:string}}
 */
function synthesize(task, options = {}) {
  const library = options.library || BASE_LIBRARY;
  const maxSize = options.maxSize || DEFAULT_MAX_SIZE;
  const maxEnumerated = options.maxEnumerated || DEFAULT_MAX_ENUMERATED;
  const examples = task.examples;
  const want = targetSignature(examples);
  const returnType = task.returnType || (Array.isArray(examples[0].output) ? 'L' : 'N');

  // banks[type][size] = Program[]
  const banks = { L: [], N: [] };
  for (let s = 0; s <= maxSize; s++) {
    banks.L.push([]);
    banks.N.push([]);
  }

  const seen = new Set();
  let enumerated = 0;
  let reachedSize = 0;

  const consider = (term, type, sz) => {
    enumerated++;
    const sig = signature(term, examples, library);
    const key = `${type}#${sig}`;
    if (seen.has(key)) return null;
    seen.add(key);
    banks[type][sz].push(term);
    if (type === returnType && sig === want) return term;
    return null;
  };

  for (let sz = 1; sz <= maxSize; sz++) {
    reachedSize = sz;
    for (const comp of library.components) {
      const arity = comp.args.length;
      if (arity === 0) {
        if (sz !== 1) continue;
        const hit = consider({ op: comp.name, args: [] }, comp.ret, 1);
        if (hit) return done(true, hit);
        if (enumerated >= maxEnumerated) return done(false, null, 'ENUMERATION_BUDGET');
        continue;
      }
      if (sz === 1) continue;

      for (const split of compositions(sz - 1, arity)) {
        // argüman tiplerine uyan bankaların çarpımı
        const pools = [];
        let ok = true;
        for (let i = 0; i < arity; i++) {
          const pool = banks[comp.args[i]][split[i]];
          if (!pool || pool.length === 0) { ok = false; break; }
          pools.push(pool);
        }
        if (!ok) continue;

        const idx = new Array(arity).fill(0);
        for (;;) {
          const args = new Array(arity);
          for (let i = 0; i < arity; i++) args[i] = pools[i][idx[i]];
          const hit = consider({ op: comp.name, args }, comp.ret, sz);
          if (hit) return done(true, hit);
          if (enumerated >= maxEnumerated) return done(false, null, 'ENUMERATION_BUDGET');

          let k = arity - 1;
          while (k >= 0) {
            idx[k]++;
            if (idx[k] < pools[k].length) break;
            idx[k] = 0;
            k--;
          }
          if (k < 0) break;
        }
      }
    }
  }

  return done(false, null, 'MAX_SIZE');

  function done(solved, term, reason) {
    return {
      solved,
      term,
      termSize: term ? size(term) : null,
      enumerated,
      maxSizeReached: reachedSize,
      reason: solved ? undefined : reason,
    };
  }
}

module.exports = { synthesize, signature, targetSignature, compositions };
