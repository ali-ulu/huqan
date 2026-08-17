# HUQAN DLM — deterministik sentez ve kütüphane indüksiyonu

**Durum:** çalışan prototip + ölçüm. Ürün taahhüdü değil, kaynak gerçeği.
**Koşum:** `npm run dlm` · **Test:** `npm run test:dlm`
**Kod:** `lib/dlm/`, `scripts/dlm-experiment.js`

---

## 1. Neden bu var

"Deterministik dil modeli" bir çelişki gibi duruyordu. Değil — olasılıksal
modelin iki bileşenini değiştirmek yeterli:

| Olasılıksal LM | HUQAN DLM |
| --- | --- |
| token üzerinde dağılım | tipli terim uzayında sıralı arama |
| örnekleme (sampling) | sabit sıra, ilk-eşleşen, RNG yok |
| kayıp fonksiyonu | spesifikasyona karşı doğrulama (kabul/ret) |
| ağırlık güncellemesi | kütüphane indüksiyonu (yeni bileşen düğümleri) |

Sonuç: aynı spesifikasyon her zaman aynı programı verir; doğrulanmamış hiçbir
çıktı dönmez. Model "bilmiyorum" der (`solved:false`), uydurmaz.

## 2. Kapatılan yapısal boşluk

`dream.js`'in beş hipotez üretecinin tamamı yalnızca *var olan* düğümler
arasına kenar önerir. Hiçbiri yeni düğüm üretemez. Bu yüzden "öğrenilen
bilginin alt dalları kendiliğinden oluşsun" mevcut mimaride imkânsızdı.

Eksik organ **anti-unification**'dır (Plotkin 1970, *least general
generalization*): iki somut terimden ikisini de kapsayan en özel genellemeyi
deterministik olarak türetir. Çıktı, korpusta bulunmayan yeni bir bileşendir —
yani yeni bir düğüm. Üretim değil türetim olduğu için halüsinasyon riski
taşımaz.

`lib/dlm/antiunify.js` bunu uygular; aday seçimi Stitch (POPL 2023) ile aynı
sıkıştırma faydasını kullanır (gövde boyutu × kullanım sayısı).

## 3. Ölçüm

Kurulum: 23 bileşenli tipli DSL, aşağıdan-yukarı sayımlı sentez, gözlemsel
denklik budaması. Görev ayrımı **train / probe / test**; held-out görevler ne
indüksiyona ne seçime girer.

### 3.1 Kütüphane boyutu taraması (held-out toplam taranan program)

| soyutlama | taranan | kazanç |
| --- | --- | --- |
| 0 (taban DSL) | 20.792 | 1.00x |
| 1 (`f0`) | 4.057 | **5.12x** |
| 2 (`f0,f1`) | 5.410 | 3.84x |
| 3 (`f0,f1,f2`) | 6.596 | 3.15x |

**Bulgu: eğri monoton değil.** Kazanç 1 soyutlamada tepe yapıp geriliyor. Sebep
literatürde bilinen *library bloat*: her yeni bileşen numaralandırmanın
dallanma çarpanını büyütür. Soyutlamayı kullanmayan görev bu vergiyi öder.

Bu, "öğrendikçe üstel hızlanır" iddiasının ölçülmüş sınırıdır: **soyutlama
eklemek tek başına hızlandırmaz.**

### 3.2 Seçim kriteri

Sıkıştırma faydası korpusu küçültür, arama maliyetini küçültmeyi garanti etmez.
Seçim, probe kümesinde ölçülen arama maliyetine MDL cezası eklenerek yapılır:

```
amaç = log(probe arama maliyeti) + λ · |kütüphane|      (λ = 1)
```

λ = 1 "bileşen başına bir birim tanım uzunluğu" demektir; a priori seçilmiştir,
test kümesine bakılarak ayarlanmamıştır.

