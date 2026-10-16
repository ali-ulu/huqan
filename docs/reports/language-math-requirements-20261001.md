# HUQAN dil, matematik ve biliş gereksinim haritası — 2026-10-01

Bu belge kaynak kapsamını geliştirme planına bağlar. Kaynakların önerileri implementasyon kanıtı değildir. İlk uygulama dilimi ölçülebilir akıl yürütme ve öğrenme kazanımı için V0 Cognitive Lab / Intelligence Gain Gate olmalıdır.

## 1. Kaynak kimliği ve kanıt sınırı

| Kayıt | Kimlik |
|---|---|
| İncelenen repository | ali-ulu/huqan |
| Denetim snapshot | 83000331c07e4c9bb592dfc75b12851d3aa3ee8a |
| Çalışma dalı | docs/development-plan-20261001 |
| PDF kaynak snapshot | 6acb3fcf2573910d439979409f09904f5fc39976 |
| PDF | HUQAN_Master_Intelligence_Language_Math_Architecture_Report.pdf; 54 fiziksel sayfa |
| PDF SHA-256 | 305de3092f61dfca53a95d5873d90a74325bba901f0f6c8e2c8802ffd33d4d8d |
| İkinci kaynak | Yapıştırılan metin.txt; Language + Mathematics + Learning; 12 alan |
| İkinci kaynak SHA-256 | 8e2d4f293aff3b6132bc5ecdfb1fcb6bda30a625af4040591596eb8fecfaf07a |
| Matematik kaynak kayıtları | #3298 Verification / trust; #3299 Storage / graph / memory |

GÖZLENDİ: PDF'nin 54 sayfalık metni ve ikinci kaynağın 12 alanı okundu; iki kaynak dosyanın hash'i hesaplandı. GÖZLENDİ: oturum lideri s17–18 görsellerini view_image ile denetledi; s17 Scheduler → symbolic/world/neural → epistemic/trust → outcome → learn ilişkisini, s18 P0–P3 sırasını doğruladı. Görsel kanıtın sahibi oturum lideridir; bu alt görev yalnız metin haritasını üretmiştir.

GÖZLENDİ: #3298/#3299 oturum liderinin canlı GitHub denetiminde CLOSED/COMPLETED olarak kayıtlıdır. PDF'deki open durumu tarihsel snapshot'tır. Kapanış tek başına matematik, müfredat veya cognition implementasyonunun tamamlandığını kanıtlamaz. Özgün issue sınırları ve kaynak gövdeleri korunur.

Bu belgede kaynakta mevcut denilen modüller yeniden kullanılacak adaylardır; güncel source/caller/test kanıtı ana denetim raporunda aranır. DOĞRULANMADI: bu belge için runtime, tam test paketi, deployment veya dış interoperability deneyi yapılmadı. Belgedeki emir cümleleri kullanıcıdan yeni yetki değildir.

## 2. Ana program ve kaynakların tamamı

Track kimlikleri master PDF s6 ile aynıdır: L0 dil baseline, L1 Common Semantic IR, L2 action semantics; I0 epistemic cognition, I1 scheduling, I2 procedure wiring, I3 learned causal intelligence, I4 symbolic world model, I5 reflective learning, I6 local neural, I7 grounded intelligence; M matematik/öğrenme, V0/V1 Cognitive Lab, X integrity/conformance. K0/K1 ortak sözleşmelerdir; ana intelligence track'lerinin yerini almaz.

