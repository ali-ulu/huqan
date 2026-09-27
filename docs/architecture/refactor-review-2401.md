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
| #2213 | `lib/verify-native.js` | 242 | REFACTORED | Türkçe metin eşleştirme `verify-turkish-text.js`'e (`9641e758`); 158 satırlık `buildVerifySemanticTrust` fazlara bölündü: `supportScoreFor`, `STATEMENT_RISK_DETECTORS` (yedi dedektör, aynı sıra), `edgeRuleSignals`, `verifyContradictionSignal`, `resolveStatus`, `matchTypeFor`. Önce karakterizasyon: `test/verify-semantic-trust-characterization.test.js` 95 girdinin tam çıktısını kayıtlı fixture ile karşılaştırır (her dedektör, hepsi birden, çelişki kuralı tetikleyen edge'ler); dedektör sırasını ya da `contradicted` destek puanını değiştiren mutasyonlar yakalanır. |
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

## Parti 3 — `lib/`, `schemas/` (#2229–#2251)

İnceleme tabanı: `origin/main` @ `10ac795`.

| Issue | Dosya | Satır | Karar | Kaynak sembolleri / korunan invariant / test / gerekçe |
|---|---|---:|---|---|
| #2229 | `lib/causal/causal-edge.js` | 262 | REFACTORED | 187 satırlık alan-başına-if doğrulayıcısı sıralı `FIELD_RULES` tablosuna çevrildi (self-edge kuralı uç noktalarla `relation` arasındaki yerinde); `futureFieldErrors`, `strengthLabelError` çapraz-alan kontrolleri, `unitIntervalError` strength/confidence için ortak. Önce karakterizasyon: `test/causal-edge-validation-characterization.test.js` 87 girdinin tam sonucunu (hata kodu, mesaj, alan, sıra) fixture ile karşılaştırır ve her hata koduna ulaşır; iki kuralın yer değiştirmesi ya da self-edge kuralının silinmesi yakalanır. Test: `test/causal-edge.test.js`, `test/causal-edge-schema.test.js`. |
| #2231 | `lib/github-app-beta-http-boundary.js` | 138 | REFACTORED | #2823: `github-app-beta-http-config`, `-errors`, `-responses`. |
| #2232 | `lib/graph-traversal.js` | 66 | REFACTORED | #2815: `graph-chain-traversal`, `graph-cycle-search`, `graph-path-search`. |
| #2233 | `lib/approval-flow.js` | 184 | REFACTORED | #2810: `approval-flow-utils`, `approval-receipts`. |
| #2234 | `schemas/v5/agent-identity-validator.js` | 342 | KEEP | Zaten kayıt tabanlı: `REASON_CODE_SHAPES` reason code → şekil doğrulayıcı haritası; her `validate*Shape` 10–30 satır, tek şemanın tek sorumluluğu. Yeni reason code bir satır + bir fonksiyon. Test: `test/v5-agent-identity-validator.test.js`. |
| #2236 | `lib/http/pr-guardian-routes.js` | 191 | REFACTORED | #2807: `pr-guardian-ui-route`, `pr-guardian-webhook-route`. |
| #2237 | `lib/plugin-provenance-registry.js` | 333 | KEEP | Tek bir kayıt defterinin API'si: `recordPluginLoad`, `verifyDependencyGraph`, `revalidatePlugin`, `markRevoked`, changelog okuyucuları; 17 fonksiyonun en uzunu ~50 satır ve hepsi aynı `registry` yapısı üzerinde. Çağıranlar `plugin-manager-*` modülleri. Test: `plugin-provenance.test.js`. |
| #2238 | `lib/graph-hypotheses.js` | 332 | DEFER | `generateHypotheses` sırayla dört kural uygular (düğüm, kenar, döngü, bağlı bileşen), yardımcılar (`findCausalCycles`, `connectedComponents`) zaten ayrık. Tetikleyici: beşinci kural eklendiğinde kuralları `(graph, context) => hypotheses[]` listesine çevir. Korunacak: `hypothesisSort` sırası, `KANIT_EKSİK` ile paylaşılan `hasEvidence`. Test: `test/graph-hypotheses-edge-cases.test.js`, `test/hypothesis-thresholds.test.js`. |
| #2239 | `lib/pr-guardian/policy.js` | 332 | KEEP | `RISK_PATTERNS` veri (~45 satır) + `evaluatePullRequest` sıralı karar yükseltmesi (eksik alan → risk şiddeti → kesik dosya listesi → check'ler → derivation → action → onaylı yürütme). Sıra politikanın kendisi ve her adım yorumla gerekçeli; bölmek sırayı dağıtır. Test: `test/pr-guardian-derivation.test.js`, `test/pr-guardian-execute-once.test.js`. |
| #2240 | `lib/viewer/viewer-gateway.js` | 192 | REFACTORED | #2806: `viewer-gateway-primitives`. |
| #2241 | `lib/memory-store-utils.js` | 114 | REFACTORED | #2805: `memory-persistence-paths`, `sqlite-busy-retry`. |
| #2242 | `lib/automation-safety-gate/automation-input-normalizer.js` | 324 | KEEP | 16 küçük normalizasyon yardımcısı + `normalizeAutomationSafetyInput` (~95 satır) tek girdi sözleşmesini kurar; `isSecretLikeValue` iç içe sır tespiti AB5 düzeltmesiyle (`f1590825`) bu sözleşmeye bağlı. Test: `test/automation-safety-gate.test.js`, `test/classifier-downgrade-fail-closed.test.js`. |
| #2243 | `lib/command-parser.js` | 315 | REFACTORED | 156 satırlık, 53 dallı `parseCommand` zinciri denendiği sırayla `COMMAND_RULES` tablosuna çevrildi (`prefixRule`, `wordRule`, `matchRule`); bağlam bir kez kurulur, ilk eşleşme döner, yoksa `anlamadım`. RFC-001 karar 7 katlama notları ve `coder`'ın büyük/küçük harf notu ilgili kuralın yanında. Önce karakterizasyon: `test/command-parser-characterization.test.js` 855 girdiyi (her önek ve kelime iki yazımla, büyük harf, boşluklu, yüklü; regex komutları; karşılaştırma/soru sezgileri; iki komşu kurala birden uyan girdiler; düğüm geri dönüşü) kernel'siz ve bir düğüm bilen kernel'le fixture'a karşı çalıştırır, 37 komutun hepsine ulaşır; karşılaştırma/soru ve `mı`/soru sırasının değişmesi ile katlamasız kelime eşleşmesi yakalanır. |
| #2245 | `lib/background-provenance.js` | 165 | REFACTORED | #2783: `background-provenance-projection`. |
| #2246 | `lib/provenance-ingest.js` | 216 | DEFER | `buildProvenance` 170 satır ama gövdenin büyük kısmı politika gerekçesi yorumları (F1a beyan edilen güven, içerik hash'i yokluğu). Alan normalizasyonu ile güven politikası tek fonksiyonda; ayrılabilir ama her satır admission kararına dokunur. Tetikleyici: yeni bir provenance alanı. Test: `test/ingest-content-hash-pinning.test.js`, `test/source-version-pinning-e2e.test.js`. |
| #2247 | `lib/risk-rules.js` | 316 | KEEP | Dedektör kataloğu: her `detect*` bağımsız, en uzunu 32 satır; `runRiskRules` onları sırayla çalıştırır. Adversarial dedektörler `adversarial-signals.js`'te. Test: `test/risk-rules-mutation.test.js`, `test/verify-semantic-trust-characterization.test.js`. |
| #2249 | `lib/llm-proxy/proxy-handler.js` | 314 | DEFER | `createLlmProxyHandler` (191 satır) kapanış fabrikası: `recordReceipt`, `forward`, `handleChatCompletions`, `handleModels`, yönlendirici. İki handler anahtar-yok ve `MAX_RESPONSE_BYTES` yanıtlarını tekrarlar. Tetikleyici: üçüncü endpoint; o zaman ortak yanıt yardımcısı çıkarılır. Test: `test/llm-proxy-handler.test.js`. |
| #2251 | `lib/mcp/response-builders.js` | 313 | KEEP | Bağımsız saf yanıt kurucuları (en uzunu `buildMemoryAdmissionSurface` 47 satır); tek konu MCP yanıt yüzeyi. Test: `test/mcp-security-integration-regression-matrix.test.js`, `test/mcp-learn-agent-contract.test.js`. |

