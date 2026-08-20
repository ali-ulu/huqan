# Dream Motoru: Gerçek Hipotez Zinciri Kaynak Raporu

**Status:** `research`

**İnceleme kapsamı:** `dream.js`, `kernel.js`, `lib/background-provenance.js` ve arka plan yazma kapısı testleri.

**Rapor amacı:** Bu belge, Dream motorunun çekirdek kaynak yollarında gerçekten bulunan hipotez üretimi, admission ve canonical grafik yazımını; ayrıca canonical branch’te #969 ile eklenen opt-in, bounded deney döngüsünü ayırarak açıklar. Önceki kaynak incelemesinin “ayrı state machine yok” bulgusu tarihsel baseline’a aittir; mevcut branch’teki `lib/dream-experiment-loop.js` bu boşluğu sınırlı bir controller olarak kapatır. Kavramsal olarak arzu edilen sınırsız otonom araştırma akışı ise mevcutmuş gibi sunulmaz.

## 1. Ana bulgu

Dream çekirdeğinde bağımsız bir `HypothesisChain` sınıfı yoktur; çekirdek `dream.js`/`kernel.js` yolları hipotez adaylarını üretir ve background admission üzerinden yazar. Canonical branch’te #969 ile eklenen `lib/dream-experiment-loop.js` ise bu adayları `PENDING → VERIFYING → OBSERVED → COMMITTED/DEFERRED` durumlarıyla sınırlı bir deney controller’ından geçirir. Bu durum, çekirdek Dream yazım yollarının gerçekliğini değiştirmez; aşağıdaki üç yol hâlen canonical hipotez kenarı yazımının kaynak kodda doğrulanan yollarıdır:

| Yol | Hipotez kaynağı | Canonical kenar yazımı | Kaynak kodda doğrulanan sonuç |
|---|---|---|---|
| `Kernel.dream({ learnFromDream: true })` | Çağrının ürettiği Dream adayları | `_commitBackgroundEdge(..., 'dream', ...)` üzerinden | Admission `allow` ise canonical kenar ve `LEARN` audit; allow dışıysa `pending` ve `REVIEW`/`REJECT` audit |
| `Kernel.startAutoThink()` → `_autoThinkTick()` | Periyodik `Dream.dream()` çıktısının ilk beş adayı | `_commitBackgroundEdge(..., '_autoThinkTick', ...)` üzerinden | Uygun aday admission `allow` alırsa canonical kenar; aksi halde `bekleyen` sayacı ve audit |
| `Kernel.selfEvolve()` | `Dream.dream()` çıktısının yeterli güven eşiğini geçen adayları | `_commitBackgroundEdge(..., 'selfEvolve', ...)` üzerinden | Admission `allow` ise `added`; allow dışıysa `deferred` |

Bu yolların ortak noktası, hipotez kenarlarının doğrudan ve sessiz bir `graph.addEdge()` çağrısıyla değil, arka plan provenance ve öğrenme admission kapısından geçirilerek yazılmasıdır. `commitBackgroundEdge` fonksiyonu admission sonucunu değerlendirir; `allow` dışındaki sonuçlarda kenar yazmadan audit üretir, `allow` sonucunda ise `addEdge` çağrısını yapıp `LEARN` audit kaydı üretir. [2] [3]

Dolayısıyla kaynak koddan çıkarılabilecek doğru sonuç şudur:

> **Çekirdek Dream akışında hipotez üretimi vardır ve hipotez adayları, ilgili adaylık/eşik koşulları sağlanıp arka plan admission kararı `allow` olduğunda canonical grafiğe yazılabilir. Varsayılan veya daha kısıtlı admission kararlarında yazım yapılmaz; aday `pending`/`deferred` olarak ve audit ile görünür kalır. #969 sonrasında opt-in bounded controller, hipotezi verify adımına bağlar, sonucu `support`/`reject`/`unknown` gözlem sinyaline normalize eder ve supporting observation için mevcut `_commitBackgroundEdge()` admission yolunu kullanır. Bu, sınırlı kontrollü deney döngüsüdür; sınırsız otonom deney orkestrasyonu değildir.**