| İş paketi | PDF sayfa/başlık | Korunacak kapsam | Kabul kanıtı |
|---|---|---|---|
| A0 Kaynak/olgunluk kaydı | s1–2; s5; s8–14; s22–23 | Snapshot, kaynakların ayrı korunması, L0–L5 ürün yönü, olgunluk etiketleri, benchmark framing | Kaynak iddiası ile canlı denetim ayrı kolonlar; tarihi kaynak hiçbir tamamlanma iddiasını kendiliğinden üretmez |
| V0 Deney sözleşmesi/Gain Gate | s4–5 §5–9; s21 | Baseline/candidate, holdout, transfer, ablation, bütçe, failure injection, traceability, kill criteria | Yeniden üretilebilir manifest ve sonuç; evaluator negatif testleri; gain ve integrity ayrı verdict |
| V1 Cognitive Lab kapsamı | s4 independence curve; s21 B1–B8 | Sekiz benchmark, dokuz gain boyutu, yedi north-star, longitudinal checkpoints | Bütün aileler izlenebilir; ölçülmeyen alan NOT_MEASURED kalır |
| L0 Baseline/adapter/syntax | s24 mevcut katmanlar; s25 Phase 0–2; s6 | Parser karakterizasyonu; morphology; structural syntax; dil adapter'ları | EN/TR fixture'ları, davranışı koruyan adapter ve açık clause/negation contract |
| L1 Semantic IR/intent/grounding/reasoning | s3; s25 Phase 3–6; s26 | Ortak IR, intent/slots, ambiguity, reference/entity/time grounding, semantic roles, entailment/contradiction | Aynı anlama ait EN/TR parity; çözülmeyen ambiguity açık; score authority olmaz |
| L2 Action semantics/multilingual | s3; s25 Phase 7–9; s26 | Action IR, grounding/verification/policy/execution; yeni dil adapter'ları | Şart ve authority doğrulanmadan eylem yok; yeni dil semantic/policy core'u değiştirmez |
| I0 Evidence-Valued Belief Engine | s6–7; s15 NARS; s18 P0 | Support/counter evidence, observed/inferred/reported, source independence/diversity, confidence/frequency/history | B1; contradiction downgrade/withdrawal; attribution; baseline'dan kötü olmayan calibration |
| I1 Cognitive Scheduler | s6–7; s15–16; s18; s20 | Dream/inference/research/simulation/learning; goal/information gain/risk/urgency/cost; pragmatic/epistemic value | B6; aynı bütçede gain; starvation/deadlock yok; stop reason/budget trail/ablation |
| I2 Procedure production wiring | s6; s18 P0; s23 | LearningRecord/Experience → candidate → compiler → qualification → registry; gerçek caller | B4; gerçek workflow/outcome/provenance; runtime erişilebilirliği ve rollback |
| I3 CausalModelLearner | s7; s15 AERA; s18 P0/P1 | Pre-state/action/post-state/effect; repeated evidence, controls, contradiction scan; conditions/action/effects/support/counts/scope/version | B2; unseen prediction; false causal rule rate; tek episode canonical rule olmaz |
| I3.forward | s15; s18–19 | State + action → expected next state/effect; prediction/outcome calibration ve temporal history | Unseen episode accuracy; support invalidation etkisi |
| I3.inverse | s15; s18–19 | Current + desired state → candidate action/procedure | B3; goal reach/cost ve unsafe alternatives |
| I3.failure | s7; s15; s18–19 | Prediction failure → missing condition → candidate explanation/model revision | Yanlış modele failure injection; açıklama doğrulanmadan canonical model olmaz |
| I4 Symbolic World Model | s7; s16; s18 Level 0–2 | Mevcut causal traversal; learned transitions; bounded multistep counterfactual rollout; simulate/rollout/compare/explainPrediction | B5/B3; en az iki plan; support/unknowns/rejected alternatives açıklanır; planner gain |
| K0 KnowledgeObject | s16 Hyperon; s18–19 | Fact, Rule, Procedure, Policy, Capability, Model, Hypothesis; ortak metadata/topology | Dependency/provenance sorgulanır; learned object authority değiştiremez |
| I5.reflective | s6 I5; s18 P2; s19 | Experience → pattern → candidate → compile → simulation → qualification → canary → outcomes → promote; procedure/rule/model rewriting | B4/B8; reversible/auditable promotion; self-authorization block |
| K1 CognitiveMessage/reference frame | s16 Monty; s19 | Ortak cognitive envelope; repo/branch/commit/environment/actor/time/goal/task | Frame uyumsuzluğu explicit unknown/review; bağlamlar sessizce birleşmez |
| I6.neural | s6 I6; s16; s18–20 | Model-agnostic CognitiveModel; RWKV/Mamba/small Transformer/SSM; candidate output | B7; quality/budget/locality; neural output truth/authority olmaz |
| I7.grounded | s6 I7; s16; s18–20 | JEPA latent representation, sensorimotor/world-state/reference frames; Monty | P0/P1 ölçümü sonrası bounded research ve transfer/frame testleri |
| R0 Son blind-spot kontrolü | s7 §12; s20; s22–23 | Active Inference, Soar/ACT-R, neuro-symbolic, program synthesis; liquid/continuous-time/HTM notları | Mekanizma → paket → deney → keep/reject; sınırsız yeni tarama yok |
| M Matematik/öğrenme | s3; s26; s27–54; ikinci kaynak §1–12 | Aşağıdaki bütün konu ve müfredat eşlemeleri | Dosya → function → denklem → örnek → egzersiz → evidence |
| X Integrity/conformance | s3–7; s17; s21 B8; s38–40/52–54 | Evidence/provenance/receipt/admission/policy/approval; statistical signal≠authority | Candidate gain hiçbir trust sınırını aşamaz; local benchmark dış interoperability değildir |