## Parti 4 — `lib/`, `adapters/` (#2252–#2279)

İnceleme tabanı: `origin/main` @ `1c05cf4`. Fonksiyon uzunluğu, fonksiyonun kapanan `}` satırına kadar ölçüldü.

| Issue | Dosya | Satır | Karar | Kaynak sembolleri / korunan invariant / test / gerekçe |
|---|---|---:|---|---|
| #2252 | `lib/external-action-receipt-shipper.js` | 308 | KEEP | `shipExternalActionReceipts` (105 satır) sıralı boru hattı: oku → cursor → `unsentReceipts` → imza anahtarı (ilk batch'ten önce, yanlış anahtar hiçbir şey göndermeden düşsün diye) → tenant/run batch'leri → HTTP ya da `deliver`. Sıra invariantın kendisi; adımlar zaten ayrı fonksiyonlar. Test: `test/external-action-receipt-batch-signature.test.js`. |
| #2253 | `lib/memory-mutation-gate/memory-mutation-classifier.js` | 199 | REFACTORED | 279 satırlık 11 bloklu `classifyMemoryMutation`, aynı sırayla `CLASSIFICATION_RULES` tablosuna çevrildi; ortak alanlar `baseVerdict`/`changeFlags`'te, iki dinamik sonuç (release/auto-merge gerekçesi, geniş graph → dry-run-only) satırlarında fonksiyon. Önce karakterizasyon: `test/memory-mutation-classifier-characterization.test.js` 2276 üretilmiş girdinin kararını serileştirilmiş JSON olarak (alan sırası dahil; hash'lenen receipt buna bağlı) fixture ile karşılaştırır; kural sırası, graph kararı ya da alan sırası değişirse yakalanır. **Bulgu (düzeltilmedi, ayrı bug):** `malformed` dalı boş `scope` ister ama `normalizeEntry` her zaman varsayılan workspace'e düşer; `null`/`{}` girdi `malformed` yerine `unknown`/`review` alır. Dal olduğu gibi korundu, testte sabitlendi. |
| #2254 | `lib/github-app-beta-store.js` | 306 | KEEP | `createGitHubAppBetaStore` (101 satır) içi küçük kapanışlardan oluşan fabrika (`reserveDelivery`, `commitReceipt`, `readReceipt`); `assertSafeRoot` kök doğrulaması ayrı. Tek kaynak: teslim rezervasyon/receipt dizinleri. Test: `test/v5-c7-github-app-beta.test.js`. |
| #2256 | `lib/receipt/v4-receipt-family.js` | 305 | KEEP | 13 fonksiyon, en uzunu 56 satır; tek V4 receipt ailesinin kuralları. Test: `test/receipt-trust-root-3a-family-chain.test.js`. |
| #2257 | `lib/v5/verification-core.js` | 22 | REFACTORED | #2789: `verification-evaluator`, `-evidence-normalizer`, `-input-shape`, `-reason-mapping`. |
| #2259 | `lib/external-client-http-adapter.js` | 300 | KEEP | 21 küçük HTTP sınır yardımcısı (en uzunu `readBody` 52 satır, sınırlı gövde okuma). Test: `test/faults/network-disconnect.test.js`. |
| #2260 | `lib/memory-link-read.js` | 298 | KEEP | 8 okuma fonksiyonu, en uzunu `traverseLinks` 68 satır; workspace kapsamlı tek okuma yüzeyi. Test: `test/memory-link-read-delegation-contract.test.js`. |
| #2261 | `lib/v5/structural-signing-helper.js` | 298 | KEEP | `validateStructuralSigningInput` (76 satır) + imzalama yardımcıları; tek şema. Test: `test/v5-structural-signing-helper.test.js`. |
| #2262 | `lib/v5/runtime-reader.js` | 297 | KEEP | `validateReaderCandidate` (80 satır) + okuyucu; yazıcı tarafı zaten `runtime-writer-*` modüllerinde. Test: `test/v5-runtime-writer-reader-local-contract.test.js`. |
| #2263 | `lib/workflow-contract.js` | 303 | KEEP | Ağırlıkla veri: `WORKFLOW_CAPABILITIES`, `CLI_COMMAND_CAPABILITIES`, `COMPATIBILITY_COMMANDS` kataloğu; fonksiyonlar kısa (en uzunu `workflowOpenApiDocument` 42). Katalog tek kaynak olmalı (`capability-usage.js` ve manifest onu okur). Test: `test/cli-restore-workflow.test.js`. |
| #2265 | `lib/agent-behavioral-integrity.js` | 290 | KEEP | 16 fonksiyon, en uzunu 49 satır. Test: `test/agent-behavioral-integrity.test.js`. |
| #2266 | `lib/external-client-authority.js` | 149 | REFACTORED | #2585: `external-client-authority-errors`, `-primitives`, `external-client-trusted-key-snapshot`. |
| #2267 | `lib/workbench/ingest-approval-action.js` | 288 | KEEP | `executeApprovedIngest` (102 satır) lease'li yürütme işlemi: önce kalıcı claim (ret ancak executing satırı kalıcıyken yazılabilir), snapshot doğrulama, oversight, heartbeat, sonuç sınıflandırma, receipt. Sıra doğruluk invariantı ve yorumla gerekçeli. Test: `test/v4-b2b-ingest-approval-authority-gap.test.js`, `test/ingest-approval-audit-evidence.test.js`. |
| #2269 | `lib/workbench/trust-receipt-inspector.js` | 288 | DEFER | `inspectTrustReceipt` (116 satır) okuma sonucunu dört duruma (ok, invalid_request, chain_invalid, not_found) göre yanıta çeviriyor; `chain_invalid` asla bulunmuş receipt sayılmıyor (#766). Tetikleyici: beşinci durum; o zaman durum → yanıt kurucusu tablosu. Test: `test/v4-wb1-trust-receipt-inspector.test.js`. |
| #2270 | `lib/audit-query.js` | 193 | REFACTORED | #2270: `audit-query-primitives`. |
| #2271 | `adapters/pdf-adapter.js` | 282 | KEEP | `parsePdf` (86 satır) tek ayrıştırma döngüsü; ortak provenance/learn akışı zaten `adapters/utils/learn-entries.js`'te (`13742190`). Test: `test/provenance-pinning-audit.test.js`, `test/connector-firewall-coverage.contract.test.js`. |
| #2275 | `lib/interop/vc-mapping.js` | 279 | KEEP | 9 fonksiyon, en uzunu 49 satır; tek eşleme (receipt ↔ VC). Test: `test/interop-mapping.test.js`. |
| #2276 | `lib/http/public-badge-route.js` | 278 | KEEP | 13 fonksiyon, en uzunu 33 satır; tek rota. Test: `test/public-badge-route.test.js`. |
| #2277 | `lib/trust-evidence-ledger.js` | 365 | KEEP | 12 fonksiyon, en uzunu `buildTrustEvidencePayload` 59 satır; tek defter. Test: `test/mcp-ingest-trust-evidence-ledger.test.js`. |

