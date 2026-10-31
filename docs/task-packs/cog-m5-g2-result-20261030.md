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

**Etiket: `H1 PASSED`** — `pairedSamples=24` (≥ 24), bütünlük ihlali yok (`firewallBypass=0`, `approvalBypass=0`).

| Ölçü | Değer |
| --- | --- |
| Kollar ayrıştı mı | evet — aday `SYSTEM1×24`, taban `SYSTEM2×24` |
| Görev başarısı (her iki kol) | 24/24 çözüldü, yazma gerçekten indi |
| Doğrulama süreçleri (taban) | `4` (24/24 koşuda) |
| Doğrulama süreçleri (aday) | `1` (24/24 koşuda) |
| `costDelta` (taban − aday) | `+3` |
| `meanCostDelta` | `+3.0000` |
| `successCI_Lower` | `0.0000` (≥ `-0.05`: NON-INFERIOR) |
| Duvar-saati medyanı (taban → aday) | `852 ms` → `736 ms` |
| Güvenlik duvarı kontrolü | yetkisiz yazma reddedildi (`needs_human_decision`, `status=6`), dosya değişmedi |

Değerlendirici mesajı: `H1 PASSED: costDelta=3.0000 (candidate cheaper) (successCI_Lower=0.0000 >= -0.05: NON-INFERIOR), integrityGuard=PASS (firewallBypass=0, approvalBypass=0), samples=24 >= 24.`

Yorum: Bu fikstürde yönlendiricinin `SYSTEM1` kısayolu, aynı desteklenen görevde başarıyı koruyarak görev başına doğrulama sürecini 4'ten 1'e düşürdü; kollar gerçekten ayrıştı ve bütünlük kapıları ölçüldü (varsayılmadı).

## 4. İddia sınırı

- Fikstür **kontrollüdür**: tek bir aritmetik görev ailesi, sentetik nitelik fikstürleri ve sentetik ısıtma. Sonuç, ön-kayıtlı hattın (iki kol → gerçek yürütme → eşli değerlendirme) uçtan uca çalıştığını gösterir; **üretimde öğrenme kazanımı kanıtı değildir**.
- `calls` alt-süreç sayısı, gerçek model token'ı değildir. Model kullanan bir yolda maliyet ölçütü token'ları da içerir; bu ölçüm onu kapsamaz.
- `assertsGain` bu sonuçla `true` olmaz. Yönlendirici üretimde danışmanlık-only kalır; varsayılan/terfi kararı gerçek ve bağımsız bir kohort sonrası ayrı bir PR'da değerlendirilir (ön-kayıt §10).
- Isıtma koşuları her iki kola aittir ve simetriktir; aday kolun kazancı ısıtma maliyetini **içermez** (ön-kayıt §6 gereği ısıtma ayrı ve eşit raporlanır, kazanç iddiasına katılmaz).

## 5. Tekrar üretim

- Aynı fikstür ve sırayla koşu deterministiktir (saat/rastgelelik yönlendirici kararına girmez; dosya sistemi her koşuda yeniden kurulur).
- Testler: `node --test test/cognitive-lab-m5-g2.test.js` (ölçüm), `node --test test/dual-process-router.test.js test/dual-process-routing-integration.test.js` (yönlendirici birim/entegrasyon).
- Kanıt satırı: test `M5_G2_EVIDENCE {…}` JSON'unu basar; yukarıdaki tablo bu satırdan türetilmiştir.

## 6. Sonraki adımlar

- Gerçek (sentetik olmayan) bir kohort ile G3 birleşik kabulü sonrası varsayılan/terfi değerlendirmesi.
- Model kullanan yolda `tokens` içeren maliyet ölçütüyle ayrı bir ölçüm.
- Yönlendiriciyi üretimde bir tüketiciye bağlama kararı, yalnız yukarıdaki iki adım yeşil olduktan sonra ve ayrı bir PR'da.
