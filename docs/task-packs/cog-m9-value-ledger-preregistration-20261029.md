# M9 değer defteri H1: ölçüm öncesi kayıt

İlgili iş: [#4063](https://github.com/ali-ulu/huqan/issues/4063) (epic [#4060](https://github.com/ali-ulu/huqan/issues/4060)).
Kapsam: kontrollü, store'suz Lab ölçümü; genel görev kazanımı deneyi değildir.

Bu belge, ölçüm kodu ve karakterizasyon testi çalıştırılmadan önce ayrı imzalı
commit ile sabitlenir. Sonuçlar bu metne sonradan eklenmez; ayrı bir sonuç
belgesi ve ilgili PR üzerinden raporlanır. Ön-kayıt §9'un istediği hipotez,
eşikler, seed'ler ve karar kuralları burada **sonuç görülmeden** dondurulur.

## 1. Kaynak ve kapsam

- Başlangıç kaynak SHA: `1f3907de2e482fdb76122d0019106bd0c77d33fe` (main, dirty: false).
- M9 çekirdeği: `lib/cognition/value-ledger.js` (`SCHEMA huqan-cognition-value-ledger-v1`).
- Saf beklenti sinyali: `lib/cognition/reward-signal.js` (`rewardForOutcome`, `RPE_BOUND`).
- Eşli değerlendirme kontratı: `lib/cognitive-lab-paired-delta.js`.
- Yeni ölçüm modülü: `lib/cognitive-lab-m9-evaluator.js`.
- Ölçüm yüzeyi: `lib/cognitive-lab-cli.js` — `value-ledger --value-ledger-records FILE`.
- Yeni test: `test/cognition-value-ledger-characterization.test.js`.

Mevcut M9 çekirdeği, `rewardForOutcome` sözlüğü ve eşli delta kontratı olduğu
gibi kullanılır. Üretim kodu, eşik, model, varsayılan, `opts.cognition.value`
seam'i ve wiring ledger'ı değişmez.

## 2. Hipotez H1 (ön-kayıt §9)

> Ayrı `success.p` tahmini, bir sonraki gözlenmiş sonucun `confirmed` olması
> hedefinde, aynı prior'ı kullanan anahtar-bağımsız taban oranından daha iyi
> olur. Beklenen ödül `V` bu deneyin p değeri **değildir**.

- **Aday kol (candidate):** defterin anahtar başına `success.p` değeri,
  `(nConfirmed+1)/(nObserved+2)` prior'ı ile.
- **Taban kol (baseline):** aynı prior'ın, anahtardan bağımsız olarak
  karar-öncesi penceredeki tüm gözlenmiş sonuçlara uygulanmış hâli.
- **Hedef:** her holdout kararı için `y=1` (confirmed) / `y=0` (diğer bilinen
  gözlenmiş sonuçlar). `censored`/bilinmeyen sonuç dışlanır; sessiz sıfır sayılmaz.

`V`'nin p'ye çevrilmesi yasaktır. Bütün sonuçlar `compensation` olsa ödül `-0.5`
olabilir ama gerçek confirmed oranı `0`'dır; bu ayrım açıkça etiketlenir.

## 3. Zaman sıralı predict-then-update

Her holdout kararının tahmini **yalnız o ana kadar kullanılabilir geçmişten**
üretilir:

- Kararın kendi sonucu ve karardan sonra gelen kayıtlar tahmine giremez
  (`buildValueLedger` `historyBoundary` + `availableAt ≤ at` süzgeci).
- Eğitim / kalibrasyon / holdout grupları `split` alanıyla ayrıdır; yalnız
  `split:'holdout'` kararları skorlanır. Seçilmiş başarılı kayıtlar üzerinden
  kapsam gizlenmez: aday desteği `MEASURED` olmayan holdout kararı her iki
  koldan da düşülür ve `coverage.uncovered` olarak raporlanır.
- Taban kol, aday ile aynı pencereyi ve defterin kendi `MAX_EVENTS` tavanını
  okur; iki kol "karar öncesi" konusunda çelişemez.

## 4. Donmuş eşli kontrat

Eşli Brier delta, ECE non-inferiority ve eşit bütçe kontrolü mevcut
`pairedCalibrationDelta` üzerinden alınır. Kontrat sonuç görülmeden dondurulur:

| Alan | Değer |
| --- | --- |
| method | `seeded-paired-bootstrap` |
| seed | `40630` |
| resamples | `2000` |
| confidenceLevel | `0.95` |
| meaningfulEffect | `0` |
| nonInferiorityMargin | `0.05` |
| minimumSamples | `10` |
| direction | `lower-brier-is-better` |

Bilinmeyen alan veya eksik alan reddedilir; skorlama anında eşik seçilemez.
`minimumSamples=10`, defterin kendi `MIN_SAMPLES=3` bağımsız-destek kapısından
farklıdır: iç kapı anahtar başına desteği, dış kapı eşli örneklem sayısını
kapatır. Sayısal prior yeterli kanıt yerine geçmez.

## 5. Karar kuralları (sonuç görülmeden, öncelik sırası)

1. Eşleşmeyen kollar veya geçersiz kayıt → `REJECT`.
2. Eşli örneklem `minimumSamples` altında, boş holdout veya hiç kapsanmış karar
   yoksa → `INSUFFICIENT`. Uydurma ölçüm üretilmez.
3. Aksi halde `MEASURED`; etiket Brier aralığından:
   - `lower > meaningfulEffect` → **GAIN** (`paired_gain_measured`);
   - `upper < 0` → **ZARAR** (`interval_upper_below_zero`);
   - aksi → **NOT_CLEARED** (`interval_below_meaningful_effect`).

Zarar da kazanç kadar raporlanır. ECE non-inferiority ayrı raporlanır ama
etiket yalnız Brier aralığına bağlıdır: defterin `p` değeri bir kalibrasyon
ölçümü geçmeden kalibre ilan edilmez (§9), bu yüzden ECE etiketi
kilitlenmez — yalnız bilgi olarak taşınır.

**`assertsGain` her durumda `false`'tur.** Daha iyi kalibrasyon tek başına daha
iyi görev başarısı sayılmaz (§9). Varsayılan yapma kararı yalnız ön-kayıtlı
kazanım **ve** G3 birleşik sistem kabulü sonrası, ayrı PR'da değerlendirilir
(§10); bu belge hiçbir varsayılanı değiştirmez.

## 6. Önceden belirlenen kabul koşulları

1. Her etiket sınıfı (GAIN / ZARAR / NOT_CLEARED), donmuş sabit bir corpus
   üzerinden kendi ön-kayıtlı etiketine %100 uymalı.
2. Aynı corpus iki koşuda ve gerçek CLI girişi (`bin/huqan-cognitive-lab.js`)
   üzerinden bayt-bayt aynı JSON'u üretmeli (saat, rasgelelik veya store yoktur;
   yalnız seed'e bağlı deterministik alanlar).
3. Boş corpus `INSUFFICIENT` döndürür; eksik dosya store açmadan fail-closed olur.
4. Kapsam (`holdoutTotal`, `covered`, `uncovered`) her raporda bulunur; aday
   desteği olmayan karar gizlenmez.
5. Zaman sıralaması kanıtlanır: bir kararın kendi sonucu veya sonraki kayıt
   o kararın tahminini değiştirmez.
6. Alt komut store açmaz ve kanonik belleğe yazmaz; `assertsGain` her koşuda
   `false`, `intelligenceGain` `NOT_MEASURED`'dur.
7. Defter sinyali hiçbir risk eşiğini, firewall kararını veya capability trust
   rung'ını değiştirmez; modül yalnız puanlar (`SIGNAL_ONLY`), eylem yetkisi almaz.

## 7. Doğrulama ve iddia sınırı

Yeni dosya için `node --test test/cognition-value-ledger-characterization.test.js`;
mevcut `test/cognition-value-ledger.test.js` ve Lab CLI wiring testleriyle
regresyon; `check:file-size`, `check:layers`, `check:cycles`,
`check:architecture-trackers`, `check:module-boundary`, `check:coverage`,
lint ve `git diff --check` çalıştırılır.

Geçen test, bu sınırlı etiket/determinizm/fail-closed sözleşmesini gösterir.
M9 sinyalinin üretim kararıyla ilişkisini, G1 gerçek gözlem bağlantısını
(#4064/#4065) veya G3 birleşik kabulünü kanıtlamaz. M9'un G1 katkısı (§9 son
maddesi) sonraki seçim/hata oranında ayrıca gözlenir; bu ölçüm onu kapsamaz.
#4063 kapanışı ayrıca canlı issue kabul koşullarına göre değerlendirilir.

## 8. Bağlama notu

M9 çekirdeğinin üretim çağıranları (`lib/agent-cognition-seam.js`,
`lib/cognition-value-ledger-pairs.js`) zaten vardır; bu PR üretim çağıranı
eklemez. `lib/cognitive-lab-cli.js`'e eklenen
`value-ledger --value-ledger-records` alt komutu yalnızca opt-in ölçüm
yüzeyidir: mevcut davranış bayrak verilmeden bayt-bayt aynı kalır, wiring
ledger ve reachability baseline bu PR'da değişmez.
