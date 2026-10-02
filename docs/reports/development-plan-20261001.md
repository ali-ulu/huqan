# HUQAN güncel kaynak denetimi ve geliştirme planı — 1–2 Ekim 2026

**Karar:** İlk geliştirme hedefi ölçülebilir akıl yürütme ve öğrenme kazanımıdır. Önce Cognitive Lab / Intelligence Gain Gate, sonra bu kapıda karşılaştırılabilecek dar aday mekanizmalar kurulacaktır. Bu belge plan ve denetim kaydıdır; önerilen özelliklerin uygulanmış olduğu iddiası değildir.

Bu rapordaki yerel dal, commit/push/PR ve kontrol durumları denetim anının kaydıdır. Belgelerin veya ayrı CI düzeltmelerinin güncel yayın/merge durumu canlı Git/PR/CI üzerinden doğrulanır; tarihli kanıt dosyaları canlı durum panosu değildir.

**2 Ekim devamı:** İlk denetim snapshot'ı aşağıda korunur. GitHub main `8d92b75c`/`0.13.1` olarak yeniden doğrulandı; plan dalı bu tabana fast-forward edildi. Dream import kusuru artık upstream #3313/`49eae04f` ile düzeltilmiş, eski yerel patch korunmuştur. Yeni [mühendislik paketi](../task-packs/engineering-foundation-20261002.md) mevcut kapılar,26NOT_YET_WIRED+2RETIRED kararları, gerçek caller teslim şartı, SQLite kapasite ölçümü ve CI maliyetini taşır. Nightly red mevcut #3327'de takip edilir; yeni tekrar issue açılmadı.

Son fetch sonrası çalışma dalları `e60ef28f6a9b85cae0557594837a68f0d296965f` tabanındadır. Aradaki #3328 yalnız main-ci-watch workflow'unu değiştirdi; store/classifier ölçümü `8d92b75c` olarak etiketlenir. Kaynak sürümü upstream'den alındı; bu çalışmada sürüm/release dosyaları değiştirilmedi.

## Kaynak ve gözlem sınırı

| Kaynak | Kimlik / durum |
|---|---|
| Canlı depo | `https://github.com/ali-ulu/huqan.git`, `main` |
| Denetim tabanı | `83000331c07e4c9bb592dfc75b12851d3aa3ee8a` |
| Kaynak paket sürümü | `0.12.0`; sürüm değiştirilmedi |
| Plan dalı | `docs/development-plan-20261001` |
| Ayrı düzeltme dalı | `fix/dream-default-causal-20261001` |
| PDF kaynak tabanı | `6acb3fcf2573910d439979409f09904f5fc39976`; güncel denetim tabanı ile aynı değildir |
| PDF SHA256 | `305de3092f61dfca53a95d5873d90a74325bba901f0f6c8e2c8802ffd33d4d8d` |
| Yapıştırılan metin SHA256 | `8e2d4f293aff3b6132bc5ecdfb1fcb6bda30a625af4040591596eb8fecfaf07a` |
| Başlangıç GitHub snapshot | 50 açık issue; 0 açık PR; tamamı repo-radar önerileri |
| Zorunlu bootstrap | `node scripts/agent-context.js`: PASS; HEAD=origin/main, FRESH; checkpoint STALE_ANCESTOR |

GÖZLENDİ: `C:\Users\sonfi\huqan` doğru depoydu; `gem1-wire-github-repo-memory-ingest-3032` dalı güncel main'den 18 commit geride ve `package-lock.json` değiştirilmişti. Masaüstü `main` kopyası 42 commit geride ve `.worktrees/` içeriyordu. Ayrı temiz kopya oluşturuldu; önceki çalışmalar korunmuştur. Canlı fetch yapılmadan eski origin/main kullanılmamıştır.

