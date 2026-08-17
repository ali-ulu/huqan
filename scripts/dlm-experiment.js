'use strict';

// HUQAN DLM - hızlanma deneyi.
//
// Tek soru: "öğrendikçe hızlanıyor" iddiası ölçülebilir mi?
//
// Protokol:
//   1. TRAIN görevlerini taban DSL ile çöz.
//   2. Çözümlerden anti-unification ile soyutlama kütüphanesi indükle.
//   3. HELDOUT görevlerini İKİ kez çöz: (a) taban DSL, (b) indüklenen kütüphane.
//   4. Taranan program sayısını ve süreyi karşılaştır.
//
// Held-out görevler eğitimde hiç görülmedi. Her iki koşu da aynı doğrulama
// kapısından geçer; kütüphaneli koşuda dönen program taban DSL'e açılıp
// yeniden doğrulanır.

const { HuqanDLM } = require('../lib/dlm');
const { BASE_LIBRARY, format, size } = require('../lib/dlm/dsl');
const { TRAIN, PROBE, HELDOUT } = require('../lib/dlm/tasks');

const BASELINE_BUDGET = Number(process.env.DLM_BASELINE_BUDGET || 3000000);
const LIBRARY_BUDGET = Number(process.env.DLM_LIBRARY_BUDGET || 3000000);
const MAX_SIZE = Number(process.env.DLM_MAX_SIZE || 9);

function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }
function fmtNum(n) { return n.toLocaleString('en-US'); }