| seçim yöntemi | seçilen | held-out taranan | kazanç |
| --- | --- | --- | --- |
| sıkıştırma (Stitch faydası) | `f0,f1,f2` | 6.596 | 3.15x |
| maliyet, ceza yok | `f0,f2,f1` | 6.593 | 3.15x |
| **maliyet + MDL cezası** | **`f0`** | **4.057** | **5.12x** |

MDL cezalı seçim, test kümesine hiç dokunmadan tarama optimumunu buldu.

### 3.3 Doğrulama ve determinizm

- Held-out 7/7 çözüldü; **üretilen her program taban DSL'e açılıp yeniden
  doğrulandı** (kütüphane kısayoldur, güven kaynağı değildir).
- Deneyin tam çıktısı iki bağımsız koşumda **byte-identical**
  (`sha256 aebf75f5…`). Testler bunu ayrıca `deepStrictEqual` ile bağlar.
- Çözülemeyen spesifikasyonda program değil ret döner (`sum-of-squares` testi).

## 4. Dürüst sınırlar

1. **Alan dar.** Liste/sayı DSL'i, 23 bileşen. Gerçek kod domaini değil; AST
   çıkarımı henüz yok.
2. **Ölçek kanıtlanmadı.** Sayımlı sentez program boyutunda üsteldir.
   Kütüphane sabit bir faktör kazandırır, üstelliği kaldırmaz.
3. **Soyutlamalar 0-arity çıktı.** `f0 := rev(sort(x))` bir *ground term* —
   parametreli soyutlamadan çok memoizasyon. Delikli soyutlamalar bu görev
   setinde daha düşük fayda aldı.
4. **λ = 1 tek alanda denendi.** Başka alanda doğrulanmadı.
5. **Kazanç 5.12x, üstel değil.** Ölçülen budur.

## 5. Bağlantılı literatür

- Plotkin (1970) — least general generalization; yeni düğüm üretiminin
  deterministik temeli.
- Ellis vd., **DreamCoder** (PLDI 2021) — wake-sleep kütüphane öğrenimi;
  kütüphane büyüdükçe daha çok problemin *ve daha hızlı* çözüldüğü sonucu.
  HUQAN'ın farkı: nöral arama politikası yerine MDL sıralı deterministik
  numaralandırma.
- Bowers vd., **Stitch** (POPL 2023) — yukarıdan-aşağıya kütüphane öğrenimi;
  DreamCoder'a göre 3-4 kat büyüklük daha hızlı. Fayda tanımı buradan alındı.
- Cao vd., **babble** (POPL 2023) — e-graph + anti-unification.
- Gözlemsel denklik budaması — bottom-up SyGuS çözücülerinin standart budaması.

## 6. Sonraki doğrulanabilir adım

Sırayla, her biri kendi kabul ölçütüyle:

1. **AST çıkarıcı.** JS/TS kaynağını aynı graph'a düğüm olarak aç. Kabul:
   gerçek bir modülden çıkarılan AST üzerinde anti-unification en az bir
   tekrar eden yapıyı yeni düğüm olarak üretmeli.
2. **Delikli soyutlama baskısı.** Fayda fonksiyonuna genelleme terimi ekle;
   0-arity ground term'ler yerine parametreli soyutlamalar seçilsin. Kabul:
   held-out kazancı 5.12x'in altına düşmeden arity>0 soyutlama oranı artmalı.
3. **λ'nın ikinci alanda doğrulanması.** Kabul: farklı bir görev alanında da
   MDL seçimi tarama optimumunu ±%10 içinde bulmalı.
4. **Kernel entegrasyonu.** Soyutlamalar admission seam'inden geçen graph
   düğümleri olarak yazılsın, receipt üretsin. Kabul: her soyutlama için
   provenance kaydı ve denetlenebilir gerekçe.

Whitepaper bu dördü kapanmadan yazılmamalı; şu an elde 5.12x ve dar bir alan
var, "platform" iddiası yok.