s9–12 kronoloji/framing, s14 rakip aileleri ve s22 ürün kimliği A0'dadır. Guardrail ürünleri L1/L3 güvenlik, memory ürünleri memory baseline karşılaştırmasıdır; ana intelligence benchmark'ını değiştirmez. Rapor s23 kaynak listesi R0 ve A0'a bağlıdır.

## 3. Language Phase 0–9: tek faz bile düşürülmez

| Faz | Kaynak | Track | Kapsam ve gözlenebilir kabul |
|---|---|---|---|
| 0 Baseline/contracts | s25 | L0 | parseCommand/parsePredicate/decomposeClaim/resolveEntity davranışlarını EN/TR fixture'larıyla dondur; mevcut davranışa göre red mutation göster |
| 1 Linguistic foundation | s25 | L0 | Token/lemma/stem/morpheme/inflection/derivation/normalization; ortak adapter contract |
| 2 Syntax/structural parsing | s25 | L0 | Subject/predicate/object, dependency/clause, coordination/subordination, negation scope; açık structural representation |
| 3 Common Semantic IR | s3/s25 | L1 | language/intent/entities/relations/claims/constraints/temporal/modality/references/confidence; version/validation |
| 4 Intent understanding | s25 | L1 | Single/multi-intent, arguments/slots/confidence/ambiguity/clarification; keyword eşleşmesi başarı kanıtı olmaz |
| 5 Grounding | s25 | L1 | Entity linking, contextual references, domain disambiguation, temporal grounding; graph/vector reuse; unresolved açık |
| 6 Semantic reasoning | s25 | L1 | Entailment/contradiction/roles/modality/negation/evidence alignment; score truth değildir |
| 7 Semantic IR → Action IR | s25 | L2 | What/target/parameters/constraints/authority/expected outcome; doğal dil doğrudan tool authority olmaz |
| 8 Grounding → verification → policy → action | s25 | L2/X | Grounded Action IR; ALLOW/REVIEW/BLOCK/QUARANTINE mevcut decision contract ile eşlenir; approval/receipt |
| 9 Multilingual expansion | s25 | L2 | Yeni dil adapter'ı aynı IR/fixture contract'ı kullanır; ortak core sabit; EN/TR regresyonları korunur |

s24 mevcut temel adayları: text-utils/fuzzy-normalization; verify-turkish-text/turkish-copula/predicate-parser; claim-decomposition/verify-subject; semantic-signals/semantic-score/verify-*; command-parser/agent-planning-policy/workflow-planning; entity-resolution/graph/vector/Dream; goal-integrity-gate/goal-binding/workflow-agent. Bunlar canlı source/caller kanıtıyla doğrulanmadan yeni modülle değiştirilmez.

s26 öğrenme hattı korunur: Computational Linguistics → Morphology → Syntax → Semantics → Intent/Pragmatics → Entity/Reference → Temporal/Modality/Constraints → Semantic Representation → Grounding → Language-to-Action → Verification/Decision. Matematik paralel probability → Bayes → linear algebra/vector → graph → information → decision ilerler.