function main() {
  const engine = new HuqanDLM({ maxSize: MAX_SIZE, maxEnumerated: BASELINE_BUDGET });

  console.log('='.repeat(78));
  console.log('HUQAN DLM - deterministik sentez + kutuphane indüksiyonu');
  console.log('LLM yok, GPU yok, ag cagrisi yok, RNG yok.');
  console.log('='.repeat(78));

  // --- 1. EGITIM ---
  console.log('\n[1] EGITIM (taban DSL ile cozum)\n');
  const report = engine.train(TRAIN, { maxSize: MAX_SIZE, maxEnumerated: BASELINE_BUDGET });
  console.log(`${pad('gorev', 20)}${padL('taranan', 12)}${padL('boyut', 7)}  program`);
  console.log('-'.repeat(78));
  for (const r of report.solutions) {
    console.log(
      pad(r.task, 20)
      + padL(r.solved ? fmtNum(r.enumerated) : 'COZULEMEDI', 12)
      + padL(r.programSize ?? '-', 7)
      + '  ' + (r.program || `(${r.reason})`)
    );
  }

  // --- 2. INDUKLENEN KUTUPHANE ---
  console.log('\n[2] INDUKLENEN KUTUPHANE (anti-unification / Plotkin lgg)\n');
  if (report.rounds.length === 0) {
    console.log('  (soyutlama bulunamadi)');
  }
  for (const r of report.rounds) {
    console.log(`  ${pad(r.name, 4)} := ${pad(r.definition, 34)} :: ${pad(r.type, 12)} kullanim=${r.uses} fayda=${r.utility}`);
  }
  const compression = report.corpusSizeBefore / Math.max(1, report.corpusSizeAfter);
  console.log(`\n  korpus boyutu: ${report.corpusSizeBefore} -> ${report.corpusSizeAfter} dugum`
    + `  (sikistirma ${compression.toFixed(2)}x)`);
  console.log(`  YENI DUGUM SAYISI: ${report.abstractions.length}`
    + '   <-- dream.js bunu yapamiyordu (yalnizca kenar onerebiliyordu)');

  // --- 3. HELD-OUT KARSILASTIRMA ---
  console.log('\n[3] HELD-OUT GOREVLER - kutuphanesiz vs kutuphaneli\n');
  console.log(
    pad('gorev', 20) + padL('taban:taranan', 15) + padL('kutuphane', 12)
    + padL('kazanc', 10) + padL('dogrulandi', 12)
  );
  console.log('-'.repeat(78));

  const rows = [];
  for (const task of HELDOUT) {
    const base = engine.solve(task, {
      library: BASE_LIBRARY, maxSize: MAX_SIZE, maxEnumerated: BASELINE_BUDGET,
    });
    const lib = engine.solve(task, {
      library: report.library, maxSize: MAX_SIZE, maxEnumerated: LIBRARY_BUDGET,
    });

    const baseCell = base.solved ? fmtNum(base.enumerated) : `>${fmtNum(base.enumerated)} X`;
    const libCell = lib.solved ? fmtNum(lib.enumerated) : `>${fmtNum(lib.enumerated)} X`;
    const speedup = base.solved && lib.solved
      ? `${(base.enumerated / Math.max(1, lib.enumerated)).toFixed(1)}x`
      : (lib.solved ? 'sonsuz' : '-');

    console.log(
      pad(task.name, 20) + padL(baseCell, 15) + padL(libCell, 12)
      + padL(speedup, 10) + padL(lib.solved ? (lib.verified ? 'EVET' : 'HAYIR') : '-', 12)
    );
    rows.push({ task: task.name, base, lib, speedup });
  }

  // --- 4. URETILEN KOD ---
  console.log('\n[4] URETILEN PROGRAMLAR (kutuphaneli) + taban DSL karsiligi\n');
  for (const row of rows) {
    if (!row.lib.solved) {
      console.log(`  ${pad(row.task, 20)} COZULEMEDI (${row.lib.reason})`);
      continue;
    }
    console.log(`  ${pad(row.task, 20)} ${row.lib.program}`);
    console.log(`  ${pad('', 20)}   = ${row.lib.core}   [${row.lib.coreSize} dugum, dogrulandi=${row.lib.verified}]`);
  }

  // --- 5. KUTUPHANE BOYUTU TARAMASI ---
  // "Ogrendikce hizlanir" iddiasinin sekli: monoton mu, doyuma mi ugruyor,
  // yoksa geri mi donuyor? Her soyutlama arama uzayina dallanma ekler; kazanc
  // ile bu vergi arasindaki denge burada gorulur.
  console.log('\n[5] KUTUPHANE BOYUTU TARAMASI (held-out toplam taranan program)\n');
  console.log(pad('soyutlama sayisi', 20) + padL('toplam taranan', 18) + padL('taban/bu', 12) + padL('cozulen', 10));
  console.log('-'.repeat(78));
  const { makeLibrary } = require('../lib/dlm');
  let baselineTotal = null;
  let totalLibAll = null;
  for (let k = 0; k <= report.abstractions.length; k++) {
    const lib = makeLibrary(report.abstractions.slice(0, k));
    let total = 0;
    let solvedCount = 0;
    for (const task of HELDOUT) {
      const r = engine.solve(task, { library: lib, maxSize: MAX_SIZE, maxEnumerated: LIBRARY_BUDGET });
      total += r.enumerated;
      if (r.solved && r.verified) solvedCount++;
    }
    if (k === 0) baselineTotal = total;
    if (k === report.abstractions.length) totalLibAll = total;
    console.log(
      pad(k === 0 ? '0 (taban DSL)' : `${k} (${report.abstractions.slice(0, k).map(a => a.name).join(',')})`, 20)
      + padL(fmtNum(total), 18)
      + padL(`${(baselineTotal / Math.max(1, total)).toFixed(2)}x`, 12)
      + padL(`${solvedCount}/${HELDOUT.length}`, 10)
    );
  }

  // --- 6. MALIYET GUDUMLU SECIM ---
  // Sikistirma faydasi korpusu kucultur; arama maliyetini kucultmeyi garanti
  // etmez. Burada adaylar SADECE egitim gorevleri uzerinde olculen arama
  // maliyetine gore ileri-greedy secilir. Held-out gorevler secime girmez.
  console.log('\n[6] MALIYET GUDUMLU SECIM (secim yalnizca PROBE uzerinde: train degil, test degil)\n');
  const selection = engine.selectAbstractions(report.abstractions, PROBE, {
    maxSize: MAX_SIZE, maxEnumerated: LIBRARY_BUDGET,
  });
  for (const t of selection.trace) {
    console.log(`  adim ${t.step}: [${t.chosen.join(', ') || 'bos'}]  probe maliyeti = ${fmtNum(t.cost)}  amac(MDL) = ${t.objective.toFixed(3)}`);
  }
  console.log(`  secilen: [${selection.abstractions.map(a => a.name).join(', ') || 'bos'}]`);

  let costTotal = 0;
  let costSolved = 0;
  let costVerified = true;
  for (const task of HELDOUT) {
    const r = engine.solve(task, {
      library: selection.library, maxSize: MAX_SIZE, maxEnumerated: LIBRARY_BUDGET,
    });
    costTotal += r.enumerated;
    if (r.solved) { costSolved++; if (!r.verified) costVerified = false; }
  }
  console.log(`\n  HELD-OUT (secime hic girmedi):`);
  console.log(`    taban DSL                : ${fmtNum(baselineTotal)}`);
  console.log(`    sikistirma-secimli (${report.abstractions.length} soyutlama) : ${fmtNum(totalLibAll)}`
    + `  -> ${(baselineTotal / Math.max(1, totalLibAll)).toFixed(2)}x`);
  console.log(`    maliyet-secimli (${selection.abstractions.length} soyutlama)    : ${fmtNum(costTotal)}`
    + `  -> ${(baselineTotal / Math.max(1, costTotal)).toFixed(2)}x`);
  console.log(`    cozulen ${costSolved}/${HELDOUT.length}, hepsi taban DSL'de dogrulandi: ${costVerified ? 'EVET' : 'HAYIR'}`);

  // --- 7. OZET ---
  const solvedBase = rows.filter(r => r.base.solved).length;
  const solvedLib = rows.filter(r => r.lib.solved).length;
  const bothSolved = rows.filter(r => r.base.solved && r.lib.solved);
  const totalBase = bothSolved.reduce((s, r) => s + r.base.enumerated, 0);
  const totalLib = bothSolved.reduce((s, r) => s + r.lib.enumerated, 0);
  const allVerified = rows.filter(r => r.lib.solved).every(r => r.lib.verified);

  console.log('\n' + '='.repeat(78));
  console.log('OZET');
  console.log('='.repeat(78));
  console.log(`  cozulen (taban DSL)      : ${solvedBase}/${rows.length}`);
  console.log(`  cozulen (kutuphaneli)    : ${solvedLib}/${rows.length}`);
  if (bothSolved.length > 0) {
    console.log(`  ikisinin de cozdugu ${bothSolved.length} held-out gorevde taranan program:`);
    console.log(`      taban DSL                     : ${fmtNum(totalBase)}`);
    console.log(`      sikistirma-secimli kutuphane  : ${fmtNum(totalLib)}`
      + `  -> ${(totalBase / Math.max(1, totalLib)).toFixed(2)}x`);
    console.log(`      MDL-secimli kutuphane         : ${fmtNum(costTotal)}`
      + `  -> ${(totalBase / Math.max(1, costTotal)).toFixed(2)}x   <-- yontem`);
  }
  console.log(`  uretilen her programin taban DSL'de dogrulanmasi: ${allVerified ? 'GECTI' : 'KALDI'}`);
  console.log('='.repeat(78));

  return { report, rows };
}

if (require.main === module) main();
module.exports = { main };
