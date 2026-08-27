# Deterministic Graph Hypotheses

HUQAN’ın `hypotheses` komutu, mevcut Graph read API’leri üzerinden workspace-scope’lu, deterministik ve kural tabanlı bir analiz raporu üretir. Motor **önerir; canonical graph yazmaz**. Varsayılan çalışma salt-okumadır.

## Kurallar

| Kural | Ciddiyet | Varsayılan koşul |
| --- | --- | --- |
| `KANIT_EKSİK` | `medium` | Düğüme gelen kenar vardır, ancak hiçbir gelen kenar kanıt taşımaz. |
| `KRİTİK_DÜĞÜM` | `high` | In-degree değeri en az `5`’tir. |
| `YALITILMIŞ_DÜĞÜM` | `low` | Düğümün gelen veya giden kenarı yoktur. |
| `ZAYIF_BAĞ` | `medium` | Kenar confidence değeri `0.4` altındadır. Confidence yoksa Graph’ın mevcut weight değeri, o da yoksa `0.5` kullanılır. Confidence tam olarak `0.4` ise bağ zayıf kabul edilmez. |
| `NEDENSEL_DÖNGÜ` | `high` | `CAUSES`, `PREVENTS`, `ENABLES`, `DEPENDS_ON` veya `LEADS_TO` ilişkilerinde çevrim bulunur; bir causal self-loop (`a -> a`) tek bir çevrim olarak raporlanır. |
| `KÜÇÜK_BİLEŞEN` | `low` | En büyük bağlı bileşenden kopuk, en fazla `3` düğümlü bir bileşen vardır. |

Aynı girdi aynı sırada aynı raporu üretir. Raporun `meta.ruleCounts` alanı kural bazında sayıları içerir. `workspaceId`, `nodeCount` ve `edgeCount` rapor kapsamını açıkça taşır. Motor, read API’si kapsamlı dönse bile node ve edge kayıtlarındaki `workspaceId` değerini ikinci kez doğrular; hedef workspace dışındaki kayıtları analize almaz. `KRİTİK_DÜĞÜM` için eşik karşılaştırması `>=`, `ZAYIF_BAĞ` için karşılaştırma `<` şeklindedir.

## Kullanım

```bash
node cli.js hypotheses
node cli.js hypotheses --json
node cli.js hypotheses --workspaceId default --critical 3 --confidenceFloor 0.25 --small 2
node cli.js hypotheses --propose --critical 3
```

`--json`, CLI’nin mevcut `WorkflowEnvelope` sözleşmesine uyar. `--propose` yalnızca yüksek ciddiyetli hipotezleri `candidate_claim` olarak admission ve CLI mutation-audit sınırından geçirir; mevcut graph’a doğrudan edge veya node yazmaz. Proposal modu açıkça istenmedikçe hiçbir candidate claim oluşturulmaz.

## İnsan incelemesi

`--propose` ile kuyruğa alınan adaylar `status: 'pending'` ve `recommendation: 'flag'` taşır. Conflict-detection yolu `flag` önerisini hiçbir zaman kabul veya redde taşımadığı için, bu adayları insan kararıyla sonuçlandıran tek yol `hypotheses review` komutudur.

```bash
node cli.js hypotheses review cand_hyp_<digest> --accept --reviewer ali
node cli.js hypotheses review cand_hyp_<digest> --reject --json
```

Karar yalnızca `status`, `reviewedBy` ve `reviewedAt` alanlarını değiştirir; motorun kendi önerisini taşıyan `recommendation` alanına dokunmaz. İki ayrı olgudur: biri motorun ne dediği, diğeri insanın ne dediği.

**Kabul, teşhis onayıdır; kenar onayı değildir.** `ZAYIF_BAĞ` adayları dolu bir `proposedEdge` taşır, ancak `--accept` hiçbir koşulda canonical node veya edge yazmaz — hipoteze katılmak, o kenarın grafa eklenmesini istemek anlamına gelmez. Bu ayrım, "motor yalnızca önerir, asla yazmaz" omurgasını uçtan uca korur.

Komut fail-closed davranır: bilinmeyen `candidateId`, hipotez motoru dışında bir kaynaktan gelen aday, zaten incelenmiş bir aday ve tanınmayan bir karar reddedilir. İlk verilen karar sessizce üzerine yazılmaz. Yazım, `--propose` ile aynı admission seam'inden ve aynı CLI mutation-audit girdisinden geçer; sonuç `CLAIM_ACCEPTED` veya `CLAIM_REJECTED` audit event'i olarak kayda geçer.