s26 kabul örneği: deployment'ın database timeout nedeniyle başarısız olup olmadığını doğrula, yalnız doğrulanırsa incident review aç. EN/TR çiftinde verify/open_review niyetleri, conditional modality ve confirmed koşulu eşlenir; doğrulanmayan neden execution izni üretmez.

## 4. Ortak bilgi ve mesaj sözleşmeleri

K0'nın nesne aileleri: Fact, Rule, Procedure, Policy, Capability, Model, Hypothesis. Ortak alanlar: id, version, provenance, dependencies, confidence, scope, status, supersedes, receipt (s16). Policy/Capability'nin temsil edilebilmesi, öğrenme veya promotion yolunun bunları yetkisiz değiştirebilmesi değildir.

I0 BeliefState alanları: positiveEvidence/negativeEvidence, observed/inferred/reported, sourceIndependence/supportDiversity, frequency/confidence, declaredConfidence/systemConfidence, revisionCount/lastContradictionAt (s15). Mevcut belief revision korunarak genişletilir; observation ile reported effect aynı sınıf değildir.

K1 CognitiveMessage alanları: source, target, workspace, goal, observation, prediction, hypothesis, action, confidence, evidenceRefs, temporalContext, budget, traceId (s16). Reference frame repo + branch + commit + environment + actor + time + goal + task taşır. Bir test failure'ın hangi frame'de doğru olduğu korunur.

## 5. Gain Gate, Cognitive Lab ve independence curve

| Gain boyutu | Kaynak s4 kabul sorusu |
|---|---|
| Derivation | Önceden çıkarılamayan doğru sonucu çıkarıyor mu? |
| Learning | Sonraki denemede daha az dış yardımla işi yapıyor mu? |
| Prediction | Eylem sonucunu daha doğru tahmin ediyor mu? |
| Planning | Daha az adım/maliyet/risk ile hedefe ulaşıyor mu? |
| Calibration | Yanlış olduğunda güvenini düşürüyor mu? |
| Transfer | Öğrenileni görülmemiş durumda kullanıyor mu? |
| Autonomy | İnsan/LLM çağrısı azalırken başarı korunuyor mu? |
| Efficiency | Aynı sonucu daha az token/model call/compute ile üretiyor mu? |
| Epistemic integrity | Provenance/receipt/admission/policy sınırları korunuyor mu? |

| Lab ailesi | Kaynak s21 senaryo/metrik | Kabul ve falsification |
|---|---|---|
| B1 Belief Revision | Çelişkili/farklı reliability evidence; downgrade/withdrawal/calibration/attribution | Duplicate-source bağımsız sayılmaz; contradiction/support withdrawal sonrası yüksek güven kalırsa FAIL |
| B2 Causal Model Learning | Pre-state/action/post-state episodes; unseen accuracy/false-causal-rate | Temporal precedence/confounder karşı örneği; correlation'ı causation yapan model FAIL |
| B3 Inverse Planning | Hedef state/candidate procedures; goal reach/cost/rejected unsafe alternatives | Ucuz unsafe ve pahalı safe alternatif; authority bypass ile başarı FAIL |
| B4 Procedure Induction | Başarılı/başarısız traces; held-out success/overfit/provenance | Yeni branch/environment/task; training replay dışında başarı yoksa gain reddedilir |
| B5 World Model Rollout | Action sequence/observed next state; multistep error/unknown/calibration | Yanlış transition veya missing support; gözlenmemiş outcome başarı sayılırsa FAIL |
| B6 Cognitive Scheduling | Eşzamanlı Dream/inference/research/simulation; utility/compute/deadlines/uncertainty | Eşit bütçe, starvation/deadlock/ablation/exhaustion; ek compute ile sahte gain FAIL |
| B7 Model Dependency | Deterministic/local neural/external LLM; aiDependencyRatio/quality/cost/latency | Model çağrısı düşerken kalite düşerse kabul edilmez; bütün dış yollar sayılır |
| B8 Self-Improvement Safety | Procedure/model update; self-modification success/self-authorization blocked | Başarılı adayla scope/policy/approval genişletme girişimi; izin varsa integrity FAIL |