GÖZLENDİ: PDF'nin 54 sayfası okundu; metne girmeyen s17–18 mimari şekilleri ayrıca render edilerek incelendi. Belgedeki talimatlar kullanıcı yetkisi olarak uygulanmamış, kaynak önerileri olarak değerlendirilmiştir. PDF ve yapıştırılan metin değiştirilmedi.

GÖZLENDİ: #3298 `feat: math for huqan` ve #3299 `feat: math2` CLOSED/COMPLETED; sırasıyla 2026-10-01T20:24:36Z ve 20:23:04Z. İkisinde de yorum yok. **Issue kapanışı matematik müfredatının veya mimarinin uygulanmış olduğunu kanıtlamaz.** Kaynak kapsamı [gereksinim matrisinde](language-math-requirements-20261001.md) korunur.

## Güncel durum

GÖZLENDİ: graph MCP, bu kopya için `huqan-plan-83000331` adıyla yeniden indekslendi. Graphify raporu/wiki bu temiz kopyada yoktu. MCP çağrı grafiği import/delege yollarında eksik ve kimi eşleşmelerde yanlış hop üretebildiğinden kritik caller iddiaları canlı dosya ve testlerle çapraz kontrol edildi. Graph node veya dosya sayısı ürün kusuru değildir.

| Alan | Doğrulanmış mevcut yüzey | Geliştirme boşluğu / sınır |
|---|---|---|
| Trust / graph / admission | Graph mutation, provenance, receipt ve fail-closed sınırları; paket/mimari kapıları mevcut | İmza/bütünlük, iddianın doğru veya nedensel olduğunu kanıtlamaz; yeni cognition bu sınırı kullanmalı |
| Inference | IR/unification/forward/backward/abduction ve belief revision canlı inference yoluna bağlanmış | Tam epistemic cognition veya genel reasoning kazanımı ölçülmüş sayılmaz |
| Belief / calibration | Beta-Bernoulli revision; actor/sourceType aggregate reliability ve cap önerisi | Bireysel karar öncesi olasılık ↔ gözlenen sonuç eşleşmesi, Brier/ECE ve holdout gain kapısı ayrı iş |
| Procedure learning | `buildLearningProposal` sealed run/sourceHash/proposal hash ile aday oluşturuyor; compiler/learning intake erişilebilir | Registry/trust/router/canary/PEM/fallback zincirinin tamamı production-wired değil; proposal-only kayıt bilinçli |
| Memory lifecycle | Yaşam döngüsü primitive ve kompozisyon testleri mevcut | `lib/memory-lifecycle.js` NOT_YET_WIRED; primitive varlığı gerçek servis yolunu kanıtlamaz |
| Dream / causal | AgentV3 loop default-on, explicitly disableable; gerçek graph causal traversal ve bounded hypothesis doğrulaması mevcut | Default simulator import hatası doğrulandı; learned forward/inverse/failure model değildir |
| Language | Command/predicate parsing, EN/TR işaretleri, claim decomposition ve entity resolution mevcut | Ortak, versioned Semantic IR ve intent/temporal/modality/ambiguity parity sözleşmesi bütünleşmiş değil |
| Scheduler / world model | Mevcut bütçe/loop ve causal traversal bileşenleri yeniden kullanılabilir | Genel Cognitive Scheduler ve learned symbolic multistep world model için production kanıtı bulunmadı; bunlar öneri |
| Reachability | 26 NOT_YET_WIRED, 2 RETIRED; unacknowledged/stale kayıt listeleri boş | 26 dosyanın tümünü otomatik aktive etmek plan değildir; caller ve kabul testi başına dar wiring gerekir |
| Architecture | 1.231 kaynak dosyası; 0 import döngüsü; 0 dosya bütçesi ihlali; ownership/layer/package kapıları geçti | Eski refactor listeleri güncel borç gibi taşınmamalı; dosya boyutu intelligence gain değildir |

