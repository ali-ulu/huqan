# COG-M3 — bağımsız aile korpusu H1 sonucu (result)

**Ön-kayıt:** `docs/task-packs/cog-m3-h1-preregistration-20261101.md` (protokol ölçümden önce
ayrı commit ile kilitlendi).
**Base:** `ef9e2d65` (origin/main). **Issue:** [#4465](https://github.com/ali-ulu/huqan/issues/4465).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060).
**Eval:** `test/cog-m3-h1-corpus.test.js` (`node --test test/cog-m3-h1-corpus.test.js`).
**Önceki:** `cog-m3-replay-preregistration-20261027.md` (#4069 — protokol, külliyat yok) ve
`cog-m3-family-evaluation-contract.md` (#4469 — aile düzeyinde paired adapter).

## 1. Sonuç özeti

| Boyut | Sonuç |
|---|---|
| Kaynak (§2) | Gerçek `coder` mühürlü koşumları — **kanıtlandı**: aile başına 30 `positive_procedure` + 6 `negative_example` |
| Külliyat (§4) | **24 bağımsız holdout ailesi** + **8 transfer ailesi** (ilk 8 aile transfer görevi de taşır) |
| Kollar (§3) | A1 recent-K vs A2 priority, K = 32, kol başına ayrı journal kopyası |
| Kolların ayrışması (§4) | **24/24 aile non-inert** — A1 ve A2 farklı destek kümesi seçer |
| Sızıntı denetimi (§5) | source/qualification/evaluation **ayrık**; oracle hedef digest'leri qualification kümesinde değil; adapter `split_overlap` + `qualification_or_source_overlap` kapıları yeşil |
| Doğruluk (§6) | holdout aile-ortalama farkı **0.0** (A1 = A2 = her görevde doğru) |
| Transfer (§6) | transfer aile-ortalama farkı **0.0** |
| Yanlış yazma / ihlal | **0** (adapter `trust_violation` üretmedi) |
| Etki eşiği (§7) | `clearsEffect = false` (birincil alt sınır 0 ≤ 0) |
| Adapter durumu (§8) | **`MEASURED`** — `reason: family_paired_diagnostic` |
| H1 verdict (§8) | **`MEASURED_NO_GAIN`** (bu belgenin etiketi; adapter `status`'u değil) |
| `assertsGain` | **`false`** |

**H1 verdict: `MEASURED_NO_GAIN`.** Ölçüm geçerlidir (kaynak gerçek ve mühürlü, kohort kilitli,
kollar gerçekten ayrışıyor, sızıntı yok) ama **priority seçimi recent-K'ya göre doğruluk
kazancı üretmez**: iki kol da bağımsız oracle karşısında her holdout ve transfer görevinde
doğru sonucu verir, fark tam olarak sıfırdır. Bu, #4069'un "priority replay kazanç üretir mi"
sorusuna bu külliyatta **olumsuz** yanıttır; yanlış yazma 0'dır, yani kazanç yokluğu bir
regresyon değil, ölçülmüş bir eşitliktir.

## 2. Kaynak — mühürlü gerçek koşumlar

Aile başına kaynak günlüğü, gerçek `applyDerivation` (pozitif) ve `runFixLoop` (negatif)
koşumlarından oluşur. Her koşum hash-zincirli ve mühürlüdür:

```
readSealedRun(journal, '<id>:c1', 'default')
  => { ok:true, manifest.closed:true, learningEligibility, outcomeStatus }
```

Ölçülen kaynak bileşimi (her aile için aynı):

| Eligibility | Adet | Üretim yolu |
|---|---|---|
| `positive_procedure` | 30 | `applyDerivation`, doğrulama geçti |
| `negative_example` | 6 | `runFixLoop`, test asla geçmedi → geri alma, koşum failed |

Bu karışım, priority kolunun üzerinde çalıştığı sinyali (surprise + ödül işareti) taşır:
negatifler yüksek magnitude ile eski, pozitifler yeni. recent-K yalnız yeni pencereden seçer;
priority magnitude'dan seçer — bu yüzden iki kol ayrışır.

## 2b. Kilitli manifest (deterministik)

| Alan | Değer |
|---|---|
| `schemaVersion` | `huqan-cog-m3-family-evaluation-v1` |
| `protocolHash` | `17c3b4fa1bc5bcc2b4179f83e35a9cbb53014c598643a5385221ebdf4f6797d8` (adapter `PROTOCOL_HASH`'e pinli) |
| `oracleHash` | `429b4e2a79b27e639b8b8ba945eb06912d3ae752a6560c4eb66acdd04e8d543f` (32 oracle satırı) |
| `asOf` | `2026-10-25T00:00:00.000Z` |
| `splits` | `source` / `qualification` / `evaluation` ayrık, `evaluation` = 24 aile etiketi |
| Kaynak koşum damgaları | 2026-10-20 (negatif→pozitif sırası); native kollar 2026-10-26 |
| `contract` | B4 `CONTRACT` (#4469 ile aynı: K=32, 2000 resample, %95, effect 0) |

`lockHash`, her aile journal/prediction/request dosyasının SHA-256'sını ve oracle hash'ini
kapsar; adapter ölçüm öncesi hepsini yeniden hesaplayıp eşleştirir ve değişmişse
`source_changed` ile fail-closed durur. Journal hash'leri koşum zamanına bağlı olduğundan
`lockHash` koşumdan koşuma değişir; `oracleHash` ve `protocolHash` deterministiktir.

## 3. Ölçüm (tek koşum, `t.diagnostic`)

- Kohort: 24 holdout + 8 transfer ailesi, aile başına 36 kaynak koşumu (toplam 864 mühürlü kaynak koşumu).
- Kol başına gerçek native koşum: her aile için A1 ve A2 `runFixLoop` ile hedef göreve uygulanır
  (holdout + 8 transfer görevi → toplam 64 native koşum).
- Native doğruluk, `nativeResult` ile bağımsız oracle'a karşı yeniden türetilir.

Diagnostic (test çıktısı):

```json
{"status":"MEASURED","holdoutFamilies":24,"transferFamilies":8,
 "primary":{"mean":0,"interval":{"lower":0,"upper":0}},
 "transfer":{"mean":0,"interval":{"lower":0,"upper":0}},
 "clearsEffect":false,"assertsGain":false}
```

## 4. Neden sıfır fark

Bu külliyatta her iki kol da hedef görevi **doğru** çözer (her holdout ve transfer görevi
`applied_tested`, oracle eşleşmesi tam). A1 ve A2 farklı destek kümelerinden derlenen
prosedürleri bağlar ama ikisi de aynı `replace_text` işlemini aynı doğru içerikle uygular,
çünkü kaynak görevler aynı transformation'ın bağımsız koşumlarıdır. Yani seçim stratejisi
burada doğruluğu **değiştirmez**; kazanç yokluğu ölçülmüştür, varsayılmamıştır.

Bir kazanç ölçmek için, kolların **farklı** sonuç ürettiği bir külliyat gerekir (ör. recent-K
penceresinin yalnız negatif/episode-yok içerdiği, priority'nin doğru desteği bulduğu bir
dağılım). Bu, ayrı bir ön-kayıt ve ayrı bir külliyat gerektirir; bu belge onu iddia etmez.

## 5. Bütünlük ve fail-closed davranış (ölçüldü)

- Kilitli manifest: her aile journal/prediction/request hash'i ve oracle hash'i request'e
  gömülür; sonradan değişirse adapter `source_changed` ile **fail-closed** reddeder. Test bunu
  ayrı bir vakada kanıtlar (journal'a ekleme → `source_changed`).
- Bölme sızıntısı: `split_overlap` ve `qualification_or_source_overlap` kapıları yeşil; ölçüm
  testi oracle digest'lerinin qualification kümesinde olmadığını ayrıca assert eder.
- Kol ayrışması: 24/24 aile non-inert; adapter `selection_inert` üretmedi.
- Yetki: `authority: CANDIDATE_ONLY`, `intelligenceGain: NOT_MEASURED`, `assertsGain: false`.
  Ölçüm hiçbir varsayılanı terfi ettirmez.

## 6. Maliyet ve çözülmemiş kanıt sınırları

Issue #4465 kabul kriteri 6: gözlenen sonuç, aralık, yanlış yazmalar, **gerçek maliyetler** ve
**çözülmemiş kanıt sınırları** yayımlanmalı; gözlenmeyen maliyet için `NOT_MEASURED`, eksik
kanıt için `INSUFFICIENT` kullanılmalı.

- **Maliyet: `NOT_MEASURED`.** Adapter `cost: 'NOT_MEASURED'` döndürür. Külliyat gerçek koşumla
  üretilir (864 mühürlü kaynak koşumu + 64 native kol koşumu), ama bu ölçüm model çağrısı, token
  veya CPU maliyeti **saymaz** ve hiçbir maliyet iddiası kurmaz. `experiment: 'NOT_RUN'`: canlı
  terfi deneyi koşulmadı.
- **Native kabul yolu:** adapter her kolu gerçek kabul kaydından (`readOrdinaryAcceptance`) ve
  sabitlenmiş `sourceHash` üzerinden bağlar; sahte kabul yoktur. Ancak **promotion / canary /
  admission** canlı yolu bu külliyatta **koşulmaz** (`registered: false`, `authority:
  CANDIDATE_ONLY`); ölçüm salt-okuma doğrulamasıdır (`evidence: 'READ_ONLY_VALIDATED'`).
- **Zaman aşımı ve kısmi sonuç:** adapter aday yokluğunu (`unexpected_execution`) ve eksik native
  kanıtı (`native_evidence_unavailable` → `INSUFFICIENT`) sessizce düşürmeden raporlar. Gerçek bir
  **timeout** vakası bu külliyatta ayrıca üretilmedi; kapsanmış sayılmaz.
- **Aile bağımsızlığı beyanı:** `familyLabels: 'CALLER_DECLARED'`. Adapter yalnız hash ve bölme
  eşitliğini doğrular; aile bağımsızlığını ve kronolojisini **kanıtlamaz** (#4465: "Hash equality
  alone does not prove independence or chronology"). Külliyat kendi kaynak dağılımını denetler
  (`sourceEligibility`), ama bağımsızlık iddiası çağıran tarafındır.
- **Görev fixture sınırı:** holdout/transfer **görevleri** fixture'dır (hedef içerik ön-kilitli);
  kaynak gerçektir. G3 ölçümleriyle aynı sınırdır (§9).
- **Güç ve genel zeka:** güç analizi (`sigma`) türetilmedi, `minimumSamples` bir tabandır; genel
  zeka iddiası yoktur (`intelligenceGain: 'NOT_MEASURED'`).

## 7. Kapsam dışı (dokunulmadı)

- `lib/` altında hiçbir dosya değişmedi; M3 adapter (#4469) ve mevcut sabitler aynen kullanıldı.
- Mevcut ön-kayıtlar ve sonuçlar (`cog-m3-replay-preregistration-20261027.md`,
  `cog-m3-family-evaluation-contract.md`, `cog-m3-b4-replay-result-20261030.md`) değişmedi.
- `config/reachability-baseline.json` değişmedi.