## 2. Gerçek ana akışın özeti

Kaynak kodun doğruladığı genel akış şöyledir:

```text
Graph düğümleri ve kenarları
        ↓
Dream bağlamı ve bütçe oluşturma
        ↓
Benzerlik hipotezleri üretme
        ↓
Geçişli/zincir hipotezleri üretme
        ↓
Boşluk/bağlantı önerileri üretme
        ↓
Simetri hipotezleri üretme
        ↓
Çelişki hipotezleri üretme
        ↓
Bileşik skor hesaplama
        ↓
Çelişkileri öne alma ve en fazla 10 aday döndürme
        ↓
Kernel seviyesinde sınırlı `_evidence` görünümü
        ↓
İsteğe bağlı background admission
        ├─ allow   → canonical edge + LEARN audit
        └─ review/reject/quarantine → canonical edge yok + pending/deferred + audit
```

Bu, “hipotez zinciri” ifadesinin mevcut kaynak koddaki en doğru karşılığını verir: grafik yapısından hipotez adayları üretmek ve bu adayları güvenli bir arka plan yazma kapısından geçirmek. Ancak bu zincir, hipotezlerin dış dünyaya ilişkin bir deney yürüttüğü veya deney sonucuna göre kendiliğinden yeni bir hipotez state’ine geçtiği anlamına gelmez. [1] [2] [3]

## 3. `Dream.dream()` içindeki gerçek hipotez üretimi

### 3.1. Başlangıç ve ön koşul

`Dream.dream()` önce `beforeDream` olayını yayınlar. Grafikte iki düğümden az varsa boş dizi döner ve `afterDream` olayını boş hipotez listesiyle yayınlar. İki veya daha fazla düğüm bulunduğunda `_createDreamContext(nodes)` çağrılır. [1]

### 3.2. Dream bağlamı ve bütçeler

Dream bağlamında düğümlerin çıkış ve giriş kenarları, hedef kümeleri, hedefe göre kenar haritası ve ilişki-hedef kümeleri hazırlanır. Ortalama derece, karşılaştırma bütçesi ve iş bütçesi de bu bağlamda tutulur. `MAX_DREAM_COMPARISONS = 50_000` ve `MAX_DREAM_WORK = 50_000` sınırları, üretim döngülerinin sınırsız çalışmasını önler. [1]

### 3.3. Benzerlik hipotezleri

İlk üretim aşaması `_findSimilarityHypotheses()` fonksiyonudur.

| Alt tür | Kaynakta doğrulanan koşul | Üretilen temel alanlar |
|---|---|---|
| `benzerlik` | İki düğümün ortak hedefleri bulunur ve aralarında mevcut benzerlik ilişkisi yoktur | `from`, `to`, `via`, `confidence`, `ortak_sayısı` |
| `vektör-benzerlik` | Cosine similarity değeri `0.5` üzerindedir ve düğümler arasında doğrudan kenar yoktur | `from`, `to`, `confidence`, `benzerlik` |

Bu aşamada en fazla 50 aday eklenir. [1]

### 3.4. Geçişli/zincir hipotezleri

`_findTransitiveHypotheses()` fonksiyonu, `A → B` ve `B → C` biçiminde iki kenarlı bir geçiş bulunup `A → C` aynı ilişkiyle mevcut değilse `zincir` türünde aday üretir. Aday `via: B` alanını taşır ve güven değeri ilgili kenar ağırlıklarından hesaplanır. Bu, motorun gerçek geçişli çıkarım adımıdır; ancak bir hipotezin deney state’leri arasında yürütüldüğü bir zincir değildir. [1]

### 3.5. Boşluk ve bağlantı önerileri