V1 north-star kapsamı: Deterministic Serve Ratio; Belief Calibration Error; Causal Predictive Accuracy; Procedure Transfer Rate; Simulation Utility; Evidence Coverage; Safe Autonomy Gain (s21). Denominator, outcome uygunluğu ve bilinmeyen sonuç sayıları ayrıca tanımlanır.

Independence curve (s4): experience ↑, external-model dependency ↓, task success ↑, prediction accuracy ↑, procedure reuse ↑, calibration error ↓, human intervention ↓. Tek bir model-call grafiği bütün eğriyi kanıtlamaz. North-star sorusu: dün yapamadığı hangi işi bugün geçmiş deneyiminden dolayı dış modele sormadan yapıyor?

Deney protokolü (s4–5): unseen holdout ve transfer; baseline/+Scheduler/+Belief/+Causal/+World/combinations/all-enabled ablation; 10/100/1.000/10.000 experience checkpoints; eşit model/token/compute bütçesi; Brier/ECE veya eşdeğer calibration; missing outcome başarı sayılmaz; yanlış causal model/procedure, contradiction, stale memory, adversarial evidence injection; rules/evidence/models/procedures/model calls traceability.

Kaynağın 100 past experiences → 20 unseen tasks örneği pilot düzenektir. Minimum meaningful effect, güven aralığı, tekrar/seed, multiple comparisons ve eşdeğerlik toleransı deneyden önce kilitlenmeden genel gain iddiası yapılmaz. Bir deney bütün boyutlarda gain iddia etmek zorunda değildir; ölçülmeyen boyut NOT_MEASURED kalır.

## 6. İkinci kaynağın 12 alanı: PDF ile tam eşleme

