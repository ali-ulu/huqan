# M2 tahmin hatası karakterizasyonu: ölçüm öncesi kayıt

İlgili iş: #4061 (epic #4060). Kapsam: kontrollü karakterizasyon; genel kazanım
deneyi değildir. Bu belge yeni karakterizasyon testi çalıştırılmadan önce ayrı
imzalı commit ile sabitlenir. Sonuçlar bu ön-kayıt metnine sonradan
eklenmez; test/CI çıktısı ve ilgili PR üzerinden raporlanır.

## Kaynak ve kapsam

- Başlangıç kaynak SHA: `702aa9a873ef56a8b15c0d711b78384db96762a5`.
- M2 çekirdeği: `lib/cognition/prediction-error.js`; Git blob:
  `6d764daf2325d52e516c8a2bf7c8e7e0f08601bd`.
- Ölçüm yüzeyi: `lib/cognitive-lab-cli.js`; Git blob (ön-kayıt öncesi):
  `1cc280d753cdfa2a9982cc74e21cda9377bebddd`.
- Yeni test: `test/cognition-prediction-error-characterization.test.js`.
- Mevcut M2 çekirdeği, `comparePredictionOutcome` ve `file-effect-sensor`
  gözlem sözlüğü olduğu gibi kullanılır. Üretim kodu, eşik, model,
  varsayılan veya `RISK_LEVEL_BANDS` değişmez.

Bu çalışma B1 replay koşusu değildir: #4061 §9'un istediği her sonuç sınıfı
(MEASURED / ABSTAIN / REJECT) dört türde (risk, probability, state, effect)
açık sabit girdilerle ayrı ayrı sınanır. Girdiler test içinde sabittir;
gerçek görev örneklemi değildir ve istatistiksel kazanım çıkarılmaz.

## Önceden belirlenen kabul koşulları

1. Her sınıf için beklenen etiket %100 tutmalı; tek bir uyumsuzluk
   karakterizasyonu başarısız sayar.
2. Risk skoru asla olasılığa çevrilmez. `score >= 50` HIGH öngörüsüdür:
   adverse sonuçta `signedError = adverse(1/0) − predictedHigh(1/0)`,
   confirmed sonuçta tersi. Censored ve unscored ABSTAIN'dir
   (`outcome_unknown_or_censored`, `prediction_unscored`).
3. Probability'de `signedError = y − p` ve
   `surpriseBits = min(20, −log2(max(1e-6, y===1 ? p : 1−p)))`:
   `p=0.9, y=0` için `−0.9` ve `3.321928`; `p=0.9, y=1` için `0.1` ve
   `0.152003`. `probabilitySource` eksikse ABSTAIN; `p` aralık dışıysa REJECT.
4. State'te `CONFIRMED → 0`, `MISMATCH → differences.length / keyCount`
   (2/4 için `0.5`); `failure.status === 'UNKNOWN'` ABSTAIN;
   `keyCount` geçersizse REJECT.
5. Effect'te `expected === observed → 0`, aksi halde `1`;
   `indeterminate` gözlem ABSTAIN'dir, başarı sayılmaz.
6. Bilinmeyen `kind` ve bilinmeyen alan REJECT'tir
   (`unknown_kind`, `unknown_field:<alan>`).
7. Rapor deterministic'tir: aynı kayıt dosyasının iki koşusu
   bayt-bayt aynı JSON'u üretir (saat, rasgelelik veya store yoktur).
8. Boş kayıt kümesi `status: 'INSUFFICIENT'` döndürür; uydurma ölçüm üretilmez.
9. Alt komut store açmaz, kanonik belleğe yazmaz; `bin/huqan-cognitive-lab.js`
   üzerinden çağrıda kanonik memory içeriği değişmez.
10. Hata sinyali hiçbir risk eşiğini, firewall kararını veya wiring ledger'ını
    değiştirmez; modül yalnız puanlar (SIGNAL_ONLY), eylem yetkisi almaz.

## Doğrulama ve iddia sınırı

Yeni dosya için `node --test test/cognition-prediction-error-characterization.test.js`;
mevcut `test/cognition-prediction-error.test.js`,
`test/cognition-prediction-error-pairs.test.js` ve Lab CLI wiring
testleriyle regresyon; `check:layers`, `check:import-cycles`, `check:file-size`,
lint ve `git diff --check` çalıştırılır.

Geçen test, bu sınırlı etiket/determinizm/fail-closed sözleşmesini gösterir.
M2 sinyalinin üretim kararıyla ilişkisini, G1 gerçek gözlem bağlantısını
(#4064/#4065), M7/M3/M10 kazanımını veya G3 birleşik kabulünü kanıtlamaz.
#4061 kapanışı ayrıca canlı issue kabul koşullarına göre değerlendirilir.

## Bağlama notu

M2 çekirdeğinin üretim çağıranı M7 seam'i (`lib/agent-cognition-seam.js`)
zaten vardır; bu PR üretim çağıranı eklemez. `lib/cognitive-lab-cli.js`'e
eklenen `prediction-error --prediction-error-records` alt komutu yalnızca
opt-in ölçüm yüzeyidir: mevcut davranış bayrak verilmeden byte-byte aynı
kalır, wiring ledger ve reachability baseline bu PR'da değişmez.
