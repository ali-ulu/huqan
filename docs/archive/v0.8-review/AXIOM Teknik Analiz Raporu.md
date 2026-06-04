# AXIOM Teknik Analiz Raporu

## 1. Giriş

Bu rapor, `agiulucom42-del/axiom` GitHub deposunda bulunan AXIOM projesinin teknik bir analizini sunmaktadır. AXIOM, bellek, modeller, araçlar, ajanlar ve kararlar için yerel öncelikli bir akıl yürütme katmanı olarak tanımlanmaktadır. Projenin temel amacı, Büyük Dil Modelleri (LLM) çıktılarının doğruluğunu ve güvenilirliğini artırmak, çelişkileri tespit etmek, doğal dilden öğrenmek ve kararların potansiyel etkilerini simüle etmektir. AXIOM, LLM'lerin akıcı yanıtlar üretme eğilimine karşılık, denetlenebilir akıl yürütme üzerine odaklanarak, bilginin güvenilirliğini ve kaynağını sorgulayan bir yaklaşım benimser.

Projenin temel felsefesi, "Desteklenmeyen bilginin güvenilir bir bellek haline gelmemesi gerektiği" ilkesine dayanmaktadır. Bu, LLM'lerden gelen bilgilerin doğrudan hafızaya kaydedilmeden önce bir doğrulama sürecinden geçirilmesini vurgular. AXIOM, harici LLM, GPU veya bulut hizmetlerine bağımlılık olmadan çalışabilen, hafif ve yerel öncelikli bir motor olarak tasarlanmıştır.

## 2. Temel Kavramlar ve Mimari

AXIOM'un mimarisi, bir dizi çekirdek modül ve eklenti etrafında şekillenmiştir. Ana bileşenler şunlardır:

*   **Kernel:** AXIOM'un çekirdek mantığını barındıran ana modül. Yetenek yönetimi, NLP entegrasyonu ve genel işlem akışını sağlar.
*   **Graph:** Bilgiyi düğümler ve kenarlar olarak depolayan bir bilgi grafiği yapısı. İlişkileri, güven düzeylerini ve kanıtları yönetir. SQLite veya JSON tabanlı kalıcılığı destekler.
*   **Agent:** AXIOM'un planlama, yürütme ve hafıza yönetimi katmanı. Hedefleri belirler, adımları planlar ve araçları orkestra eder.
*   **Causal Simulator:** Nedensel akıl yürütme yeteneği sunan modül. "Ne olurdu eğer?" senaryolarını simüle ederek kararların potansiyel sonuçlarını analiz eder.
*   **Plugins:** AXIOM'un yeteneklerini genişleten modüler bileşenler. Örnek olarak `Company Brain` ve `Repo Memory` eklentileri verilebilir.

Bu bileşenler, LLM'lerin çıktılarını doğrulamak, çelişkileri tespit etmek ve bilgi tabanını güvenilir bir şekilde genişletmek için birlikte çalışır. AXIOM, bilgiyi `graph-backed` (grafik tarafından desteklenen), `llm-assisted` (LLM destekli), `unsupported` (desteklenmeyen) ve `contradicted` (çelişkili) olarak sınıflandırarak, bilginin güven düzeyini açıkça belirtir.

## 3. Ana Modüllerin Detaylı Analizi

### 3.1. Kernel (`kernel.js`)

`kernel.js` dosyası, AXIOM'un merkezi kontrol birimidir. Bir `Kernel` sınıfı tanımlar ve bu sınıf, sistemin temel işlevselliğini sağlar:

