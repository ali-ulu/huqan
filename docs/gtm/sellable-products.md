# HUQAN — Satılabilir Ürünler

**Baz:** `origin/main` @ `37f68cf`. Bu belgedeki her "çalışıyor" ifadesi
2026-08-12 gecesi çalıştırılarak doğrulandı; doğrulanmayan hiçbir şeye
"çalışıyor" denmedi.

---

## Bu gece fiilen doğrulanan varlıklar

Bunlar iddia değil, çalıştırılmış çıktı.

### 1. Kanıtlanabilir makbuz paketi — **en somut satılabilir artefakt**

```
GET /api/workbench/receipt-bundle?workspaceId=default
{"ok":true,"status":"exported","receiptCount":1,"serializedBytes":902,
 "bundleHash":"9984ea86cb44512e9d558b602cae674f420aacf65d4e14fbb91f79dd623e9bc0",
 "verified":true,"bundle":{"schemaVersion":"v4-receipt-bundle-v1",...}}
```

`verified: true` + içerik hash'i. Yani "ajanım şunu yaptı" iddiası,
kurcalanamaz bir pakete bağlanabiliyor. **Bu, para ödenen şeydir.**

### 2. Bellek kabul kapısı — çekirdek değer önerisi çalışıyor

```
POST /upload {"text":"Smoking causes lung cancer"}
→ outcome:"review", reason:"approval_required", graphWrite:false,
  provenanceId:"prov_f8bf...", receiptId:"madm_receipt_b0ec..."
```

Onay olmadan grafiğe yazmıyor, provenance ve makbuz üretiyor. Ürünün tezi burada gerçek.

### 3. A2A güven uyumluluk paketi — **en farklılaştırıcı varlık**

```
npm run conformance:a2a
52/52 passed · verdict: V5_D6_BOUNDED_A2A_EXCHANGE_SUFFICIENT
reportSha256: e3ad2b62...
```

50 düşmanca senaryo: yetki devri kapsam yükseltme, replay saldırısı, kimlik
bağlama takası, imza kurcalama, kısıt aşımı, iki süreçte tam-bir-kez etki.
Hepsi doğru şekilde bloklanıyor. Rapor imzalı, `nonClaims` listesi dürüst.

### 4. Dış uyumluluk paketi

```
npm run conformance:external
73/73 passed · 0 skipped · 0 failed · blocked gaps: 0
```

**Toplam 123 geçen uyumluluk vakası.** Bu, bir güvenlik/uyum ürününün
satış masasına koyabileceği en güçlü tek belgedir ve zaten elde.

---

## Bu gece doğrulanan engeller

Mühendislik güçlü; **paketleme satılamaz durumda.** Üç yüzeyin üçü de bozuk:

| Yüzey | Gözlenen | Etki |
|---|---|---|
| REST | `POST /verify` → `{"status":"bilinmiyor"}`; hata: `"statement veya text gerekli"` | API sözleşmesi Türkçe |
| REST | `/health` → `"service":"axiom"`; açılış: `🧠 AXIOM web arayüzü` | Terk edilmiş marka |
| REST | `/verify`, `claim` alanını reddediyor (sadece `statement`/`text`) | Sezgisel olmayan sözleşme |
| MCP | `serverInfo.name:"axiom"`, 11 tool `axiom.*`, örnek: **`"kedi hayvandir"`** | Dünyadaki her Claude/Cursor kullanıcısı bunu görüyor |
| UI | `<title>AXIOM — Productization & Shield</title>`, 14 AXIOM, karışık TR/EN etiket | İç jargon, eski marka |
| Açılış | 3 plugin yüklenemiyor (`company-brain`, `contradiction-alert`, `repo-memory`) | İlk izlenim "bozuk" |
| Test | Windows'ta 4 test kırmızı (EPERM) | Katkıcı ilk denemede kırmızı görüyor |
| İlk deneyim | İlk sorgu `"bilinmiyor"`, 0 kanıt döndürüyor | Demo tatmin etmiyor |

Bunların **hiçbiri mimari sorun değil** — hepsi paketleme. Bu iyi haber:
ucuz düzeltmeler, yüksek etki. (5 ajan bu gece bunların üzerinde çalıştı.)

---

## Satılabilir SKU'lar — ilk gelire kalan süreye göre

### SKU 0 — Ticari Lisans (AGPL alternatifi) · **hukukçu onayı sonrası değerlendirilebilir**

**Ne:** HUQAN şu anda `AGPL-3.0-only` ile dağıtılıyor. Kapalı kaynak bir ürüne
HUQAN bileşeni eklemek isteyen şirket, kullanım modelinin AGPL yükümlülüklerini
nasıl etkilediğini ve ayrı bir ticari sözleşmeye ihtiyaç olup olmadığını
hukukçusuyla değerlendirmelidir.

**Gereken iş:** Teknik çekirdek tek başına yeterli değildir. Satıştan önce hak
sahipliği ve dependency envanteri, covered component/version kapsamı, yazılı
lisans sözleşmesi, fiyat ve ödeme şartları, sorumluluk hükümleri ve onaylı
iletişim süreci tamamlanmalıdır.

**Fiyat:** 5.000-25.000 $/yıl yalnızca iç planlama için yer tutucudur; teklif
veya kamuya açık fiyat değildir.
**Alıcı:** ajan altyapısı satan yazılım şirketleri.
**Sonraki adım:** hukukçu incelemesi, `docs/legal/commercial-license-working-draft.md`
metninin onaylanması ve ancak bundan sonra gerçek ticari sözleşme ile iletişim
sürecinin oluşturulması. Bu belgede henüz `LICENSE-COMMERCIAL.md` bulunmuyor.

