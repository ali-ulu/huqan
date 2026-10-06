# R19: model-agnostic yerel nöral biliş adayı (I6, B7)

`huqan-neural-lab` çıktısı **yetki değildir**. Model, model-agnostic bir port
üzerinden yalnız `CANDIDATE_ONLY` bir öneri (`canonical: false`) üretir; kalite,
bütçe ve yerellik B7 ile ölçülür. KEEP yalnız deneyseldir; otomatik model, bellek
veya graph-rule promosyonu yoktur.

## Port ve model

| Yüzey | Ne söyler | Ne söylemez |
|---|---|---|
| `lib/cognitive-model-port.js` | Doğrulanmış öneri sözleşmesi (`huqan-cognitive-model-v1`), katı alan kontrolü, yerellik kapısı | Bir cevabın doğru ya da yetkili olduğunu |
| `lib/cognitive-model-local-ssm.js` | Yerel, deterministik SSM ailesi: sabit tohumlu reservoir + kapalı-form ridge readout | Kalibre olasılık, eylem izni, kanonik kural |
| `bin/huqan-neural-lab.js` | Sınırlı, çevrimdışı B7 ölçümü ve tek JSON rapor | Bellek açma, dış çağrı, promosyon |

```js
const { createLocalNeuralModel } = require('huqan');
const model = createLocalNeuralModel({ seed: 3474, reservoir: 24, ridge: 0.5, steps: 8 });
model.train([{ sequence: [1,0,1,1,0,1,1,0], label: 1 }]);
const proposal = model.predict([1,1,1,1,0,0,1,1]);
// proposal.authority === 'CANDIDATE_ONLY', proposal.canonical === false
```

Aktivasyon `Math.tanh` değil `s / (1 + |s|)`'dir: ikincisi platformlar arasında
bit düzeyinde aynı olmayabilir ve model çıktısı hash'lenir. Ağırlıklar sabit
tohumlu LCG'den çekilir ve dondurulur; aynı tohum aynı modeli ve aynı cevabı verir.

## Ön-kayıt (preregistration)

Tasarım, girdi üreteci ve ortam kanunu ölçümden **önce** dondu. Herhangi bir eşik
sonuç görülmeden önce yazıldı; `test/cognitive-lab-neural-experiment.test.js`
donmuş kaydı (`fixtures/cognitive-lab/neural-cognition-design.json`) pinler.

| Alan | Değer |
|---|---|
| Şema | `huqan-neural-cognition-experiment-v1` |
| Tohum | 3474 |
| Ortam | `bounded-binary-accumulation-v1` (8 adım, en az 4 tane `1`) |
| Split | train 400 / holdout 320 / transfer 320 (ayrık çekilişler) |
| Model | SSM, reservoir 24, ridge 0.5, steps 8, yerellik LOCAL |
| Bütçe | 0 model/dış/insan çağrısı, 0 token; ≤4096 örnek, ≤4096 parametre |
| Baseline | `majority` (train çoğunluğu) ve `memoryless` (yalnız son adım) |
| Eşik | min kalite 0.75; min kazanç 0.05; min kazanç alt sınırı 0.02 |
| Faz | `CONFIRMATORY_PREREGISTERED` |

Kalibrasyon bu dilimde **NOT_MEASURED**'dır: readout skoru kalibre olasılık
değildir ve bir sonuç-olasılık eşleşmesi tanımlanmamıştır.

## Nasıl çalıştırılır

```bash
node bin/huqan-neural-lab.js --benchmark B7 \
  --source-commit <40-karakterli Git SHA> --source-dirty <true|false>
```

Araç donmuş ortam kanunu digest'i kurulu kaynakla uyuşmazsa ölçüm yapmayı
reddeder ve çağıranın bildirdiği Git SHA'sının yanında okuduğu her kaynak
dosyasının ölçülen hash'ini raporlar.

## Ölçülen sonuç (tohum 3474)

| Split | Aday | Majority | Memoryless | Kazanç (majority) | Kazanç alt sınırı |
|---|---|---|---|---|---|
| holdout | 0.888 | 0.666 | 0.634 | +0.222 | +0.085 |
| transfer | 0.931 | 0.634 | 0.622 | +0.297 | +0.160 |

Her iki split de KEEP. Dış çağrı 0, token 0, parametre 649, eğitim örneği 400.
Sonuç deterministiktir: aynı girdi ve aynı tohum aynı raporu verir.

## Sınırlar

- **Sentetik ve tek çerçeve:** sonuç yalnız sınırlı ikili dizi yasası içindir;
  dış görev, dil, görü, genel yetenek iddiası yoktur.
- **Kalibrasyon yok:** readout skoru olasılık olarak sunulmaz.
- **Tek uygulama:** port model-agnostiktir, ama bu dilimde yalnız SSM ailesi
  ölçüldü; RWKV/Mamba/Transformer karşılaştırması yapılmadı.
- **Yetki yok:** çıktı candidate-only; hiçbir otomatik promosyon yoktur.