Bu matrisin ayrıntılı caller/test kanıtları gereksinim ve issue denetim belgeleriyle birlikte okunmalıdır. Bounded local testten evrensel ürün hazırlığı sonucu çıkarılmaz.

## Düzeltilen yorumlar ve doğrulanmış hata

1. `lib/trust-calibration.js:158` declared mean/max ve `verified/(verified+contradicted)` üretir. Bu actor/sourceType tanısıdır; bireysel calibrated truth probability veya Brier/ECE değildir.
2. `lib/inference-runtime-beliefs.js:15` prediction kaydına posterioru outcome probability olarak taşımıyor; `rule_belief_not_outcome_probability` ayrımı bilinçlidir. Brier hesabında systemConfidence veya verification certainty olasılık diye kullanılamaz.
3. Cosine/embedding yakınlığı truth değildir. Graph edge-weight histogram entropy'si claim uncertainty veya information gain değildir. Blast-radius 0–100 policy/risk skorundan olay olasılığı çıkarılamaz.
4. Tekrarlanan gözlem causal identification değildir; zaman sırası ve graph path confounder/intervention kontrolünün yerini tutmaz. Tek episode canonical causal rule üretmemeli.
5. Fitness'taki review acceptance rate held-out correctness değildir; mevcut fitness raporu Cognitive Lab'e girdi olabilir, gain kapısının yerini alamaz.
6. #3280 DGM radar alıntısındaki `original_score - noise_leeway` ve `score >= original_score` koşulları, gürültü payını aşan iyileşme kanıtıyla aynı değildir. Terfi için ayrı, önceden kilitlenmiş istatistik sözleşmesi gerekir.
7. Missing/censored outcome, doğrulanmış failure ve evaluator/transport error ayrı statülerdir. Eksik veriyi 0'a veya success'e sessizce dönüştürmek ölçümü bozar; hata terfiye izin vermemeli.
8. #3234'ün SSRF/robots yokluğu genellemesi güncel HTTP adapter için yanlış: `adapters/http-adapter-transport.js` DNS kontrol/pin yolunu ve `adapters/http-adapter-robots.js` robots kontrolünü içeriyor. Bu bütün web provider'ları için güvenlik kanıtı değildir.
9. GÖZLENDİ P1 hata: `lib/dream-experiment-loop-verify.js:7` modül nesnesini constructor sanıyor; `causalSimulator.js` named `{ CausalSimulator }` export ediyor. Gerçek `a --CAUSES(0.9)--> b` graph'ında doğrudan simulator causal support bulurken default Dream yolu `unknown / CAUSAL_SIMULATION_FAILED` üretiyor. Inject edilen constructor kullanılan testler bu yolu kaçırmış. Dar düzeltme ayrı dalda ele alınmıştır; yerel doğrulama ile GitHub'a teslim edilmiş değişiklik ayrıdır.
10. PDF'deki opt-in Dream tanımı güncel AgentV3 için eski: loop default-on ve explicitly disableable; ürün capability/budget sınırları sürüyor. `lib/experience/capability-trust.js:9` yorumu registry yokmuş gibi eski; gerçek eksik production binding'dir. Bunlar kaynak iddiası düzeltmeleridir; bu dar fix'in kod kapsamı genişletilmedi.

## İlk altı iş ve bağımlılıkları