*   **Yetenek Yönetimi:** `hasCapability`, `enableCapability`, `requireCapability` gibi metotlarla sistemin sahip olduğu yetenekleri (örneğin, `graph`, `temporal`, `llm`, `contradictionDetection`) yönetir. Bu, modüler bir yapı ve özelliklerin dinamik olarak etkinleştirilmesini sağlar.
*   **NLP Entegrasyonu:** `createNlp` fonksiyonu aracılığıyla doğal dil işleme yeteneklerini entegre eder. `normalizeWord`, `tokenizeText`, `isStopWord`, `extractFacts` gibi metotlar, metin analizi ve bilgi çıkarımı için kullanılır. Özellikle Türkçe dil desteği (`lang: 'tr'`) dikkat çekicidir.
*   **Bilgi Grafiği Etkileşimi:** `Graph` sınıfının bir örneğini (`this.graph`) içerir ve bilgi grafiği üzerinde düğüm/kenar ekleme, sorgulama gibi işlemleri yönetir.
*   **Plugin Yönetimi:** `PluginManager` aracılığıyla eklentileri yükler ve çalıştırır. Eklentiler, `beforeLearn`, `afterLearn` gibi olaylara abone olabilir ve AXIOM'un davranışını genişletebilir.
*   **Sonuç Formatlama:** `_ok` ve `_fail` metotları, tüm AXIOM işlemlerinin standart bir `ok: boolean`, `type`, `data`, `evidence`, `error`, `meta` yapısında sonuç döndürmesini sağlar. Bu, çıktıların tutarlı ve denetlenebilir olmasını garanti eder.
*   **Çelişki Tespiti ve Kanıt Sıralaması:** `learn` metodu içinde çelişki tespiti (tür, değil, kısıtlama çelişkileri) ve alternatif tespiti mekanizmaları bulunur. `_rankEvidence` metodu, kanıtları güven düzeylerine göre sıralar.

### 3.2. Graph (`graph.js`)

`graph.js` dosyası, AXIOM'un bilgi grafiği yapısını ve kalıcılık mekanizmalarını tanımlar. Temel özellikleri şunlardır:

*   **Düğüm ve Kenar Yönetimi:** `addNode`, `getNode`, `removeNode`, `addEdge`, `getEdges`, `getInEdges` gibi metotlarla grafikteki düğümleri ve kenarları yönetir. Her düğümün bir ağırlığı (`weight`) ve son erişim zamanı (`lastAccessed`) vardır, bu da bilginin güncelliğini ve önemini yansıtır.
*   **Kalıcılık:** Bilgi grafiğini `memory.json` (JSON) veya `memory.db` (SQLite) dosyalarında saklar. `better-sqlite3` kütüphanesi kullanılarak SQLite desteği sağlanır. SQLite şeması, düğümler (`nodes`) ve kenarlar (`edges`) için tablolar içerir ve çeşitli indekslerle sorgu performansını artırır.
*   **Nedensel İlişkiler:** `CAUSAL_RELATIONS` sabitinde tanımlanan özel ilişki türlerini (örneğin, `CAUSES`, `PREVENTS`, `ENABLES`, `DEPENDS_ON`, `LEADS_TO`) destekler. Bu ilişkiler, nedensel simülasyon için temel oluşturur ve `strength` (güç) alanı ile nedensel etkinin şiddetini belirtir.
*   **Güven ve Kanıt:** Her kenarın bir `confidence` (güven) değeri ve `evidence` (kanıt) listesi bulunur. Bu, bilginin kaynağını ve güvenilirliğini izlemeyi sağlar.

### 3.3. Agent (`agent.js`)

`agent.js` dosyası, AXIOM'un ajan davranışını, planlamasını ve hafıza yönetimini sağlar. Ana işlevleri şunlardır:

*   **Hafıza Yönetimi:** Ajanın geçmiş planlarını, çalıştırmalarını, hedeflerini ve başarısızlıklarını `agent.memory.json` dosyasında saklar. `_loadMemory`, `_saveMemory`, `_pruneMemory` metotları ile hafızanın yüklenmesi, kaydedilmesi ve budanması işlemlerini yönetir.
*   **Hedef ve Plan Kaydı:** `_recordGoal` ve `_rememberPlan` metotları, ajan tarafından belirlenen hedefleri ve oluşturulan planları kaydeder. Bu, ajanın geçmiş deneyimlerinden öğrenmesini ve tekrar eden görevlerde daha verimli olmasını sağlar.
*   **Tool Politikası ve İstatistikler:** `_policy` metodu, bir hedefe ulaşmak için hangi araçların kullanılacağına dair bir politika belirler. Araç kullanım istatistiklerini (`_updateToolStats`) ve hedef istatistiklerini (`_updateObjectiveStats`) tutar, bu da ajanın performansını izlemesine ve iyileştirmesine olanak tanır.
*   **İlerleme Takibi:** `_isStalledProgress` metodu, ajanın ilerlemesinin duraklayıp duraklamadığını kontrol eder, bu da sonsuz döngüleri veya verimsiz çalışmaları önlemeye yardımcı olur.

