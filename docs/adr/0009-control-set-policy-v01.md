# ADR-0009: #2505 control set — resolved policy v0.1

Tarih: 2026-09-25. Kaynak: ADR-0008 (Codex tasarım belgesi transkripsiyonu)
üzerinden falsifikasyon incelemesi: kaynak iddiaları canlıya karşı tek tek
doğrulandı, uyduruk madde yok; ama hiçbir sayı kalibre edilmiş değildi ve tüm
bağlayıcı kararlar "sahip onaylasın" diye geri atılmıştı. Bu ADR, tasarım
faslını kapatır: aşağıdaki sayılar **öneri olmaktan çıkıp v0.1 hükmü olur**,
fakat hiçbiri kalibre edilmiş değildir ve 4. maddedeki aktivasyon barajı
geçilmeden hiçbir yaptırım üretime giremez.

Durum: **DECIDED v0.1 (uncalibrated)**. Sayısal politika, tekrar-oynatma
kanıtı ve sahip imzası olmadan yaptırıma dönüşemez.

## 1. Kabul edilen sayılar (başlangıç hipotezi olarak hüküm)

- **A/I etki bütçesi:** run 200/300/400, session 400/600/800
  (review/quorum/block). Projeksiyon, önerilen aksiyon dahildir; eşitlik
  bandı tetikler; en katı hüküm kazanır. Onay yalnızca o aksiyon
  digest'ine verilir, bütçe sıfırlamaz. Bloklanmış toplam, olağan review
  ile aşılamaz.
- **Bypass yanıtı:** 10 dakika içinde 2. aynı engellenen deneme → run
  review; 3. → parmak-izi run-boyu blok + operatöre stop önerisi. 1
  doğrulanmış sandbox kaçağı veya yetkisiz yetki genişlemesi → blok +
  öneri. Beklenmeyen egress, deployment politikasında kalır. Salt
  kayıp/doğrulanmamış sinyalden otomatik stop yok.
- **D finansman:** review varsayılanı kalır; ödeme asla otomatik-allow
  almaz. USD başlangıç bantları: 100'e kadar tek bağımsız reviewer,
  100–1.000 quorum, 1.000 üstü ayrı ödeme mandası. Diğer para birimleri
  review'da tutulur. Bölünmüş ödemeler hedef+görev+24s penceresinde
  toplanır. Reviewer kendi ajanının ödemesini onaylayamaz.
- **E oran:** üst-ajan başına 60 saniyede 4 başlatma, workspace başına
  saatte 16 başlatma. Eşitlik serbest, sonraki başlatma review'da tutulur.
  Reddedilen/zaman-aşımı slot harcamaz; onaylanan harcar (çocuk sonradan
  başarısız olsa da). Saat defter hizmetinden gelir.

## 2. Korunan hükümler (değişiklik yok)

- **V4:** dondurulmuş harici-aday V2 yazıcısında `riskScore === 0` aynen
  kalır — miras sözleşme değeridir, hesaplanmış-sıfır iddiası değildir.
  Ölçülmüş risk, ayrı sürümlü hash-bağlı kanıttadır.
- **Public/VC/OTel:** 7 alan aynen kalır. Yeni public şema yalnızca
  alan-alan gizlilik incelemesinden sonra; önerilen ek
  `policyEvidenceHash` + `riskAssessmentStatus` (`computed`/`unknown`).

## 3. Kabul edilen formatlar (kayıt tarafı, yaptırımsız)

- Karar kanıtı: risk/`unknown`, 5 boyut girdisi, eşik anlık görüntüsü,
  sebep kodu, açıklama — Trust Evidence Ledger'da, aksiyon makbuz
  hash'ine tipli bağla bağlı. MCP aynı kelime dağarcığını kullanır.
- Çıktı hash'i veya açık `output_unavailable` sebebi her aksiyonda
  kaydedilir. Hash yalnızca bayt denkliği kanıtlar.
- Tersinirlik: `reversible`/`compensatable`/`irreversible` + merci + süre
  + referans. Bağlantı yoksa `unknown`. Tazminat, geçmişi silmeyen yeni
  yönetilen aksiyondur.
- Defter yazma hatası, dış-sonuçlu aksiyonun çalışmasını engeller; çalıştı
  ise olay kaydı korunur, başarılı makbuz uydurulmaz.
- Sürüm başına değerlendirici-imzalı kayıt (SHA, fixture digest'leri,
  kimlik, ortam, sayı/TM/kabul-riski/süre-sonu). Başarısız/eksik kayıt
  yayını bloklar. Aynı yazarın CI koşusu iç değerlendirmedir.
- Tahmin-kayıtları karar/aksiyon ID'siyle sonuçla eşlenir (red, geri
  alma, çelişki, olay, sansürlü pencere); kayıp sonuç `unknown`dur.
  Bant+sınıf bazında kalibrasyon; tek global doğruluk yok. Ayar yalnızca
  önerir, uygulamaz. Geri alma, önceki imzalı sürümü geri yükler.
- Capability yayını: kart hash'i + ölçüm penceresi + kaynak makbuz kökü +
  imza; `null`/kısmi/bayat görünür kalır; kimlik doğrulanamazsa yayın yok.
- Sektör overlay'i yalnızca sıkılaştırabilir; içerikten sektör etiketi
  çıkarılmaz. Olay bildirimi sürümlü özel zarf + insan onaylı gönderim;
  sınır-ötesi ayrı imzalı minimize projeksiyon; otomatik iletim yok.

## 4. Aktivasyon barajı (yaptırım için zorunlu)

1. En az 30 günlük doğrulanmış makbuz üzerinde tekrar-oynatma
   (`scripts/replay-impact-thresholds.js`): yanlış-blok sayıları,
   eksik-skor oranları, eşik dağılımı yayınlanır.
2. Kapsama yetersizse kapı `unknown` için `review`'da kalır, `allow` olmaz.
3. Tek kapsamda aktivasyon + kayıtlı geri-alma planı.
4. İmzalı politika sürümü (sürüm, kapsam, sahip, yürürlük zamanı, limitler).
5. Bu dördü olmadan hiçbir kutu tamamlanamaz; tasarım belgesi tek başına
   tamamlamaz.

## 5. Kalan iş (uygulama dilimleri, sırayla)

Runtime bağlantı (üretim aksiyon/MCP/spawn/çıktı yolları — yürütme
yönlendirme sınırları saklı), politika aktivasyonu, kanıt yayını,
değerlendirme/kalibrasyon akışı, capability yayıncısı, incident exchange.
Her biri ayrı dar PR; her kutu için arayan-iz, dayanıklılık testi,
fail-closed testi, tekrar testi ve runtime makbuzu şarttır.
