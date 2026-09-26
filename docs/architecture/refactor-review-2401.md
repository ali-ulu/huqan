# #2401 refactor inceleme kaydı

#2401'deki kapalı-issue aday envanterinin dosya bazında karar kaydı. Her satır
kaynak okunarak yazıldı; tarayıcı sinyalinin yokluğu refactor gerekmez kanıtı
sayılmadı. Kararlar:

- **REFACTORED**: sorumluluk ayrımı yapılmış ve merge edilmiş; dosya artık bir cephe (facade).
- **KEEP**: dosyaya özel gerekçeyle olduğu gibi kalır.
- **DEFER**: ayrım mümkün ama bugün getirisi düşük; tetikleyici koşul yazılıdır.
- **REFACTOR**: somut ayrım önerisi; ayrı PR/issue ile yapılır.

Tarayıcı düzeltmeleri (aynı issue): paketlenen bin'ler ürün kapsamında (#2961),
composition root açık liste (#2962), if/else-if zinciri OCP sinyali (#2964).
SSE lifecycle (#2235) ve lexer (#2250) manuel incelemeleri issue gövdesinde
REOPEN olarak kaydedilmiş ve kendi PR'larıyla kapatılmıştır.

## Parti 1 — `scripts/`

İnceleme tabanı: `origin/main` @ `b872288`.

| Issue | Dosya | Satır | Karar | Kaynak sembolleri / korunan invariant / test / gerekçe |
|---|---|---:|---|---|
| #2131 | `scripts/external-conformance/consumer.js` | 18 | REFACTORED | #2958: `consumer-harness.js` + yedi sıralı bölüm modülü. İnvariant: vaka sırası ve rapor birebir (75 vaka, önce/sonra diff). Test: `test/v5-c5-external-conformance.test.js`. |
| #2159 | `scripts/a2a-conformance/run.js` | 75 | REFACTORED | `f0e1c7c6`: `run-support`, `run-fixture`, `run-cases`, `run-consumer`, `run-properties`. `buildFixture` cephe üzerinden export edilir. |
| #2164 | `scripts/launch-installed-package-smoke.js` | 103 | REFACTORED | #2891: `-cli`, `-context`, `-mcp`, `-parity`, `-rest` modülleri. Test: `test/spawn-windows-aware.test.js`; CI: `launch-smoke.yml`. |
| #2202 | `scripts/ci-impact-plan.js` | 64 | REFACTORED | #2877: `-agent`, `-build`, `-paths`, `-validate` + `ci-impact-rules.js`. Test: `test/test-impact-plan.test.js`, `test/ci-test-selection.test.js`. |
| #2221 | `scripts/agent-context.js` | 84 | REFACTORED | #2876: `-primitives`, `-baseline`, `-git`. Test: `test/agent-context.test.js`. |
| #2230 | `scripts/verify-package-tarball.js` | 148 | REFACTORED | #2825: `verify-tarball-shared`, `-checks-core`, `-checks-guard`. `module.exports` üç modülü yeniden yayar. |
| #2244 | `scripts/fitness-dashboard.js` | 149 | REFACTORED | #2792: SVG grafikleri `fitness-dashboard-charts.js`'e. Test: `test/fitness-dashboard.test.js`. |
| #2258 | `scripts/capability-usage.js` | 302 | KEEP | Tek soru: "bu yetenek hiç çalıştı mı?". `EVIDENCE` (el yazımı kaynak tablosu) → `evidenceFor` → `buildUsageReport` → `formatReport` tek bir boru hattı; ~50 satırı USED/NEVER/UNKNOWN ayrımını açıklayan belge. İnvariant: UNKNOWN asla NEVER'a katlanmaz. Test: `test/capability-usage.test.js`. Yeni yetenek = `EVIDENCE`'a bir satır, kod dalı değil. |
| #2273 | `scripts/external-client.js` | 281 | KEEP | Tek dosya olması sözleşme: `test/external-client-standalone.test.js` "zero repository-internal imports" testiyle göreli `require` yasak; dosya repodan bağımsız kopyalanıp denetlenebilen stdlib istemcisi. Bölmek bu invarianti bozar. Semboller: `assertTransportSecurity` (URL, kimlik bilgisi okunmadan önce reddedilir), `readApiKey` (argv'de anahtar yok), `verifyArtifact`. |
| #2278 | `scripts/check-docs-drift.js` | 280 | DEFER | `violationsIn` beş kural döngüsü (node-version, release-version, tool-name, route, missing-path); `RECORD_PATHS`/`ALLOWED` kapsam verisi. Bugün tutarlı. Tetikleyici: altıncı kural eklendiğinde kuralları `{ name, pattern, check }` tablosuna çevir. Test: `test/docs-drift-check.test.js`; CI: `architecture.yml`. |
| #2286 | `scripts/comment-pr-guardian-block.js` | 265 | KEEP | İki katman zaten ayrık ve ayrı test ediliyor: saf `buildComment`/`blockReason`/`escapeInline` export edilir; `githubRequest`/`nextPagePath`/`findManagedComment` yalnız bu workflow'un REST istemcisi (repoda Link-header pagination'ın başka kopyası yok). İnvariant: tek yönetilen yorum (`MARKER`), güncelle-yoksa-oluştur. Test: `test/pr-guardian-block-comment.test.js` (`fetch` stub). |
| #2301 | `scripts/knowledge-graph-demo.js` | 162 | REFACTORED | ~95 satırlık satır içi demo külliyatı `scripts/knowledge-graph-demo-corpus.json` veri dosyasına taşındı (grup sırası korunur; `buildDemoCorpus` çıktısı önce/sonra birebir). Korunan: `isDemoRequested` bayrağı olmadan hiçbir yazım yok, `resolvePersistDir` kapsamı; JSON `package.json#files`'ta. Test: `test/knowledge-graph-demo-safety.test.js`. |
| #2347 | `scripts/seed-demo.js` | 135 | KEEP | `createKernel`/`addFact`/`seedFacts`/`runDemoSeed` küçük, test edilebilir bir demo tohumlayıcı; `KernelV2`'yi `loadPlugins: false` ile kuran scripts/ composition root'u. Test: `test/scripts-testability.test.js`, `test/mutation-admission-boundary.contract.test.js`. |

Açık kalan: `lib/`, `adapters/`, `schemas/`, `public/`, `plugins/` ve kök
dosyalar (sonraki partiler).