### 3.4. Causal Simulator (`causalSimulator.js`)

`causalSimulator.js` dosyası, AXIOM'un nedensel akıl yürütme yeteneğini sağlar. Bir `CausalSimulator` sınıfı tanımlar ve bu sınıf, "ne olurdu eğer?" senaryolarını simüle ederek kararların potansiyel sonuçlarını analiz eder:

*   **Değişim Simülasyonu:** `simulateChange` metodu, belirli bir düğüm üzerindeki bir değişikliğin (ekleme, kaldırma, değiştirme) nedensel zincirlerini izler. `maxDepth` parametresi ile simülasyon derinliği kontrol edilebilir.
*   **İlişki Profilleri:** `RELATION_PROFILES` sabiti, farklı nedensel ilişki türleri (CAUSES, PREVENTS, ENABLES vb.) için etki, risk ve şiddet önyargılarını tanımlar. Bu profiller, simülasyon sonuçlarının daha gerçekçi olmasını sağlar.
*   **Risk ve Sonuç Analizi:** Simülasyon, potansiyel sonuçları (`outcomes`), riskleri (`risks`), etkilenen düğümleri (`affectedNodes`) ve kanıtları (`evidence`) belirler. Riskler, `critical`, `high`, `medium`, `low` gibi şiddet seviyelerine göre sınıflandırılır.
*   **Öneri Üretimi:** `_deriveRecommendation` metodu, simülasyon sonuçlarına dayanarak bir öneri (örneğin, "Değişiklik önerilmez" veya "Daha fazla kanıt toplayın") sunar. Bu, karar verme süreçlerine doğrudan girdi sağlar.

### 3.5. Company Brain Plugin (`plugins/company-brain.js`)

`plugins/company-brain.js` dosyası, AXIOM'un "Şirket Beyni" yeteneğini uygular. Bu eklenti, şirket hafızasını yönetmek ve sorgulamak için kullanılır:

*   **Ingest Mekanizmaları:**
    *   `ingestManual`: Serbest metinlerden (örneğin, manuel notlar) gerçekleri çıkarır ve bilgi grafiğine ekler. `sourceRef` ve `evidenceType` gibi meta verilerle bilginin kaynağını izler.
    *   `ingestDecision`: Kararları, gerekçeleri, alternatifleri ve ilgili bağlantıları bilgi grafiğine yapılandırılmış bir şekilde kaydeder. Bu, kurumsal karar alma süreçlerinin izlenebilirliğini artırır.
*   **Sorgulama:** `queryCompanyBrain` metodu, doğal dil sorularını işler. Soru metninden anahtar kelimeler çıkarır, bilgi grafiğindeki düğümlerle eşleştirir ve ilgili kanıtları toplar. Eğer grafik yeterli bilgi sağlamazsa, isteğe bağlı olarak bir LLM adaptörü (`LLMAdapter`) kullanarak yedek bir yanıt üretmeye çalışır.
*   **Durum Takibi:** `getIngestStatus` metodu, farklı kaynaklardan (repo, markdown, manuel) alınan bilgilerin dağılımını ve ingest hatalarını gösterir.

### 3.6. Workflow Tools (`workflow-tools.js`)

`workflow-tools.js` dosyası, AXIOM'un Workflow Agent OS'u için çeşitli araç adaptörlerini içerir. Bu araçlar, ajanın belirli görevleri yerine getirmesini sağlar:

*   **`verifyClaim`:** AXIOM çekirdeği ile bir iddiayı doğrular ve doğrulama sonucunu standart bir zarf içinde döndürür.
*   **`findContradictions`:** Bilgi grafiğindeki çelişkileri tespit eder ve kanıtlarla birlikte sunar.
*   **`rankEvidence`:** Kanıt öğelerini sıralar ve ayarlanmış güven düzeylerini hesaplar. Bu, farklı kanıt türlerinin (örneğin, `user_experience`, `docs`) ağırlıklandırılmasını sağlar.
*   **`repoMemory`:** GitHub depolarını veya Markdown kaynaklarını şirket hafızasına alır. Bu, kod tabanları, dokümantasyon veya diğer metin tabanlı varlıkların AXIOM'un bilgi grafiğine entegre edilmesini sağlar.
*   **`companyBrain`:** Şirket hafızasını sorgulamak veya manuel/karar verilerini ingest etmek için kullanılır. `plugins/company-brain.js` eklentisinin işlevselliğini bir araç olarak sunar.

