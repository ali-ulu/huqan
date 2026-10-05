# HUQAN matematik müfredatı — dosya → fonksiyon → denklem → örnek → egzersiz → davranış kanıtı

Bu belge #3472 (roadmap R17) kabul kriterini karşılar: her matematik başlığı için
somut test/kanıt. Başlıklar `docs/reports/language-math-requirements-20261001.md`
§7'deki PDF'nin 13 ayrıntılı matematik başlığı ile issue kapsamındaki 12 alanın
birleşimidir.

**Kanıt sınırı.** Bu bir müfredat haritasıdır, yeni runtime özelliği değildir.
Her satırdaki "davranış kanıtı" güncel kaynakta gerçekten var olan bir modül ve
onu çalıştıran bir testtir; uygulanmamış bir yetenek vaadi değildir. Modüllerin
shipped feature olup olmadığı ayrıdır (bkz. #3298/#3299 notu: kapanış tek başına
matematik uygulamasını kanıtlamaz). Eğitim egzersizi product capability kanıtı
sayılmaz; satırdaki kanıt kaynak kodun kendi davranışıdır.

Müfredatı denetleyen yürütülebilir kanıt: `test/math-curriculum-evidence.test.js`.
Bu test, aşağıdaki her satırın dosyasının var olduğunu, fonksiyonun export
edildiğini ve denklemin sayısal davranışını doğrular.

## 1. PDF'nin 13 ayrıntılı matematik başlığı

| # | Başlık | Dosya | Fonksiyon | Denklem | Örnek (gerçek değer) | Egzersiz | Davranış kanıtı |
| ---: | --- | --- | --- | --- | --- | --- | --- |
| 1 | Graph Theory | `graph.js` | `Graph` `getEdges` / `getInEdges` | G=(V,E); derece, yol, erişilebilirlik, çevrim, bileşen | iki düğüm + iki kenar → 2 kenar | derece toplamı = 2·\|E\| | `test/kernel-read-use-cases-contract.test.js` |
| 2 | Bayesian Inference | `lib/inference-belief-revision-values.js` | `posteriorMean` | (s+1)/(s+f+2) | (1,1)→0.5; (3,1)→2/3 | Beta(1,1) prior; gözlem arttıkça MLE'ye yakınsama | `test/inference-belief-revision.test.js` |
| 3 | Statistics | `lib/trust-calibration.js` | `deriveCalibrationVerdict` | declared vs empirical uyum; örnek eşiği | yetersiz örnek → verdict insufficient | declared confidence ile outcome'u eşleştir; ayrımı koru | `test/trust-calibration.test.js` |
| 4 | Calibration Theory | `lib/cognitive-lab-probability-calibration.js` | `calibrate` | Brier=(1/N)Σ(p−y)²; ECE=Σ(n_b/N)·\|p̄_b−ȳ_b\| | 10 gözlem, p=0.9 → Brier 0.01, ECE 0.1, `assertsGain:false` | bin kenarını kaydır, Brier ile ECE'nin ters yönde hareketini gör | `test/cognitive-lab-probability-calibration.test.js` |
| 5 | Linear Algebra / Vector Geometry | `lib/graph-node-similarity.js` | `cosineSimilarity` | cos(a,b)=a·b/(‖a‖‖b‖) | (1,1)·(1,1)→1; (1,0)·(0,1)→0 | sıfır norm ve seyrek vektör davranışı | `test/graph-node-similarity-delegation-contract.test.js` |
| 6 | Dream / Random Walk | `lib/dream-embedding.js` | `biasedWalk` | node2vec bias: 1/p geri, 1 BFS, 1/q DFS | p=q=1 → yönsüz yürüyüş | p ve q'yu değiştir; BFS↔DFS eğilimini ölç | `test/dream-hypothesis-finders.test.js` |
| 7 | Information Theory | `lib/kernel-read-use-cases-analysis.js` | `entropy` | H=−Σ p·log p, p=weight/total | iki eşit kenar → ln 2 ≈ 0.6931; boş → 0 | ağırlıkları tek kenara yığ; H→0 gör | `test/kernel-read-use-cases-contract.test.js` |
| 8 | Hypothesis Scoring | `lib/dream-hypothesis-scoring.js` | `calculateCompositeScore` | 0.45C+0.25N+0.20U+0.10Q | ağırlık toplamı = 1.0 | tek terimi artır; skorun monoton arttığını gör | `test/dream-hypothesis-quality.test.js` |
| 9 | Risk Mathematics | `lib/blast-radius.js` | `computeBlastRadius` | Base×Breadth×Dependency×Reversibility×Boundary, 0–100 clamp | bilinmeyen boyut → `score:null`, `status:'unknown'` | kategori+boyut ver; skoru 0–100 aralığına kenetle | `test/blast-radius.test.js` |
| 10 | Exponential Decay | `lib/graph-node-weight.js` | `getWeight` | w=w₀·exp(−λt); yarı ömür t½=ln2/λ | λ=0.1, t=ln2/0.1 → 0.5 | t½'yi hesapla, ağırlığın yarıya indiğini doğrula | `test/graph-node-weight-delegation-contract.test.js` |
| 11 | Decision Theory | `lib/risk-policy-constants.js` | `ACTION_DECISIONS` / `RISK_BY_CATEGORY` | kanıt→sinyal→politika→karar; beklenen kayıp/FP-FN | karar kümesi {ALLOW,BLOCK,QUARANTINE,HUMAN_REVIEW} | aynı kategoriyi farklı flag ile sınıfla | `test/action-risk-classifier.test.js` |
| 12 | Formal Logic | `lib/inference-rule-ir.js` | `createRule` / `parseRule` | birinci-derece Horn; forward/backward chain | kural serileştir→parse→eşit | kural ekle/çıkar; türetilmiş olgunun provisional kaldığını gör | `test/inference-rule-ir.test.js` |
| 13 | Cryptographic Mathematics | `lib/content-hash.js` | `contentHash` | sha256(UTF-8); preimage/collision direnci | sha256("abc")=ba7816bf…15ad; boş→"" | içeriği değiştir; hash'in değiştiğini gör | `test/ingest-content-hash-pinning.test.js` |