`_findGapHypotheses()` kernel’in `detectGaps()` çıktısını kullanır. Boşlukla ilişkili düğüm için cosine similarity bakımından en yakın başka düğüm aranır; benzerlik `0.1` üzerindeyse `bağlantı-önerisi` türünde aday üretilir. Bu adım yapısal bağlantı adayı üretir; tek başına doğrulanmış yeni bilgi veya deney sonucu değildir. [1]

### 3.6. Simetri hipotezleri

`_findSymmetryHypotheses()` bir yönde `A → B` kenarı varken ters yönde eşdeğer bir ilişki veya doğrudan kenar bulunmuyorsa `simetri` adayını oluşturur. Güven değeri mevcut kenar ağırlığının `0.3` katsayısıyla hesaplanır. [1]

### 3.7. Çelişki hipotezleri

`_findContradictionHypotheses()` kernel’de `detectContradictions()` mevcutsa çelişki sonuçlarını `çelişki` türünde adaylara dönüştürür. Adaylar `node`, `targets` ve `confidence` alanlarını taşıyabilir. Bu aşamadaki hata, hipotez üretiminin tamamını düşürmek yerine ilgili çelişki adayını eklemeden devam edecek şekilde ele alınır. [1]

## 4. Gerçek skorlama ve çıktı sırası

Üretilen adaylara `_calculateCompositeScore()` uygulanır:

```text
score = confidence × 0.5
       + novelty × 0.3
       + usefulness × 0.2
```

`confidence` adayın mevcut güven değeridir. `novelty`, özellikle çelişkilerde `1.0`, yeni bağlantılarda `1` ve mevcut bağlantılarda `0` gibi kaynak kodda tanımlanan değerlere dayanır. `usefulness`, adayla ilişkili düğümün giriş/çıkış derece değerlerinin grafiğin ortalama derecesine oranından türetilir. Çelişki adayları kendi içinde güven değerine göre, diğer adaylar bileşik skora göre azalan sırada düzenlenir. Birleştirilmiş sonuçtan en fazla 10 hipotez döndürülür ve `afterDream` olayı bu listeyle yayınlanır. [1]

## 5. Kernel seviyesindeki gerçek hipotez görünümü

`Kernel.dream(opts)` `Dream.dream()` çıktısını aldıktan sonra adaylar için sınırlı bir `_evidence` nesnesi oluşturur.

| Alan | Kaynakta doğrulanan anlam |
|---|---|
| `kind` | `hypothesis` sabiti |
| `text` | Düğüm ilişkisini sınırlı metin görünümünde ifade eden alan; örneğin `from ? to` |
| `confidence` | `0` ile `1` arasına sınırlandırılmış güven değeri |
| `nodes` | Hipotezde geçen düğüm kimlikleri |
| `edges` | `from` ve `to` mevcutsa ilişki görünümü |

Bu `_evidence` alanı, hipotezin yapılandırılmış görünümüdür; tek başına Trust Evidence Ledger makbuzu değildir. `Kernel.dream()` bu noktada ledger receipt veya `evidenceDigest` üretmez. Canonical yazım, aşağıdaki admission yollarında ayrıca gerçekleşir. [2]

## 6. `learnFromDream` yolunda canonical yazım

`Kernel.dream({ learnFromDream: true })` verildiğinde, `dreamLearnThreshold` üzerindeki, `from` ve `to` alanlarına sahip ve grafikte mevcut olmayan adaylar `_commitBackgroundEdge(..., 'dream', ...)` yoluna gönderilir. İlişki tipi kaynak kodda aşağıdaki şekilde eşlenir:

| Koşul | Canonical kenar ilişkisi |
|---|---|
| `relation` veya `via` `tür` ise | `tür` |
| `relation` `yapabilir` ise | `yapabilir` |
| `relation` `özellik` ise | `özellik` |
| `type` `zincir` veya `relation` `benzer` ise | `benzer` |
| Diğer durumlar | `hipotez` |

