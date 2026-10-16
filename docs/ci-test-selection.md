# PR Test Seçimi ve Ajan Test Planı

HUQAN, her PR’da bütün test dosyalarını çalıştırmak yerine değişen yüzeyin etkilediği testleri seçebilir. Bu mekanizma testleri silmez; PR geri bildirimini daraltır, nightly ve release katmanlarında tam envanteri korur.

## Güvenlik kuralı

> Ajan test ekleyebilir; zorunlu test çıkaramaz.

Deterministic selector önce minimum güvenlik ve sözleşme kümesini oluşturur. Bu küme admission, approval, policy, Agent Action Firewall, workspace/tenancy, provenance, Trust Receipt, audit, mutation journal, persistence, auth, sandbox, package closure ve ilgili core delegation testlerini kapsar. Ajanın önerisi yalnızca bu kümenin üzerine eklenir.

Ajan önerisi varsa PR branch’inde `.huqan/agent-test-plan.json` dosyası bulunabilir. Dosya şu alanları kullanır:

```json
{
  "schemaVersion": 1,
  "addTests": ["test/v5-c5-external-conformance.test.js"],
  "confidence": "high",
  "rationale": "Changed graph path crosses the external trust package boundary.",
  "fallback": "none"
}
```

`addTests` yalnızca repository’de keşfedilen gerçek test dosyalarını içerebilir. `removeTests`, arbitrary command, workflow değişikliği veya seçilmiş test listesini doğrudan override eden alanlar geçersizdir. Unknown file, schema hatası, `low` confidence veya `fallback: "full"` durumunda selector tam test suite’ine düşer.

## Deterministic seçim

`node scripts/ci-impact-plan.js` changed path, impact rule ve mandatory union üzerinden `artifacts/test-impact-plan.json` üretir. `graph.js`, `kernel.js`, `server.js`, `mcpServer.js`, approval/policy/firewall/receipt/provenance/persistence, package manifest veya workflow değişiklikleri genişletilmiş veya full fallback planını tetikler. Docs-only değişiklikte runtime test seçilmez.

Üretilen plan `selectedTests`, `mandatoryPatterns`, `matchedImpactRules`, `dependencyDerived`, `agent.addedTests`, `fullSuite` ve `fallbackReason` alanlarını içerir. `node scripts/run-test-shard.js --selection=artifacts/test-impact-plan.json` yalnızca doğrulanmış `selectedTests` listesini weighted shard’lara dağıtır; boş veya unknown liste Node’un default test discovery’sine düşmez.

## Bağımlılık-türetimli seçim (#2610)

Impact rule tablosu elle tutulan bir açıklamadır ve ağaç hareket ettikçe sessizce kayar. #2505 C `lib/external-action-identity.js` dosyasını değiştirdi, tabloda bu yolu karşılayan hiçbir kural yoktu, plan 885 testin 117’sini seçti ve yeni default’u sınayan beş suite çalışmadı. 27 hata ancak ertesi gün nightly koşusunda görüldü.

Bu yüzden seçim artık gerçek bağımlılık grafiğinden türetilir (`scripts/ci-test-selection.js`):

- **require kenarı.** Değişen dosyayı (geçişli olarak) require eden test seçilir.
- **adlandırılmış-dosya kenarı.** Bir test bir dosyayı tırnaklı literal içinde adlandırıyorsa seçilir. Subprocess olarak `bin/huqan-gate-hook.js` çalıştıran ve `test/fixtures/deterministic-tasks/<ad>.json` fixture’ını yükleyen suite’ler require grafiğinde görünmez; kayıp giden bağımlılıklar tam olarak bunlardır.

`.js` hedefine adlandırılmış-dosya kenarı yalnızca kaynak gerçekten süreç başlatıyorsa (`spawnSync`/`execFileSync`/`exec`/`fork`) kurulur. Süreç çalıştıran dosya çalıştırdığı programı adıyla anmak zorundadır; yalnızca modül require eden dosya başka dosyalardan sadece düzyazıda söz eder, düzyazı ise bağımlılık değildir. Ölçüm: bu kısıt olmadan `server.js` bir yardımcıdan düzyazıda anıldığı için server closure’ı her şeye kaynıyor ve tek bir değişiklik 111 yerine 417 test seçiyor. `.js` olmayan hedefler (fixture, şema, workflow dosyası) geniş kuralı korur; bunlar closure’ları birleştiremeyen yapraklardır ve bayat bir JSON fixture’ını başka hiçbir kapı görmez.

Katman yalnızca **ekler**: mandatory union ve impact rule tablosu taban olarak kalır, dolayısıyla plan daralamaz, sadece genişleyebilir. Yeni çalışma için tipik seçim: 223/886 test, 5/5 hedef suite.

## CI katmanları

| Katman | Kapsam |
|---|---|
| PR fast required | Deterministic mandatory union ve değişen yüzeyin unit/contract testleri |
| PR impact integration | UI, browser, MCP, A2A, external veya stress testleri yalnız ilgili path değişince |
| Nightly | `schedule` veya `workflow_dispatch` ile tüm keşfedilen test dosyaları |
| Release | Full suite, external conformance, browser, stress, benchmark ve package round-trip |

Mevcut required check adı `npm test gate` olarak korunur. Plan üretimi başarısız olursa gate başarısız olur; planın sessizce NOT_APPLICABLE sayılması mümkün değildir. Test seçimi deterministik değildir veya güven seviyesi düşükse kapsam genişler; yanlış pozitif maliyeti kabul edilir, etkilenmiş güvenlik testinin atlanması kabul edilmez.