Bu araçlar, ajanın karmaşık görevleri adım adım yerine getirmesi için bir arayüz sağlar ve her aracın çıktısı, tutarlı bir `buildEnvelope` yapısı ile formatlanır.

## 4. AXIOM'un Değeri ve Kullanım Alanları

AXIOM, modern yapay zeka sistemlerinin "LLM çıktısının makul gelmesi -> sistemin bunu bellek olarak depolaması -> gelecekteki yanıtların kirlenmiş belleğe güvenmesi -> ürün davranışının sapması" şeklindeki yaygın hata moduna doğrudan saldırmaktadır. AXIOM, çıktıyı güvenmeden önce sınıflandırır:

*   `graph-backed`: Bilgi grafiği tarafından destekleniyor.
*   `llm-assisted`: Model yardımcı oldu, ancak grafik desteği kısmi.
*   `unsupported`: Bilgi grafiği bilmiyor.
*   `contradicted`: Bilgi grafiği ile çelişiyor.

Bu sınıflandırma, AXIOM'u LLM uygulamaları, dahili araçlar, ajan sistemleri ve kurucu karar iş akışları etrafında bir yargı katmanı olarak değerli kılar.

**Başlıca Kullanım Alanları:**

*   **LLM Çıktı Doğrulaması:** LLM'lerden gelen bilgilerin güvenilirliğini artırmak ve halüsinasyonları azaltmak.
*   **Kurumsal Bilgi Yönetimi:** Şirket içi belgelerden, kararlardan ve kod depolarından öğrenerek tutarlı ve doğrulanabilir bir şirket hafızası oluşturmak.
*   **Ajan Sistemleri:** Araç orkestrasyonu ve görev planlaması için deterministik bir akıl yürütme katmanı sağlamak.
*   **Karar Simülasyonu:** Önemli kararların potansiyel nedensel etkilerini analiz ederek riskleri önceden belirlemek.

## 5. Sonuç

AXIOM, yapay zeka sistemlerinde güvenilirlik ve denetlenebilirlik sorunlarına yenilikçi bir çözüm sunan, sembolik akıl yürütme tabanlı güçlü bir projedir. Bilgi grafiği, ajan mimarisi ve nedensel simülasyon gibi temel bileşenleri, LLM'lerin yeteneklerini tamamlayıcı ve güçlendirici bir rol oynamaktadır. Özellikle Türkçe dil desteği ve yerel öncelikli çalışma prensibi, projenin geniş bir kullanım alanına sahip olabileceğini göstermektedir.

Projenin modüler yapısı ve eklenti sistemi, gelecekteki genişlemeler ve özelleştirmeler için sağlam bir temel sunmaktadır. AXIOM, "LLM cevap verir, AXIOM yargılar" felsefesiyle, yapay zeka sistemlerinin daha şeffaf, güvenilir ve kontrol edilebilir olmasını hedeflemektedir. Bu, özellikle kritik karar alma süreçlerinde ve hassas bilgi yönetiminde büyük bir değer yaratma potansiyeline sahiptir.

## 6. Referanslar

[1] agiulucom42-del/axiom GitHub Deposu: [https://github.com/agiulucom42-del/axiom](https://github.com/agiulucom42-del/axiom)
[2] AXIOM `package.json` dosyası: `/home/ubuntu/axiom/package.json`
[3] AXIOM `README.md` dosyası: `/home/ubuntu/axiom/README.md`
[4] AXIOM `kernel.js` dosyası: `/home/ubuntu/axiom/kernel.js`
[5] AXIOM `graph.js` dosyası: `/home/ubuntu/axiom/graph.js`
[6] AXIOM `agent.js` dosyası: `/home/ubuntu/axiom/agent.js`
[7] AXIOM `causalSimulator.js` dosyası: `/home/ubuntu/axiom/causalSimulator.js`
[8] AXIOM `workflow-tools.js` dosyası: `/home/ubuntu/axiom/workflow-tools.js`
[9] AXIOM `plugins/company-brain.js` dosyası: `/home/ubuntu/axiom/plugins/company-brain.js`