---

### SKU 1 — Agent Trust Gate (OSS, ücretsiz) · **dağıtım, gelir değil**

**Ne:** MCP + CLI + lokal REST. Ajanın riskli aksiyonunu onaya düşürür,
makbuz üretir.

**Amaç:** gelir değil, dağıtım ve güven. Balfour'un düşük-ARPU/düşük-CAC ucu.

**Engel:** yukarıdaki paketleme sorunları. `axiom.*` tool adları ve
`"kedi hayvandir"` örneği düzelmeden bu kanal çalışmaz.

**Fiyat:** 0 $.

---

### SKU 2 — Trust Receipt / Denetim Paketi · **1-2 ay**

**Ne:** Ekibin ajanlarının ne yaptığının kurcalanamaz kaydı. Doğrulanmış
makbuz paketi (yukarıda kanıtlandı), Trust Receipt Viewer (V4-B4 `PASS`),
denetim dışa aktarımı (V4-B3 `PASS`).

**Alıcı:** üretimde ajan çalıştıran, "ne oldu?" sorusuna kanıtla cevap
vermek zorunda olan ekipler.

**Gereken:** İngilizce API sözleşmesi + paketlenmiş kurulum (Docker zaten var)
+ çok kullanıcılı çalışma alanı.

**Fiyat:** 500-1.500 $/ay ekip başına, yıllık.
**Uyarı:** 20-50 $/ay bireysel katmana **girme**. Balfour'un tehlike bölgesi:
düşük-CAC kanallar için fazla sürtünmeli, satış+içerik için fazla ucuz.

---

### SKU 3 — Ajan Güven Sertifikasyonu · **en yüksek değer, 3-6 ay**

**Ne:** "Ajanınız HUQAN'ın 123 vakalık güven uyumluluk paketinden geçti"
belgesi. Kurcalanamaz, imzalı rapor.

**Neden bu en değerlisi:**
- Koşucular **zaten çalışıyor** (bu gece 123/123 doğrulandı).
- Rakiplerde eşdeğeri yok; ajan güvenliği için standartlaşmış düşmanca
  test paketi bir boşluk.
- Sertifika veren taraf kategoriyi tanımlar (Balfour'un otorite kanalı).
- Düşük-CAC dağıtımı yüksek ARPU ile barıştıran nadir yapı: geliştiriciye
  bedava dağıt, parayı sertifikaya ihtiyacı olan kurumdan al.

**Gereken:**
1. Koşucuyu üçüncü taraf implementasyonuna yöneltmek (bugün self-test +
   tek bir cross-implementation Python karşılaştırması).
2. Issuer zarfı: kimlik, düzenleme/bitiş zamanı, iptal, kriter sürümü,
   kanıt özeti — `docs/v5/v5-certified-node-draft.md` (C9) bunları zaten
   doğru şekilde "gelecekteki issuer alanları" diye tanımlamış.
3. `V5_IMPLEMENTATION_ENTRY: FAIL` kapısının açılması.

**Fiyat:** 15.000-50.000 $/yıl sertifika başına.
**Alıcı:** ajan/otomasyon satan yazılım şirketleri, kurumsal AI platformları.

**Not:** README bugün açıkça *"a public agent marketplace or certification
network"* iddia etmediğini yazıyor. Bu SKU'ya gidilecekse o satır bilinçli
olarak güncellenmeli — sessizce çelişilmemeli.

---

### SKU 4 — TrustBench (yayın) · **gelir değil, kanal**

**Ne:** Uyumluluk paketini kamuya açık bir benchmark olarak yayınlamak
(`docs/v5/v5-trustbench-draft.md`, C10).

**Amaç:** doğrudan gelir değil; SKU 3'ün talebini yaratan otorite kanalı.
Benchmark'ı yayınlayan taraf kategoriyi tanımlar.

**Taslak metnin kalitesi yüksek:** eksik vakayı paydada tutuyor, exit-code
sıfırı kanıt saymıyor. Bu dürüstlük benchmark'ın tek para birimidir.

---

## Önerilen sıra

```
ŞİMDİ      SKU 0  ticari lisans     → mühendislik yok, gelir bugün mümkün
2 HAFTA    SKU 1  paketlemeyi onar  → marka + İngilizce API + TTV (ajanlar başladı)
1-2 AY     SKU 2  denetim paketi    → ilk tekrarlayan gelir
3-6 AY     SKU 3  sertifikasyon     → asıl iş burada
PARALEL    SKU 4  TrustBench yayını → SKU 3'ün talebini yaratır
```

Kritik nokta: **SKU 0 dışındaki her şey SKU 1'in paketleme onarımına bağlı.**
`axiom.*` tool adları ve Türkçe API dururken hiçbir alıcıya gidilemez.

---

## Fiyatlandırmada kaçınılacak tek hata

20-50 $/ay bireysel geliştirici aboneliği. Düşük-CAC kanallar (MCP dizini,
OSS) için fazla sürtünmeli; içerik + satış maliyetini karşılamak için fazla
ucuz. AGPL zaten doğru iki uçlu yapıyı dayatıyor: **0 $ (dağıtım)** ve
**kurumsal (gelir)**. Ortası boş bırakılmalı.
