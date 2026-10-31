# M5 G2 çift-süreç yönlendiricisi H1: kontrollü Lab sonucu

İlgili iş: [#4068](https://github.com/ali-ulu/huqan/issues/4068) (epic [#4060](https://github.com/ali-ulu/huqan/issues/4060)).
Ön-kayıt: [`cog-m5-g2-preregistration-20261029.md`](cog-m5-g2-preregistration-20261029.md).
Kod: `test/cognitive-lab-m5-g2.test.js`, `test/helpers/cog-m5-harness.js`, `test/helpers/cog-m5-arm.js`, `test/helpers/cog-m5-arm-preload.js`.
Durum: **kontrollü Lab ölçümü**; üretim kazanımı veya varsayılan terfi iddiası değildir. `assertsGain:false`, `intelligenceGain:NOT_MEASURED`. Yönlendirici üretimde danışmanlık-only (`executes:false`, `authority: ROUTING_ADVICE_ONLY`) kalır.

Bu belge ön-kayıt metnini değiştirmez. Sonuç, ön-kayıt dondurulduktan sonra tek seferlik bir koşudan alınmıştır ve yalnız bu fikstür için geçerlidir.

## 1. Koşu

```bash
node --test test/cognitive-lab-m5-g2.test.js
```

- Ölçüm: eşli (paired), `pairedSamples=24` (ön-kayıt §5 `minimumPairedSamples`), ısıtma `warmupRuns=30`.
- Her iki kol da **aynı gerçek yürütme yolundan** geçti: `cli.js coder <görev> --synthesize`, görevin sentez niyeti `reuseMemory:true` ile `runMemoryFirstSynthesis` (`lib/coder/synthesis-memory.js`). Bu yol öğrenilmiş-aday seçicisini danışır ve reddedilirse (`no_applicable_candidate`) taze senteze düşer — her zaman-`SYSTEM2` yolu. Hiçbir şey mock'lanmadı: gerçek dosyalar, gerçek `git`, gerçek alt süreçler, gerçek Coder kapısı, gerçek güvenlik duvarı ve gerçek operatör onayı (`--authorize`).
- Kollar yalnızca yönlendirici tavsiyesinin danışılıp danışılmamasıyla ayrılır (`test/helpers/cog-m5-arm-preload.js`, `--require`): `baseline` seçici her zaman reddeder (her zaman `SYSTEM2`); `candidate` yalnızca yönlendirici hızlı yol (`SYSTEM1`/`SYSTEM1_VERIFY`) dediğinde kısayolu alır.
- Maliyet birimi: `perTaskTotalCost = tokens + calls` (ön-kayıt §5). Determinist Coder yolu model kullanmaz → `tokens=0`; `calls`, koşunun kendi kazanç günlüğünden okunan gerçek doğrulama alt-süreç sayısıdır.
- Isıtma (trust geçmişi) her iki kol için **aynı** ve sayılmıştır (ön-kayıt §6): capability üzerinde 30 üretim kısayolu koşusu. Bu, ön-kayıtın gizlemeden sayılmasını istediği nitelik/amortisman maliyetidir.

## 2. Donmuş yönlendirici kontratı

Ön-kayıt §2'deki sabitler uygulamada olduğu gibi kullanıldı (`lib/cognition/dual-process-router.js`): `SCHEMA_VERSION=huqan-cognition-dual-process-v1`, `WEIGHTS={predictionError:0.35, uncertainty:0.25, novelty:0.20, arousal:0.20}`, `S1_MAX_DEMAND=0.30`, `S2_MIN_DEMAND=0.60`. Sert kural sırası ve sessiz-kısayol yasağı korunur.

## 3. Sonuç

**Etiket: `H1 NOT PASSED`** — maliyet avantajı ölçüldü, ancak **başarı non-inferiority'si N=24'te kurulmadı**. Bütünlük ihlali yok (`firewallBypass=0`, `approvalBypass=0`).

| Ölçü | Değer |
| --- | --- |
| Kollar ayrıştı mı | evet — aday `SYSTEM1×24`, taban `SYSTEM2×24` |
| Görev başarısı (her iki kol) | 24/24 çözüldü, yazma gerçekten indi |
| Doğrulama süreçleri (taban) | `4` (24/24 koşuda) |
| Doğrulama süreçleri (aday) | `1` (24/24 koşuda) |
| `costDelta` (taban − aday) | `+3` |
| `meanCostDelta` | `+3.0000` |
| `successCI_Lower` (tam, tek-yönlü %95) | `-0.1173` (< `-0.05`: INFERIOR) |
| Isıtma maliyeti (her iki kol için eşit) | `30` süreç, `20209 ms` |
| Duvar-saati medyanı (taban → aday) | `841 ms` → `727 ms` |
| Güvenlik duvarı kontrolü | yetkisiz yazma reddedildi (`needs_human_decision`, `status=6`), dosya değişmedi |

Değerlendirici mesajı: `H1 FAILED: costDelta=3.0000 (successCI_Lower=-0.1173 < -0.05: INFERIOR), integrityGuard=PASS.`

**Neden PASS değil.** 24/24 eşleşmede eşli başarı farkının nokta tahmini 0, ama bir nokta tahmini non-inferiority kanıtı değildir. Tam (Clopper–Pearson) tek-yönlü %95 alt sınırı `-0.1173`'tür; `-0.05` marjının altındadır. 24/24, marjı 0.05 olan bir non-inferiority iddiasını destekleyecek kadar büyük değildir: başarısızlık oranı için kesin üst sınır ≈ %11.7'dir. Bu yüzden karar `H1 FAILED`'dır — maliyet kazancı gerçektir, ancak başarı kapısı bu N'de geçmez. (Normal yaklaşım burada varyans 0 verip [0, 0] aralığı üretir; bu, kanıtı olmayan bir PASS olurdu ve #4422 incelemesinde reddedildi.)

Yorum: Yönlendiricinin `SYSTEM1` kısayolu görev başına doğrulama sürecini 4'ten 1'e düşürdü ve kollar gerçekten ayrıştı; bütünlük kapıları ölçüldü (varsayılmadı). Ancak ön-kayıtlı karar kuralı maliyet avantajı **ve** başarı non-inferiority'sini birlikte ister; ikincisi bu örneklemde sağlanmadı. Daha büyük bir N, aynı eşli farkla sınırı `-0.05`'in üstüne taşıyabilir (ör. sıfır uyumsuz çiftte `n` arttıkça sınır 0'a yaklaşır).

## 4. İddia sınırı

- Fikstür **kontrollüdür**: tek bir aritmetik görev ailesi, sentetik nitelik fikstürleri ve sentetik ısıtma. Sonuç, ön-kayıtlı hattın (iki kol → gerçek yürütme → eşli değerlendirme) uçtan uca çalıştığını gösterir; **üretimde öğrenme kazanımı kanıtı değildir**.
- **H1 bu örneklemde geçmedi.** Bu bir başarısızlık değil, dürüst bir ölçüm sonucudur: maliyet avantajı ölçüldü, non-inferiority kurulmadı. `assertsGain` kesinlikle `false`'tur ve varsayılan/terfi iddiası yoktur.
- `calls` alt-süreç sayısı, gerçek model token'ı değildir. Model kullanan bir yolda maliyet ölçütü token'ları da içerir; bu ölçüm onu kapsamaz.
- Isıtma koşuları her iki kola aittir ve simetriktir; aday kolun kazancı ısıtma maliyetini **içermez** (ön-kayıt §6 gereği ısıtma ayrı ve eşit raporlanır, kazanç iddiasına katılmaz). Ölçülen ısıtma maliyeti: `30` süreç, `20209 ms`.
- Başarı aralığı için tam (Clopper–Pearson) sınır kullanılır; eşleşmeyi yok saydığı için eşli bir aralıktan daha geniştir ve non-inferiority'yi asla abartmaz (fail-closed).

## 5. Tekrar üretim

- Aynı fikstür ve sırayla koşu deterministiktir (saat/rastgelelik yönlendirici kararına girmez; dosya sistemi her koşuda yeniden kurulur).
- Testler: `node --test test/cognitive-lab-m5-g2.test.js` (ölçüm), `node --test test/dual-process-router.test.js test/dual-process-routing-integration.test.js` (yönlendirici birim/entegrasyon).
- Kanıt satırı: test `M5_G2_EVIDENCE {…}` JSON'unu basar; yukarıdaki tablo bu satırdan türetilmiştir.

## 6. Sonraki adımlar

- **N'yi büyüt.** Maliyet avantajı ölçüldü; başarı non-inferiority'si bu örneklemde kurulmadı (tam sınır `-0.1173` < `-0.05`). Aynı sıfır-uyumsuz eşli farkla, `n` arttıkça sınır 0'a yaklaşır ve marjı geçebilir; ön-kayıtlı `minimumPairedSamples` yeniden gözden geçirilmeli (yeni bir ön-kayıt ile).
- Gerçek (sentetik olmayan) bir kohort ile G3 birleşik kabulü sonrası varsayılan/terfi değerlendirmesi.
- Model kullanan yolda `tokens` içeren maliyet ölçütüyle ayrı bir ölçüm.
- Yönlendiriciyi üretimde bir tüketiciye bağlama kararı, yalnız yukarıdaki adımlar yeşil olduktan sonra ve ayrı bir PR'da.
