'use strict';

// HUQAN DLM - deterministik dil/kod modeli motoru.
//
// "Deterministik dil modeli" bir çelişki değildir; yalnızca olasılıksal
// modelin iki bileşenini değiştirir:
//
//   olasılıksal LM            HUQAN DLM
//   ----------------------    ---------------------------------------
//   token üzerinden dağılım   tipli terim uzayında sıralı arama
//   örnekleme (sampling)      sabit sıra + ilk-eşleşen (RNG yok)
//   kayıp fonksiyonu          spesifikasyona karşı doğrulama (kabul/ret)
//   ağırlık güncellemesi      kütüphane indüksiyonu (yeni bileşen düğümleri)
//
// Sonuç: aynı spesifikasyon her zaman aynı programı verir ve doğrulanmamış
// hiçbir çıktı dönmez. Model "bilmiyorum" diyebilir (UNSOLVED); uyduramaz.

const { BASE_LIBRARY, makeLibrary, format, expand, size, evaluate, isErr } = require('./dsl');
const { synthesize } = require('./enumerate');
const { induceLibrary } = require('./antiunify');

class HuqanDLM {
  constructor(options = {}) {
    this.library = options.library || BASE_LIBRARY;
    this.maxSize = options.maxSize || 9;
    this.maxEnumerated = options.maxEnumerated || 400000;
  }

  /**
   * Spesifikasyonu (I/O örnekleri) programa çevirir.
   * Doğrulama sentezin yan ürünü değil, tanımıdır: dönen terim tüm örnekleri
   * bire bir sağlamak zorundadır, aksi halde `solved:false` döner.
   */
  solve(task, options = {}) {
    const started = process.hrtime.bigint();
    const res = synthesize(task, {
      library: options.library || this.library,
      maxSize: options.maxSize || this.maxSize,
      maxEnumerated: options.maxEnumerated || this.maxEnumerated,
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    const library = options.library || this.library;
    const receipt = {
      task: task.name,
      solved: res.solved,
      enumerated: res.enumerated,
      elapsedMs,
      reason: res.reason,
      program: res.term ? format(res.term) : null,
      programSize: res.termSize,
      core: res.term ? format(expand(res.term, library)) : null,
      coreSize: res.term ? size(expand(res.term, library)) : null,
      verified: false,
      examplesChecked: task.examples.length,
    };
    Object.defineProperty(receipt, 'term', { value: res.term, enumerable: false });

    if (res.solved) {
      // Bağımsız yeniden doğrulama: aramanın kabul ettiğine güvenme,
      // çekirdek biçimi taban DSL üzerinde tekrar koştur.
      receipt.verified = this.verify(res.term, task, library);
    }
    return receipt;
  }

  /**
   * Bir terimi görev örneklerine karşı, soyutlamaları taban ilkellerine
   * açarak yeniden doğrular. Kütüphane bir kısayoldur, bir güven kaynağı
   * değildir.
   */
  verify(term, task, library = this.library) {
    const core = expand(term, library);
    for (const ex of task.examples) {
      const got = evaluate(core, ex.input, BASE_LIBRARY);
      if (isErr(got)) return false;
      if (JSON.stringify(got) !== JSON.stringify(ex.output)) return false;
    }
    return true;
  }

  /**
   * Maliyet güdümlü soyutlama seçimi.
   *
   * Sıkıştırma faydası (Stitch/MDL) korpusu küçültür ama arama maliyetini
   * doğrudan ölçmez: her yeni bileşen numaralandırmada dallanma çarpanı
   * ekler. Ölçümde bu vergi görünür hale geldi (1 soyutlamada kazanç tepe
   * yapıp sonra geriliyor). Bu yüzden adaylar sıkıştırmaya göre değil,
   * *ölçülen arama maliyetine* göre ileri-greedy seçilir.
   *
   * Seçim yalnızca `probeTasks` üzerinde yapılır; held-out görevlere
   * dokunulmaz.
   */
  selectAbstractions(candidates, probeTasks, options = {}) {
    const maxSize = options.maxSize || this.maxSize;
    const maxEnumerated = options.maxEnumerated || this.maxEnumerated;
    // MDL cezası: kütüphaneye eklenen her bileşenin bir tanım bedeli vardır.
    // lambda = 1 "bileşen başına bir birim tanım uzunluğu" demektir ve a
    // priori seçilmiştir - test kümesine bakılarak ayarlanmadı. Ceza olmadan
    // greedy seçim, probe kümesini iyileştiren her adayı kabul eder ve
    // görülmemiş görevlere binen dallanma vergisini hiç ödemez.
    const lambda = options.lambda === undefined ? 1 : options.lambda;

    const cost = abstractions => {
      const lib = makeLibrary(abstractions);
      let total = 0;
      for (const task of probeTasks) {
        total += synthesize(task, { library: lib, maxSize, maxEnumerated }).enumerated;
      }
      return total;
    };
    // Arama maliyeti çarpımsal büyüdüğü için log alanında toplanır;
    // kütüphane bedeli bu alanda doğrusal bir terimdir.
    const objective = (searchCost, count) => Math.log(Math.max(1, searchCost)) + lambda * count;

    const chosen = [];
    let bestCost = cost([]);
    let bestObjective = objective(bestCost, 0);
    const trace = [{ step: 0, chosen: [], cost: bestCost, objective: bestObjective }];
    const remaining = candidates.slice();

    for (;;) {
      let bestCandidate = null;
      let bestCandidateCost = null;
      let bestCandidateObjective = bestObjective;
      for (const cand of remaining) {
        // Soyutlama gövdesi daha önce seçilmiş bir soyutlamaya atıfta
        // bulunabilir; bağımlılığı karşılanmayan adayı bu turda atla.
        const trial = [...chosen, cand];
        let c;
        try { c = cost(trial); } catch (_) { continue; }
        const obj = objective(c, trial.length);
        if (obj < bestCandidateObjective) {
          bestCandidateObjective = obj;
          bestCandidateCost = c;
          bestCandidate = cand;
        }
      }
      if (!bestCandidate) break;
      chosen.push(bestCandidate);
      remaining.splice(remaining.indexOf(bestCandidate), 1);
      bestCost = bestCandidateCost;
      bestObjective = bestCandidateObjective;
      trace.push({
        step: chosen.length,
        chosen: chosen.map(a => a.name),
        cost: bestCost,
        objective: bestObjective,
      });
    }

    return { abstractions: chosen, library: makeLibrary(chosen), trace, lambda };
  }

  /**
   * Eğitim: görevleri çöz, çözülen programlardan soyutlama kütüphanesi
   * indükle. Bu adım yeni bileşen düğümleri üretir - fraktal büyümenin
   * gerçekleştiği yer.
   */
  train(tasks, options = {}) {
    const solved = [];
    const solutions = [];
    for (const task of tasks) {
      const r = this.solve(task, { library: BASE_LIBRARY, ...options });
      solutions.push(r);
      if (r.solved && r.verified) solved.push(r.term);
    }

    const induced = induceLibrary(solved, {
      library: BASE_LIBRARY,
      maxAbstractions: options.maxAbstractions || 6,
    });

    this.library = induced.library;
    return {
      solutions,
      abstractions: induced.abstractions,
      rounds: induced.rounds,
      corpusSizeBefore: solved.reduce((s, t) => s + size(t), 0),
      corpusSizeAfter: induced.corpus.reduce((s, t) => s + size(t), 0),
      library: induced.library,
    };
  }
}

module.exports = { HuqanDLM, BASE_LIBRARY, makeLibrary, format, expand };