Buradaki kritik ayrım admission sonucudur:

| Admission sonucu | Canonical grafik | Kernel çıktısı/audit |
|---|---|---|
| `allow` | `addEdge` üzerinden yazılır | Aday `learned` listesine eklenir; `LEARN` audit üretilir |
| `review`, `reject` veya `quarantine` | Yazılmaz | Aday `pending` listesine karar bilgisiyle eklenir; `REVIEW` veya `REJECT` audit üretilir |
| Admission yok veya değerlendirilemiyor | Yazılmaz | Fail-closed biçimde review/audit yolu kullanılır |

Bu nedenle varsayılan arka plan politikası `review` verdiğinde testte yeni canonical kenar oluşmaması beklenir. Bu, allow yapılandırıldığında hipotez kenarlarının hiç yazılamayacağı anlamına gelmez; yalnızca o belirli admission koşulunda yazımın gerçekleşmediğini gösterir. Kaynak test, varsayılan admission davranışındaki bu non-allow durumunu doğrular. [2] [3]

## 7. `startAutoThink()` ve `_autoThinkTick()` yolunda canonical yazım

`Kernel.startAutoThink()` periyodik timer kurar. Her `_autoThinkTick()` çağrısında Dream motoru çalıştırılır, ilk beş aday incelenir ve güveni `0.25` üzerinde olan adaylar için mevcut düğüm/kenar koşulları değerlendirilir.

Kaynak kodda adayın ilişkisi şu eşlemeyle belirlenir:

| Hipotez koşulu | `_autoThinkTick()` ilişki değeri |
|---|---|
| `type === 'zincir'` | `benzer` |
| `type === 'benzerlik'` | `benzer` |
| `relation === 'tür'` | `tür` |
| `relation === 'yapabilir'` | `yapabilir` |
| `relation === 'özellik'` | `özellik` |
| Diğer durumlar | `hipotez` |

Aynı düğüm çifti arasında mevcut herhangi bir kenar yoksa aday `_commitBackgroundEdge(..., '_autoThinkTick', ...)` yoluna gönderilir. Admission `allow` ve gerçek kenar sonucu varsa `eklenen` artırılır; diğer sonuçlarda `bekleyen` artırılır. Provenance ekinde `hypothesisType` ve `hypothesisConfidence` tutulur. [2]

Böylece AutoThink yolu da iki farklı davranışı aynı sözleşme içinde taşır:

```text
Dream hipotezi
    ↓
confidence ve mevcut kenar koşulları
    ↓
_commitBackgroundEdge('_autoThinkTick')
    ├─ allow   → canonical edge + LEARN audit + eklenen
    └─ non-allow → edge yok + REVIEW/REJECT audit + bekleyen
```

Varsayılan admission altında canonical kenar sayısının artmamasını bekleyen testler, bu yolun `allow` konfigürasyonunda yazamayacağını değil, testte kullanılan varsayılan non-allow politikasını doğrular. [3]

## 8. `selfEvolve()` yolunda canonical yazım

`Kernel.selfEvolve()` yeni bir `Dream` örneği oluşturur ve `dreamer.dream()` çıktısını alır. Adaylar önce güven eşiklerinden geçirilir: çağrıda `minConfidence` verilmişse bu eşik, ayrıca aday türüne göre varsayılan minimum güven uygulanır. Mevcut aynı ilişkiye sahip kenar varsa aday atlanır.

İlişki seçimi kaynak kodda şöyledir:

```text
h.relation varsa onu kullan
aksi halde type benzerlik veya vektör-benzerlik ise benzer
aksi halde hipotez
```

Ardından aday `_commitBackgroundEdge(..., 'selfEvolve', ...)` yoluna gönderilir. `allow` ve gerçek kenar sonucu `added` listesine, allow dışı kararlar `deferred` listesine alınır. Yazım için `source: 'kendilik'`, ağırlık ve `hypothesisType`/`hypothesisConfidence` provenance alanları taşınır. [2]