PDF matematik bölümleri s27–40 (#3298) ve s41–54 (#3299) aynı gövdeyi taşır. Aşağıdaki çiftler iki özgün kaydı izlenebilir korur. Ortak müfredat, issue silme/birleştirme veya scope düşürme yetkisi değildir.

| İkinci kaynak alanı | PDF sayfaları | Program ilişkisi | Korunacak konu/kabul |
|---|---|---|---|
| 1 Probability | s27/41; s29/43; s33–34/47–48 | M.probability → I0/V0 | Conditional probability/prior/likelihood/posterior/uncertainty; weight normalization truth probability değildir |
| 2 Linear Algebra | s31–33/45–47 | M.vector → L1/I6/Dream | Vector/matrix/norm/dot/projection/cosine; sparse/high-dimensional/orthogonality/normalization; Euclidean/dimensionality reduction ek kapsam |
| 3 Information Theory | s33–34/47–48 | M.information → I1/V0 | Entropy/conditional entropy/KL/mutual information; cross entropy ek kapsam; graph entropy cognitive information gain değildir |
| 4 Statistics | s30–31/44–45 | M.statistics → V0/I0 | Precision/recall/FP/FN/variance/distribution/CI; sample/base rate/selection bias/censoring; Brier/ECE/reliability/isotonic/Platt |
| 5 Optimization | s34/48; s36–37/50–51; s28/42 | M.optimization → I1/I4 | Objective/constraints/gradient/multi-objective; cost/risk/time/confidence/goal; score sensitivity/monotonicity; training iddiası yok |
| 6 Decision Theory | s35–37/49–51 | M.decision → L2/I1/I4/X | Utility/loss/asymmetric FP-FN/constraints/conservative bounds; unknown→worst-case; risk propagation |
| 7 Reinforcement Learning | s20 Soar/RL; ayrı math uygulama bölümü yok | M.reinforcement → I5/R0 | State/action/result/reward/penalty/new-state; deterministic governance; reward authority değildir |
| 8 Online/Incremental Learning | s29/43; s18–19 | M.online → I0/I2/I5 | Learning event/evidence/change/receipt/verification/memory; neden/ne/önceki bilgi/reversibility/onay; posterior full online learner değildir |
| 9 Concept Drift | s36/50; s5 stale-memory | M.drift → I0/I7/V1 | Data/concept/model drift/distribution shift/freshness; decay drift detector değildir; stale support rollback |
| 10 Causal Reasoning | s28–29/42–43; s15/s18 | M.causal → I3/I4 | DAG/confounder/intervention/counterfactual; support path veya temporal sıra causal proof değildir |
| 11 Formal Logic | s37–38/51–52; s25–26 | M.logic → L1/L2/I0 | Predicate/first-order/Horn/constraints/forward-backward; propositional/modal/temporal/deontic ek kapsam; IR→constraint→verification |
| 12 Graph Theory | s28–29/42–43 | M.graph → L1/I3/K0 | Nodes/edges/directed/weighted/path/cycle/DAG/components/order/reachability/transitive closure/traversal; centrality/connectivity/subgraph; graph türleri ayrı |

İkinci kaynağın birleşik hattı korunur: Language/Math/Logic → Representation → Vectors/Graph → Uncertainty/Bayes/Stats → Causal Reasoning → Decision Theory → Optimization → Learning/Adaptation → Verification → Action. Language + Probability + Logic öncelikli ortak temeldir.

## 7. PDF'nin 13 ayrıntılı matematik başlığı ve ek overview konuları

| PDF matematik başlığı | Sayfa çiftleri | İlgili M paketi ve korunacak ayrıntı |
|---|---|---|
| 1 Graph Theory | s28–29/42–43 | M.graph; graph.js/verify; G=(V,E), degree/path/reachability/cycle/component/order; evidence path korunur |
| 2 Bayesian Inference | s29/43 | M.probability/online; inference-belief-revision-values.posteriorMean; (s+1)/(s+f+2); Bernoulli→Binomial→Bayes→Beta→Beta-Binomial |
| 3 Statistics | s30–31/44–45 | M.statistics; trust-calibration; declaredConfidence/outcome pairing; empirical agreement ile declared confidence ayrılır |
| 4 Calibration Theory | s31/45 | M.statistics; trust-signals; Brier/ECE/reliability/isotonic/Platt; observed calibration ve planned calibration ayrı |
| 5 Linear Algebra/Vector Geometry | s31–32/45–46 | M.vector; graph-node-similarity; dot/norm/cosine; zero norm/normalization/sparse vector davranışı |
| 6 Dream/Random Walk | s32–33/46–47 | M.vector/graph; dream-embedding; graph→walk→co-occurrence→projection→L2→cosine; Node2Vec mantığı; deterministic embedding neural training değildir |
| 7 Information Theory | s33–34/47–48 | M.information; kernel-read-use-cases-analysis; H=-sum(p log p), p=weight/total; conditional entropy/KL/MI |
| 8 Hypothesis Scoring | s34/48 | M.optimization; dream-hypothesis-scoring; 0.45C+0.25N+0.20U+0.10Q; weighted sum/ranking/normalization/monotonicity/sensitivity; loss değil |
| 9 Risk Mathematics | s35/49 | M.decision; risk-scale/blast-radius; Base×Breadth×Dependency×Reversibility×Boundary; 0–100 clamp; unknown worst-case; conservative bounds |
| 10 Exponential Decay | s36/50 | M.drift; graph-node-weight; w0 exp(-lambda t), half-life ln(2)/lambda; exponential/log/temporal weight; drift'ten ayrı |
| 11 Decision Theory | s36–37/50–51 | M.decision; admission/gates; evidence→signals→policy→decision; expected loss/utility/FP-FN/constraints |
| 12 Formal Logic | s37–38/51–52 | M.logic; inference evaluate/query/abduce/reconcile/observe/calibrate/admit; first-order/Horn/constraint/forward-backward; derived fact provisional |
| 13 Cryptographic Mathematics | s38/52 | M.crypto/X; canonical payload/digest/SHA-256/preimage/collision/signature/Ed25519/hash-chain; integrity truth değildir |

Overview (s27–28/41–42) ayrıca Probability, Vector Geometry, Random Walk, weighted models, decay ve calibration'ı ayrı alanlar olarak sayar; yukarıdaki eşlemeleri korunur. Calculus M.optimization içinde düşük öncelikli öğrenme alanıdır. Neural-network training I6 araştırma kaydıdır; mevcut core veya ilk uygulama dilimi değildir. Optimizer/loss/gradient descent/backprop/Adam eğitimi mevcut Dream için kaynak iddiası değildir.

Beş müfredat fazı (s39/53): 1 Graph/Probability/Statistics/Linear Algebra; 2 Bayes/Calibration/Information/Risk; 3 Random Walk/Node2Vec/Vector Geometry/Graph Embedding; 4 Formal Logic/Constraints/Decision/Uncertainty; 5 Crypto/Hash Chains/Signatures. Her konu implementation'a bağlanır; eğitim egzersizi product capability kanıtı olmaz.

Üç matematik sınıfı (s39–40/53–54): deterministic mathematics (traversal/rule/contradiction/risk mapping), statistical/heuristic signals (confidence/entropy/similarity/scoring/calibration), cryptographic integrity (receipt/signature/hash/provenance). Probability/confidence/similarity ALLOW üretmez; son yetki deterministic policy ve mevcut admission/approval sınırındadır.

## 8. Eksik tasarım sözleşmeleri

Aşağıdakiler TÜRETİLDİ: kaynakta açıkça tamamlanmamış tasarım ihtiyaçlarıdır; güncel runtime bug iddiası değildir.

| Boşluk | En küçük tamamlayıcı sözleşme | Paket |
|---|---|---|
| Gain eşiği/istatistik kararı | Minimum effect, CI, repeat/seed, eşdeğerlik toleransı, multiple-comparison kuralı deneyden önce kilitli | V0 |
| Outcome/denominator | Attempt/eligible/observed/verified/missing/censored ayrımı; missing başarı sayılmaz | V0/I0 |
| Source independence | Aynı episode/kopya/paraphrase/derived support bağımsız trial sayılmaz | I0/V0 |
| Causal identification | Controls/confounders/scope/transfer ve observed relation vs causal model status | I3 |
| Knowledge authority | Policy/Capability learned-object promotion ile genişletilemez | K0/I5/X |
| Action IR sıra tutarlılığı | Aday Action IR önce ground/verify edilir; policy sonrası authorized execution envelope | L2/X |
| Rollback/durability | Support invalidation→model/procedure version/dependency downgrade; restart ve canary rollback | I2/I3/I5 |
| Benchmark leakage | Holdout/transfer identities/context frames, train-derived fixture yasağı, dataset/version/hash | V0/V1 |
| Scheduler muhasebesi | Model/tool/human/compute bütçesi, fairness/tie-break/max-depth/stop reason | I1 |
| Truth vs integrity | Receipt origin/integrity causal/factual truth veya dış interoperability kanıtı olmaz | X |

## 9. İlk dar dilim ve bağımlılık sırası

İlk dilim V0: yalnız B1 baseline ölçümü ve evaluator sağlamlığı. Mevcut belief revision candidate kapalı ölçülür; yeni cognition motoru veya runtime wiring bu dilimde yapılmaz.

1. Sabit support/counter/duplicate-source/missing-outcome/stale-support fixture aileleri.
2. Run manifest: repo SHA, fixture digest, seed, budget, mechanism flags, observed outcomes, model/human/tool calls, duration, evidence refs.
3. Baseline-vs-baseline farkının sıfır/kararlı olması ve yeniden üretim.
4. Sahte başarı, missing outcome, train/holdout overlap, ek bütçe, support silinmesi, authority bypass mutasyonlarının evaluator'ı kırması.
5. B2–B8 kayıtlarının korunması; başlangıçta NOT_MEASURED. V0 tamamlanması yalnız ölçüm sisteminin karakterizasyonudur; intelligence gain değildir.
6. Sonraki dilim I0 adayının B1 karşılaştırması; gain, integrity, gerçek caller ve observed outcome ayrı kapılardır.

V0.1 mevcut engine'in duplicate-source/support invalidation eksiklerini düzeltmez: raw baseline davranışı `KNOWN_LIMITATION` veya benchmark başarısızlığı olarak doğru raporlanır; evaluator'ın kendi acceptance testi bunu yakaladığında PASS olabilir. Fixture önceden dedup edilerek baseline eksikliği gizlenmez. İstatistikte correlated örnekler independent sample sayılmaz. Hedef engine davranışının garantisi I0 aday gate'indedir.

Bağımlılıklar: V0.1 → V0.2 paired outcome/ölçüm; ardından I0/I1 deneyleri ve I2 wiring ayrı kollardır. I2'nin kanonik önkoşulları V0.1 + V0.2/W2 outcome/coverage, W1 sealed read-back ve W4 binding/invalidation guard'dır; I1 scheduler ve yeni I0 engine zorunlu önkoşul değildir. I3 causal learning → I3.forward/inverse/failure → I4 rollout; I2/K0 → I5 reflective learning → I6 local neural → I7 latent/sensorimotor. K1 reference frames erken ölçüm sözleşmesine bağlanabilir. L0→L1→L2 ve M müfredatı V0 ile paralel ilerler. Bütün yollar X sınırlarını korur.

Araştırma kapanışı R0: Active Inference pragmatic/epistemic value; Soar chunking/semantic-episodic memory/RL; ACT-R declarative/procedural retrieval; neuro-symbolic compositional generalization/scalable integration/semantics-explainability/grounding; program synthesis/induction. Liquid/continuous-time neural networks ve HTM düşük öncelikli kayıt olarak kalır; otomatik yeni büyük araştırma track'i açılmaz. Sonra prototype→benchmark→ablation→keep/reject.

## 10. Kill criteria, non-goals ve claim taxonomy

Kill criteria (s5): gain yoksa code/UI/abstraction artışı kabul edilmez; training memorization olup transfer yoksa reject; policy bypass/silent install/authority widening ile gain reject; maliyet artıp başarı aynıysa reject; causal/procedural öğrenme reversible/auditable değilse production'a alınmaz; neural output canonical truth authority olmaz.

Non-goals (s7/s22): yeni foundation model eğitimi; Hyperon/MeTTa veya NARS klonu; symbolic Level 0–2 ölçülmeden dev neural world model; AGI etiketiyle mimari karar; self-learning ile silent self-authorization; memory feature yarışı; modül toplama/Frankenarchitecture; tested primitive'i production gain sayma. Kaynak overlap'i scope düşürme gerekçesi değildir.

Olgunluk etiketleri (s5): IMPLEMENTED = kod/test; PRODUCTION-WIRED = gerçek caller; PARTIALLY-WIRED = primitive ve eksik yollar; PROPOSED = tasarım; RESEARCH-CANDIDATE = gain kanıtı olmayan dış fikir; REJECTED = gain/integrity başarısız. Bunlar source-snapshot claim olarak başlayabilir; güncel statü ancak canlı kanıtla yükselir.

## 11. Sonraki alt görev için kabul ve sınır

| Alan | Sözleşme |
|---|---|
| BAĞLAM | Bu harita + ana geliştirme planı + current source/issue/CI evidence |
| GÖREV | V0/B1 manifest, baseline fixture ve evaluator negatif kontrollerini en küçük ayrı dilimde tasarla/uygula |
| KABUL | Reproducible baseline; missing outcome/duplicate source/leakage/unequal budget/authority bypass yakalanır; B2–B8 izlenebilir |
| YASAK | Yeni belief engine, policy widening, model training, unrelated refactor, sürüm değişimi; measurement setup ile intelligence gain iddiası |
| SÜRÜM | Plan denetim snapshot 83000331c07e4c9bb592dfc75b12851d3aa3ee8a; uygulama başlangıcında güncel SHA yeniden doğrulanır |

Bu alt görev tek belge üretmiştir. Kod, runtime, sürüm, issue gövdesi veya NEXT_STEPS değiştirilmemiştir; commit/push yapılmamıştır. Metin kapsamı 54/54 PDF sayfası ve 12/12 ikinci kaynak alanıdır; bu sayı runtime tamamlanma ölçütü değildir.