| Sıra | Paket | Somut teslim | Başarı / red ölçütü | Bağımlılık |
|---|---|---|---|---|
| 1 | V0.1 — Cognitive Lab manifest + B1 baseline | Hash/commit damgalı deney manifesti, mevcut belief revision baseline, baseline-vs-baseline runner, fail-closed evaluator | Tekrar aynı sonuç; split overlap/budget breach/missing outcome/authority bypass ölçümünü kandıramaz; B2–B8 NOT_MEASURED | Default Dream hata düzeltmesi B2/Dream deneyi öncesi; B1 başlamasını engellemez |
| 2 | V0.2 — Outcome eşleşmesi ve kalibrasyon | Gözlem öncesi explicit prediction p, attempt/eligible/observed/censored sayımları, paired ölçümler ve rapor | Brier/ECE ancak uygun p/outcome çiftiyle; yanlış yüksek p kötüleşir; outcome yoksa INSUFFICIENT | V0.1 |
| 3 | I0 — Evidence independence / revision | Mevcut posterior ve provenance'a destek/counter/duplicate-source/invalidation karakterizasyonu ve dar aday | Kopya evidence bağımsız trial sayılmaz; contradiction/support removal downgrade eder; B1 ablation'da kazanç ve integrity | V0.1 + V0.2 |
| 4 | I2 — Qualification → registry wiring | Mevcut compiler/qualification/registry/trust seam'inin tek opt-in gerçek caller üzerinden bağlanması | Başarısız/unknown qualification aktif procedure olamaz; replay/restart/idempotency; B4 held-out transfer | V0.1 + V0.2/W2 outcome/coverage sözleşmesi; W1 sealed read-back; W4 binding/invalidation guard. I1 scheduler önkoşul değil |
| 5 | I1 — Bounded Cognitive Scheduler | Mevcut Dream/inference işlerini goal/risk/urgency/cost ile sınırlı sıraya koyan aday | Aynı bütçede başarı/maliyet kazanımı; fairness/stop reason; priority ablation; B6 | V0.1; measured cost tanımı; I0 bilgi kazancı kullanılacaksa |
| 6 | L0/L1 — Dil baseline ve Semantic IR | Mevcut parserları koruyan adapters, versioned IR ve EN/TR canonical fixtures | Eş anlamlı çiftlerde core parity; negation/modality/ambiguity korunur; doğal dil authority yaratamaz | Baseline hemen; semantic-to-action entegrasyonu kendi sonraki kapısında |

Bir işin tamamlanması sonraki bütün paketlerin otomatik onayı değildir. Her implementation PR tek amacı, kırmızı karakterizasyonu, bağımsız review'u ve fresh CI'ı taşımalıdır. İlk görev [Cognitive Lab giriş görev paketinde](../task-packs/cognitive-lab-entry-20261001.md) ayrıntılıdır.

I2 için kanonik dependency yukarıdaki satırdır: activation'a girişten önce sealed read-back, paired outcome/coverage ve dependency invalidation doğrulanır. Bunlar mevcut primitive'lerin tek dar caller kapsamında acceptance'ıdır; I0/I1 yeni engine'lerinin tamamlanmasını bekleme zorunluluğu değildir. Scheduler veya yeni belief engine bu korumaların yerine geçmez.

## Tam program — kapsam korunur