`selfEvolve()` yolunun gerçek sonuç sözleşmesi aşağıdaki gibidir:

| Admission sonucu | Sonuç |
|---|---|
| `allow` | Aday canonical kenar olarak eklenir ve `addedDetails` içinde görünür |
| `review`, `reject` veya başka allow dışı sonuç | Canonical kenar eklenmez ve aday `deferredDetails` içinde karar bilgisiyle görünür |

Bu yol, kullanıcının grafikte `hipotez` ilişkili kenar görmüş olmasını açıklayabilecek gerçek kaynak yollarından biridir. Özellikle adayın `relation` alanı yoksa ve türü `benzerlik`/`vektör-benzerlik` değilse ilişki değeri `hipotez` olur; admission `allow` verdiğinde bu ilişki canonical grafiğe yazılır. [2]

## 9. `amplify`, `simulate`, `verify` ve `walk` ana zincirin neresinde?

`Dream` sınıfında `amplify()`, `simulate()`, `verify()` ve `walk()` yardımcıları bulunur; ancak kaynakta bunlar `Dream.dream()` içindeki beş hipotez üretim aşamasından çağrılan deney state’leri değildir.

| Yardımcı | Kaynakta doğrulanan işlev |
|---|---|
| `amplify` | Aday cevapları kenar ağırlığı ve `verify()` sonucuyla puanlar; bazı kenar ağırlıklarını artırabilir |
| `simulate` | Bir düğüm için mevcut kenarlar ve embedding benzerliğinden aday cevaplar üretir; ilk üçü döndürür |
| `verify` | Grafikte iki düğüm arasında en fazla beş derinlikli DFS yolu arar ve yol güveni hesaplar |
| `walk` | En yüksek ağırlıklı yolu seçerek belirli derinliğe kadar yürür |

Bu yardımcılar sorgulama, puanlama veya doğrulama araçlarıdır; kendi içlerinde deney state machine’i değildir. #969’un ayrı `lib/dream-experiment-loop.js` controller’ı bu çekirdek yardımcıları bounded `verify` adımı, normalize edilmiş observation ve sonraki hipotez seçimiyle bağlar. Controller’ın yazma etkisi yine mevcut Graph/mutation-admission/background-provenance sınırları içindedir; ikinci bir durability otoritesi oluşturmaz. [1] [5]

## 10. Gerçek akış ile olması gereken akış arasındaki ayrım

### Kaynakta gerçekten olan

```text
Bilgi grafiği
  → Dream bağlamı ve bütçeler
  → beş hipotez üreticisi
  → bileşik skor ve sıralama
  → en fazla 10 hipotez
  → kernel `_evidence` görünümü
  → learnFromDream / AutoThink / selfEvolve aday yolu
  → background provenance
  → learning admission
  ├─ allow   → canonical edge + LEARN audit
  └─ non-allow → pending/deferred + REVIEW/REJECT audit
```

### #969 öncesi baseline’da ayrı bir kapalı döngü olarak doğrulanmayan

```text
Hipotez
  → deney tasarımı
  → güvenlik kapısından araç yürütme
  → gerçek dünya veya araç gözlemi
  → gözlem/sonuç kaydı
  → hipotez sonucu ve başarısızlık nedeni
  → otomatik sonraki hipotez
```

Buradaki ikinci şema #969 öncesi baseline’ın tarihsel bulgusudur; güncel canonical branch’in gerçekleşen akışı olarak tek başına sunulamaz. Güncel branch’te bunun sınırlı karşılığı `lib/dream-experiment-loop.js` içinde vardır: controller bounded hypothesis listesi üretir, her hipotezi mevcut AgentV3 `verify` yoluna bağlar, sonucu observation sinyaline dönüştürür ve bir sonraki hipotezi seçer. Workflow katmanındaki diğer araç adlarının bu controller’ın dışında aynı state machine’i kurduğu iddia edilmez. [1] [2] [5]

