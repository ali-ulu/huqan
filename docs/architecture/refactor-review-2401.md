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

## Parti 2 — `lib/`, `adapters/`, `schemas/`, kök (ilk 17)

İnceleme tabanı: `origin/main` @ `5f04799`.

| Issue | Dosya | Satır | Karar | Kaynak sembolleri / korunan invariant / test / gerekçe |
|---|---|---:|---|---|
| #2140 | `lib/verify.js` | 108 | REFACTORED | #2941: `verify-compound`, `verify-contradiction-scan`, `verify-edge-phases`, `verify-graph-phases`, `verify-result`. Test: `test/kernel-v2-native-public-verify-result.test.js`, `test/verify-detect-contradictions-scan.test.js`. |
| #2210 | `adapters/http-adapter.js` | 130 | REFACTORED | 398 satırlık dört sorumluluk ayrıldı: `http-adapter-transport.js` (`pinnedLookup`, `rawFetch`, `fetchUrl`, `setBoundedCache`), `http-adapter-robots.js` (`parseRobotsDisallow`, `isAllowedByRobots`, `assertRobotsAllows`), `http-adapter-html.js` (`parseHtml`); cephe yanıt önbelleği ve ingest'i tutar, aynı isimleri export eder. Korunan: her redirect adımında `resolveSafeAddress` sabitlemesi, `maxBytes` kesmesi, fetch ve her hop öncesi robots. Connector-firewall defteri aynı dört `fetchUrl` çağrısını yeni dosyalarında sayar. Test: `adapters/http-adapter.test.js`, `test/http-adapter-redirect-robots.test.js`, `test/connector-firewall-coverage.contract.test.js`. |
| #2211 | `lib/module-reachability.js` | 277 | KEEP | ~160 satırı elle bakılan sınıflandırma verisi (`PRODUCTION_ENTRY_POINTS`, `STANDALONE_FILES`, `NOT_YET_WIRED` …); analiz (`analyzeReachability`) ~40 satır. Listelerin tek yerde olması gözden geçirilebilirliğin şartı; ayırmak yalnız dosya sayısı üretir. Test: `test/module-reachability.test.js`, `test/module-reachability-symlink-safety.test.js`. |
| #2213 | `lib/verify-native.js` | 238 | REFACTOR | Türkçe metin eşleştirme `verify-turkish-text.js`'e ayrılmıştı (`9641e758`), ama `buildVerifySemanticTrust` hâlâ 158 satırlık tek fonksiyon: destek puanı, yedi risk dedektörü (`detectHighRiskDomain` … `detectMultilingualAmbiguity`, her biri çağır-ve-ekle), çelişki sinyalleri ve sınıflandırma. Öneri: dedektörler bir liste üzerinden, fazlar ayrı fonksiyonlar. Korunacak: sinyal sırası (`uniqueFlags` çıktısı), `supportVerified` eşiğiyle `verified` düşürme. Test: `test/verify-substring-false-contradiction.test.js` (dolaylı; önce karakterizasyon testi gerekir). |
| #2214 | `lib/graduated-autonomy.js` | 169 | REFACTORED | #2214: kademe politikası ve durum geçişleri `autonomy-state.js`'e; receipt geçmişi `autonomy-receipt-history.js` (yeniden export edilir). Test: `test/graduated-autonomy.test.js`, `test/autonomy-state.test.js`. |
| #2215 | `lib/external-action-identity.js` | 198 | KEEP | `evaluateAgentIdentityCard` fail-closed bir güvenlik kapısı: kart → imza → workspace → agent → geçerlilik zamanı → yetki → görev kapsamı; ilk başarısızlık kararı verir. Sıra güvenlik anlamı taşır ve sıralı guard clause'lar en denetlenebilir biçim. Test: `test/external-action-guard.test.js`, `test/human-sponsor-authority.test.js`. |
| #2216 | `lib/graph-record-utils.js` | 152 | REFACTORED | #2869: `graph-record-utils-edges`, `graph-record-utils-nodes`. Test: `test/graph-edge-read-delegation-contract.test.js`, `test/graph-node-write-delegation-contract.test.js`. |
| #2217 | `lib/self-healer/behavioral-containment.js` | 136 | REFACTORED | #2862: `behavioral-containment-baseline`, `-records`. Test: `test/self-healer-behavioral-containment.test.js`. |
| #2218 | `lib/external-client-package-gate.js` | 134 | REFACTORED | #2864: `-inputs`, `-verify`. Test: `test/external-client-route-adversarial.test.js`. |
| #2219 | `lib/human-oversight-approval-runtime-primitives.js` | 121 | REFACTORED | #2865: `-primitives-normalize`, `-primitives-values`. |
| #2220 | `lib/http-human-oversight-adapter.js` | 182 | REFACTORED | #2866: `-identity`, `-input`. Test: `test/http-human-oversight-production-wiring.test.js`. |
| #2222 | `requestGuards.js` | 97 | REFACTORED | #2874: `requestGuards-body`, `-command-policy`, `-rate-limit`. Test: `test/faz2-rest-cli-mutation-gate-parity.test.js`. |
| #2223 | `lib/agent-identity-runtime.js` | 134 | REFACTORED | #2867: `-resolve`, `-shape`. Test: `test/agent-identity-runtime.test.js`. |
| #2224 | `schemas/v5/shared-trust-package-validator.js` | 149 | REFACTORED | #2813: `shared-trust-package-guards`, `-sections`. Test: `test/v5-shared-trust-package-validator.test.js`. |
| #2225 | `lib/github-app-streaming-trust-store.js` | 196 | REFACTORED | #2826: `-files`, `-records`. Test: `test/v5-c8-streaming-trust.test.js`, `test/gateA-crash-recovery.test.js`. |
| #2226 | `adapters/github-adapter.js` | 186 | REFACTORED | #2811: `github-adapter-utils`, `github-tree`. Test: `test/source-version-pinning-e2e.test.js`. |
| #2228 | `lib/self-healer/dryrun-runner.js` | 197 | REFACTORED | #2817: `dryrun-budget-gate`, `dryrun-projections`. Test: `test/self-healer-dryrun-runner.test.js`. |

Açık kalan: `lib/` ve `adapters/` altında #2229'dan başlayan adaylar, `schemas/`, `public/`, `plugins/` ve kök dosyalar (sonraki partiler).
