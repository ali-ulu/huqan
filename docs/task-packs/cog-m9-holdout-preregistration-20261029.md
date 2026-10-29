# M9 değer defteri holdout corpus üreteci: ölçüm öncesi kayıt

İlgili iş: [#4388](https://github.com/ali-ulu/huqan/issues/4388) (epic [#4060](https://github.com/ali-ulu/huqan/issues/4060)).
Modül: [#4063](https://github.com/ali-ulu/huqan/issues/4063) (COG-M9). Precedent: M7/G1 #4353 → #4357 → #4370.

Bu belge, ölçüm kodu çalıştırılmadan önce ayrı imzalı commit ile sabitlenir.
Sonuçlar bu metne sonradan eklenmez; ayrı bir sonuç belgesi ve ilgili PR
üzerinden raporlanır. Hipotez, eşikler, seed'ler ve karar kuralları burada
**sonuç görülmeden** dondurulur.

## 1. Kaynak ve kapsam

- Başlangıç kaynak SHA: `ee4c4ba6c5f53066f2439121f055c66b6bc8d798` (main, dirty: false).
- Yeni üreteç: `lib/cognitive-lab-m9-corpus.js` (`SCHEMA huqan-m9-corpus-v1`).
- Yeni koşucu: `lib/cognitive-lab-m9-holdout.js` (`SCHEMA huqan-m9-manifest-v1`).
- Ölçüm modülü (değişmez): `lib/cognitive-lab-m9-evaluator.js` (#4063, kilitli).
- Eşli kontrat (değişmez): `lib/cognitive-lab-paired-delta.js` — seed `40630`, 2000 tekrar, `confidenceLevel 0.95`, `meaningfulEffect 0`, `nonInferiorityMargin 0.05`, `minimumSamples 10`.

Üretim kodu, defter çekirdeği (`lib/cognition/value-ledger.js`),
`opts.cognition.value` seam'i ve wiring ledger'ı değişmez. M9 opt-in kalır;
`assertsGain` bu PR'da her koşulda `false`'tur.

## 2. Hipotez H1

> Defterin anahtar başına `success.p` tahmini, bir sonraki gözlenmiş sonucun
> `confirmed` olması hedefinde, aynı prior'ı taşıyan anahtar-bağımsız taban
> oranından daha iyi olur. `success.p` p-değeri değildir; beklenen ödül `V` bu
> deneyin p değeri değildir.

- **Aday kol:** defterin `success.p` değeri, `(nConfirmed+1)/(nObserved+2)` prior'ı ile.
- **Taban kol:** aynı prior'ın karar-öncesi penceredeki tüm gözlenmiş sonuçlara uygulanmış hâli.
- **Hedef:** her holdout kararı için `y=1` (confirmed) / `y=0` (diğer bilinen
  olumsuz sonuçlar). `censored`/bilinmeyen sonuç dışlanır.

## 3. Task corpus'u (üreteç)

- **Anahtar bantları (heterojen profil, dondurulmuş):** `[0.9, 0.85, 0.8, 0.75, 0.7, 0.3, 0.25, 0.2, 0.15, 0.1]`.
- **Anti-vaka (uniform profil, dondurulmuş):** her anahtar `0.5` — anahtar-başına
  sinyal yoktur, ölçüm kazanç **bulamamalıdır**.
- **Bölme satırları (dondurulmuş):** `train/calibration/holdout` her biri
  anahtar başına `24` karar → bölme başına `240` karar.
- **Olumsuz sonuç sözlüğü:** `rollback`, `reviewer-rejection`, `compensation`,
  `contradiction`, `incident` (M9 `rewardForOutcome` sözlüğü).
- **Zaman:** bütün corpus boyunca tek monoton saat, bölme sırasında; her train
  kararı her calibration kararından önce, o da her holdout kararından öncedir.

## 4. Bölme ve sızıntı

- Anahtarlar seed ile Fisher-Yates karıştırılır; **yeniden örneklenmez**, böylece
  bölme boyutları dondurulmuş kalır.
- `auditSplits` fail-closed'dur: karar kimlikleri corpus genelinde benzersiz,
  her karar kendi `at`'inde ya da sonrasında `availableAt`'e sahip, ve hiçbir
  anahtarın kararları bölme sırası dışında görünmez.
- `auditSplits.status` `LEAK` ise manifest `REJECT`; `UNAVAILABLE` ise `INSUFFICIENT`.

## 5. Ölçü, etki ve örnek sayısı

- **Birincil ölçü:** eşli Brier deltası (taban − aday; pozitif aday daha iyi).
- **Etki (dondurulmuş):** `MIN_EFFECT = 0.05`.
- **Güç (dondurulmuş):** `alpha 0.05` / `power 0.8` için `z_alpha 1.96`, `z_power 0.84`.
- **Örnek formülü (dondurulmuş):** `n = ceil(((z_alpha + z_power) * sigma / MIN_EFFECT)^2)`,
  en az `CONTRACT.minimumSamples = 10`.
- **sigma:** calibration bölümünün eşli Brier deltalarından, `n − 1` paydalı örnek
  standart sapması, **holdout açılmadan** ölçülür ve manifeste yazılır.
- Güç hesabı holdout'un sağlayabildiğinden büyükse (`powerMet=false`), ölçüm
  `INSUFFICIENT` döner; küçük örnek numara gibi sunulmaz.

## 6. Karar kuralları (sonuç görülmeden, öncelik sırası)

1. Eşleşmeyen kollar, geçersiz kayıt veya bölme sızıntısı → `REJECT`.
2. `powerMet=false`, boş holdout veya eşli örneklem `minimumSamples` altında → `INSUFFICIENT`.
3. Aksi halde `MEASURED`; etiket kilitli eşli-delta aralığından:
   - `lower > meaningfulEffect(0)` → **GAIN**;
   - `upper < 0` → **HARM**;
   - aksi → **NOT_CLEARED**.

Etiket yalnız Brier aralığına bağlıdır; ECE non-inferiority bilgi olarak taşınır.
**`assertsGain` her durumda `false`'tur** (§9): daha iyi kalibrasyon tek başına
daha iyi görev başarısı değildir.

## 7. İddia sınırı

Bu ölçüm yalnız M9/H1 kalibrasyon sorusunu, **seçilmemiş bir holdout** üzerinden
yanıtlar. M9 sinyalinin üretim kararıyla ilişkisini, G1 gerçek gözlem bağlantısını
(#4064/#4065) veya G3 birleşik kabulünü (#4060) kanıtlamaz. Varsayılan/opt-in
durumu değişmez; varsayılan yapma kararı ayrı bir PR'da, kazanım **ve** G3 kabulü
sonrası değerlendirilir.

## 8. Anti-vaka ve kilit

- **Anti-vaka (uniform profil):** kazanç bulunmamalı; calibration manifesti
  `antiCase.uniform.gain=false` kaydeder.
- **Kilit tablosu:** `MIN_EFFECT`, güç hesabı, `sigma`, `requiredSample`,
  `powerMet`, `minimumSamples`, seed'ler ve `corpusDigest` holdout açılmadan
  manifeste yazılır.
- **Tek-kullanım:** holdout raporu `'wx'` ile yazılır; ikinci koşu
  `M9_HOLDOUT_ALREADY_RUN` ile reddedilir.
- **Değişmezlik:** holdout, her parmak izi (`corpus`, `evaluator`, `runner`,
  `preregistration`) manifesttekiyle bayt-bayt aynı değilse `M9_MANIFEST_MISMATCH`
  ile durur.

## 9. Bağlama notu

Bu PR üretim çağıranı eklemez; M9 çekirdeğinin canlı çağıranları zaten vardır
(`lib/agent-cognition-seam.js`, `lib/cognition-value-ledger-pairs.js`). Yeni iki
modül standalone koşucudur (`lib/module-reachability.js` `STANDALONE_FILES`), G1
emsali gibi; Lab CLI'ya bağlanmaz, store açmaz, kanonik belleğe yazmaz.
`assertsGain` `false`, `intelligenceGain` `NOT_MEASURED`'dur.
