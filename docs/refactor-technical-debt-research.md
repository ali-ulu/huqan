# Refaktör ve Teknik Borç Araştırması

**Status:** `research`
**Base commit:** `68c079f` (`origin/main`, "Merge pull request #701 from ali-ulu/docs/700-v5-record-commit-pins")
**Ölçüm tarihi:** 2026-08-14

Bu belge bir araştırmadır. Hiçbir refaktörü yetkilendirmez, hiçbir dosyayı
bölmez ve `docs/v4/big-file-refactor-gate.md` kapısının yerine geçmez.
Aşağıdaki her sayı, yukarıdaki commit üzerinde çalıştırılmış komutlardan
gelir; her öneri ayrı onay bekler.

---

## 0. Bağlam çakışması: klon sığlığı, checkpoint borcu değil

`node scripts/agent-context.js` ilk çalıştırmada başarısız oldu ve
`test/agent-context.test.js` dört testi kırmızı verdi:

```
CONTEXT_CONFLICT: checkpoint main 0fef5948f644e611baa8b725f018249662bcdb5d
is not an ancestor of origin/main 68c079ff44e85885039ea31520268a8139d4f53a
```

İlk teşhis yanlıştı. `git cat-file -t 0fef5948` →
`fatal: Not a valid commit name` çıktısı, checkpoint'in var olmayan bir
commit'i sabitlediği izlenimi verdi. Gerçek sebep, çalışma ortamının
**sığ (shallow) klon** olmasıydı: 2089 commit'lik geçmişin yalnızca 222'si
mevcuttu, bu yüzden hem nesne araması hem de `merge-base` başarısız oldu.

`git fetch --unshallow` sonrası ölçüm (gözlemlenen):

```
git cat-file -t 0fef5948…                       -> commit
git merge-base --is-ancestor 0fef… origin/main  -> yes (ancestor)

node --test test/agent-context.test.js:
17 total
17 pass
0 fail
0 skipped

npm test:
3829 total
3799 pass
0 fail
30 skipped
```

