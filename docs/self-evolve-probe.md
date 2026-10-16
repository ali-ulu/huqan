# Self-Evolve Probe — soruşturma bulguları

Tek bir soruyu cevaplamak için yazılmış salt-okunur bir probe: **HUQAN'ın kendi kendini evrimleştirmesi, bildiğini mi değiştiriyor, yoksa öğrenme biçimini mi?**

Bu iki iddia aynı şey değildir. Türetilmiş bir kenar yazmak, sistemin *içeriğini* genişletmesidir. Bir eşiği değiştirmek, sistemin *içeriği üreten süreci* değiştirmesidir. Yalnızca ikincisi "öğrenmeyi öğrenme"dir; ve bu ayrımı iddia etmek kolay, göstermek zordur — bu yüzden probe onu tartışmak yerine ölçer.

## Bulgu

`lib/kernel-self-evolve.js` okundu. `runSelfEvolve`:

- `createDreams()` ile hipotez üretir; her birini `commitBackgroundEdge` üzerinden **kanonik kenar** olarak yazmayı dener. Yazım admission gate'inden geçer ve background kaynaklı yazımlar için varsayılan karar `review`'dur — yani operatör daha yüksek güvenli bir background politikası bağlamadıkça kenarlar `deferred` listesinde kalır.
- `consolidate(false)` ve `optimize()` çağırır; bir şey değiştiyse `save()` eder.
- `dreamCount` sayacını artırır.

**Hiçbir eşiği, hiçbir konfigürasyon değerini değiştirmez.** `confidenceFloor`, `criticalInDegree`, `smallComponentSize` — hipotez motorunun ayarlanabilir yüzeyinin tamamı — `runSelfEvolve` tarafından hiç okunmaz, hiç yazılmaz.

**Hüküm: `native-content-only`.** HUQAN bugün içeriğini evrimleştiriyor, öğrenme parametrelerini değil. Döngünün son halkası — sistemin kendi eşiğini değiştirmesi — hâlâ açık.

## Probe

```js
const { probeSelfEvolve, VERDICTS } = require('./lib/self-evolve-probe');

const probe = probeSelfEvolve(kernel, {
  workspaceId: 'default',
  invoke: () => kernel.selfEvolve({ workspaceId: 'default' }),
});
```

Probe iki şey yapar:

1. **Statik tespit** — `runSelfEvolve`, `buildSelfEvolveCollaborators` ve `runDream` mevcut mu (`probe.symbols`).
2. **Çalışma zamanı ölçümü** — verilen invocation'ın öncesi ve sonrasında düğüm, kenar, aday ve eşik değerlerinin farkı.

| Hüküm | Koşul |
| --- | --- |
| `native-writes-config` | bir eşik değişti |
| `native-content-only` | graf içeriği değişti, eşikler değişmedi |
| `inactive` | hiçbir şey değişmedi |
| `unmeasured` | invocation verilmedi |

**Probe hiçbir şey yazmaz.** Raporladığı fark yalnızca ölçülen invocation'dan gelir; testler `addNode` / `addEdge` / `addCandidateClaim` / `appendAuditEvent` çağrılarını spy'layarak probe'un kendisinin sessiz kaldığını doğrular. Invocation verilmezse ölçüm yapılmaz ve hüküm `unmeasured` döner — sembollerin varlığından bir sonuç uydurulmaz.

Patlayan bir invocation yutulmaz: hata mesajı `measurement.invocationError` alanında raporlanır ve sonrası anlık görüntüsü yine alınır, çünkü yarım kalmış bir koşu bir şey yazmış olabilir.

## Sınır

Probe bir invocation'ı tetiklemez; tetiklemeyi çağırana bırakır. Ölçtüğü şey o tek çağrının etkisidir, sistemin genel davranışı hakkında bir garanti değildir.
