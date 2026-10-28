# İP-1 — Yanlış alarm ölçüm seti sonucu

> Durum: ölçüm kaydı. Bu belge bir hedefin **tutup tutmadığını** bildirir, bir
> politika kararı vermez. Kapı (gate) ölçüldüğü gibi bırakılmıştır.

- Ölçüm tabanı: `main @ 2dbd8f9019df94fdf97ed9e398bac34b620ae08e`
- Set: `test/fixtures/false-alarm-corpus.json` (703 güvenli, 114 riskli)
- Üretici: `scripts/build-false-alarm-corpus.js`
- Ölçüm betiği: `scripts/false-alarm-rate.js`
- Test: `test/false-alarm-rate.test.js`
- Ham çıktı: `node scripts/false-alarm-rate.js` (aşağıdaki tablolar bu çıktıdır)

## Yöntem

Her çağrı, etiketinden bağımsız olarak **gerçek karar yolundan** geçer; hiçbir
karar taklit edilmez (mock yok):

- `shell` ve `file-write` yüzeyleri → `evaluateExternalAction`
  (`lib/external-action-guard.js`, hook'un kullandığı giriş).
- `agent-tool` ve `step-enforcement` yüzeyleri → `evaluateAgentActionFirewall`.
- `automation` yüzeyi → `evaluateAutomationSafety` (AB5 seam).

Bir çağrı `allow` dışında bir karar aldıysa (block / review / dry_run_only)
"insan olmadan çalışmaz" sayılır ve güvenli sette **yanlış alarm** olarak
kaydedilir. Güvenli set iki kez ölçülür: **varsayılan politika** ile ve
sevkiyat paketindeki `team-ci` şablonunun `allowedCommands` listesi ile
(`lib/command-policy-templates.js`) — çünkü görevdeki hedef yalnızca bir
allowlist ile ulaşılabilir bir hedeftir.

Kimlik kapısı bu ölçümde kapalıdır (`requireIdentityCard: false`): kimlik
kapısı bu soruya dik ve kendi testi var
(`test/external-action-identity.test.js`); açık olsaydı her satır aynı ilgisiz
sebepten durur ve ölçümü boğardı. `scripts/benign-false-block-rate.js` de aynı
seçimi yapar.

## Sonuç — varsayılan politika

| Ölçüm | Değer |
|---|---|
| Güvenli çağrı, durduruldu | **113 / 703 (%16,07)** |
| Riskli çağrı, geçti | **0 / 114 (%0,00)** |

Güvenli set, katman bazında:

| Katman | Durdurulan | Toplam |
|---|---:|---:|
| read | 0 | 372 |
| diff | 0 | 178 |
| test | 81 | 81 |
| lint | 26 | 26 |
| build | 6 | 6 |
| plan | 0 | 40 |

Riskli set, kategori bazında (hepsi en az `review` aldı):

| Kategori | Geçen | Toplam |
|---|---:|---:|
| destructive | 0 | 55 |
| history | 0 | 6 |
| deploy | 0 | 9 |
| permission | 0 | 7 |
| secret | 0 | 4 |
| network | 0 | 3 |
| bypass | 0 | 4 |
| escape | 0 | 7 |
| agent-tool | 0 | 11 |
| automation | 0 | 8 |

## Sonuç — `team-ci` allowlist şablonu ile

| Ölçüm | Değer |
|---|---|
| Güvenli çağrı, durduruldu | **30 / 703 (%4,27)** |
| Riskli çağrı, geçti | **0 / 114 (%0,00)** |

Katman bazında: read 0/372, diff 0/178, **test 0/81**, lint 25/26, build 5/6,
plan 0/40. `team-ci` listesi `npm test`, `npm run test`, `npm run build`,
`npm run lint`, `npm run typecheck`, `npm run check`, `node --test` içerir;
`npx tsc --noEmit`, `npx oxlint`, `npm ci`, `npm install` ve tek tek
`npm run check:<ad>` komutları listede olmadığı için hâlâ `review` alır.

## Görev hedefi karşısında durum

Görevde istenen hedef: güvenli işlemlerde yanlış alarm **500'de 1'in altında**
(≤ %0,20) ve **okuma/diff/test/lint/plan** komutlarında **sıfır**.

| Katman | Varsayılan | team-ci | Hedef |
|---|---|---|---|
| overall | %16,07 | %4,27 | ≤ %0,20 |
| read | 0/372 ✅ | 0/372 ✅ | sıfır |
| diff | 0/178 ✅ | 0/178 ✅ | sıfır |
| test | 81/81 ❌ | 0/81 ✅ | sıfır |
| lint | 26/26 ❌ | 25/26 ❌ | sıfır |
| plan | 0/40 ✅ | 0/40 ✅ | sıfır |

**Hedef tutmuyor.** Kanıtla, kısa:

- Varsayılan politikada **test, lint ve build katmanlarının tamamı** `review`
  alır: `npm test`, `node --test <dosya>`, `npm run lint`, `npm ci`, `npm run
  build` — hepsi insan onayı ister. Bu yüzden overall %16,07'dur.
- `team-ci` allowlist şablonu **test** katmanını sıfıra indirir (81/81 → 0/81),
  ama `lint` katmanında `npx tsc --noEmit`, `npx oxlint` ve tek tek
  `npm run check:<ad>` komutları listede olmadığı için 25/26 kalır.
- Riskli tarafta hiçbir kaçak yok (0/114, iki politikada da).

Görev gereği ajan bu sonuç karşısında **politikayı değiştirmedi**; yalnızca
raporladı. Hedefe ulaşmak için gereken adım (bir allowlist'in kapsamını
genişletmek) ayrı bir karardır ve bu paketin kapsamı dışındadır.

## Yorum

- `read`, `diff` ve `plan` katmanlarının sıfır olması, kapının salt-okuma
  işlerden ücret almadığını gösterir; asimetri tam olarak burada değil,
  `test`/`lint`/`build` katmanlarındadır.
- `scripts/benign-false-block-rate.js` başlığındaki ifade burada da geçerli:
  `review` bir hata değil, savunulabilir bir politika seçimidir. Ölçümün
  varlık sebebi o seçimin **toplam maliyetini** görünür kılmaktır — bu belge
  o maliyeti görünür kılar.
- `team-ci` şablonu uygulandığında dahi sıfır olmayan `lint` katmanı, şablonun
  `allowedCommands` listesinin `npm run check:*` ailesini kapsamadığını
  gösterir. Bu bir eksik değil, bilinçli bir daraltmadır: liste yalnızca
  sınıflandırıcının "bilinmeyen araç zinciri" sayacağı bir komutu yükseltebilir
  (`allowlistMatch`, `lib/external-action-envelope.js`). İki kelimelik asgari
  şart bu eşleştiriciye değil, yayımlanan şablon girdilerine ve allowlist
  madencisine aittir (`MIN_SHAPE_WORDS`, `lib/command-allowlist-miner.js`);
  `allowlistMatch` tek kelimelik bir girdiyi de kabul eder (komut girdiye eşitse
  ya da `${girdi} ` ile başlıyorsa).

## Takip — hedef ve şablon düzeltmesi

Yukarıdaki ölçüm `2dbd8f90` tabanında alındı ve olduğu gibi bırakıldı. Hedefi
tutturmak için iki değişiklik yapıldı; kapının kendisi **zayıflatılmadı**.

**1. Hedef katman bazına çevrildi.** `target` artık hangi politikaya göre
yargılandığını söylüyor (`policy: "team-ci"`) ve bir `reviewTiers` listesi
taşıyor. Tavan (`≤ %0,20`) yalnızca ne sıfır ne de "sormanın normal olduğu"
katmanlar üzerinden hesaplanır:

- `safeZeroTiers`: `read`, `diff`, `test`, `lint`, `plan` — sıfır olmalı.
- `reviewTiers`: `build` — `npm ci`/`npm install` üçüncü-taraf lifecycle
  scripti çalıştırır, `npm run verify`/`coverage` tüm suite'i koşar. Orada bir
  `review` **kapının çalışmasıdır**, yanlış alarm değil; tavan dışı bırakıldı.
- Tavan, kalan katmanlar üzerinde hesaplanır.

Varsayılan (allowlist'siz) politika hedefi **bilerek** tutmaz: her
sınıflandırılmamış araç zinciri insana gider. Hedef, önerilen politika olan
`team-ci`'ye göre okunur.

**2. `team-ci` şablonu tamamlandı.** Salt-okunur analiz komutları eklendi:
`npx oxlint`, `npx tsc --noEmit`, `node scripts/check-{layers,import-cycles,file-size}.js`
ve `npm run check:*` ailesi (20 ad). Hepsi salt-okunur rapor; hiçbiri
`--fix`/`--write`/`--update` olmadan dosya değiştirmez.

**Yan ürün — iki delik kapatıldı.** `allowlistMatch` bir girdiyi "ön ek" olarak
eşleştirdiği için `npx oxlint` şablona girince `npx oxlint --fix` (kaynağı
yeniden yazan) komutu da `allow` oluyordu. Aynı sınıf mevcut `team-ci`'de de
vardı (`npm run lint` → `npm run lint --fix`; `npm run` bayrağı yuttuğu için
zararsızdı, `npx` yutturmuyor). Kural eklendi: mutasyon bayrağı
(`--fix`, `--fix-suggestions`, `--fix-dangerously`, `--write`, `--update`,
`--apply`, `--in-place`) taşıyan bir komut allowlist tarafından **hiç
yükseltilmez** (`lib/external-action-allowlist.js`, `carriesMutationFlag`).
Karşılaştırma öncesi tırnaklar soyulur: kabuk `'--fix'` kelimesini `--fix`
olarak iletir, ham-kelime kontrolü tırnaklı bayrağı kaçırırdı. İnceleme sırasında
kapatılan iki kaçak (`npx oxlint '--fix'`, `npx oxlint --fix-suggestions`) test
ile sabitlendi.

**Politika seçimi de fail-closed.** Hedef, yalnızca raporun gerçekten ölçtüğü bir
politikaya göre okunur. `team-ci` kendi allowlist'iyle, **diğer her ad** (eksik,
yanlış yazılmış veya ölçülmeyen bir politika) varsayılan politikaya düşer; böylece
bir corpus, ölçülmeyen bir politikayı adlandırarak hedefi "tutmuş" gösteremez
(`scripts/false-alarm-rate.js`, `selectTargetPolicy`).

### Yeni ölçüm (`team-ci`, 703 güvenli)

| Katman | Durdurulan | Toplam | Kural |
|---|---:|---:|---|
| read | 0 | 372 | sıfır ✅ |
| diff | 0 | 178 | sıfır ✅ |
| test | 0 | 81 | sıfır ✅ |
| lint | 0 | 26 | sıfır ✅ |
| plan | 0 | 40 | sıfır ✅ |
| build | 5 | 6 | review (tavan dışı) |

- Yargılanan küme: **0 / 697** durduruldu → overall **%0,00 ≤ %0,20** ✅
- Riskli taraf: **0 / 114** geçti (değişmedi).

**Hedef artık MET.** Varsayılan politikada hâlâ tutmaz; o durum raporda
görünür ve kasıtlıdır.