## 2. Issue kapsamındaki 12 alan → başlık eşlemesi

| Kapsam alanı | Başlık # | Birincil modül |
| --- | ---: | --- |
| probability | 2 | `lib/inference-belief-revision-values.js` |
| linear algebra | 5 | `lib/graph-node-similarity.js` |
| information theory | 7 | `lib/kernel-read-use-cases-analysis.js` |
| statistics | 3, 4 | `lib/trust-calibration.js` |
| optimization | 8 | `lib/dream-hypothesis-scoring.js` |
| decision theory | 9, 11 | `lib/blast-radius.js`, `lib/risk-policy-constants.js` |
| RL | 8, 11 | `lib/cognitive-scheduler.js` |
| online learning | 2, 3 | `lib/trust-calibration.js` |
| concept drift | 10 | `lib/experience/optimization-hypothesis.js` |
| causal reasoning | 1, 12 | `lib/causal/index.js` |
| formal logic | 12 | `lib/inference-rule-ir.js`, `lib/inference-unification.js` |
| graph theory | 1, 6 | `graph.js`, `lib/graph-traversal.js` |

Ek kaynak çapaları (issue kapsamını genişletir, başlık numarası taşımaz):

| Alan | Modül | Fonksiyon | Davranış kanıtı |
| --- | --- | --- | --- |
| RL / planlama | `lib/cognitive-scheduler.js` | `scheduleCandidates` | `test/cognitive-scheduler.test.js` |
| concept drift / demotion | `lib/experience/capability-trust.js` | `deriveState` | `test/experience-capability-trust.test.js` |
| causal verdict | `lib/causal/index.js` | `scoreCausalVerdict` | `test/causal-verdict.test.js` |
| graph reachability | `lib/graph-traversal.js` | `findPath` / `detectCycle` | `test/graph-chain-traversal-budget.test.js` |
| evidence ladder | `docs/evidence-ladder.md` | (politika) | `test/evidence-ladder.test.js` |

## 3. Üç matematik sınıfı ve yetki sınırı

`docs/reports/language-math-requirements-20261001.md` §7 sınıflandırması korunur:

- **Deterministic mathematics** — traversal/kural/çelişki/risk eşlemesi (başlık 1, 11, 12).
- **Statistical/heuristic signals** — confidence/entropy/similarity/scoring/calibration (başlık 2, 3, 4, 5, 7, 8, 10).
- **Cryptographic integrity** — receipt/signature/hash/provenance (başlık 13).

Probability/confidence/similarity ALLOW üretmez; son yetki deterministic policy ve
mevcut admission/approval sınırındadır (`lib/risk-policy-constants.js`,
`lib/risk-classify.js`).

## 4. Beş müfredat fazı

1. Graph/Probability/Statistics/Linear Algebra → başlık 1, 2, 3, 5.
2. Bayes/Calibration/Information/Risk → başlık 2, 4, 7, 9.
3. Random Walk/Node2Vec/Vector Geometry/Graph Embedding → başlık 5, 6.
4. Formal Logic/Constraints/Decision/Uncertainty → başlık 11, 12.
5. Crypto/Hash Chains/Signatures → başlık 13.

## 5. Nasıl çalıştırılır

```bash
node --test test/math-curriculum-evidence.test.js
```

Test, bu belgedeki her satırın dosya/fonksiyonunu ve denklemin sayısal
davranışını doğrular; böylece belge ile kaynak arasındaki kayma yakalanır.
