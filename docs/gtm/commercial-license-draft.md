# Ticari Lisans — TASLAK

> **DURUM: TASLAK. HUKUKİ İNCELEME GEREKTİRİR.**
> Bu belge bir teklif veya bağlayıcı şart değildir. Fiyatlar ve şartlar
> yer tutucudur. Yayımlamadan önce bir avukatın gözden geçirmesi şarttır.
> Buradaki hiçbir madde hukuki tavsiye değildir.

## Neden bu SKU bugün satılabilir

HUQAN, **AGPL-3.0** ile lisanslı. AGPL'in ağ hükmü (§13) şunu gerektirir:
HUQAN'ı değiştirip bir ağ servisi üzerinden kullanıcıya sunan taraf, o
servisin tüm kaynak kodunu aynı lisansla sunmak zorundadır.

Bu, kapalı kaynak ürün satan her şirket için ikili bir seçim yaratır:

1. Kendi ürününü de AGPL yap, veya
2. Ticari istisna satın al.

**Gereken mühendislik: sıfır.** Ürün hazır. Eksik olan tek şey bir sayfa
ve bir iletişim adresi.

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

1. Avukat incelemesi — **diğer her şeyden önce**.
2. `LICENSE-COMMERCIAL.md` (gerçek metin, avukat onaylı).
3. README'ye kısa bölüm: "HUQAN AGPL-3.0'dır. Kapalı kaynak üründe
   kullanmak için ticari istisna mevcuttur: <iletişim>".
4. `docs/gtm/` altında tek sayfalık fiyat/kapsam belgesi.
5. Gelen talepleri karşılayacak bir e-posta adresi.

`NOTICE` dosyası ve mevcut telif sahipliği, ticari lisans satabilmek için
tüm katkıların hak durumunun net olmasını gerektirir. Dış katkı alındıysa
CLA durumu incelenmeli — bu, adım 1'in parçasıdır.
