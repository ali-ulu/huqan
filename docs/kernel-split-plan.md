# Kernel.JS & Kernel.V2 Fonksiyonel Bölme Planı (#328)

**Durum:** Doküman-first tasarım. Kod değişikliği yok. Onay sonrası ilk adım mekanik (KernelV2 saf katman), ikinci adımlar fonksiyonel değişiklikle eş zamanlı yürütülür.

**Kural hatırlatması:** Sınıf içi yöntemler JIT bölünür — sadece bir yöntem üzerinde fonksiyonel bir değişiklik yapılırken, o yöntem ve eşlik eden saf helper'lar birlikte kendi modülüne çıkarılır. Bu plan her adımı o ilkeye bağlar; mekanik olarak "bütün sınıfı" bölmek yasak.

---

## 1. Mevcut durum (ratchet kanıtı)

| Dosya | Satır | Sınıf | Not |
|---|---|---|---|
| lib/memory-store.js | 2085 | Evet | Sınıf; bölme bekliyor |
| graph.js | 1694 | Evet | Sınıf; bölme bekliyor |
| kernel.js | 1543 | Evet | En büyük hedef |
| server.js | 1118 | Evet | — |
| agent.js | 1076 | Evet | — |
| workflow-agent.js | 1020 | Evet | — |
| kernel.v2.js | 975 | Evet | **Bu planın konusu** |
| lib/verify.js | 967 | Evet | — |
| workflow-tools.js | 962 | Hayır | Saf fonksiyonlar — mekanik aday |
| scripts/external-conformance/consumer.js | 924 | Hayır | CLI; mekanik aday |
| lib/code-change-gate.js | 891 | Hayır | Saf — mekanik aday |
| lib/sandbox-isolation.js | 855 | Hayır | Saf — mekanik aday |

---

## 2. kernel.v2.js analizi (975 satır)

### 2.1 Yapı haritası

| Bölge | Satır | İçerik | Saf mı? |
|---|---|---|---|
| Import + sabitler | 1–34 | `require`, `TYPE_RELATIONS`, `FACT_RELATIONS`, `OPPOSITE_PREDICATES`, `MANIPULATION_RULES` (regex tablosu) | ⚠️ OPPOSITE_PREDICATES `registerOppositePair` ile mutasyona uğrar (module-init, saf) |
| Saf fonksiyonlar | 35–99 | `nowIso`, `normalizeText`, `normalizeAscii`, `stripCopulaTail`, `registerOppositePair`, `normalizeManipulationText`, `parseSimpleTurkishStatement` | ✅ Hepsi pure |
| class KernelV2 | 100–964 | Constructor + 70+ yöntem | ❌ Sınıf içi |
| Exports | 965–975 | `module.exports = KernelV2` + async wrapper'lar | — |

### 2.2 Kullanım noktaları (seam doğrulaması)

Saf fonksiyonlar (35–99) yalnızca sınıf yöntemlerinin **içinden** çağrılıyor (satır 226, 336, 541, 548, 551, 560, 567, 748). Dışarıdan kimse doğrudan import etmiyor — bu, ekstraksiyonun **sıfır dış API kırma riski** taşıdığı anlamına gelir.

### 2.3 Adım V2-A: `lib/kernel-v2-native.js` (mekanik)

- Satır 35–99 arası 7 fonksiyon + `OPPOSITE_PREDICATES` map'inin init bloğu yeni modüle taşınır.
- `MANIPULATION_RULES` da taşınabilir (regex tablosu pure data), ancak `OPPOSITE_PREDICATES` ile aynı dosyada kalmalı — ikisi `normalizeAscii`/`stripCopulaTail` zinciriyle bağlı.
- KernelV2 dosyası bu fonksiyonları `require('./kernel-v2-native')` ile alır.
- Beklenen sonuç: **975 → ~880 satır** (hâlâ 800+ — mekanik tek başına eşiği aşmaz, ama fonksiyonel adımların yolunu açar).

