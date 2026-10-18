# Scale Truth Pack

Current measured position for AXIOM graph and memory behavior:

- local-first
- deterministic
- small-to-medium graph tested
- larger graph support requires dedicated benchmarking
- not yet proven at Wikipedia-scale
- scale roadmap exists but is not claimed

## What is proven

- Graph and Memory Core run locally.
- Graph state is primarily in-memory.
- Graph uses SQLite as an optional persistence backend; its primary query path
  still uses hydrated in-memory nodes, edges, candidates and audit records.
- In SQLite mode, MemoryStore now reads from SQLite, validates rows in bounded
  chunks at open, and retains a bounded 2048-entry LRU instead of a full copy
  (#3208). Its non-SQLite backend retains in-memory operational state.
- Existing benchmark fixtures cover `small`, `medium`, `large`, and `xlarge`.
- The `small`/`medium`/`large`/`xlarge` family tops out at 140 nodes and 131 edges; it is separate from the scale fixtures.
- The end-to-end scale benchmark (#3016) defaults to `scale-10k` with 10000 nodes and 10000 edges. The opt-in `scale-100k` fixture was also measured on 18 October 2026 (see the bounded record below).

## What is not proven

- 100k-node production claims.
- 1M-node claims.
- Wikipedia-scale throughput or latency.
- Enterprise graph scale claims.
- Unlimited dream/random-walk depth or breadth.

## Current limits

- `graph.js` queries read from in-memory node/edge structures; SQLite persists state but does not replace the in-memory query path.
- `dream.js` is heuristic and bounded:
  - `dream()` returns at most 10 hypotheses.
  - Similarity, transitive, gap, symmetry, and contradiction generation are each capped internally.
  - `_biasedWalk()` is bounded by `walkLength` and `walksPerNode`.
- `dream()` is not persistent. It returns its hypotheses in the `pending`
  list of the return value only; with the default `graphWrite: false` they are
  neither written to the graph nor to `candidate_claims`. The persistent path is
  `hypotheses --propose` (see `docs/hypotheses.md`), which is a different
  rule set from `dream()`.
- The `çelişki` dream hypothesis and `detectContradictions` fire only when the
  graph holds two disjoint `tür` edges for one subject. The ordinary `learn`
  path does not produce that state: on a disjoint-`tür` conflict
  `lib/learn-use-case.js` records the second `tür` as a `benzer` edge and
  reports the conflict in `conflicts`. In normal learning the contradiction
  hypothesis therefore does not fire; it fires only when such edges are added
  directly to the graph.
- The historical #3911 single-machine learning measurement recorded 100 facts
  at 322 ms, 300 at 1026 ms, 600 at 2420 ms, and 10k at about 173 s. It is a
  different version/workload from the paired, approved-learning measurement
  below, not its before baseline. Large learning batches remain unproven.
- Graph scale is bounded by its local process, hydrated heap, and fixture
  behavior. MemoryStore's bounded retained cache does not remove its linear
  startup validation cost, synchronous read cost, or SQLite writer contention.

## 2 Ekim 2026 MemoryStore ölçümü

GÖZLENDİ: `8d92b75c3f17a4c74c511c7d83ec7557542c7b52`, Windows x64,
Node22.22.0, native SQLite3.53.1 üzerinde mevcut
`node --expose-gc benchmarks/bench-memory-store-open.js` exit0 ile çalıştı.
10k/50k/100k kayıt açılışı sırasıyla 320.7/3800.5/7140.9 ms; 20 çağrının
ortalama warm rule-list okuması 1.58/10.25/16.13 ms. Bir kayıt başına bir event
ve her 100 kayıtta bir rule kullanıldı; ölçüm tek koşudur, p95/p99 değildir.
Cache dışındaki retained heap farkı 0.1/0/-0.3 MiB; negatif değer GC/gürültüdür,
RSS veya sıfır bellek maliyeti iddiası değildir.

Bu MemoryStore koşusunun doğrulamadıkları: yoğun eşzamanlı yazma, Graph100k, gerçek admission throughput,
çok süreçli cache freshness veya sunucu ölçeği. Kapasite ve backend kararının
kabul sözleşmesi [mühendislik görev paketinde](task-packs/engineering-foundation-20261002.md)
bulunur; bu ölçüm desteklenen production limit ilan etmez.

## Measured fixtures

| Fixture | Nodes | Edges |
|---|---:|---:|
| `small` | 6 | 5 |
| `medium` | 19 | 15 |
| `large` | 49 | 30 |
| `xlarge` | 140 | 131 |
| `scale-10k` (#3016) | 10000 | 10000 |
| `scale-100k` (opt-in, 18 October 2026) | 100000 | 100000 |

## End-to-end scale benchmark (#3016)

`benchmarks/bench-scale-10k.js` seeds a 10000-node / 10000-edge graph through
the Graph API and measures seed (write), ask, verify, reason (read) and a full
SQLite checkpoint save (write), plus heap. The pinned numbers live in
`benchmarks/scale-10k-baseline.json`; `benchmarks/check-scale-10k.js` gates
the shape as blocking and the timings as advisory (`--strict-timing` for the
nightly job).

Baseline on a developer machine (advisory, not portable across machines or
Node majors):

| Path | Measure |
|---|---:|
| seed 10k nodes+edges | ~165 ms (~60k nodes/s bulk write) |
| ask | ~2 ms |
| verify | ~54 ms |
| reason | ~4 ms |
| save (full SQLite checkpoint) | ~856 ms |
| heap delta for the 10k seed | ~19 MB |

The pinned #3016 baseline and default CI fixture remain 10k. The separate
100k measurement below does not change that default. This script's
`benchLearnCurve` uses `test_fixture_seed` admission bypass and a non-SQLite
kernel: those small learn-curve numbers are not approved SQLite admission
throughput. Neither Graph API seeding nor that curve proves a 10k/100k batch
of admitted facts. `scale-100k` remains opt-in, not a default CI workload.

## 18 Ekim 2026 kapasite ölçümü

GÖZLENDİ: Windows x64, Node 22.22.0, `better-sqlite3` 13.0.3. İki ayrı
ölçüm vardır; graf fixtürü büyüklüğü öğrenilmiş olgu sayısı değildir.

### Sentetik 100k graf

`e8bdb6f7c6d7c555e3f422ef2790e836c8358eff` üzerinde
`node benchmarks/bench-scale-10k.js --fixtures=scale-100k --quick --json`
çıkış `0` verdi: 100000 düğüm ve 100000 kenar. Bir warmup ve bir ölçülen
tekrar kullanıldı. Bellekte Graph API seed 1313.597 ms, ask 33.507 ms,
verify 619.564 ms, reason 16.683 ms; ayrı SQLite grafında **reload + checkpoint
save** 13129.863 ms. Seed sonrası heap artışı 190.65 MiB; bu RSS değildir.
SQLite grafını ilk doldurma süresi bu seed sayısı içinde değildir. Bu kayıt
tek makinedeki sentetik graf okuma/yazma kanıtıdır; öğrenme veya üretim SLO'su
değildir.

### Gerçek, onay bağlamlı öğrenme: aynı fixtürde önce/sonra

Başlangıç `6c22665ab57ab065a7e352b03b82420c64e12ad6`, aday üretim kodu
`6cd2c35f3db45bf0a4e226e10033b6faaa3fe8a9`. Admission gerekçesi ve öğrenme
artık bilinen düğüm listesini tembel sağlar. TR ayrıştırıcı, bilinen iki/üç
kelimeli özne arayacaksa listeyi extraction başına bir kez okur. Kısa metin,
`bir` ve koordinasyon yollarında kullanılmayan kopyalar oluşmaz. Mevcut
object/array ve normalize-ID eşleşmesi korunur; yeni indeks veya model yoktur.

Her boyutta aynı SQLite seed dosyasının bağımsız kopyaları kullanıldı. Eski/yeni
sırası çiftler arasında değiştirildi; her deneme yeni Node sürecinde açıldı.
Bir denemede dört farklı iki kelimeli olgu (`profil-0 meyvedir` …) öğrenildi.
İlk çağrı cold, kalan üç çağrı warm örneklerdir. Her çağrıda `ok: true`,
`admission.outcome: allow`, `learned: 1` ve gerçek kenar geri okuması arandı;
kapatıp açtıktan sonra dört kenar tekrar doğrulandı. İki boyutta toplam
64 gerçek yazma (eski/yeni 32'şer) doğrulandı.

| Seed düğüm | Çift / warm örnek (her taraf) | Warm medyan eski → yeni | Yerel oran | Cold medyan eski → yeni |
|---:|---:|---:|---:|---:|
| 10000 | 5 / 15 | 42.486 → 18.619 ms | 2.28x | 560.856 → 500.372 ms |
| 100000 | 3 / 9 | 722.944 → 339.370 ms | 2.13x | 5662.749 → 4906.490 ms |

Tam `getNodes` çağrıları her denemede eski kodda `[2,3,3,3]`, yeni kodda
`[0,1,1,1]` oldu. Yani bu fixtürde çağrı başına iki gereksiz tam okuma kaldırıldı;
sonraki çağrılarda başka bir tam okuma hâlâ vardır. Belirsiz çok kelimeli
metinlerde bilinen düğüm listesi hâlâ okunabilir; genel O(N) öğrenme maliyeti
çözülmüş değildir.

Zaman yalnız senkron `kernel.learn` çağrısıdır: süreç açılışı, fixtür kopyası,
veritabanı açılışı ve restart doğrulaması dışarıdadır; ilk JSON ayna export'u
cold çağrıya dahildir. Seed Graph API ile hazırlanmıştır (100k'da tek fixtür
transaction'ı), gerçek öğrenme sayısına dahil değildir. Test yükü mevcut
onaylı-fixtür bağlamını (`approvalStatus: approved`, approval ID, manual
provenance) kullanır; öğrenmede admission bypass yoktur. Bu, MCP/HTTP veya
kurulu Approval Authority üzerinden uçtan uca ölçüm değildir. Her denemede
yalnız dört çağrı olduğundan periyodik beşinci-öğrenme bakımı bu yükte yoktur.

Sınırlar: tek, diğer süreçlerden yalıtılmamış makine; az örnek; CPU maliyeti
ve p95/p99 garantisi yok. 10k warm maksimumu eski 62.629 ms iken yeni 122.660 ms
oldu; medyan kazancı her çağrının veya kuyruğun hızlandığı anlamına gelmez.
100k cold yeni medyanı hâlâ yaklaşık 4.9 saniyedir. 100k **yeni olguluk batch**,
yoğun paralel öğrenme, çok kelimeli her metin, sunucu kapasitesi veya production
limit artışı doğrulanmadı. `bench:capacity` varsayılan onay beklemelerini
`reviewedWrites` sayar; bunlar öğrenme throughput'u olarak kullanılamaz.

Yeniden çalıştırma: eski/yeni worktree'lerde aynı lockfile bağımlılıklarını
sağlayın. PowerShell'de yolları doldurun; script yalnız kendi geçici
fixtürlerini oluşturur/siler. Varsayılan çıktı iki boyutun ham örneklerini verir;
süreler makineye göre değişir.

```powershell
$env:CAPACITY_BASELINE_ROOT = '<6c22665a worktree>'
$env:CAPACITY_CANDIDATE_ROOT = '<candidate worktree>'
$env:NODE_PATH = '<same-lockfile installation>\node_modules'
@'
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const roots={baseline:process.env.CAPACITY_BASELINE_ROOT,candidate:process.env.CAPACITY_CANDIDATE_ROOT};
function trial(){
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const assert=require('node:assert/strict'),Kernel=require(path.join(process.argv[1],'kernel'));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'huqan-lazy-trial-'));
  const opts={useSQLite:true,dbPath:path.join(dir,'graph.db'),memoryPath:path.join(dir,'memory.json'),loadPlugins:false};
  fs.copyFileSync(process.argv[2],opts.dbPath);let k;const rows=[];
  try{
    k=new Kernel(opts);assert.equal(k.graph.getStats().backend,'sqlite');
    assert.equal(k.graph.nodeCount('capacity-profile'),Number(process.argv[3]));
    const original=k.graph.getNodes;let reads=0;
    k.graph.getNodes=function(...args){reads++;return original.apply(this,args);};
    for(let i=0;i<4;i++){
      const before=reads,start=process.hrtime.bigint();
      const result=k.learn('profil-'+i+' meyvedir',{
        workspaceId:'capacity-profile',approvalRequired:true,approvalStatus:'approved',approvalId:'apr_profile_'+i,
        provenance:{provenanceId:'prov_profile_'+i,sourceType:'manual',sourceRef:'test:capacity-profile',
          actor:'kernel-test',workspaceId:'capacity-profile',timestamp:'2026-10-18T00:00:00.000Z',trustPolicyVersion:'1.0.0'}});
      const ms=Number(process.hrtime.bigint()-start)/1e6;
      assert.equal(result.ok,true);assert.equal(result.data.admission.outcome,'allow');assert.equal(result.data.learned,1);
      assert.equal(k.graph.getEdges('profil-'+i,'capacity-profile').length,1);
      rows.push({ms,getNodesCalls:reads-before});
    }
    k.graph.closeSqlite();k.memory.close();k=new Kernel(opts);
    for(let i=0;i<4;i++)assert.equal(k.graph.getEdges('profil-'+i,'capacity-profile').length,1);
    console.log(JSON.stringify({rows,restartedEdges:4}));
  }finally{
    if(k){k.graph.closeSqlite();k.memory.close();}
    assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});
  }
}
for(const size of [10000,100000]){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'huqan-lazy-seed-')),db=path.join(dir,'seed.db');
  let seed;
  try{
    const Kernel=require(path.join(roots.baseline,'kernel'));
    seed=new Kernel({useSQLite:true,dbPath:db,memoryPath:path.join(dir,'seed.json'),loadPlugins:false});
    const populate=()=>{for(let i=0;i<size;i++)seed.graph.addNode('seed-'+i,'seed-'+i,null,{workspaceId:'capacity-profile'});return{seedNodes:size};};
    if(size===100000)seed.graph.runMutationOnce('capacity-fixture-seed',populate);else populate();
    seed.graph.closeSqlite();seed.memory.close();seed=null;
    const results={baseline:[],candidate:[]};
    for(let pair=0;pair<(size===10000?5:3);pair++){
      for(const mode of(pair%2?['candidate','baseline']:['baseline','candidate'])){
        const child=spawnSync(process.execPath,['-e','('+trial.toString()+')()',roots[mode],db,String(size)],{encoding:'utf8',timeout:180000});
        assert.equal(child.status,0,child.stderr);results[mode].push(JSON.parse(child.stdout));
      }
    }
    console.log(JSON.stringify({size,results}));
  }finally{
    if(seed){seed.graph.closeSqlite();seed.memory.close();}
    assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});
  }
}
'@ | node
```

## 19 Ekim 2026: nedensel etki için hedefli düğüm okumaları

Kaynak baz `dcd1e8b8ffc990d06ce1f5132d5fd5fd8ddc4616`, aday
`919636e5788ffc1b87e9e05e5777bc832e5369d3`; Windows x64, Node22.22.0,
better-sqlite3 13.0.3. Aynı lockfile kurulumu kullanıldı. `simulateChange`,
workspace'in bütün düğümlerini kopyalamak yerine mevcut `getNode` API'sinden
hedefi ve nedensel zincirlerin son düğümlerini okur. Traversal, puanlama,
admission ve bütçe kuralları değiştirilmedi.

Yukarıdaki dört-yazmalı SQLite protokolü bu iki kaynakla yeniden çalıştırıldı:
aynı seed kopyaları, dönüşümlü eski/yeni sıra, her ayakta yeni süreç,
10k'da 5 çift ve 100k'da 3 çift. Seed yalnız düğüm içerir, kenar içermez;
Graph API fixtür hazırlığı gerçek öğrenme değildir. İki boyutta toplam
64 onaylı yazma (sürüm başına 32) yeniden açılışta doğrulandı.

| Seed düğüm | Warm örnek / sürüm | Warm medyan eski → yeni | Oran | Warm maksimum eski → yeni | Cold medyan eski → yeni |
|---:|---:|---:|---:|---:|---:|
| 10000 | 15 | 35.093 → 11.800 ms | 2.97x | 75.562 → 111.459 ms | 912.175 → 839.671 ms |
| 100000 | 9 | 496.266 → 61.403 ms | 8.08x | 561.779 → 130.869 ms | 10024.920 → 9853.326 ms |

Tam `getNodes` çağrıları eski sürümde `[0,1,1,1]`, adayda `[0,0,0,0]` oldu.
Bu fixtürde son gereksiz tam düğüm kopyası da kaldırıldı. 10k maksimumu
kötüleşti; bütün çağrıların hızlandığı veya p95/p99 iyileşmesi iddiası yoktur.
Cold çağrı ilk JSON ayna export'unu içerir ve 100k'da hâlâ yaklaşık
9.85 saniyedir. Farklı günlerdeki cold süreler doğrudan karşılaştırılamaz.
Bu sonuç genel O(N) öğrenme maliyetinin çözüldüğünü göstermez.

### Daha uzun onaylı seri, varsayılan bakım açık

Aynı iki sürümde, her ayakta boş SQLite graf ile `serie-i meyvedir`
öğrenildi. Her çağrı manual provenance ve açık onay-fixtür bağlamı taşıdı;
admission bypass kullanılmadı. Her `learn` sonrasında `setImmediate` beklendi:
varsayılan `maintenanceEvery=5` bakımı kapatılmadı. Toplam süre senkron
öğrenmeyi ve bu beklemeler/bakımı içerir; süreç/veritabanı açılışı ve restart
kontrolü dışarıdadır. Her sayı tek tamamlanmış koşudur; hız garantisi değildir.

| Gerçek yazma / sürüm | Toplam süre eski → yeni | Yazma/s eski → yeni | Bakım çağrısı / sürüm | Restart sonrası doğrulanan kenar / sürüm |
|---:|---:|---:|---:|---:|
| 100 | 928.566 → 1284.700 ms | 107.69 → 77.84 | 20 | 100 |
| 1000 | 15387.566 → 12340.578 ms | 64.99 → 81.03 | 200 | 1000 |

100 yazmalık seri **yavaşladı**. 1000 yazmalık seri daha kısa sürdü; iki
ayakta da bakım hatası sıfırdı. Bu iki yükte toplam 2200 tamamlanmış yazma
yeniden açılışta doğrulandı. 1000'lik serinin senkron `learn` örneklerinde
gözlenen p50/p95/p99 eski sürümde 12.946/26.560/41.115 ms, adayda
10.750/20.408/34.045 ms oldu; bakım bu senkron örneklere dahil değildir.
Bunlar tek koşunun gözlenen yüzdelikleridir, servis SLO'su değildir.

100 yazmada bütün receipt'ler `computed` oldu. 1000 yazmada **her iki sürümde
500 `computed`, 500 `upper_bound`** vardı: ortak `meyve` düğümünün bağımlıları
mevcut `maxNodes=500` tarama bütçesini doldurdu. Nedeni receipt'te
`dependency: the dependents of an existing node were not fully traversed (max_nodes)`
olarak kaydedildi. `upper_bound` tam ölçülmüş etki değildir. Mevcut sözleşmede
blast radius receipt metadata'sıdır (`blastRadiusEnforced: false`);
bu sonuç admission'ın `allow` kararıyla aynı şey değildir. Eşik veya bütçe
değiştirilmedi. Tam `getNodes` sayısı 100 yazmada 99 → 0, 1000 yazmada
499 → 0 oldu; baz sürüm bütçe dolduğunda nedensel simulasyona zaten geçmez.

Yeniden üretim: yukarıdaki PowerShell protokolünde baz/adayı bu bölümün
SHA'larına sabitleyin. Uzun seri için `trial` fonksiyonunu `async` yapın;
seed kopyalamadan boş SQLite açın; döngüyü 100 veya 1000 çağrı yapın, her çağrıdan sonra
`await new Promise(setImmediate)` ile varsayılan bakımı çalıştırın.
Her sonuçta `ok`, `admission.outcome === 'allow'`, `learned === 1` doğrulayın;
receipt'in `computed`/`upper_bound` sayısını ve nedenlerini ayrı sayın.
Her 5 yazmada bakım çağrısını ve hatalarını kaydedin, tüm `tür` kenarlarını
kapatıp yeniden açtıktan sonra doğrulayın. Açılış/restart zamanını seri
süresine katmayın; bakım dahil toplam süreyi senkron `learn` örneklerinden
ayrı raporlayın.

Sınırlar: tek ve diğer süreçlerden yalıtılmamış makine, tek süreçli
onay-fixtürü; HTTP/MCP/kurulu Approval Authority uçtan uca kanıtı değildir.
1000 yazmalık seri boş grafta büyür; 100k graf üzerinde 1000 yazma veya
100k yeni olgunun topluca öğrenilmesi ölçülmedi. Eşzamanlı öğrenme,
production kapasite limiti ve genel throughput artışı doğrulanmadı.

## Graph label-lookup benchmark (#3009)

`benchmarks/bench-label-lookup.js` contrasts the indexed label lookup against
the pre-#3009 linear scan (`Object.values(nodes).filter(...)`) on the same node
map. Defaults are `n-1000` and `n-10000` nodes across 64 labels and 4
workspaces, with 1000 repeated probes to lift the single-query noise floor.

At `n-10000` on a developer machine the indexed query is roughly two orders of
magnitude faster than the scan (about 0.03 ms vs 3.3 ms per query, ~97x over
1000 probes); the workspace-scoped node count is O(1) versus a full scan
(~0.003 ms vs ~4.9 ms, >1500x). Exact numbers are machine-dependent; run the
command to reproduce.

## Capacity limits: multi-process SQLite write contention (#3314)

The row above measures one process. This section measures what the runtime
actually ships: several long-lived processes (agent MCP servers, the HTTP
server, the CLI) writing the **same** graph/memory database file. SQLite allows
one writer per file, so the question is how much throughput is lost and whether
a write fails with `SQLITE_BUSY` after the configured retries.

Benchmark: `benchmarks/bench-sqlite-write-contention.js`. The parent seeds each
target file, then forks N child processes (`spawn`) that write into that one
file at the same time, each inside its own process and its own SQLite handle.
Every child opens its handle, waits on a barrier, then runs the timed write
loop, so all writers are connected before the first write lands. The contended
write phase is compared against a **fresh single-process run of the same total
write count**, so the reported slowdown compares like with like instead of a
small contended run against a large solo run.

`--children=N` runs a single size; the default sizes are `1, 2, 4, 8`. Graph
draws are `addNode`/`addEdge`; memory draws are `MemoryStore.store`. Because
`better-sqlite3` is synchronous, one iteration's wall time is also the longest
its process's event loop was blocked. The report keeps each process's own
maximum block, not only the merged one, so the process that blocked longest is
identifiable.

Environment: commit `cfb22b9` (benchmark `1.1.0`), Node v24.21.0, linux x64,
AMD EPYC 9B14 (4 vCPU). `--writes=30` (30 writes per child). Absolute timings
are advisory and noisy on a shared 4 vCPU host; the shapes (no failure, roughly
flat throughput, growing per-process block) are what matters.

Graph writes:

| N (processes) | total writes | wall ms | writes/s | p50 ms | p95 ms | p99 ms | max event-loop block ms | slowdown vs solo | `SQLITE_BUSY` failures |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 30  | 763.3  | 161.0 | 6.0 | 7.4  | 10.7  | 10.7  | 1.00 | 0 |
| 2 | 60  | 947.4  | 167.2 | 5.8 | 6.9  | 190.4 | 190.4 | 1.04 | 0 |
| 4 | 120 | 1338.3 | 165.2 | 5.7 | 7.9  | 516.5 | 536.0 | 1.16 | 0 |
| 8 | 240 | 2092.0 | 173.8 | 5.6 | 20.1 | 836.4 | 1217.4 | 1.08 | 0 |

Memory writes:

| N (processes) | total writes | wall ms | writes/s | p50 ms | p95 ms | p99 ms | max event-loop block ms | slowdown vs solo | `SQLITE_BUSY` failures |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 30  | 610.8 | 593.5 | 1.5 | 1.9 | 6.4   | 6.4   | 0.98 | 0 |
| 2 | 60  | 673.2 | 558.3 | 1.5 | 2.6 | 57.2  | 57.2  | 1.10 | 0 |
| 4 | 120 | 814.5 | 538.5 | 1.5 | 2.5 | 82.8  | 184.1 | 1.20 | 0 |
| 8 | 240 | 1022.0| 717.7 | 1.4 | 6.1 | 182.7 | 233.0 | 0.95 | 0 |

Checkpoint under contention (`graph-checkpoint`; 8 writers plus one process
taking repeated full checkpoints):

| writers | checkpoint cycles | checkpoint ms | p95 write ms | max event-loop block ms | `SQLITE_BUSY` failures |
|---|---|---|---|---|---|
| 8 | 4 | 9.4 | 9.4 | 1273.5 | 0 |

Reading (subject to the small write budget and the 4 vCPU host):

- **Throughput does not scale with N.** writes/s stays roughly flat from N=1
  onward for both targets (graph ~161 to ~174, memory ~594 to ~718 with noise):
  the single-writer lock serialises writes, so extra processes add no write
  throughput. The individual write (`p50`) stays flat too.
- **The cost is a per-process stall, not throughput loss.** Each process's own
  maximum event-loop block grows sharply with N (graph 10.7 to 1217.4 ms,
  memory 6.4 to 233.0 ms) while `p50` barely moves. On a synchronous driver a
  process that loses the lock waits for the whole hold, so a client sharing the
  file can be blocked for over a second at N=8. That is the figure that matters
  for an agent client, not aggregate throughput.
- **No `SQLITE_BUSY` failure survived the configured retries at any N.** The
  lock is absorbed by waiting, not by failing. Non-busy write errors are counted
  separately (`otherFailures`), and were 0 as well.
- **A full checkpoint under contention did not fail either** (0 `SQLITE_BUSY`),
  but its write phase still shows the same long per-process blocks
  (max 1273.5 ms), consistent with checkpoint and writes serialising on the
  same lock.
- The graph per-write baseline is about 3x the memory one (two node upserts plus
  an edge row per draw), which is why the same N blocks the graph loop longer.

### Migration condition (threshold, not a decision)

The measurements do **not** justify a storage change now. Treat this as the
condition to revisit, with the numbers to be re-measured at real agent counts:

> Revisit moving graph writes behind a single-writer process (or another store)
> **only if**, at the expected agent count M, a re-run of this benchmark shows a
> per-process **event-loop block above 50 ms** or any `SQLITE_BUSY` failure
> after retries.

The 50 ms figure is chosen in terms of the metric the benchmark actually
reports: the per-process maximum block (and p99), because that is what a client
sharing the file experiences. It is **not** SQLite lock wait in isolation; the
timer spans the whole synchronous write call, which is the honest bound on how
long the process was unavailable. At M = 8 the measured memory block already
exceeds 50 ms, while the graph block is far above it, so under this budget the
condition is already met for a client that cannot tolerate a second of stall.
That is a real signal, not a marginal one: re-run at the intended agent count
and write budget before acting on it. Cheaper options come first if it holds: a
single writer process with the others as clients, shorter checkpoint holds, or a
smaller `busy_timeout`. A different database is last.

`NOT_MEASURED`: agent counts above 8, writes-per-agent above 30, checkpoint
contention with a write budget large enough to force a real checkpoint hold
(here the checkpoint was fast enough that it rarely overlapped a full hold), and
any host other than the 4 vCPU machine above. Nothing here is extrapolated
beyond the table.
## Benchmark commands

```bash
node benchmarks/bench.js --quick
node benchmarks/bench.js --fixtures=small,medium,large,xlarge
node benchmarks/bench-label-lookup.js --quick
node benchmarks/bench-label-lookup.js --fixtures=n-1000,n-10000
node benchmarks/bench-scale-10k.js --quick
node benchmarks/bench-scale-10k.js --fixtures=scale-100k --iterations=1
node benchmarks/bench-sqlite-write-contention.js --writes=30
node benchmarks/bench-sqlite-write-contention.js --children=8 --writes=100
node benchmarks/verifBench.js
node --test benchmarks/bench.test.js benchmarks/bench-label-lookup.test.js benchmarks/bench-scale-10k.test.js benchmarks/check-regression.test.js
```

## Safe public language

Use these phrases:

- local-first
- deterministic
- small-to-medium graph tested
- larger graph support requires dedicated benchmarking
- not yet proven at Wikipedia-scale
- scale roadmap exists but is not claimed

Avoid these claims unless a future benchmark proves them:

- millions of nodes supported
- Wikipedia-scale
- enterprise graph scale
- production-scale knowledge graph

## Recommendation

Public docs and demos should describe AXIOM as a deterministic local-first reasoning engine with measured small-to-medium graph coverage, and should keep larger-scale claims as roadmap items until a dedicated benchmark pack proves them.