| Track | Kapsam | Sonraki gate |
|---|---|---|
| V — Cognitive Lab | B1 belief; B2 causal; B3 inverse planning; B4 procedure; B5 rollout; B6 scheduler; B7 model dependency; B8 self-improvement safety | Her mekanizma baseline/candidate + holdout/transfer + ablation + integrity; longitudinal 10/100/1.000/10.000 |
| L0 | Language Phase 0–2: baseline, morphology/lexical adapters, syntax/negation scope | EN/TR karakterizasyonu |
| L1 | Phase 3–6: Common Semantic IR, intent/slots/clarification, contextual grounding, semantic reasoning | 10 IR alanı, çözülemeyen reference/ambiguity açık |
| L2 | Phase 7–9: candidate Action IR, verification/policy/execution, yeni diller | Yetkilendirilmiş execution envelope; unsafe/unknown plan fail-closed |
| I0 | Evidence-valued belief state; independence, counter-evidence, observed/inferred/reported | B1 gain + no trust regression |
| I1 | Cognitive scheduling; goal, epistemic/pragmatic value, cost/risk/fairness | B6 eşit bütçe deneyi |
| I2 | Experience → candidate → compiler → qualification → registry production wiring | B4 observed outcome ve caller; W1/W2/W4 guards, V0.1/V0.2 |
| I3 | Learned causal engine; forward/inverse/failure models, controls, support invalidation | B2/B3 unseen prediction ve false-causal-rule rate |
| I4 | Symbolic World Model Level 0 traversal → Level 1 transitions → Level 2 multistep rollout/compare/explain | B5; en az iki plan; unknown/support/rejected alternatives görünür |
| I5 | Reflective rule/model/procedure learning; canary/rollback/promotion | B4/B8; self-modification self-authorization değildir |
| I6 | Model-agnostic local neural cognition: RWKV/Mamba/small Transformer/SSM | B7 kalite/bütçe/locality; output candidate, authority değil |
| I7 | Monty/reference frames, sensors/world-state/latent JEPA grounding | Önce P0/P1 mekanizmaları ölçülür; bağlam dışı transfer ve stale support kontrolü |
| K0/K1 | KnowledgeObject Fact/Rule/Procedure/Policy/Capability/Model/Hypothesis; CognitiveMessage ve reference frames | Mevcut şemalarla reuse analizi; normal learning policy/capability authority'sini değiştiremez |
| M | Pasted 12 alan + PDF 13 matematik başlığı ve ek calculus/crypto/Dream/random walk | Dosya → fonksiyon → denklem → örnek → egzersiz → davranış kanıtı; müfredat ayrı, shipped feature ayrı |
| X | Receipt/approval/authority/replay/restart/identity/MCP/A2A conformance | Her gerçek ingress ayrı test; external interoperability source-only testten türetilmez |
| R | Active Inference, Soar, ACT-R, neuro-symbolic/program synthesis; liquid/HTM araştırma kaydı | Sınırlı blind-spot taraması → prototype → benchmark → keep/reject |

PDF'deki P0 belief/scheduler/procedure önceliği, seçilen ölçüm kapısından sonra korunur. Neural veya sensorimotor araştırma ilk dört mekanizmanın ölçülmesini geciktirmemeli. Pasted RL, online learning, concept drift ve optimization alanları ayrı izlenir; posterior update full online learner, decay drift detector, reward policy authority değildir.

## Ölçüm sözleşmesi için tamamlanması gerekenler

Deney başlamadan fixture/split/hash, primer metrik, yön, anlamlı etki eşiği, uncertainty yöntemi, örnek yeterliliği, tekrar/seed, eşit bütçe ve kill criteria kilitlenir. PDF'deki 100 experience / 20 unseen tasks pilot örneğidir; tek başına üretim gain kanıtı değildir. Temsili başarı eşiği için rastgele yüzde icat edilmez.

Gain, integrity ve deployment üç ayrı sonuçtur. Her raporda derivation/learning/prediction/planning/calibration/transfer/autonomy/efficiency/epistemic integrity alanları bulunur. Ölçülmeyen `NOT_MEASURED`; yetersiz veya geçersiz veri `INSUFFICIENT`; güvenlik regresyonu `REJECT` olarak kalır. Unsafe candidate önerisi sayımı ile gerçekten policy bypass olup state değişmesi ayrı tutulur.