`0fef5948` (PR #597) `origin/main`'in **meşru atasıdır**;
`docs/current-agent-checkpoint.json` bayat değildir ve tazelenmesi
gerekmez. Kapı doğru davranmıştır: CI'nin paylaşmadığı bir tabana karşı
ataliğin ölçülmesini reddetmiştir. Bu bir depo borcu değil, ortam
koşuludur — sığ klonla çalışan her ajanın `--unshallow` yapması gerekir.

Çalışma dalı `claude/refactor-technical-debt-research-n74a74`, `origin/main`
(`68c079f`) ile aynı noktadadır. Bu araştırma canlı kaynak üzerinden
yapıldı (SRC-001 sırası).

---

## 1. Endüstri standardı: bu repoda zaten var

Kullanıcı isteği "endüstri standardı varsa ona göre, yoksa 1–300 satır"
şeklindeydi. **Standart var ve kodda uygulanıyor** — yeni bir 300 satır
kuralı icat etmek mevcut kapıyla çakışırdı:

| Mekanizma | Yer | Ne yapar |
|---|---|---|
| Satır eşiği | `scripts/check-file-size.js` | `THRESHOLD = 800` |
| Borç defteri | `scripts/file-size-baseline.json` | 15 mevcut ihlali tavanla kilitler |
| Cırcır (ratchet) | aynı script | Tavan **yalnızca düşebilir**; `--update` asla yükseltemez |
| CI testi | `test/arch-3-file-size-ratchet.contract.test.js` | Karar mantığını doğrudan sabitler |
| Döngü kapısı | `scripts/check-import-cycles.js` | `require` döngüsü yok |
| İnce orkestratör | `docs/agent-canon.md` `ARCH-001` | `kernel.js`, `graph.js`, `server.js` vb. dosyalara yeni alan mantığı yasak |
| Bölme zamanlaması | `docs/v4/big-file-refactor-gate.md` | Bölme "temizlik için" değil, o dosyayı ağır düzenleyecek PR'dan hemen önce |

Bu kombinasyon (eşik + baseline ledger + tek yönlü cırcır) yaygın ve
sağlam bir endüstri desenidir; hedefi 800'den 300'e çekmek şu an **karşı
tavsiyedir**: 283 runtime dosyasının 73'ü 300 satırın üzerinde, yani gate
ilk gün 73 ihlalle patlar ve devre dışı bırakılır. Cırcırın anlamı budur.

Doğrulanan durum (gözlemlenen): defterdeki 15 girdinin tamamı bugünkü
satır sayılarıyla **birebir** eşleşiyor, yani cırcır dinlenme halinde —
ne bayat girdi ne de büyümüş dosya var.

### Ölçüm özeti

```
runtime dosya: 283   toplam satır: 71.998   >300 satır: 73   >800 satır: 15
require döngüsü: 0 (271 kaynak dosya tarandı)
TODO/FIXME/HACK: 1 (runtime kodunun tamamında)
```

Yorum: bu bir "çürümüş kod tabanı" değil. Yorum-borcu neredeyse sıfır,
döngü yok, kapılar canlı. Borç **yapısal**: birkaç monolit, tekrar eden
konnektör kodu ve tutarsız dosya yerleşimi.

---

## 2. Bulgular, etki sırasına göre

### B1 — `plugins/repo-memory.js` (1200 satır): kopyala-yapıştır konnektörler

En yüksek getirili, en düşük riskli hedef. Dosyada yedi ingest fonksiyonu var:

| Fonksiyon | Satır | Uzunluk |
|---|---:|---:|
| `ingestGithubRepo` | 132 | ~194 |
| `ingestMarkdownPath` | 326 | ~132 |
| `ingestJsonPath` | 458 | ~132 |
| `ingestYamlPath` | 590 | ~132 |
| `ingestGitLogPath` | 722 | ~140 |
| `ingestPdfPath` | 862 | ~132 |
| `ingestHttpUrls` | 994 | ~137 |

`json` / `yaml` / `pdf` / `git-log` gövdeleri satır satır neredeyse
aynı; yalnızca `sourceSubType` (`'json_entry'`, `'yaml_entry'` …) ve
hata metni (`'json path is required'`) değişiyor. Yaklaşık **650 satır**,
dosyanın ~%55'i, tek bir parametreli akıştan üretilebilir:

- `lib/connectors/entry-ingest-flow.js` — ortak akış (doğrulama →
  `buildConnectorProvenance` → düğüm/kenar → admission kaydı → özet)
- `plugins/repo-memory.js` — yalnızca konnektör tanımları (biçim adı,
  ayrıştırıcı, `sourceSubType`) ve eklenti kaydı

Beklenen sonuç: 1200 → ~400 satır; defterden bir girdi düşer. Risk düşük,
çünkü bu bir eklenti, çekirdek değil ve `_test` yüzeyi zaten dışa açık.
YAGNI-001 ihlali değil: kod zaten var, yeniden yazılmıyor, tekilleştiriliyor.

### B2 — `lib/memory-store.js` (2176 satır): tek sınıf, dört sorumluluk

Defterin en büyük girdisi. 45 metod, dört ayrık kümeye düşüyor:

1. **Kalıcılık/şema** — `_initDB`, `_warmup`, `_withTransaction`,
   `_snapshotInMemoryState`, `_restoreInMemoryState`, `save`, `load`, `close`
2. **Kayıt yaşam döngüsü** — `store`, `patchMetadata`, `tombstone`, `supersede`
3. **Sorgu/arama** — `list`, `get`, `findBy*` (5 adet), `query`, `search`,
   `_queryTemporalMemories`, `since`/`before`/`between`, `timeline`
4. **Bağ grafiği** — `link`, `contradict`, `getBacklinks`, `traverseLinks`,
   `queryLinks`, `linksForMemory`, `eventsForMemory`
5. **Paket** — `exportPackage`, `importPackage` (~270 satır, tek başına bir modül)

Bu, `ARCH-001`'in tarif ettiği ayrıştırmanın ders kitabı örneği. Ancak
kapı kuralı nettir: **PR5 benzeri ağır bir düzenleme gelmeden bölünmez.**
Şu anki tavsiye: bölme, ama `exportPackage`/`importPackage` çiftini bir
sonraki paket işine giden PR'ın *önünde* çıkarılabilir aday olarak işaretle.

### B3 — `graph.js` (1697) ve `kernel.js` (1601)

`kernel.js` **zaten büyük ölçüde ince**: 60+ metodun çoğu 4 satırlık
delegasyon (`_forwardChain`, `_findPath`, `entropy`, `compare` …).
Kalan yağ tek bir kümede: `learn` / `_evaluateLearnAdmission` /
`_backgroundProvenance` / `_commitBackgroundEdge` (~550 satır, 587–869
aralığı). Bölünecekse bölünmesi gereken tek yer burasıdır; gerisi
dokunulmamalı.

`graph.js` içinde ayrı bir sorumluluk açıkça duruyor: mutation-receipt
journal'ı (`_jsonJournalPath` → `_runMutationOnceJson`, 444–700 arası,
~260 satır) kendi başına tutarlı bir modüldür ve depolama semantiğinden
bağımsızdır. İkisi de yüksek blast-radius; `NEEDS_MANUAL_REVIEW` sınıfı
korunmalı.