> Not: Bu adım tek başına ratchet'ten düşürmez; ancak 2.4'teki fonksiyonel adımlarla birlikte 800 altı hedeflenir.

### 2.4 Adım V2-B: Fonksiyonel seam — verify zinciri

En büyük yöntem `verify` (86 satır) ve yardımcısı `_buildContradictionDetails` (86 satır) **çelişki tespiti** işini yapar. Bu, zaten tanımlı bir fonksiyonel alan (contradiction detection).

**Senaryo:** `contradiction-detection` alt modülü (`lib/contradiction/v2-contradiction-engine.js`) — ancak bu ancak sınıf içi `this.graph` erişimini çözecek bir tasarım kararıyla yapılır:

- **Seçenek B1 (önerilen):** Yeni yöntem `_buildContradictionDetails`'ın bir kısmı zaten pure (parsed statement + graph query sonuçları alıp detay üretiyor). Graph query'yi (`_collectTypeTargets`/`_collectFactTargets`) sınıf dışında bir `fetchTargets(graph, subject)` fonksiyonu olarak çıkarıp, contradiction detay üreticisini tamamen saf yapmak — bu bir **davranış ekleme/fonksiyonel netleştirme** içerir, JIT kuralına uygun.
- **Seçenek B2:** Çelişki tespiti zaten bir plugin alanı (`contradiction-alert` plugin'i var). Sınıfın bu yöntemleri plugin API'sine bağlamak, class içi kodu azaltır ve mimari olarak temiz. **EMİNLİK: orta** — plugin manifest'inde capability bağlama maliyeti var.

### 2.5 Adım V2-C: Fonksiyonel seam — manipulation/güvenlik katmanı

`_analyzeManipulation` (40 satır) + `MANIPULATION_RULES` + `learnFromLLM` içindeki risk eşikleme mantığı tek bir **metin güvenlik skorer'ı** oluşturur.

**Senaryo:** `lib/text-safety-scorer.js` — `MANIPULATION_RULES` + `normalizeManipulationText` + `analyzeManipulation(text)` pure API'siyle. KernelV2 `this._analyzeManipulation`'ı bu modüle delege eder. Bu **fonksiyonel bir netleştirme** (skorer artık LLM learning dışından da test edilebilir/gate'lenebilir) ve JIT kuralına tam uyumlu. Beklenen: KernelV2'den ~120 satır düşer → **~760 satır** → ratchet'ten düşer.

---

## 3. kernel.js analizi (1543 satır)

### 3.1 Yapı haritası

| Bölge | Satır | İçerik | Saf mı? |
|---|---|---|---|
| Import + saf ön-kod | 1–91 | `Graph` import, `AXIOM_ERROR`/`CONTRACT_VERSION` tanımları (zaten `lib/kernel-contract.js`'e kopyalandı — #913) | ✅ Zaten kısmen çıkarıldı |
| class Kernel | 92–1522 | Constructor (82) + ~70 yöntem | ❌ Sınıf içi |
| Module.exports + bypass | 1523–1543 | `createAdmissionBypassOpts` (pure, dışarıda) | ✅ |

### 3.2 Yöntem boyutları (top)

| Yöntem | ~Satır | Alan | Bölme adayı mı? |
|---|---|---|---|
| learn | 94 | Öğrenme giriş kapısı | ❌ Yoğun `this` bağımlı |
| proposeNode | 86 | Graph yazımı | ❌ Sınıf state |
| learnFromLLM | 83 | LLM öğrenme | ⚠️ Risk skorlama kısmı V2-C ile ortak |
| constructor | 82 | State kurulumu | ❌ JIT ancak |
| _commitBackgroundEdge | 82 | Background provenance | ❌ Audit + graph |
| alternatives | 69 | Graph traversal | ⚠️ `_findPath` ile birlikte |
| selfEvolve | 67 | FAZ2 dream integration | ❌ JIT ancak |
| dream | 60 | Dream entegrasyonu | ❌ JIT ancak |
| _crossLink | 59 | FAZ2 derived edges | ❌ FAZ2 PR'ında JIT |
| _autoThinkTick | 59 | Auto-think | ❌ Sınıf state |

### 3.3 Fonksiyonel seam haritası (kernel.js)

Kernel.js'te **saf fonksiyonlar zaten ayrı modüllerde**: `edgeRef`, `rankEvidence`, `edgeEvidence`, `parsePredicate`, `pathEvidence` — sınıf bunlara ince wrapper'larla delege ediyor (`_edgeRef` → `edgeRef` vb.). Yani kernel.js'in "mekanik olarak çıkarılabilir" kısmı zaten çıkarılmış; kalan 1430 satır **gerçekten sınıf içi mantık**.

Kurala uygun fonksiyonel seam'ler:

**Seam K1 — Öğrenme admission zinciri** (~180 satır toplam: `_runBeforeLearn` + `_runPreIngest` + `_evaluateLearnAdmission` + `_admissionReceiptDetails`):
- `lib/kernel-admission-chain.js` olarak ayrılabilir **ancak** ancak learn admission politikasında fonksiyonel bir değişiklik (örn. yeni admission kararı tipi, yeni kanıt alanı) yapılırken.

**Seam K2 — Background provenance** (`_commitBackgroundEdge` 82 + `_backgroundProvenance` + audit):
- `lib/background-provenance.js` zaten var! Kernel.js bu modülü kullanıyor. `_commitBackgroundEdge`'in geri kalanı bu modüle **delege edilerek** sınıf küçültülebilir — bu fonksiyonel bir görev (delegation + API netleştirme).

**Seam K3 — Auto-think** (`_autoThinkTick` 59 + `startAutoThink` + `stopAutoThink`):
- `lib/auto-think-engine.js` — ancak auto-think mantığında bir değişiklik (interval, tick policy, budget) yapıldığında JIT.

**Seam K4 — Çapraz bağlantı** (`_crossLink` 59):
- FAZ2 benzerlik kenarları zaten tanımlı bir fonksiyonel alan. FAZ2 PR'ında `_crossLink` + derived-edge mantığı `lib/derived-similarity.js`'e JIT bölünebilir.

---

## 4. Önerilen sıralama ve kararlar

| Adım | Dosya | Tür | Hedef satır | Ratchet düşüşü? |
|---|---|---|---|---|
| 1 (V2-A) | kernel.v2.js → `lib/kernel-v2-native.js` | Mekanik | 975 → ~880 | Hayır (880 > 800) |
| 2 (V2-C) | kernel.v2.js → `lib/text-safety-scorer.js` | Fonksiyonel | ~880 → ~760 | **Evet** |
| 3 (K2) | kernel.js → `lib/background-provenance.js` delegation | Fonksiyonel | 1543 → ~1440 | Hayır |
| 4 (K1/K3/K4) | kernel.js | JIT (fonksiyonel PR'larda) | kademeli | Uzun vadede evet |

**Öneri:** İlk PR V2-A + V2-C'yi birlikte yapar (tek amaç: "KernelV2'den metin güvenliği ve native yardımcı katmanını ayır"). İkinci PR K2 (background provenance delegation). K1/K3/K4 ilgili fonksiyonel işler açıldığında JIT.

**Risk notu:** V2-A'da `OPPOSITE_PREDICATES` module-init mutasyonu içerir — yeni modül require edildiği an init çalışır; KernelV2 aynı davranışı korur. Test kanıtı: mevcut `kernel.v2.test.js` + `arch-4-agent-version-parity` contract testleri.

---

## 5. Beklenen sonuç (tüm adımlar sonrası)

- kernel.v2.js: **975 → ~760** → ratchet'ten çıkar
- kernel.js: **1543 → ~1440** (K2 sonrası); kalan K1/K3/K4 JIT adımlarıyla uzun vadede <800 hedefi
- Toplam ratchet: 12 → **10** (V2 tamamlandığında)