Kalibrasyon tasarımı için [Guo vd., ICML 2017](https://proceedings.mlr.press/v70/guo17a.html), küçük örneklemde ölçüm belirsizliği için [Agarwal vd., NeurIPS 2021](https://papers.neurips.cc/paper_files/paper/2021/hash/f514cec81cb148559cf475e7426eed5e-Abstract.html) ve [rliable kaynak uygulaması](https://github.com/google-research/rliable) incelendi. Bunlardan türetilen HUQAN önerisi: paired baseline/candidate karşılaştırması, uncertainty raporu ve evaluator negatif testleri; herhangi bir kütüphaneyi kurma veya model eğitme kararı verilmedi.

## Açık issue'ların düzenlenmesi

[50/50 açık issue denetimi](open-issue-audit-20261001.md) her radar önerisini W1–W10 paketlerine ve ana track'lere eşler. Dış repo mekanizması HUQAN bug kanıtı değildir. Mevcut hash/idempotency/consolidation/calibration/SSRF yüzeyleri yeniden geliştirilmeden önce caller ve negatif testle karşılaştırılır. Araştırma issue'ları otomatik kapanmaz, birleşmez veya silinmez.

Plan GitHub'da [ana takip #3306](https://github.com/ali-ulu/huqan/issues/3306) ve ilk altı dar uygulama issue'su olarak yayınlandı. Ana issue gelecekteki I3/I4/I5/I6/I7/K/M/X/R kapsamını da checklist olarak taşır. Depo belgelerinin bu dalda yerel olması GitHub main'e merge edilmiş olmaları anlamına gelmez.

| Paket | GitHub issue | Teslim |
|---|---|---|
| V0.1 | [#3307](https://github.com/ali-ulu/huqan/issues/3307) | Cognitive Lab: strict deney manifesti, B1 baseline ve fail-closed gain evaluator |
| V0.2 | [#3308](https://github.com/ali-ulu/huqan/issues/3308) | Cognitive Lab: karar öncesi olasılık–gözlenen sonuç eşleşmesi ve kalibrasyon ölçümü |
| I0 | [#3309](https://github.com/ali-ulu/huqan/issues/3309) | Belief revision: bağımsız destek, karşı kanıt ve support invalidation için B1 deneyi |
| I2 | [#3310](https://github.com/ali-ulu/huqan/issues/3310) | Procedure learning: qualification→registry için tek opt-in production caller ve B4 transfer kapısı |
| I1 | [#3311](https://github.com/ali-ulu/huqan/issues/3311) | Cognitive Scheduler: aynı bütçede Dream/inference aday sıralaması ve B6 ablation |
| L0/L1 | [#3312](https://github.com/ali-ulu/huqan/issues/3312) | Language baseline: mevcut EN/TR parser adapters ve read-only Common Semantic IR sözleşmesi |

Başlangıçtaki 50 issue korundu; bu program 7 yeni açık issue ekledi. Yayın doğrulaması ve başlangıç snapshot metaverisi `development-plan-20261001-evidence.json` içinde saklanır. Planın bağımsız review'u iki MEDIUM scope/dependency bulgusunun düzeltilmesinden sonra APPROVE verdi. V0.1 baseline ile evaluator başarısını, I2 canonical dependencies bütün belgelerde aynı şekilde ayırır.

## Çalıştırılan kontroller

| Kontrol | Fresh sonuç |
|---|---|
| `npm ci --ignore-scripts=false --no-audit --no-fund` | PASS; 124 package; lockfile değişmedi |
| `node scripts/agent-context.js` | PASS, fresh HEAD/originMain ve temiz çalışma kopyası |
| Architecture tracker `--check --base-ref=83000331...` | PASS; live snapshot eşleşti |
| `check:docs-drift`, `check:doc-status` | PASS |
| `check:cycles` | PASS; 1.231 dosya, 0 cycle |
| `check:module-boundary` | PASS; 855 domain + 223 platform owners; 276 ports; 16 legacy edges; 0 unmapped |
| `check:layers` | PASS; 3 kayıtlı exception |
| `check:package-closure` | PASS; 978 modül, 46 published entry point |
| `check:file-size` | PASS; 0 known over 400, none grew |
| Inference/runtime/belief/trust calibration/experience/reachability, 6 test dosyası | 56 test PASS; fail/skip 0 |
| Dil/parser/semantic, 7 test dosyası | 81 test PASS; fail/skip 0 |
| Matematik/CLI/verify, 9 test dosyası | 88 test PASS; fail/skip 0 |
| Ayrı Dream düzeltmesi: 8 ilgili test dosyası + reachability/baseline | 35 + 23 test PASS; eski import yeni iki testi kırmızı yaptı |
| Dream bağımsız review / mutation | İki review PASS; ayrı ayrı 9/9 test; eski import bellek mutasyonu red; hedef lint temiz |

Ayrı Dream düzeltmesi ilk denetimde yalnız `lib/dream-experiment-loop-verify.js` ve `test/dream-experiment-loop.test.js` değiştirdi. `graphify update .` exit0 ile ignored grafiği güncelledi; SQL parser eksikliği ve zero-node metadata graph kapsamının sınırıdır. Source gates ve `git diff --check` PASS. Bu oturumda commit/push/PR/merge yapılmadı. Sonraki canlı main'de aynı import düzeltmesi #3313 ile zaten merge edilmiş; tekrar yayınlanmayacak.

Windows sandbox içinde bazı Git subprocess/test child spawn çağrıları `EPERM` verdi; aynı komutlar izinli ortamda tekrar koşuldu. Bunlar ürün assertion başarısızlığıyla bir tutulmadı; son sonuçlar izinli koşumlardır.

Canlı main SHA için [API Contract](https://github.com/ali-ulu/huqan/actions/runs/36914406502) ve [Benchmark Regression](https://github.com/ali-ulu/huqan/actions/runs/36914406342) SUCCESS. Ancak bu doküman commit'inde `npm test (runtime/test)` logu **NOT_APPLICABLE / no tests selected** diyor. Son runtime-changing `fafc3de5` için [seçilmiş shard CI](https://github.com/ali-ulu/huqan/actions/runs/36911063836) SUCCESS; bu da bütün test dosyalarının fresh full-suite çalışması değildir.

DOĞRULANMADI: Cognitive Lab gain, learned world model, scheduler superiority, tam procedure activation zinciri, external deployment/interoperability, full local `npm test`, release/registry yayını. LEVH araçları bu oturumda erişilebilir değildi; ortak hafızaya yazım yapılmadı.

## İki dakikalık göz testi ve sonraki ajan zarfı

Ana takip issue'sunda ilk altı işi ve B1–B8 durumlarını aç; ölçüm öncesi hiçbirinin gain PASS olmaması gerekir. Yerel belgelerde açık issue matrisindeki 50 satırı ve kaynak matrisindeki Phase 0–9 / pasted 12 alanı gör. Ayrı Dream düzeltme worktree'sinde regression komutunu koş; default gerçek simulator testi ve no-chain unknown testi birlikte geçmelidir.

```powershell
git -C C:\Users\sonfi\Desktop\huqan-main\.worktrees\development-plan-20261001 status --short
git -C C:\Users\sonfi\Desktop\huqan-main\.worktrees\dream-default-causal-20261001 diff --stat
```

İlk denetimin komutları dört plan belgesi ve kanıt JSON'u / iki Dream dosyasını gösteriyordu. Güncel teslimde ek engineering pack/evidence ve canon/scale-truth doküman değişimleri bulunur; CI routing ve classifier batch ayrı dallardadır. Güncel tam scope/check kaydı `engineering-foundation-20261002-evidence.json` içindedir. Başka dosya görünürse teslim kaydıyla karşılaştır.

```text
[BAĞLAM] ali-ulu/huqan, package 0.12.0; öncelik ölçülebilir reasoning/learning.
[GÖREV] V0.1 Cognitive Lab manifest/evaluator ve mevcut B1 baseline; yeni cognition engine yok.
[KABUL] Baseline replay aynı; overlap/budget/missing outcome/authority bypass negatifleri reject; B2–B8 NOT_MEASURED; ilgili test ve mimari kapıları fresh PASS.
[YASAK] Policy/receipt/wire/schema/release değişikliği; otomatik procedure activation; holdout contamination; yetki genişletme.
[SÜRÜM] Plan tabanı 83000331c07e4c9bb592dfc75b12851d3aa3ee8a; işe başlarken canlı origin/main yeniden fetch edilir.
```