### B4 — Test yerleşimi üç ayrı yerde

```
test/ dizini      : 258 test dosyası
repo kökü         :  38 test dosyası
lib/ içinde bitişik:  27 test dosyası
toplam            : 351
```

Aynı repoda üç ayrı kural. Bu bir davranış borcu değil, bulunabilirlik
borcu: bir modülün testinin nerede olduğu tahmin edilemiyor. Düzeltmesi
mekanik (saf `git mv` + require yolları) ama 65 dosyaya dokunur, yani
kendi başına bir PR olmalı ve tek amacı bu olmalı (§8 scope discipline).
Öncelik düşük, risk düşük, gürültü yüksek.

### B5 — AXIOM → HUQAN ikizleri: borç değil, sözleşme

Yüzeyde iki paket (`packages/axiom-verify`, `packages/huqan-verify`) ve
iki spec ağacı (`specs/axiom-*`, `specs/huqan-*`) tekrar gibi görünüyor.
Değil:

- `packages/axiom-verify/index.js` gövdesi tam olarak
  `module.exports = require('../huqan-verify');` — ince bir uyumluluk
  kabuğu, kopya değil. M2 kapanmış.
- `specs/axiom-trust-protocol/0.1`, RFC-001'e göre **dondurulmuş meşru
  legacy soy**; silinmesi duyurulmuş bir breaking release gerektirir.

Tavsiye: bu ikizlere refaktör olarak dokunulmamalı. Teknik borç sayılıp
"temizlenmesi", checkpoint'in `forbiddenClaims` listesindeki yetkisiz
wire-format migrasyonuna dönüşür.

### B6 — Sürüm ikizleri: `kernel.v2.js` (975), `agent.v3.js` (705)

`kernel.js` + `kernel.v2.js` ve `agent.js` + `agent.v3.js` yan yana
yaşıyor ve ikisi de `test/arch-4-*-version-parity.contract.test.js` ile
eşlik altında tutuluyor. Yani bu bilinçli, testle bağlanmış bir çift —
sessizce birleştirilecek ölü kod değil. Borç, birleştirme kararının
kendisinin hiçbir yerde yazılı olmaması: hangi sürümün ne zaman
emekliye ayrılacağını söyleyen bir ADR yok. Önerilen iş kod değil,
tek sayfalık bir emeklilik kaydı.

---

## 3. Tavsiye edilen sıra

| # | İş | Dosya | Risk | Kazanç |
|---|---|---|---|---|
| 1 | Konnektör akışını tekilleştir | `plugins/repo-memory.js` | Düşük | ~650 satır, defterden 1 girdi |
| 2 | Sürüm emeklilik ADR'si | `docs/adr/` | Yok | B6 kararı yazılı olur |
| 3 | Paket yüzeyini çıkar | `lib/memory-store.js` | Orta | ~270 satır, ancak PR5 tetiklerse |
| 4 | Test yerleşimini tekleştir | 65 dosya `git mv` | Düşük | Bulunabilirlik |
| 5 | Journal'ı çıkar / learn'i çıkar | `graph.js`, `kernel.js` | Yüksek | Yalnız ağır PR önünde |

3, 4 ve 5 **big-file-refactor-gate kuralına tabidir**: bağımlı PR
gelmeden başlatılmamalıdır.

**#1 yapıldı** — commit `85a3956`: altı entry tabanlı konnektör
`lib/connectors/entry-ingest-flow.js` içindeki tek yürüyüşe katlandı,
`plugins/repo-memory.js` 1200 → 641 satır, defterden düştü. Davranış
değişmedi: iki revizyon aynı fixture üzerinde byte-byte aynı sonuç,
admission sırası ve hata sözleşmesi üretti.

## 4. Tavsiye edilmeyenler

- 800 eşiğini 300'e çekmek — gate ilk gün 73 ihlalle devre dışı kalır.
- `kernel.js`'i toptan bölmek — zaten ince; yalnız learn/admission kümesi hedeftir.
- AXIOM kabuklarını veya `specs/axiom-*` ağacını silmek — yetkisiz breaking change.
- Refaktörü davranış değişikliğiyle aynı PR'a koymak — CHG-001.
