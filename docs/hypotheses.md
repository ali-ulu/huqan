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

> **Sınır:** Hipotez üretimi doğruluk garantisi değildir. Sonuçlar kanıt, provenance, approval ve policy geçitlerinden bağımsız olarak canonical gerçek kabul edilmez.
