# LESSONS

Kalıcı dersler. Her görev öncesi taranır, her RCA sonrası güncellenir.

## KALICI KURALLAR

- Gelir kalemlerini sıralarken önce bağımlılık yönünü kur, sonra maliyeti yaz.
  "Mühendislik gerektirmiyor" ile "önce gelir" aynı şey değildir.
- Bir dağıtım/gelir iddiası yapmadan önce kurulum yolunu fiilen doğrula
  (`npm view <paket>`, kurulum komutunu çalıştır). README'deki komut,
  paketin yayımlandığının kanıtı değildir.

---

## 2026-08-19 — HUQAN / GTM

- HATA: Kapanış önerisinde "gelir peşindeysen" ve "dağıtım peşindeysen" iki
  alternatif yol olarak sunuldu; SKU 0 (AGPL ticari istisnası) dağıtım
  başlığına konuldu.
- KÖK NEDEN: `docs/gtm/sellable-products.md` içindeki SKU listesi bağımlılık
  yönü yeniden kurulmadan aktarıldı. SKU 0 "sıfır mühendislik" olduğu için
  "önce gelir" sanıldı — ucuz olmak ile bağımlılık zincirinde önce gelmek
  karıştırıldı. Listedeki her SKU aslında benimsenmenin altındadır.
- KURAL: HUQAN gelir tartışmasında dağıtımı gelirin alternatifi olarak sunma;
  önkoşulu olarak sun. Sıralama: kurulabilirlik -> benimsenme -> SKU 0/2/3.
  Ticari lisans sayfası gelir kalemi değil, hazırlık kalemidir.
- KAPSAM: HUQAN reposu, GTM ve yol haritası önerileri.

## 2026-08-19 — HUQAN / dağıtım durumu

- HATA: `huqan` paketinin dağıtım kanalı olduğu varsayıldı.
- KÖK NEDEN: `npm run conformance:external` çıktısı `package: huqan@0.9.1`
  yazıyor ve `test/kernel-facade-contract.test.js` gerçek bir tarball kurup
  test ediyor; bu ikisi registry'de yayımlanmışlık sanıldı. README zaten
  "registry publication" iddiasını açıkça reddediyordu.
- KURAL: `npm view huqan version` -> E404. Paket yayımlanmamıştır. Tek kurulum
  yolu `git clone`. Dağıtımla ilgili her plan bu gerçekten başlar.
- KAPSAM: HUQAN reposu, dağıtım ve paketleme kararları.