## 11. Huqan trust-kernel ile doğrulanmış temas noktası

Dream hipotezlerinin trust-kernel ile doğrulanmış temas noktası, üç background yazım yolundaki `_commitBackgroundEdge()` çağrılarıdır:

```text
Dream hipotezi
  → background provenance
  → öğrenme admission değerlendirmesi
  ├─ allow
  │    → Graph.addEdge üzerinden canonical kenar
  │    → LEARN audit
  └─ allow değil
       → canonical kenar yok
       → REVIEW/REJECT audit
       → pending veya deferred görünümü
```

Bu akış ikinci bir durability otoritesi veya ayrı bir receipt family oluşturmaz; mevcut kernel admission ve Graph yazma yollarını kullanır. Bununla birlikte `Kernel.dream()` içindeki `_evidence` nesnesi tek başına Trust Evidence Ledger receipt’i değildir. Bu kaynak raporu, Dream motoru ile Human Oversight Runtime, Agent Identity Runtime veya Trust Evidence Ledger arasında doğrudan production çağrısı varmış gibi bir iddia ileri sürmez. [2] [3]

## 12. Sonuç

Dream motorunun kaynakta doğrulanan gerçek hipotez akışı şöyledir:

> **Bilgi grafiğini bağlam ve bütçe ile tarar; benzerlik, zincir/geçiş, boşluk, simetri ve çelişki adayları üretir; adayları güven, yenilik ve fayda bileşik skoruyla sıralar; çelişkileri öne alarak en fazla 10 hipotez döndürür; kernel bu adaylara sınırlı bir `_evidence` görünümü ekler; `learnFromDream`, AutoThink veya `selfEvolve` yollarında uygun adayları mevcut background provenance ve admission kapısından geçirir; admission `allow` ise ilişki eşlemesine göre `hipotez`, `benzer`, `tür`, `özellik` veya `yapabilir` ilişkili canonical kenar ve `LEARN` audit üretilir; allow dışı kararlarda canonical yazım yapılmaz ve aday pending/deferred ile audit olarak görünür.**

Bu nedenle **hipotez üretimi ve koşullu canonical hipotez yazımı çekirdek Dream kaynak kodunda doğrulanmıştır**. Buna ek olarak #969, `lib/dream-experiment-loop.js` ile hipotez → verify → observation → sonraki hipotez akışını bounded bir state machine olarak canonical branch’e bağlamıştır. Supporting observation commit’i mevcut `_commitBackgroundEdge()` admission ve `Graph.runMutationOnce()` durability yolundan geçer; rejection, unknown, missing Graph durability veya bütçe sınırı canonical edge yazımını engeller. Sonuç, kontrollü ve opt-in bir deney loop’udur; yeni signer, receipt family, durability authority veya sınırsız otonom araştırma iddiası değildir.

## References

[1]: https://github.com/ali-ulu/huqan/blob/main/dream.js "Dream motoru kaynak kodu"

[2]: https://github.com/ali-ulu/huqan/blob/main/kernel.js "Kernel Dream, AutoThink ve selfEvolve akışları"

[3]: https://github.com/ali-ulu/huqan/blob/main/lib/background-provenance.js "Background provenance ve admission-gated canonical edge yazımı"

[4]: https://github.com/ali-ulu/huqan/blob/main/test/faz2-background-write-gate-audit.test.js "Dream background admission ve audit testleri"

[5]: https://github.com/ali-ulu/huqan/blob/main/lib/dream-experiment-loop.js "Bounded Dream hypothesis verification and observation loop"

[6]: https://github.com/ali-ulu/huqan/blob/main/test/dream-experiment-loop.test.js "Dream experiment loop unit contract"