`accepted` / `rejected` değerleri, kural bazında geri bildirim sayımının girdisidir ve bu iki yüzey arasında değişmez bir veri sözleşmesidir.

## Kural bazında geri bildirim

`hypotheses feedback`, kaydedilmiş inceleme kararlarının kural bazında ne söylediğini raporlar. Tamamen salt-okumadır: düğüm, kenar, aday veya audit event yazmaz, hiçbir eşiği değiştirmez.

```bash
node cli.js hypotheses feedback
node cli.js hypotheses feedback --workspaceId alpha --json
```

Her kural için `accepted`, `rejected`, `pending`, `reviewed`, `total` sayıları ve iki oran döner. **Oranlar incelenmiş adaylar üzerinden hesaplanır, toplam üzerinden değil** — bekleyen bir aday henüz bir yargı taşımaz, paydaya girerse "henüz bakılmamış" durumu "kural aleyhine kanıt" gibi okunur. Hiç inceleme yoksa oranlar `0` değil `null` döner; bu ayrım, eşik önerisi üreten bir adımın veri yokluğunu düşük performansla karıştırmasını engeller.

Yalnızca `provenance.sourceType === 'hypothesis-engine'` adayları sayılır; `[TYPE]` etiketi taşıyan yabancı bir iddia da sayıma girmez. Etiketi bozulmuş bir hipotez adayı düşürülmez, `BİLİNMEYEN` kovasında görünür. Çıktı kural tipine göre sıralıdır ve aynı girdide birebir aynıdır.

## Eşik tuning tavsiyesi

`hypotheses tuning`, geri bildirim istatistiklerini somut bir eşik önerisine çevirir. **Tavsiye üretir, uygulamaz** — hiçbir eşiği, config dosyasını veya kaydı değiştirmez; çıktıdaki `applied` alanı her zaman `false`'tur. Eşiği kalıcı olarak değiştirmek, kendi admission ve onay hikâyesi olan ayrı bir iştir.

```bash
node cli.js hypotheses tuning
node cli.js hypotheses tuning --json --critical 7
```

Bir kural için öneri üretilmesi iki koşula bağlıdır: en az **5** inceleme (`MIN_REVIEWED`) ve **%60 üzeri** red oranı (`REJECTION_TRIGGER`; eşitlik tetiklemez). Koşullar sağlanmazsa kural `skipped` listesinde gerekçesiyle görünür — `insufficient_data`, `within_tolerance`, `already_at_bound` veya `no_tunable_threshold`.

| Kural | Option | Yön | Etki |
| --- | --- | --- | --- |
| `ZAYIF_BAĞ` | `confidenceFloor` | −0.05 | daha az kenar zayıf sayılır |
| `KRİTİK_DÜĞÜM` | `criticalInDegree` | +1 | daha az düğüm kritik sayılır |
| `KÜÇÜK_BİLEŞEN` | `smallComponentSize` | −1 | daha az bileşen küçük sayılır |

`KANIT_EKSİK`, `YALITILMIŞ_DÜĞÜM` ve `NEDENSEL_DÖNGÜ` yapısaldır, ayarlanabilir bir eşiği yoktur; sessizce düşürülmez, `no_tunable_threshold` gerekçesiyle raporlanır. Öneriler `generateHypotheses`'in kabul ettiği sınırların içinde kalır, böylece elle uygulanan bir öneri sessizce varsayılana geri kırpılmaz.

**Öneriler yalnızca bir kuralı susturur.** Sürekli reddedilen bir kural fazla ateşleniyordur; öneri onu daha az ateşlenecek yöne taşır. Tersi yön — çoğunlukla kabul edilen bir kuralın eşiğini gevşetmek — bilerek yapılmaz: kabul, bulguların doğru olduğunu söyler; daha fazla bulgu beklediğini değil. İkincisini birincisinden çıkarmak, bir tuner'ın kendi çıktısını büyütmeye başlama biçimidir.

> **Sınır:** Hipotez üretimi doğruluk garantisi değildir. Sonuçlar kanıt, provenance, approval ve policy geçitlerinden bağımsız olarak canonical gerçek kabul edilmez.
