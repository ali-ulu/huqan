# M7 / G1 düzeltme kohortu: ön-kayıt kilidi

Durum: **KİLİTLİ — sahip onayı 2026-10-29.** Bu belge **yeni ve bağımsız** bir kohortu
kilitler; tüketilmiş 2026-10-27 holdout'u (sonuç `ZARAR`) yeniden kullanılmaz,
ona göre ayar yapılmaz (#4381 kabul kriteri). Ön-kayıt tasarımı, hipotez yönü, etki
büyüklüğü, N formülü, karar kuralları ve etiket kümesi
`cog-m7-g1-holdout-preregistration-20261027.md` (sürüm 3 §12) ile **aynıdır**; yalnız
corpus seed'i ve aday düzeltmesi değişir. Herhangi bir değişiklik yeni sürüm gerektirir.

İlgili iş: #4387 (düzeltme + yeni kohort), #4381 (zarar atfı), #4065 (tüketilmiş
M7/G1 ölçümü), epic #4060 (G3). Plan: `docs/cognitive-architecture-plan.md`.

## 1. Kaynak ve kollar

- Aday kaynak SHA: bu belgeyi ve düzeltmeyi taşıyan PR'ın merge edildiği `main`
  commit'i; calibration manifesti ayrıca sabitler.
- **Aday kol:** düzeltilmiş M7 (salience → scheduler urgency). Düzeltme tek bir
  kuraldır: **aile seviyesinde kanıtlanmış negatif değere sahip bir aile kendi
  başarısızlık kaydıyla terfi edemez.** `lib/agent-cognition-seam.js` bu ailede aile
  özetinden gelen `surprise` ve ledger'dan gelen `arousal` katkısını çeker; kalan
  bileşenler (novelty, risk, goal) aynı kalır. Salience formülü
  (`lib/cognition/salience.js`, `DEFAULT_WEIGHTS`) **değişmez**.
- **Kontrol kol:** aynı SHA, aynı gözlem/öğrenme/ödül akışı; yalnız scheduler'a giden
  `urgency` sıfırlanır (`lib/cognitive-lab-g1-arm-preload.js`, v3 §12 #3).
- Geri kalan her şey (HTTP yolu, onay yetkisi, kolların aynı önyüklemeyi yüklemesi,
  tek salt-okunur kaynak depo, kol başına ayrı hedef dizin ve graf/journal kopyası)
  `cog-m7-g1-holdout-preregistration-20261027.md` §1 ve §12 ile **aynen** geçerlidir.
- Normalleştirilmiş scheduler girdileri iki kolda karşılaştırılır; `urgency` dışında
  ayrışma INSUFFICIENT'tır.

## 2. Hipotez (iki yönlü, yön iddia edilmez)

H1: Eşit görev bütçesinde **düzeltilmiş** M7 urgency katkısı, epizot başına bağımsız
kabulü geçen görev oranını kontrolden **farklı** kılar.

Düzeltmenin motivasyonu ölçülen zarardır (aile-bağımlı sinyal, düşük-getirili aileyi
öne alıyordu), ama **kazanç önceden iddia edilmez**: yeni ve bağımsız corpus'ta
düzeltme zarar da verebilir. Zarar da kazanç kadar raporlanır (§7).

## 3-8. Tasarım

§3 görev corpus'u, §4 bölme ve sızıntı, §5 epizot/bütçe/politika, §6 ölçü/etki/örnek
sayısı, §7 karar kuralları ve etiketler, §8 anti-vakalar ve mutasyon: hepsi
`cog-m7-g1-holdout-preregistration-20261027.md` §3-§8 (sürüm 3 §12 dahil) ile
**birebir aynıdır**. Tek fark §4 seed'idir:

- **Üreteç seed'i `20261029`.** Bu, 2026-10-27 holdout'undan farklı bir corpus
  (`corpusDigest`), farklı train/calibration/holdout split'i üretir; iki kohort
  arasında grup örtüşmesi yoktur. Üreteç `lib/cognitive-lab-g1-corpus.js`
  `buildG1Corpus({ seed })` ile parametrelenir; runner kohort kaydı
  `lib/cognitive-lab-g1-holdout.js` `COHORTS['g1-correction']` içindedir.
- **Holdout tek kullanımlıdır** ve bu kohort için ayrı bir `reportFile` yoluna yazılır
  (`wx` işareti yola bağlıdır). Tüketilmiş 2026-10-27 rapor yolu yeniden kullanılmaz.
- **Bütçe, seed listesi `[1, 2, 3]`, shuffle prosedürü, `maxSteps = 4`,
  `maxIterations = 2`, `maxEpisodeSteps = 6`, `minStratumGroups = 8` değişmez.**
- **Etki ve N:** |Δ| = 0.15; `N = clamp(ceil(((1.96 + 0.84)·σ̂/0.15)²), 32, 64)`;
  σ̂ yeni calibration'ın 8 grubundan (n − 1) hesaplanır ve holdout açılmadan manifestte
  kilitlenir.
- **Non-inferiority alt tabakası** tedavi öncesi, yeni train snapshot'ından tanımlanır.
  Boş/az alt tabaka kuralı §7'deki gibidir (GAIN verilmez; etiket GA'ya göre seçilir).

## 9. Kilit tablosu

| Kilit | Karşılığı |
| --- | --- |
| Yeni ve bağımsız kohort | §3 seed `20261029`, ayrı corpusDigest, ayrı reportFile (§3) |
| Düzeltme tanımı | §1 (yalnız negatif-değerli ailede aile-seviyesi surprise/arousal çekilir) |
| Salience formülü değişmez | §1 (`DEFAULT_WEIGHTS` sabit) |
| Hipotez yönü iddia edilmez | §2 (iki yönlü) |
| Karar kuralları/etiketler | v1 §7 aynen; değişiklik yok |
| Üretim varsayılanı | §10 (cognition opt-in kalır; hiçbir etiket varsayılanı değiştirmez) |

## 10. İddia sınırı

Bu ölçüm, sentetik ve model kullanmayan Coder görevlerinde M7'nin seçim etkisini
ölçer. Gerçek mühendislik görev başarısını, G2/G3 kabulünü veya genel öğrenme
kazancını kanıtlamaz. Hiçbir etiket üretim varsayılanını kendiliğinden değiştirmez;
promotion ancak G3 (#4060) sonrası ayrı bir PR'da değerlendirilir.

**M9 arousal etkisi bu belge kapsamı dışındadır.** Plan §9'un `arousalOff` kolu ayrı
bir çalışmadır (#4388); bu düzeltme arousal'ı yalnız negatif-değerli ailede çeker,
arousal bileşeninin tek başına etkisini izole etmez.
