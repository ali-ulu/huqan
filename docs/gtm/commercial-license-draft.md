# Ticari Lisans — TASLAK

> **DURUM: STRATEJİK TASLAK. HUKUKİ İNCELEME GEREKTİRİR.**
> Bu belge bir teklif, bağlayıcı şart veya lisans grant’i değildir. Fiyatlar ve
> şartlar yer tutucudur. Yayımlamadan veya herhangi bir müşteriye sunmadan önce
> hukukçu incelemesi şarttır. Hukuk/CLA çalışma belgeleri için
> [`docs/legal/dual-licensing-status.md`](../legal/dual-licensing-status.md),
> [`CLA.md`](../../CLA.md) ve
> [`commercial-license-working-draft.md`](../legal/commercial-license-working-draft.md)
> dosyalarına bakın.

## Neden bu SKU ileride satılabilir olabilir

HUQAN, **AGPL-3.0** ile lisanslı. AGPL'in ağ hükmü (§13) şunu gerektirir:
HUQAN'ı değiştirip bir ağ servisi üzerinden kullanıcıya sunan taraf, o
servisin tüm kaynak kodunu aynı lisansla sunmak zorundadır.

Bu, kapalı kaynak ürün satan her şirket için ikili bir seçim yaratır:

1. Kendi ürününü de AGPL yap, veya
2. Ticari istisna satın al.

Yeni mühendislik gerektirmeyebilecek bir lisans konuşması için teknik ürün
çekirdeği yeterli olabilir; ancak bu, ticari lisansın bugün satışa hazır olduğu
anlamına gelmez. Eksik veya doğrulanması gereken konular; hak zinciri, ticari
lisans metni, lisans kapsamı, iletişim kanalı ve hukukçu onayıdır.


## Hedef alıcı

- Ajan/otomasyon altyapısı satan yazılım şirketleri
- HUQAN'ı kapalı kaynak bir platforma gömmek isteyenler
- AGPL yükümlülüğünü hukuk departmanı kabul etmeyen kurumlar

Bu alıcı kendini bulur: AGPL'li bir bağımlılığı fark eden hukuk ekibi
satıcıyı arar. Yani **giden satış gerektirmez**, sadece bulunabilir olmak.

## Fiyat aralığı (yer tutucu)

| Segment | Yıllık |
|---|---|
| Startup (< 20 çalışan) | 5.000 $ |
| Büyüme (20-200) | 15.000 $ |
| Kurumsal (200+) | 25.000 $+ |

Süre: yıllık, otomatik yenilemeli. Kapsam: bir ürün/hat başına.

## Kapsam ayrımı (netleştirilmeli)

Ticari lisansın **kapsadığı**:
- HUQAN'ı kapalı kaynak üründe dağıtma/gömme hakkı
- AGPL §13 kaynak açma yükümlülüğünden muafiyet

Ticari lisansın **kapsamadığı** — ayrıca sözleşmelenmeli:
- destek/SLA
- sertifikasyon (bkz. SKU 3)
- barındırma
- tazminat/garanti

Bu ayrım baştan net yazılmazsa, alıcı lisansı destek sanır.

## Yapılacaklar

1. Hak zinciri ve dependency lisanslarını doğrula.
2. Avukat incelemesi — **diğer her şeyden önce**.
3. `LICENSE-COMMERCIAL.md` veya avukatın seçtiği gerçek sözleşme metnini oluştur.
4. README'ye yalnızca onaylı, bağlayıcı olmayan doğru açıklamayı ekle.
5. `docs/gtm/` altında fiyat/kapsam belgesini hukukçu onayından sonra yayınla.
6. Gelen talepleri karşılayacak onaylı bir iletişim adresi belirle.

`NOTICE` dosyası ve mevcut telif sahipliği, ticari lisans satabilmek için
tüm katkıların hak durumunun net olmasını gerektirir. Dış katkı alındıysa
CLA durumu incelenmeli — bu, adım 1'in parçasıdır.
