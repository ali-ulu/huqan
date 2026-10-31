# G3 birleşik kabul — gerçek görev kohortu sonucu (result)

**Ön-kayıt:** `docs/task-packs/g3-real-cohort-preregistration-20261030.md`
(protokol ölçümden önce, ayrı commit ile kilitlendi).
**Base:** `aa6d2182` (origin/main). **Issue:** [#4423](https://github.com/ali-ulu/huqan/issues/4423).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060).
**Eval:** `test/g3-real-cohort-result.test.js` (`node --test test/g3-real-cohort-result.test.js`).

## 1. Sonuç özeti

| Boyut | Sonuç |
|---|---|
| Nihai durum (§8) | **`NOT_MEASURED`** |
| Neden | §2 kaynağı ile §3 kolları uyuşmuyor (aşağıda kanıt) |
| Gerçek kohort (commit'li, `minimumSamples` üstü) | yok → §8.1 fail-closed |
| `assertsGain` | `false` (her durumda) |

**H1 verdict: `NOT_MEASURED`.** Hipotez ölçülmedi; bir kazanç veya kayıp iddiası
çıkarılmaz. Bu bir başarısızlık değil, ön-kaydın kendi fail-closed kuralının sonucudur.

## 2. Bulgu — kaynak/kollar uyuşmazlığı (kanıtlanmış)

Ön-kayıt iki şeyi dondurdu:

- **§2 (kaynak):** doğrulanmış başarısızlık kaydı → `produceTask` → görev.
- **§3 (kollar):** aynı görevler `--synthesize` / `--adapt-memory` öğrenme kollarında.

Gerçek zincir çalıştırıldığında üretilen görev **deterministik bir dönüşüm** görevidir:

```json
{"id":"task-failure_…","level":"l0",
 "intent":"repair verified failure …: restore expected content in docs/version.md",
 "allowedPaths":["docs/version.md"],
 "operation":{"type":"replace_text","path":"docs/version.md","find":"v1.0.0","replace":"v1.1.0"},
 "files":{}}
```

Bu görevde **`test` alanı yok** ve **`synthesis` alanı yok**. Üç öğrenme kolu da fail-closed
durur (hepsi `error.code = COMMAND_FAILED`):

```
$ node cli.js coder task.json --synthesize   --authorize --root <root> --json
  → "Synthesis requires independent test.command"
$ node cli.js coder task.json --use-memory   --authorize --root <root> --json
$ node cli.js coder task.json --adapt-memory --authorize --root <root> --json
$ node cli.js coder task.json --transfer-memory --authorize --root <root> --json
  → "Candidate memory requires a journal, candidate file and a non-project task"
```

Yani **§2 kaynağı, §3 kollarının ölçtüğü öğrenme mekanizmasını taşımıyor.** Buna karşılık
aynı gerçek görev, deterministik yolda **uygulanır** (`outcome = applied`, yalnız beyan
edilen dosya değişir) — ama bu, ön-kaydın ölçmek istediği öğrenme sorusu değildir.

Kanıt `test/g3-real-cohort-result.test.js` ile kalıcılaştırıldı (3 case: üretilen görev
şekli, öğrenme kolunun fail-closed reddi, deterministik kolun uygulaması).

## 3. İkinci engel — gerçek kohort yok

Repo'da `ErrorPrevention.recordFailure` ile üretilmiş, commit'li, `minimumSamples` üstü
gerçek kayıt kohortu **yok** (yalnız `.huqan/derivations/README.md`; hiçbir `*.failure.json`
veya kayıt dökümü commit'li değil). Ön-kayıt §8.1 gereği kayıt yokluğu `NOT_MEASURED`'dır;
uydurulmuş kayıtla doldurulmaz.

## 4. Neden sentetik fixture ile doldurulmadı

Ön-kaydın amacı tam da sentetik grammar'ın (#4380/#4416/#4415) ötesine geçmekti. Boşluğu
sentetik fixture ile kapatmak ölçümü tanımı gereği geçersiz kılar ve §8.1'i ihlal eder.
Bulunan boşluk **kapatılmaz**; ölçülür ve raporlanır (plan §G3 corpus koşulu).

## 5. Yorum ve sonraki adım

Gerçek zincirin (başarısızlık kaydı → `produceTask`) **öğrenme** değil **deterministik
onarım** ürettiği bu koşumda kanıtlandı. Bu, zincirin kusuru değil, iki farklı yolun
karıştırılmasıdır: `produceTask` doğrulanmış bir dönüşümü yeniden oynatır; öğrenme kolu ise
belirsiz bir programı örneklerden çıkarır. İkisi aynı görev şeklini paylaşmaz.

Bu nedenle bir sonraki ön-kayıt (ayrı PR/issue) şunlardan birini tanımlamalıdır:

1. **Gerçek öğrenme görevi kaynağı:** üretimde fiilen `coder --synthesize` ile koşulmuş
   görevlerin kayıtları (başarısızlık kaydından değil, çalışma günlüğünden türetilir), veya
2. **Ayrık ölçüm:** §2 kaynağını yalnız deterministik onarım ölçümü için kullanmak; öğrenme
   sorusunu sentetik kontrolde tutup gerçek kaynak koşulunu onarım doğruluğu üzerinden
   yeniden tanımlamak.

Bu belge bir kazanç iddiası içermez; `assertsGain` `false`, `intelligenceGain`
`NOT_MEASURED`'dır. Varsayılan/terfi kararı bu sonuçtan çıkarılamaz.

## 6. İddia sınırı

- Ölçülen: gerçek zincirin ürettiği görev şekli ve öğrenme kollarının ona tepkisi.
- Ölçülmeyen: H1'in kendisi (kazanç/kayıp), maliyet dağılımı, değişen ortam, restart ve
  eski beceri ölçümleri.
- Bu PR yalnız bu sonuç belgesini ve pinleme testini ekler; `lib/` altında hiçbir dosya
  değişmez, ön-kayıt belgesi (dondurulmuş) değiştirilmez.
