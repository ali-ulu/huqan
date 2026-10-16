# HUQAN — Üretimi yavaşlatmadan mühendislik temeli

**Status:** kaynak denetimi ve uygulama sözleşmesi; bütün altyapının kurulmuş olduğu iddiası değildir.
**Ölçüm/denetim tabanı:** `8d92b75c3f17a4c74c511c7d83ec7557542c7b52`, package `0.13.1`.
**Son çalışma tabanı:** `e60ef28f6a9b85cae0557594837a68f0d296965f`; yalnız main-ci-watch.yml değişti, ölçülen store/classifier davranışı değişmedi.
**Takip:** [#3306](https://github.com/ali-ulu/huqan/issues/3306); yeni engineering epic açılmaz.
**Kanıt:** [engineering-foundation-20261002-evidence.json](../reports/engineering-foundation-20261002-evidence.json).

Başarı: çalışan akış bozulmadan yeni davranışın gerçek çağrıcısı ve sonucu görülür;
aynı kusur tekrar teslim edilmez; kontrol maliyeti ölçülür; kapasite sonucu
gözlenmeyen bir veri/kullanıcı sayısına genellenmez. Cognitive Lab önceliği korunur.

## Öncelik ve tek sonraki uygulama

| Paket | İş ve kapanış kanıtı | Durum |
|---|---|---|
| E0 | Güncel main nightly hatasının kesin testi/ortamı; aynı davranışı koruyan kök neden düzeltmesi ve fresh main CI | Mevcut [#3327](https://github.com/ali-ulu/huqan/issues/3327); nightly36984900436 FAILURE, push36973078586 SUCCESS |
| E1 | Coverage source classifier sözlüğünü düzelt; yanlış yol/missing çıktı yeşil olamasın | Yerel `fix/ci-source-coverage-20261002`; 2 dosya, bağımsız review APPROVE |
| E1b | Classifier aynı published envanteri tek Bash sürecinde doğrulasın; kapsam aynı, süre ölçülsün | Ayrı `chore/ci-classifier-batch-20261002`; sonucu kanıt kaydı belirler |
| E2 | Teslimde production caller/default dependency/observed effect kanıtı, gerekli dar refactor, tekrar issue önleme | `docs/agent-canon.md::ENGINEERING-001` yerel eklendi; genel otomatik stub gate değildir |
| V0.1/V0.2 | Gain, outcome ve maliyet ölçümü; baseline limitleri görünür | #3307/#3308; önerilen uygulama, henüz ölçülmüş gain yok |
| E3 | SQLite+Graph gerçek workload kapasite envelope'u ve backend geçiş kararı | Mevcut benchmark reuse; read-only ölçüm aşağıda; concurrency harness henüz yok |
| E4 | NOT_YET_WIRED için caller/ürün kararı; ilk öğrenme bağı #3310 | 26 karar aşağıda; topluca activation yok |
| E5 | CI kritik yol/runner süreleri; ölçülmüş gereksiz tekrarların ayrı dar optimizasyonu | Aşağıdaki baseline; required-check isimleri korunur |

Sonraki uygulama sırası: E0 teslim güvenini sağlar; E1/E1b dar yerel değişiklikleri
ayrı review ve exact-head CI ile kapatılır. Ardından #3307 baseline/evaluator;
#3308 outcome contract; E3 workload ölçümü. #3310 kendi W1/W4 önkoşullarıyla
tek opt-in caller'dan ilerler. Yeni I0 engine/I1 scheduler #3310 önkoşulu değildir.

## Teslim kabulü: yarım iş bırakmama

E0 GÖZLENDİ: macOS/Node22/shard4 job110767721864, tek
`test/cdp-browser-teardown.test.js:71` — `killing the tree leaves no descendant running`.
Assertion102: `nothing may survive the tree kill, got [1774]`, actual `[1774]`,
expected `[]`. Diğer29runtime leg SUCCESS, shard225/225dosya tamamlandı; timeout
veya setup/artifact failure değil. Aggregate npm test gate failure doğru.
Kaynak helper yalnız parent exit bekleyip descendant `stragglers` snapshot'ını
bir kez alıyor; test torunun bitmesini daha sonra bekleyince fresh liveness
assertion geçip eski snapshot assertion kırılıyor. TÜRETİLDİ: settlement/status
zamanlama kontratı dar inceleme ister; log kalıcı leak veya zombie kök nedenini
tek başına kanıtlamaz. Kabul: bounded owned-descendant settlement + fresh final
status; deterministik gecikme/zombie ayrımı ve Mac22/24+Linux/Windows doğrulaması.
Assertion silme, genel retry veya yeşil eski push'u full nightly yerine sayma yok.

1. Fresh main/HEAD, scope ve test-before kaydı. Aynı açık/kapalı issue/PR varsa
   mevcut kayıtta devam; raporlanmış iş kaynaktan doğrulanmadan tekrar önerilmez.
2. Üretim entry → gerçek fonksiyon → gözlenen state/output → kabul testi.
   Test import'u, require reachability ve mock executor çıktısı tamamlanma sayılmaz.
3. Varsayılan gerçek bağımlılıklarla olumlu ve hata/unknown yolu. Yeni caller veya
   davranış bypass edilince dar regression kırılmalı. State değişirse ilgili
   tenant isolation, retry/idempotency, restart ve rollback de korunmalı.
4. Refactor gerekliyse public API/receipt/authority/verdict korunarak karakterize
   edilir. Görevin oluşturduğu orphan export, boş success fonksiyonu veya duplicate
   implementation aynı dilimde çözülür. Kasıtlı hook/no-op/public API ayrıca açıklanır.
5. Mevcut dead-code, ownership, layers, file-size, package/API ve impact kapıları
   kullanılır. Allowlist/floor gevşeterek yeşil üretme; yan borcu aynı PR'a taşıma.
6. Bağımsız reviewer, fresh komut/exit, exact diff ve doğrulanmayan sınır. Görev
   raporunun doğru olması için tam suite yerine selected-suite yazılır.

Mevcut kapılar: dead-code1048 reachable/203 classified-unreachable; 4737 named
exports/unused0/allowlisted47/opaque139; MCP30/schema30, CLI35, REST17; kaynak1231,
over400=0, privatecall0, unmapped0, layer exceptions3. Bu sayılar kaynak yapısını
ölçer. Opaque modüller veya bütün empty callback'ler otomatik silinmez. Function-level
production kullanım ayrımı bugün genel blocking gate değildir. Gerekirse mevcut
export taramasında production/test kullanımını ayrı raporla; yeni ikinci scanner
kurmadan false-positive ve süre deneyi yap. İlk hedef dar değişen export'tur.

## 26 NOT_YET_WIRED: bağlantı ve ürün kararı matrisi

Bu tablo **önerilen caller/kabul** taşır, var olan runtime bağlantısı değildir.
Canonical ledger `lib/module-reachability.js`; baseline26 ve retired2 değişmedi.
C1: gerçek entry smoke+observed effect; C2: default dependency+negative/bypass;
C3: ilgili replay/restart/tenant/rollback; C4: schema/policy authority genişlememesi;
C5: ölçüm/gain/bütçe kanıtı. Uygulama dilimi gerçek test dosyası/komutu seçer;
bugün olmayan caller için çalışır kabul komutu varmış gibi yazılmaz.

| Modül | Beklenen tüketici / karar | Önkoşul ve kabul |
|---|---|---|
| `lib/code-anchor.js` | Contract/source-location tüketicileri; runtime activation ihtiyacı ayrıca kararlaştırılır | Content değişimi/missing anchor; C2; public primitive üretim özelliği sayılmaz |
| `lib/memory-lifecycle.js` | Tek gerçek CLI/MCP/HTTP memory write/read/score/verify surface | Mevcut admission+store otoritesi, E3; C1–C4 |
| `schemas/v5/agent-identity-conformance.js` | Seçilecek identity conformance sınırı | Mevcut identity contract; C1/C2/C4 |
| `schemas/v5/agent-identity-coverage.js` | Gerçek identity coverage raporu tüketicisi | Aynı contract ve rapor completeness; C1/C2/C4 |
| `schemas/v5/agent-identity-readiness.js` | Gerçek readiness kararı tüketicisi | Missing evidence ready olamaz; C1/C2/C4 |
| `schemas/v5/agent-identity-validator.js` | Seçilecek identity ingress validator | Tamper/unknown/scope negatifleri; C1–C4 |
| `lib/self-healer/index.js` | **Library-only ürün kararı korunur**; autonomous runner yok | Caller oluşturmak için ayrı ürün kararı; import wrapper boş özellik sayılmaz |
| `lib/experience/procedure-registry.js` | #3310 tek qualification→registry caller | #3307/#3308,W1/W4 binding, durable authority; C1–C5 |
| `lib/experience/capability-trust.js` | Gerçek registry intake/outcome evidenceWindow | #3310 sonrası gözlenen outcome; C1–C5 |
| `lib/experience/router.js` | Güven kararından gerçek executor'a request dispatch | Registry/trust+seçilmiş ingress; C1–C4 |
| `lib/experience/personal-execution-model.js` | Gerçek request üzerinde evaluatePersonalExecutionModel | Policy/preference/environment/trust version binding; C1–C4 |
| `lib/experience/optimization-hypothesis.js` | Explicit trigger'da gerçek history detector tüketicisi | V0.1 outcome/cost; scheduling ayrı; C1/C2/C5 |
| `lib/experience/canary.js` | Router üzerinden gerçek candidate trial | Live observed outcomes/rollback; C1–C5 |
| `lib/experience/capability-trust-canary-extension.js` | Canary trust yolunun bağlı fonksiyonları | capability-trust+canary; C1/C2/C3 |
| `lib/experience/permitted-fallback.js` | Router/PEM refusal sonrası model-call öncesi gate | Permission/provenance sınırı, explicit opt-in; C1–C4 |
| `lib/experience/permitted-fallback-trust.js` | Gerçek fallback usage→trust kaydı | Outcome/counter integrity; C1–C5 |
| `lib/experience/capability-trust-fallback-extension.js` | Fallback trust ladder consumer | permitted-fallback-trust; C1/C2/C3 |
| `lib/experience/write-cost-budget.js` | Gerçek journal-write ölçümü ve budget gate | E3 native store ölçümü; C1–C5 |
| `lib/delegation-service.js` | Plan compiler/policy attach→gerçek execution route | Delegation scope/approval/identity; C1–C4 |
| `lib/agent-capability-report.js` | Gerçek capability report publisher | Publish policy ve observed capability; C1/C2/C4 |
| `lib/delegation-rate-counter.js` | Gerçek spawn admission gate | Bounded dispatch/idempotent count; C1–C4 |
| `lib/bypass-signal-state.js` | Gerçek recommendation sinyali kaydı | Trust/policy owner; C1–C4 |
| `lib/bypass-response.js` | Recommendation üzerinde response evaluator | Sinyal kaydı + operator contract; C1/C2/C4 |
| `lib/incident-envelope.js` | Human-approved incident sending surface | Onay ve sender seçimi ayrı; C1–C4 |
| `lib/release-evaluation-record.js` | Gerçek release gate evaluation tüketicisi | Exact artifact/CI/evaluation binding; C1/C2/C4 |
| `lib/provenance-ingest-adapter.js` | Doğrudan kernel.learn yapan bir surface adapter'ı benimser | Provenance/admission korunur, ikinci authority yok; C1–C4 |

RETIRED: `lib/http/crash-recovery-inventory.js` executable test evidence;
`lib/http/request-limits.js` canonical server-timeouts shim. Caller planlanmaz,
wiring borcuna geri eklenmez; sırf sayıyı düşürmek için silinmez.

## SQLite veri büyüdüğünde yeter mi?

GÖZLENDİ: Native SQLite backend doğrulandı; MemoryStore SQLite mode bounded
cache+chunk validation kullanıyor (#3208). Graph load ise nodes/edges/candidates/
audits `.all()` ile hydrate ediyor; Graph reads RAM/index yollarında. #3009 label
index, #3139 workspace edge counter, #3016 Graph10k ve #3208 bounded retention
işleri mevcut/kapalıdır; yeniden yapılacak listesine konmaz.

MemoryStore bütün structured-readleri indeksli yapmıyor: temel workspace/status/
contentKind page SQL fastpath; `query` text/recall/time/sourceRef gibi yollar ve
`findByKind/Status/ContentHash/SourceRef` ayrı JS scan/sort yolları içeriyor.
Dolayısıyla bounded retention tüm workload'larda bounded peak heap/latency değildir.

| Kayıt+event sayısı | Açılış ms | Cold rule-list ms | 20 warm çağrı ortalaması ms | Tek memory history ms |
|---|---:|---:|---:|---:|
| 10.000 | 320.7 | 9.70 | 1.58 | 0.48 |
| 50.000 | 3800.5 | 83.57 | 10.25 | 0.39 |
| 100.000 | 7140.9 | 122.26 | 16.13 | 0.32 |

Komut: `node --expose-gc benchmarks/bench-memory-store-open.js`, exit0; native
SQLite3.53.1/Node22.22.0, Windows x64, i5-1135G7, ~8GB RAM. Fixture küçük JSON,
her100 memory'de1 rule/1event-per-memory. Tek run; latency tail, graph capacity,
server throughput veya yoğun writer iddiası yok. Retained heap farkı0.1/0/-0.3MiB
GC gürültüsünü içerir, RSS ölçümü değildir.

TÜRETİLDİ: Veri artışı tek başına SQLite değiştirme gerekçesi değildir; gerçek
darboğaz Graph RAM/open ve admission/read/write path olabilir. SQLite dosya başına
tek writer kabul eder; WAL reader/writer eşzamanlılığını iyileştirir, aynı anda
çok writer oluşturmaz. [SQLite kullanım rehberi](https://www.sqlite.org/whentouse.html)
ve [WAL sözleşmesi](https://www.sqlite.org/wal.html). Network filesystem veya çok
sunucunun aynı DB'ye doğrudan erişimi supported deployment olarak ilan edilmez.

E3 kabul tasarımı:

- Aynı fixture/frame ile mevcut Graph10k/open benchmark reuse; 100k/1M opt-in.
  Native backend zorunlu; fallback koşumu SQLite kapasitesi diye raporlanamaz.
- Gerçek kernel.learn/admission+query+recall+finder workload'u; payload/index/disk
  ölçüsü, Graph node/edge/audit büyümesi ve cold/restart ölçümü ayrı.
- Aynı yerel DB üzerinde1/4/16writer+reader; transaction duration, p50/p95/p99,
  busy/retry/reject, queue wait, event-loop delay, RSS/heap, WAL/checkpoint büyümesi.
  Warm-cache hızını cold restart ile karıştırma; multiprocess visibility ayrıca.
- Başlamadan SLO, budget, tolerated operational rejection, sample/repeat ve
  recovery target kilitlenir. Lost write/tenant leak/double mutation/receipt drift
  kabul edilmez. Yoğun contention kontrollü failure olabilir, sessiz success olamaz.
- Integrity ve replay/restart/crash recovery değişmeden SLO'yu aşan bottleneck
  önce mevcut path'te düzeltilir. Ölçüm gerektiriyorsa Graph lazy/query-backend
  tasarımı veya mevcut port üzerinden PostgreSQL değerlendirilir. Şimdiden driver,
  dual-write, ikinci canonical read authority ya da backend migration kurulmaz.

## 80 test mi? CI maliyet tabanı

GÖZLENDİ: [PR3304](https://github.com/ali-ulu/huqan/pull/3304) head
`5fd870977dfd6cd60ce1909de1948306bec33c16`: rollup81 =80CheckRun+1CodeRabbit status;
77 unique check adı; 66success/14skipped. Bunlar test adedi değildir.
Benchmark run36908849559 ~604s wall; tüm check job duration toplamı2027s
(~33m47 runner wall, CPU veya ücret hesabı değildir). Runtime20job = Linux/Windows
×Node22/24×5shard, max-parallel10. Nightly platform matrisi ayrıca genişler.

Mevcut optimizasyon korunur: changed-source dependency closure+mandatory safety
union, agent yalnız test ekleyebilir, unknown/fallback full, timing weighted shards,
cache, stale PR cancel; nightly/release full. Security/installed-consumer/OS checks
kanıtsız silinmez. Architecture static birleştirilmiş; legacy stable-name jobs
required-check ayarları taşınmadan kaldırılmaz.

Somut ilk optimizasyon: published classifier testcase Windows'ta139260.97ms
sürdü (tek kaynak path başına Bash process); ayrı eşlenmiş worker koşumunda
aynı1043path için61246.220ms→129.293ms, toplam7test62463.664ms→1048.157ms ölçüldü.
Bu tek makine/test ölçümüdür; bütün CI'ın aynı oranda hızlandığı iddiası değildir.
E1b NUL ayrılmış stdin ile tekprocess kullanır; Windows32767char argv sınırını
aşan34510char inventory argv'ye gömülmez. Daha büyük optimizasyon için mevcut JUnit/job artifacts'tan wait/
setup/test/upload süreleri ve slowest shard çıkarılır; ilk feedback ve total
critical path ayrı ölçülür. Evrensel sabit dakika veya rastgele test sayısı hedefi yok.

Coverage bug düzeltmesi kaynak PR'larında mevcut **full-suite c8** işini yeniden
çalıştırır. Bu maliyeti artırabilir; yerel routing PASS fullcoverage oranı veya
CI süre kanıtı değildir. Sonraki maliyet deneyi full/partial coverage floor'larını
karıştırmadan tasarlanır; ratchet skip/floor düşürmek optimizasyon sayılmaz.

## Kabul komutları ve doğrulanmayanlar

```powershell
node scripts/agent-context.js
node --test test/ci-change-classifier.test.js test/ci-runtime-classifier.test.js test/check-coverage.test.js
node scripts/check-workflow-governance.js
node scripts/check-dead-code.js
node scripts/architecture-snapshot.js --check --base-ref=<fresh-main-sha>
node --expose-gc benchmarks/bench-memory-store-open.js
```

Her komut yalnız ilgili dalda gerçek son diff sonrası koşulur; conditional browser,
native SQLite ve Bash bağımlılıkları skip olursa belirtilir. Full npm test,
Mac nightly root-cause fix, GitHub exact-head CI, concurrency envelope, yeni
production caller ve gain **bu paketle tamamlanmış değildir**.

İki dakikalık göz testi: E1 dalında coverage workflow koşulları yes/no; missing
classification testi red-before/green-after. E1b'de published liste aynı,7test
skip0; terminal sürelerini kıyasla. Planın26satırında self-healer library-only,
RETIRED2 ayrı; SQLite table'da100k cold open7.1s ve heavy-writer unknown görünür.

```text
[BAĞLAM] HUQAN0.13.1, main8d92b75c; reasoning/learning önceliği ve mevcut kalite kapıları.
[GÖREV] E0 exact nightly failure triage; E1/E1b dar yerel diff'ler; ardından V0.1 ölçüm temeli.
[KABUL] İlgili gerçek caller/negative smoke+fresh exit0; kaynak/çıktı/maliyet kanıtı; scope dışı drift ayrı.
[YASAK] Yarım success stub, floor/allowlist bypass, toplu activation, ikinci authority, release/versiyon değişimi.
[SÜRÜM] İşe başlamadan live origin/main fetch; plan tabanı yukarıdakiSHA; historical ölçüm current capacity guarantee değil.
```
