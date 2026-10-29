# M9 değer defteri H1 ölçüm sonucu — KONTROLLÜ FİKSTÜR

**Ön-kayıt:** `docs/task-packs/cog-m9-value-ledger-preregistration-20261029.md` (KİLİTLİ; PR-2).
Bu belge onu **değiştirmez**; ön-kayıt §6 gereği sonuç ayrı rapor olarak verilir.
**İlgili iş:** #4063 (epic #4060). **Precedent:** M7/G1 #4353 → #4357 → #4370.

## 1. Sonuç

**Etiket: KONTROLLÜ FİKSTÜR (characterization), gain iddiası yok.**

Ölçüm yüzeyi çalışır ve kilitli kontrat altında **her ön-kayıtlı etiketi**
donmuş bir corpus üzerinden üretir. Ama M9 için bir **holdout corpus
üreticisi yoktur** (`lib/cognitive-lab-g1-corpus.js` G1 içindir; M9'un karşılığı
yoktur). Bu yüzden bu belge bir **kazanç ölçümü değildir**: gerçek, seçilmemiş
bir holdout üzerinden H1 koşulmamıştır ve `assertsGain` `false`'tur.

| Ölçü | Değer |
| --- | --- |
| Yüzey | `bin/huqan-cognitive-lab.js value-ledger --value-ledger-records FILE` |
| Donmuş corpus (GAIN sınıfı) | 18 holdout kararı, kapsam 18/18, uncovered 0 |
| Durum | `MEASURED` |
| Etiket | `GAIN` (`paired_gain_measured`) |
| Eşli Brier ortalaması | **+0,253897** (aday daha iyi) |
| %95 eşli bootstrap GA | **[0,212876, 0,298331]** (2000 tekrar, seed 40630) |
| ECE non-inferior | true |
| `assertsGain` | **false** |
| `intelligenceGain` | `NOT_MEASURED` |

`lower > meaningfulEffect(0)` olduğu için etiket GAIN'dir (§5 öncelik 3). Etiket,
kazanç iddiasından bağımsız olarak yalnız **fiks tür sınıflandırması** olarak
raporlanır; `assertsGain` her koşuda `false` kalır.

## 2. Karakterizasyon oracle'ı (donmuş, sabit)

Her etiket sınıfı, ön-kayıt §6'da yazılı olduğu gibi sabit bir corpus üzerinden
%100 tutmalıdır. Sabit corpus'lar (satır sayıları donmuş):

| Sınıf | Durum | Etiket | Ortalama | %95 GA | ECE NI | Kapsam |
| --- | --- | --- | --- | --- | --- | --- |
| GAIN | MEASURED | `GAIN` | +0,253897 | [0,212876, 0,298331] | true | 18/18 |
| ZARAR | MEASURED | `HARM` | −0,228954 | [−0,302556, −0,160627] | false | 18/18 |
| NOT_CLEARED | MEASURED | `NOT_CLEARED` | −0,103982 | [−0,240952, 0,028015] | false | 18/18 |
| Yetersiz | INSUFFICIENT | — | — | — | — | 3/3 |
| Boş | INSUFFICIENT | — | — | — | — | 0/0 |

Test: `test/cognition-value-ledger-characterization.test.js` (5 test). Sayılar
seed'e bağlı deterministiktir; makine hızına göre değişen alan yoktur.

## 3. Ön-kayıtla uyum

- §2: aday `success.p`, taban anahtar-bağımsız taban oranı; `V` p'ye çevrilmedi.
- §3: zaman sıralı predict-then-update; karar kendi sonucunu ve sonraki kaydı
  görmez (test: ilk holdout kararı yalnız 18 eğitim satırını görür, prior 10/11).
- §4: kontrat dondurulmuş (seed 40630, 2000 tekrar, margin 0,05, minimum 10).
- §5: etiket öncelikli kümeden; zarar da raporlanır; `assertsGain=false`.
- §6: etiket sınıfları, determinizm, boş→INSUFFICIENT, fail-closed, kapsam ve
  zaman-sızıntısı koşulları test edildi.

## 4. Kapsam ve iddia sınırı

Ön-kayıt §7 aynen geçerlidir. Bu ölçüm, M9 defterinin H1 yüzeyinin donmuş bir
kontrat altında doğru etiket ürettiğini gösterir. **Gerçek görev başarısını,
G1 gerçek gözlem bağlantısını (#4064/#4065) veya G3 birleşik kabulünü
kanıtlamaz.** M9'un G1 katkısı (§9 son maddesi) sonraki seçim/hata oranında
ayrıca gözlenir; bu belge onu kapsamaz.

**Üretim varsayılanı değişmez** (§10): hiçbir etiket varsayılanı kendiliğinden
değiştirmez; `opts.cognition.value` opt-in kalır ve varsayılan yapma kararı
yalnız ön-kayıtlı kazanım **ve** G3 kabulü sonrası ayrı PR'da değerlendirilir.

## 5. Kanıt

Ham rapor (GAIN sınıfı): `docs/task-packs/cog-m9-value-ledger-result-20261029.json`.
Deterministik alanlar (`coverage`, `h1`, `contract`, `assertsGain`) seed'e
bağlıdır ve iki koşuda bayt-bayt aynıdır; duvar süresi/bellek raporlanmaz
(ölçüm store açmaz, saat kullanmaz).
