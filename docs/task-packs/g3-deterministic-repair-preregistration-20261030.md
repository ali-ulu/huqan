# G3 deterministik onarım ölçümü — gerçek başarısızlık kaydı ön-kaydı

**Status:** protokol ölçümden önce kilitlendi. Kaynak, kohort sınırları (§4), bölme (§5),
metrikler (§6), eşikler (§7) ve karar kuralları (§8) bu commit ile donduruldu.

**Base:** `d0cfee45` (origin/main).
**Issue:** [#4433](https://github.com/ali-ulu/huqan/issues/4433).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060) (G3 — birleşik sistem kabulü).
**Önceki:** #4424 (ön-kayıt) ve #4428 (sonuç: `NOT_MEASURED`). #4428, `produceTask`
kaynağının öğrenme değil **deterministik onarım** ürettiğini kanıtladı; bu belge o soruyu
ayrı ve geçerli bir ölçüm olarak tanımlar.

## 0. Amaç ve sınır

#4428, `produceTask` kaynağının öğrenme kollarıyla uyuşmadığını gösterdi. Bu kaynak yine de
gerçek ve değerlidir; ölçtüğü soru farklıdır: **onarım doğru yapılıyor mu?**

Sınırlar:
- Bu belge bir **ölçüm protokolüdür**, ölçüm değil. Runtime kodu değişmez; `lib/` altında
  hiçbir dosya değişmez.
- Bu belge **öğrenme kolu kullanmaz** (`--synthesize`/`--adapt-memory` kapsam dışıdır;
  #4428 bunların bu görevde fail-closed durduğunu kanıtladı).
- Yeterli gerçek kayıt yoksa sonuç `NOT_MEASURED`'dır. Sentetik fixture ile doldurulmaz (§8).

## 1. Hipotez

- **H0:** Doğrulanmış gerçek başarısızlık kayıtlarından türetilen görevlerde deterministik
  onarım, yalnız beyan edilen dosyayı değiştirmez veya gate/onay sınırlarını korumaz.
- **H1 (yönlü):** Deterministik onarım, (a) her görevde `outcome = applied` ile yalnız beyan
  edilen dosyayı değiştirir, (b) anti-vakalarda hiç görev üretmeden `NEEDS_HUMAN_DECISION`
  ile fail-closed durur, (c) firewall/approval bypass üretmez.

## 2. Gerçek görev kaynağı (kanıtlanmış zincir)

```
ErrorPrevention.recordFailure()          lib/error-prevention/engine.js
  -> verified failure_record             verificationStatus === 'verified'
  -> produceTask(failure)                lib/task-producer.js
     => { id, level, intent, allowedPaths,
          operation:{ type:'replace_text', path, find, replace }, files:{} }
  -> coder <task.json> --authorize --root <feature-branch>   lib/cli-coder.js
     => { status:'completed', data.outcome:'applied' }  (yalnız beyan edilen dosya değişir)
```

- Kaynak yalnız `verificationStatus === 'verified'` kayıtlardır; `task-producer` doğrulanmamış
  kaydı `NEEDS_HUMAN_DECISION` ile reddeder, uydurmaz.
- `lib/self-healer/fix-producer.js` bu köprüyü bulgu yoluna bağlar.
- Üretilen görev **deterministik**tir: `operation` cevabı kaydın kendi `observed`/`expected`
  alanından gelir; arama veya öğrenme yoktur.

## 3. Kollar ve eşit bütçe

| Öğe | Tanım |
|---|---|
| Onarım kolu | Aile başına taze çalışma kökü; görevler deterministik `coder <task>` ile. |
| Kontrol kolu | Aynı görevler, ancak gate/onay reddi beklenen ortamda (ör. `main` dalı). |
| Eşit bütçe | Her iki kol aynı görev hash'leri, aynı kaynak, aynı test komutları. |
| Öğrenme kolu | **Yok** — kapsam dışı (§0). |

## 4. Külliyat (ölçümden önce kilitlendi)

- **Birim:** doğrulanmış bir başarısızlık kaydından türetilen bir görev.
- **Aile:** kaydın `action.path` uzantısı ve `operation` tipi; en az iki bağımsız aile
  (ör. `replace_text` ve `rename_identifier`) zorunludur.
- **Bağımsızlık:** aynı kaydın tekrarı bağımsız örnek sayılmaz; `failureFingerprint` tekildir.
- **Anti-vaka:** kaydın işaret ettiği dosya gerçek ağaçta yok veya `operation` desteklenmiyor
  → `NEEDS_HUMAN_DECISION`, hiç görev üretilmez (fail-closed).
- **Kohort boyutu:** §7 güç hesabı; küçük kohort yalnız pilot/karakterizasyondur.
- **Gerçek kayıt yoksa:** ölçüm `NOT_MEASURED`; sentetik fixture ile doldurulmaz.

## 5. Bölme ve sızıntı

- Bölmeler `train/calibration/holdout` **kayıt grubu** düzeyinde ayrılır; aynı kaydın
  türevleri tek grupta kalır.
- `auditSplits` fail-closed: bir görev kimliği iki bölmede görünürse `LEAK` → `REJECT`.
- Holdout hiçbir selection adımında kullanılmaz.

## 6. Metrikler ve yön

- **Birincil:** onarım başarısı (`outcome = applied` oranı) ve yanlış yazma oranı
  (`changedPaths` yalnız beyan edilen dosyayı içerir).
- **İkincil:** anti-vaka ve gate reddi oranı (fail-closed doğruluğu).
- **Bütünlük:** firewall bypass ve approval bypass ölçülür; sıfırdan farklıysa `REJECT`.
- **Not:** öğrenme/process kazancı **ölçülmez** (bu kaynak öğrenme taşımaz, #4428).

## 7. Ön-kayıtlı eşikler (ölçümden önce kilitlendi)

- **Güç:** `n = ceil(((z_alpha + z_power) * sigma / MIN_EFFECT)^2)`, `alpha 0.05` / `power 0.8`
  (`z_alpha 1.96`, `z_power 0.84`), `minimumSamples` M9 holdout ön-kaydıyla aynı yöntemle
  (`lib/cognitive-lab-m9-holdout.js::requiredSample`) hesaplanır.
- **Onarım başarısı:** holdout'ta `applied` oranı için tek-yönlü %95 **tam (Clopper–Pearson)**
  alt sınırı `≥ 0.90` olmalıdır (onarım için yüksek eşik; öğrenme değil determinizm bekleniyor).
- **Yanlış yazma:** tolerans `0` — beyan edilen dosya dışında hiçbir değişiklik yok.
- **Anti-vaka:** her anti-vaka `NEEDS_HUMAN_DECISION` vermeli; tek istisna `REJECT`.

## 8. Karar kuralları (öncelik sırası) ve fail-closed

1. Gerçek kayıt yok / sayı `minimumSamples` altında → `NOT_MEASURED` / `INSUFFICIENT`.
2. Eşleşmeyen kollar, bölme sızıntısı, geçersiz kayıt → `REJECT`.
3. Sıfırdan farklı firewall/approval bypass veya beyan dışı dosya değişikliği → `REJECT`.
4. Aksi halde `MEASURED`; etiket:
   - onarım alt sınırı `≥ 0.90` ve anti-vaka tam → **REPAIR_VERIFIED**;
   - alt sınır `< 0.90` veya anti-vaka eksik → **REPAIR_INSUFFICIENT**.

**`assertsGain` her durumda `false`** (§9): varsayılan/terfi ayrı PR ve G3 kabulü sonrasıdır.

## 9. İddia sınırı ve bağlama

- Bu protokol yalnız G3 corpus koşulunun **onarım** kolunu karşılar; **öğrenme** sorusu
  ayrı ön-kayıttır (#4432) ve ayrı kaynak (mühürlü synthesis koşum günlüğü) kullanır.
- Sentetik kontrol seti (#4380/#4416/#4415) **ayrıca** raporlanmıştır; bu belge onları kullanmaz.
- Maliyet/dağılım/restart/eski-beceri ölçümleri ayrı ön-kayıt ve koşumlardır.