## Parti 5 — `lib/`, `plugins/`, `public/` (#2280–#2300)

İnceleme tabanı: `origin/main` @ `e32711d`. `scripts/comment-pr-guardian-block.js` (#2286) Parti 1'de karara bağlandı.

| Issue | Dosya | Satır | Karar | Kaynak sembolleri / korunan invariant / test / gerekçe |
|---|---|---:|---|---|
| #2280 | `lib/pr-guardian/review-service.js` | 251 | KEEP | Receipt kurucusu `review-receipt.js`'e ayrılmıştı (`addf3855`). `createReviewService` içinde `execute` (113 satır) onaylı yürütmenin fail-closed koruma sırası: kayıt → durum → önceki yürütme → operatör token → claim desteği → hedef değişmedi mi → preflight politika → istemci → action desteği, **claim en sonda** ("decided before the claim so an action this service cannot perform is refused without consuming the approval"). Sıra invariantın kendisi. Test: `test/pr-guardian-execute-once.test.js`, `test/pr-guardian.test.js`. |
| #2281 | `lib/mcp-agent-approval-execution.js` | 271 | KEEP | 6 fonksiyon, en uzunu 31 satır; enjekte edilebilir onaylı ajan yürütmesi (`f382673f`). Test: `test/h-07-agent-claim-lease-recovery.test.js`. |
| #2282 | `lib/registry/registry-record-shape.js` | 272 | KEEP | 9 kısa şekil/versiyon fonksiyonu (en uzunu 19 satır); tek kayıt şeması. Test: `test/registry-record-shape.test.js`. |
| #2284 | `lib/coder/apply-derivation.js` | 269 | KEEP | `applyDerivation` (101 satır) sıralı boru hattı: bildirilen dosyaları oku → `runTask` → patch özeti → `evaluateCodeChange` gate → dry-run → `writePatch`; gate yazmadan önce, dry-run gate'ten sonra. Adımlar zaten ayrı fonksiyonlar. Test: `test/coder-verify-derivation.test.js`, `test/pr-guardian-derivation.test.js`. |
| #2285 | `lib/observability/notification-adapter.js` | 270 | KEEP | 19 küçük fonksiyon (en uzunu 13 satır): kanal başına bildirim biçimleyicileri. Test: `test/observability-notification-adapter.test.js`. |
| #2287 | `lib/claim-decomposition.js` | 264 | KEEP | 12 fonksiyon, en uzunu `decomposeClaim` 55 satır; tek ayrıştırıcı. Test: `test/claim-decomposition.test.js`. |
| #2288 | `lib/memory-recall-gate.js` | 272 | KEEP | `evaluateMemoryRecall` (95 satır): girdi doğrulama + kayıt başına karar döngüsü (admitted/degraded/withheld + ledger olayları). Tek gate kararı. Test: `test/memory-recall-gate-query-wiring.test.js`, `test/memory-expiry.test.js`. |
| #2290 | `lib/receipt/cryptographic-profile-contract.js` | 262 | KEEP | 11 fonksiyon, en uzunu 39 satır; tek kriptografik profil sözleşmesi ve kanonik serileştirme. Test: `test/v5-cryptographic-profile-contract.test.js`. |
| #2291 | `plugins/evidence-validator.js` | 263 | KEEP | 9 fonksiyon, en uzunu 47 satır; tek eklenti. Test: `test/secret-and-sourceref-redaction.test.js`. |
| #2292 | `lib/observability/client.js` | 262 | KEEP | `createObservabilityTelemetryClient` fabrikası, kapanışları kısa (`startRun`, `recordStep`, `recordGateDecision`, `finishRun`; en uzunu 33 satır). Test: `test/observability-client.test.js`. |
| #2293 | `lib/self-healer/finding-classifier.js` | 260 | KEEP | 10 fonksiyon, en uzunu 51 satır. Test: `test/self-healer-finding-classifier.test.js`. |
| #2294 | `lib/mutation-admission.js` | 259 | KEEP | `createMutationAdmission` tek `admit` kapanışı (84 satır): beş kontrolün her biri yorumla gerekçeli; saat alıcıya ait, verilen saat yok sayılmaz reddedilir. Tek admission kararı. Test: `test/mutation-admission.test.js`. |
| #2295 | `lib/registry/registry-route.js` | 255 | KEEP | `createRegistryBoundary` kapanışları (`route` 66, `handleRegistration` 43 satır); tek rota sınırı. Test: `test/registry-route.test.js`. |
| #2296 | `public/js/i18n.js` | 255 | KEEP | Tarayıcı varlığı: 15 fonksiyon, en uzunu 32 satır; çeviri tablosu ve çözümleyici tek modül olarak sayfaya yüklenir. Test: `test/i18n-localization.test.js`. |
| #2297 | `lib/http/read-workflow-actions.js` | 253 | KEEP | 10 fonksiyon, en uzunu `runReadWorkflow` 67 satır; salt-okunur iş akışı eylemleri. Test: `test/workflow-search-field-scope.test.js`. |
| #2298 | `lib/approval-schema.js` | 250 | KEEP | 13 fonksiyon, en uzunu `validateApprovalRequest` 61 satır; tek şema. Test: `test/approval-schema.test.js`. |
| #2299 | `lib/storage/schema.js` | 256 | KEEP | Ağırlıkla SQL şema metni; `applyStorageSchema` 37 satır. Şema tek dosyada olmalı. Test: `test/storage-schema.test.js`, `test/recovery/recovery-invariants.test.js`. |
| #2300 | `lib/github-app-beta-handler.js` | 247 | KEEP | 9 fonksiyon, en uzunu 40 satır. Test: `test/v5-c7-github-app-beta-http.test.js`. |

## Parti 6 — `lib/`, `adapters/` (#2302–#2323)

İnceleme tabanı: `origin/main` @ `e32711d`. `scripts/knowledge-graph-demo.js` (#2301) Parti 1'de REFACTORED.

| Issue | Dosya | Satır | Karar | Kaynak sembolleri / korunan invariant / test / gerekçe |
|---|---|---:|---|---|
| #2302 | `lib/memory-mutation-gate/memory-mutation-normalizer.js` | 243 | KEEP | 15 normalizasyon yardımcısı, en uzunu `normalizeEntry` 41 satır; `deleted`'ın `tombstoned`'u miras almaması (#1257) ve `metadataOnly`'nin yalnız açık `true` ile sayılması (#378) burada. Test: `test/classifier-downgrade-fail-closed.test.js`, `test/memory-mutation-classifier-characterization.test.js`. |
| #2303 | `lib/data-egress-gate.js` | 242 | KEEP | 10 fonksiyon, en uzunu `findPiiInText` 30 satır; tek egress kararı. Test: `test/data-egress-gate.test.js`. |
| #2304 | `lib/external-action-adapter.js` | 259 | KEEP | 9 fonksiyon, en uzunu `normalizeHookInvocation` 69 satır; hook çağrısını tek zarf biçimine çevirir. Test: `test/external-action-guard.test.js`. |
| #2305 | `lib/identity-privilege-escalation.js` | 251 | KEEP | 7 fonksiyon, en uzunu 33 satır. Test: `test/identity-privilege-escalation.test.js`. |
| #2306 | `lib/mcp-human-oversight-adapter.js` | 323 | KEEP | 14 fonksiyon; en uzunu `buildMcpOversightInput` 77 satır ama tek dallı nesne kurucusu. Karar işleyicisi `52f2fd95` ile ayrılmıştı. Test: `test/oversight-case-helpers.test.js`. |
| #2307 | `lib/mcp-ingest-execute-tool.js` | 241 | KEEP | 6 fonksiyon, en uzunu `decideMcpIngestApproval` 50 satır. Test: `test/mcp-tool-dispatch.test.js`, `test/mcp-ingest-audit-duplicate.test.js`. |
| #2308 | `lib/a2a/delegation-audit-log.js` | 239 | KEEP | `createA2aDelegationAuditLog` fabrikası iki kapanış (`append`, `read`); symlink/kısa ad reddi dahil tek dosya-kök defteri. Test: `test/a2a-symlinked-ancestor-refusal.test.js`. |
| #2309 | `lib/reasoning-trace.js` | 239 | KEEP | `buildReasoningTrace` (91 satır) tek dallı iz nesnesi kurucusu. Test: `test/reasoning-trace.test.js`. |
| #2310 | `lib/coder/derivation-record.js` | 237 | KEEP | 11 fonksiyon, en uzunu 20 satır; tek kayıt şeması ve hash. Test: `test/coder-derivation.test.js`. |
| #2311 | `lib/entity-resolution.js` | 237 | KEEP | 9 fonksiyon, en uzunu `resolveEntity` 69 satır. Test: `test/verify-entity-resolution.test.js`. |
| #2312 | `lib/connectors/entry-ingest-flow.js` | 236 | REFACTORED | `85a39561`: altı giriş connector'ı tek akışta birleştirildi; dosya o ortak yürüyüşün kendisi. Test: `test/ingest-root-ownership.test.js`. |
| #2313 | `lib/risk-policy-constants.js` | 250 | KEEP | Ağırlıkla sabit tablolar (`freezeSet` tek fonksiyon); `633e5179` ile sınıflandırıcıdan ayrılmıştı. Tek kaynak olmalı. Test: `test/risk-classify-boundaries-mutation.test.js`. |
| #2314 | `lib/post-action-monitor.js` | 270 | KEEP | `evaluatePostActionBehavior` (100 satır): aktivasyon yoksa erken gözlem, varsa baseline → değerlendirme → bulgu → receipt özeti; tek gözlem kararı. Test: `test/post-action-monitor.test.js`. |
| #2315 | `lib/external-action-envelope.js` | 229 | KEEP | `normalizeExternalActionEnvelope` (74 satır) tek zarf sözleşmesi. Test: `test/blast-radius.test.js`. |
| #2316 | `adapters/yaml-adapter.js` | 227 | KEEP | `parseYaml` (64 satır) tek ayrıştırıcı; ortak learn akışı `adapters/utils/learn-entries.js`'te. Test: `test/ingest-content-hash-pinning.test.js`. |
| #2317 | `lib/memory-query-engine.js` | 264 | KEEP | `runQuery` (89 satır) sekiz koşullu filtre adımı; history/SQLite yolları `101d04af` ile ayrılmıştı. Test: `test/memory-query-delegation-contract.test.js`. |
| #2318 | `lib/self-healer/safety-decision.js` | 224 | KEEP | `decideSelfHealerAction` (74 satır) tek güvenlik kararı. Test: `test/self-healer-safety-decision.test.js`. |
| #2319 | `lib/cli-hypotheses.js` | 223 | KEEP | 13 fonksiyon, en uzunu 29 satır. Test: `test/graph-hypotheses-cli.test.js`. |
| #2320 | `lib/cli-audit.js` | 222 | KEEP | `buildAuditReport` (87 satır) tek dallı rapor kurucusu. Test: `test/cli-audit.test.js`. |
| #2321 | `lib/memory-mutation-gate/memory-mutation-decision.js` | 221 | DEFER | `evaluateMemoryMutation` (135 satır) sınıflandırma özetinin üstüne sıralı yükseltmeler uygular (malformed, boş, bilinmeyen işlem, kirli repo, main'e yazım, sır, çoklu workspace, genişlik, kategori tabanı, politika tabanı) ve `decision`/`reason`'ı üzerine yazar; sıra politikanın kendisi. Tetikleyici: bir sonraki yükseltme kuralı; o zaman `[condition, escalation]` listesine çevir, önce karakterizasyon. Test: `test/inline-enforcement-matrix.test.js`, `test/mcp-gate-risk-block-wiring.test.js`. |
| #2322 | `lib/coder/verify-derivation.js` | 217 | KEEP | `verifyDerivation` (106 satır) sıralı doğrulama: bütünlük → şema sürümü (v1 "doğrulanamaz", hata değil) → runner durumu → taban ağacı uyumu → yeniden çalıştırma → hash → diff; her erken çıkış yorumla gerekçeli. Test: `test/coder-verify-derivation.test.js`. |
| #2323 | `lib/pilot/trust-receipt-pilot.js` | 217 | KEEP | 16 fonksiyon, en uzunu 34 satır. Test: `test/trust-receipt-pilot.test.js`. |

Açık kalan: #2324'ten başlayan adaylar (son parti).
