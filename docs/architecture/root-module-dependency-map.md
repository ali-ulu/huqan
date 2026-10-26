# Kök modül bağımlılık haritası (35 modül) — taşıma öncesi envanter

**Amaç:** `ali-ulu/huqan` deposunun kök dizinindeki 35 çalışma zamanı modülünün
sahiplik, ring, ithal ve paketleme gerçeğini tek yerde kayda geçirmek. Bu belge
**hiçbir kod taşımaz**; bir taşıma kararı için gereken kanıtı toplar.

**Ölçüm tabanı:** `origin/main` @ `0bcb2523f14cc3edf3b388ac4d173f379e9226f1`
(`chore(ci): bump the github-actions group with 3 updates (#4329)`).
Tüm sayılar bu commit'te, kaynak okunarak ve scriptler çalıştırılarak üretildi.
Hiçbir satır yalnızca tarayıcı sinyalinden türetilmedi.

**Yeniden üretilebilirlik:** Bu belgedeki her sayı, §0'daki yöntemle, herhangi bir
temiz `origin/main` worktree'sinde bağımsız olarak yeniden üretilebilir. Türetilemeyen
sayı belgede tutulmaz; bkz. §13 (kalan belirsizlikler).

**Durum:** assessment. Bu belge bir plan değil, bir envanterdir. Sonraki adım
(pilot taşıma) ayrı bir PR'dır ve bu haritanın gözden geçirilmesine bağlıdır.

## 0. Yöntem

Sayılar şu kaynaklardan üretildi; hepsi depoda mevcut:

- Sahiplik: `scripts/context-ownership.json` (map #2446 kararı).
- Ring: `scripts/architecture-dependency-graph.js` içindeki `ruleFor(file)`;
  kök dosya ile aynı dosyanın `lib/<ad>` biçimi ayrı ayrı sorgulandı.
- İthal sayıları: kök modülleri `require` eden dosyaların statik require grafiği
  üzerinden sayımı (lib / kök / test kırılımı).
- Satır ve fanOut: `scripts/architecture-snapshot.js` `snapshot()` çıktısı.
- Paketleme: `package.json` `files` listesi (1.451 girdi, 0bcb2523).
- Literal yol pini: yolu kod içinde sabit yazan scriptler, workflow'lar ve config.
- Shard ağırlığı: `config/shard-weights.json` `weights`.

Taşıma kararı yalnızca ad benzerliğine göre verilmedi; her modül için gerçek
ithal kenarları ve pin noktaları listelendi.

### 0.1 Sayım tanımları (yeniden üretilebilirlik için kesin)

Aşağıdaki tanımlar, sayıların nasıl elde edildiğini belirsizlik bırakmadan
tanımlar. Her tanım tek bir scriptle uygulanabilir; farklı bir tanım farklı bir
sayı üretir, bu yüzden belgedeki sayı yalnızca bu tanımla geçerlidir.

| Sayı | Tanım |
|---|---|
| Kök `.js` | `origin/main` çalışma ağacında kök dizindeki (`/` içermeyen) tüm `*.js` dosyaları. |
| Kök test | Yukarıdakilerden `*.test.js` ile bitenler (46). |
| Kök çalışma zamanı modülü | Kök `.js` eksi kök test = **35**. Bu belgenin konusu. |
| `lib/` izlenen dosya | `git ls-files lib \| wc -l`. |
| `lib/` `.js` | `git ls-files lib \| grep -c '\.js$'`. |
| Test/spec dosyası | `node_modules` ve `.git` hariç, `*.test.js` **veya** `*.spec.js` ile biten tüm dosyalar. |
| Test bağlaşması | Bir test dosyası, bir kök modülü **statik `require('<göreli yol>')`** ile ithal ediyorsa o modüle bağlı sayılır. `require.resolve` ve dinamik `import()` **dahil edilmez**; `child_process` ile çalıştırma **dahil edilmez**. |
| İthal kenarı | `require('<göreli yol>')` içindeki göreli specifier, dosyanın dizinine göre çözülür; uzantı yoksa `.js` eklenir; sonuç 35 kök modülden biriyse kenar sayılır. |
| Pin (kod-içi) | Bir script/workflow/config, bir kök modülün adını **çalıştırılabilir kodda** taşıyorsa pin sayılır. Yorum satırları, blok yorumlar ve YAML `#` yorumları hariç tutulur. |
| Pin — JS sitesi | `scripts/**/*.js` (`*.test.js` hariç) + `lib/module-reachability*.js`. Kural: tırnaklı literal bir yol içeriyorsa `basename` tam modül adı olmalı; yoksa literal `.js` ile bitip tam modül adına eşit olmalı. Çıplak uzantısız isim (ör. metadata değeri `"cli"`) **pin değildir**. Şablon literal içindeki **interpolasyonlu** yol (ör. `` `${target}/index.js` ``) pin **değildir**; değişken bir dizin adına bağlıdır, sabit bir kök modül adı taşımaz. |
| Pin — JSON sitesi | `config/*.json` + kök `*.json`. Kural: `"<modül>.js"` tam anahtar eşleşmesi. |
| Pin — workflow sitesi | `.github/workflows/*.{yml,yaml}`. Kural: `#` yorumları hariç, `<modül>.js` sözcük sınırında geçmeli. |
| Shard ağırlığı taşıyan kök test | `config/shard-weights.json` `weights` anahtarlarından kök dizinde (`/` içermeyen) olanlar. |

**Not (yeniden üretim):** Belgenin önceki sürümünde `ddf39a44` tabanında verilen
bazı sayılar (§5 test bağlaşması 520/740/328, §2 pin sütunu) bu tanımlarla
yeniden üretilemedi; §13'e bakınız. Güncel taban `0bcb2523`'tür ve tüm sayılar
oradan üretilmiştir.

## 1. Ölçülen başlangıç durumu (Aşama 1)

Karşılaştırma tabanı, `origin/main` @ `0bcb2523` üzerinde ölçüldü:

| Kapı | Sonuç |
|---|---|
| `npm run check:cycles` | PASS |
| `npm run check:layers` | PASS |
| `npm run check:module-boundary` | PASS |
| `npm run check:package-closure` | PASS |
| `npm run check:file-size` | PASS |
| `npm run check:docs-drift` | PASS |
| `npm run check:deprecations` | PASS |
| reachability (`analyzeReachability`) | reachable 1335, unreachable 244, unacknowledged 0, stale ack 0 |
| `architecture-snapshot --check` | tracker artifact canlı snapshot ile eşleşiyor |

Depo ölçeği (0bcb2523): kök 81 `.js` (46'sı `*.test.js`, 35'i çalışma zamanı
modülü), `lib/` altında 1.312 izlenen dosya (1.295 `.js`), 1.497 `*.test.js` /
`*.spec.js`, iki alt paket (`packages/huqan-verify`, `packages/axiom-verify`),
bir Rust crate (`huqan-core/`), `package.json` `files` listesinde 1.451 girdi.

**Önemli:** `package.json` içinde `workspaces` alanı **tanımlı değil**. Bu depo
bugün bir npm monorepo değil; kök paket + iki bağımsız alt paket yapısıdır.

**Taban farkı (ddf39a44 → 0bcb2523):** Kök 35 modülün hiçbiri değişmedi (satır
sayıları birebir aynı). Değişenler: `lib/` altında 20 dosya, `test/` altında 26
dosya ve dört veri dosyası — `config/reachability-baseline.json` (240→244
unreachable, 1321→1335 reachable), `scripts/context-ownership.json`
(+`lib/http/global-search-route.js`), `config/shard-weights.json` (yeni test
ağırlıkları) ve `package.json` (`files` 1.446→1.451). Bu yüzden bu belge
`0bcb2523` tabanına taşındı.

## 2. Master tablo — 35 kök modül

Sütunlar: satır / fanOut (`architecture-snapshot`), Ship (`files` listesinde mi),
Retained (retained deep-import yüzeyi), sahip (`context-ownership.json`), kök
ringi, aynı modülün `lib/` altındaki ringi (`⇄` = ring değişir), o modülü ithal
eden lib / kök / test dosya sayısı, ve yolu literal pinleyen script sayısı.

| # | Modül | Satır | FanOut | Ship | Retained | context-ownership.json | Ring | Ring→`lib/` | lib | kök | test | pin |
|---:|---|---:|---:|:--:|:--:|---|---|---:|---:|---:|---:|
| 1 | `agent.js` | 203 | 14 | ✔ | — | AgentAction (assigned) | Application | Core ⇄ | 0 | 2 | 13 | 4 |
| 2 | `agent.v3.js` | 393 | 19 | ✔ | — | AgentAction (assigned) | Application | Core ⇄ | 2 | 1 | 19 | 4 |
| 3 | `agentRuntime.js` | 204 | 10 | ✔ | — | Platform (entry) | Application | Core ⇄ | 1 | 3 | 20 | 6 |
| 4 | `backupRestore.js` | 55 | 3 | ✔ | — | Memory (assigned) | Adapters | Core ⇄ | 2 | 0 | 9 | 5 |
| 5 | `causalSimulator.js` | 176 | 4 | ✔ | — | Knowledge (assigned) | Core | Core | 2 | 1 | 7 | 5 |
| 6 | `cli.js` | 228 | 22 | ✔ | ✔ | Platform (entry) | UI | Core ⇄ | 0 | 0 | 37 | 12 |
| 7 | `demo-causal-autolearn.js` | ? | 3 | ✘ | — | never-examined | UNASSIGNED | Core ⇄ | 0 | 0 | 1 | 2 |
| 8 | `dream.js` | 276 | 6 | ✔ | — | Knowledge (assigned) | Application | Core ⇄ | 2 | 4 | 11 | 5 |
| 9 | `egitim.js` | 10 | 0 | ✘ | — | Platform (entry) | Core | Core | 0 | 0 | 0 | 2 |
| 10 | `evidence-ranker.js` | 47 | 0 | ✔ | — | Knowledge (assigned) | Core | Core | 2 | 0 | 1 | 3 |
| 11 | `finalizer.js` | 18 | 3 | ✔ | — | Observability (assigned) | Application | Core ⇄ | 3 | 2 | 2 | 4 |
| 12 | `github-app-server.js` | 144 | 4 | ✘ | — | Platform (entry) | UI | Core ⇄ | 0 | 0 | 6 | 3 |
| 13 | `graph.js` | 275 | 15 | ✔ | — | Knowledge (assigned) | Core | Core | 6 | 3 | 128 | 6 |
| 14 | `index.js` | 210 | 29 | ✔ | ✔ | Platform (entry) | UI | Core ⇄ | 0 | 0 | 7 | 17 |
| 15 | `kernel.js` | 383 | 28 | ✔ | ✔ | Platform (entry) | Core | Core | 1 | 2 | 210 | 11 |
| 16 | `kernel.v2.js` | 194 | 9 | ✔ | ✔ | Platform (entry) | Core | Core | 3 | 1 | 52 | 8 |
| 17 | `llmAdapter.js` | 196 | 0 | ✔ | — | AgentAction (assigned) | Adapters | Core ⇄ | 4 | 1 | 4 | 4 |
| 18 | `mcpServer.js` | 177 | 19 | ✔ | ✔ | Platform (entry) | UI | Core ⇄ | 2 | 2 | 72 | 11 |
| 19 | `persistencePaths.js` | 103 | 4 | ✔ | — | Memory (assigned) | Adapters | Core ⇄ | 3 | 1 | 5 | 3 |
| 20 | `plugin.js` | 208 | 7 | ✔ | — | Platform (entry) | Application | Core ⇄ | 0 | 1 | 10 | 4 |
| 21 | `requestGuards-body.js` | 105 | 0 | ✔ | — | Platform (infra) | Core | Core | 0 | 1 | 0 | 3 |
| 22 | `requestGuards-command-policy.js` | 135 | 0 | ✔ | — | AgentAction (assigned) | Core | Core | 0 | 1 | 0 | 3 |
| 23 | `requestGuards-rate-limit.js` | 67 | 0 | ✔ | — | AgentAction (assigned) | Core | Core | 1 | 1 | 0 | 3 |
| 24 | `requestGuards.js` | 84 | 5 | ✔ | — | Platform (entry) | Core | Core | 19 | 1 | 14 | 3 |
| 25 | `rustGraph.js` | 400 | 3 | ✔ | — | Knowledge (assigned) | Adapters | Core ⇄ | 3 | 1 | 11 | 8 |
| 26 | `sandboxRunner-child.js` | 107 | 2 | ✔ | — | AgentAction (assigned) | Adapters | Core ⇄ | 0 | 1 | 0 | 3 |
| 27 | `sandboxRunner-context.js` | 88 | 1 | ✔ | — | AgentAction (assigned) | Adapters | Core ⇄ | 0 | 2 | 0 | 3 |
| 28 | `sandboxRunner-limits.js` | 69 | 0 | ✔ | — | AgentAction (assigned) | Adapters | Core ⇄ | 0 | 3 | 0 | 3 |
| 29 | `sandboxRunner.js` | 331 | 5 | ✔ | — | AgentAction (assigned) | Adapters | Core ⇄ | 1 | 0 | 4 | 6 |
| 30 | `server.js` | 226 | 18 | ✔ | ✔ | Platform (entry) | UI | Core ⇄ | 0 | 0 | 18 | 15 |
| 31 | `storage.js` | 119 | 9 | ✔ | — | AgentAction (assigned) | Adapters | Core ⇄ | 4 | 1 | 36 | 7 |
| 32 | `toolPolicy.js` | 167 | 1 | ✔ | — | AgentAction (assigned) | Core | Core | 2 | 1 | 4 | 3 |
| 33 | `workflow-agent.js` | 172 | 11 | ✔ | — | AgentAction (assigned) | Application | Core ⇄ | 0 | 2 | 8 | 4 |
| 34 | `workflow-runtime.js` | 100 | 2 | ✔ | — | Platform (entry) | Application | Core ⇄ | 0 | 1 | 1 | 4 |
| 35 | `workflow-tools.js` | 38 | 7 | ✔ | — | AgentAction (assigned) | Application | Core ⇄ | 0 | 1 | 5 | 3 |

`demo-causal-autolearn.js` satırında satır `?`: bu dosya izlenen kaynak
kapsamının **dışında** kalıyor, bu yüzden `architecture-snapshot` onu ölçmez
(bkz. bölüm 7, bulgu B). `FanOut` sütunu onun için kendi kaynak taramasından
gelir (3 çıkan kenar: `causalSimulator.js`, `finalizer.js`, `graph.js`).

**Sütun notu — `kök` sütunu:** bu sütun `demo-causal-autolearn.js`'i **dahil
eder** (o dosya kök dizinde bir çalışma zamanı modülüdür). Önceki sürümde bu
dosya `kök` sütunundan düşülmüş ama §4.1 kenar haritasında sayılmıştı; bu iç
tutarsızlık düzeltildi. `causalSimulator.js`, `finalizer.js` ve `graph.js`
satırlarındaki `kök` değerleri bu yüzden +1'dir.

**Sütun notu — `pin` sütunu:** pin sayısı üç site türünün toplamıdır
(JS script + JSON config + workflow). Önceki sürüm yalnız JS scriptlerini
sayıyordu ve `config/*.json` ile `.github/workflows/*.yml` içindeki gerçek
pinleri kaçırıyordu. Ayrıntı ve satır kanıtı: §6.

## 3. Ring değişimi — 24 / 35 modül

Bir kök modülü `lib/` altına taşımak, ring atama kuralını değiştirir. Sebep:
`scripts/architecture-dependency-graph.js` kök dosyaları **açık `files` listesi**
ile, `lib/` içindeki düz `.js` dosyalarını ise Core kuralının `/^lib\/[^/]+\.js$/`
deseni ile eşler. Yani `lib/` içindeki her düz `.js` dosyası Core olur.

Sonuç: 35 modülden **24'ü** ring değiştirir; **11'i** aynı ringde kalır.

Ringi korunan 11 modül: `causalSimulator.js`, `egitim.js`, `evidence-ranker.js`,
`graph.js`, `kernel.js`, `kernel.v2.js`, `requestGuards-body.js`,
`requestGuards-command-policy.js`, `requestGuards-rate-limit.js`,
`requestGuards.js`, `toolPolicy.js` (hepsi zaten Core).

| Modül | Ring (kök) | Ring (`lib/`) | Hareket |
|---|---|---|---|
| `agent.js` | Application | Core | Application → Core |
| `agent.v3.js` | Application | Core | Application → Core |
| `agentRuntime.js` | Application | Core | Application → Core |
| `backupRestore.js` | Adapters | Core | Adapters → Core |
| `cli.js` | UI | Core | UI → Core |
| `demo-causal-autolearn.js` | UNASSIGNED | Core | UNASSIGNED → Core |
| `dream.js` | Application | Core | Application → Core |
| `finalizer.js` | Application | Core | Application → Core |
| `github-app-server.js` | UI | Core | UI → Core |
| `index.js` | UI | Core | UI → Core |
| `llmAdapter.js` | Adapters | Core | Adapters → Core |
| `mcpServer.js` | UI | Core | UI → Core |
| `persistencePaths.js` | Adapters | Core | Adapters → Core |
| `plugin.js` | Application | Core | Application → Core |
| `rustGraph.js` | Adapters | Core | Adapters → Core |
| `sandboxRunner-child.js` | Adapters | Core | Adapters → Core |
| `sandboxRunner-context.js` | Adapters | Core | Adapters → Core |
| `sandboxRunner-limits.js` | Adapters | Core | Adapters → Core |
| `sandboxRunner.js` | Adapters | Core | Adapters → Core |
| `server.js` | UI | Core | UI → Core |
| `storage.js` | Adapters | Core | Adapters → Core |
| `workflow-agent.js` | Application | Core | Application → Core |
| `workflow-runtime.js` | Application | Core | Application → Core |
| `workflow-tools.js` | Application | Core | Application → Core |

Ring değişimi kozmetik değildir: UI/Application/Adapters → Core geçen bir modül,
katman kapısının bağımlılık yönü hesabında artık daha aşağıda sayılır. Bu,
`check:layers` ve `check:cycles` sonuçlarını taşıma sırasında değiştirebilir.

## 4. Kenar haritası

### 4.1 Kök → kök bağımlılıkları (18 kaynak, 41 kenar)

Kök modüller arası grafik bir **DAG**; döngü yok. Aşağıdaki tablo 18 kaynak
satırı taşır; bu satırlardaki toplam kenar sayısı **41**'dir (bir satır birden
çok hedef içerebilir).

| Kaynak | Hedef (kök) |
|---|---|
| `agent.js` | `dream.js`, `toolPolicy.js` |
| `agent.v3.js` | `agent.js`, `dream.js` |
| `agentRuntime.js` | `agent.js`, `agent.v3.js`, `storage.js`, `workflow-runtime.js` |
| `causalSimulator.js` | `graph.js` |
| `cli.js` | `agentRuntime.js`, `dream.js`, `llmAdapter.js`, `mcpServer.js`, `package.json`, `persistencePaths.js` |
| `demo-causal-autolearn.js` | `causalSimulator.js`, `finalizer.js`, `graph.js` |
| `index.js` | `kernel.js`, `kernel.v2.js` |
| `kernel.js` | `dream.js`, `graph.js`, `plugin.js`, `rustGraph.js` |
| `kernel.v2.js` | `kernel.js` |
| `mcpServer.js` | `agentRuntime.js` |
| `requestGuards.js` | `requestGuards-body.js`, `requestGuards-command-policy.js`, `requestGuards-rate-limit.js` |
| `sandboxRunner-child.js` | `sandboxRunner-context.js`, `sandboxRunner-limits.js` |
| `sandboxRunner-context.js` | `sandboxRunner-limits.js` |
| `sandboxRunner.js` | `sandboxRunner-child.js`, `sandboxRunner-context.js`, `sandboxRunner-limits.js` |
| `server.js` | `agentRuntime.js`, `mcpServer.js`, `package.json`, `requestGuards.js` |
| `workflow-agent.js` | `finalizer.js` |
| `workflow-runtime.js` | `workflow-agent.js`, `workflow-tools.js` |
| `workflow-tools.js` | `workflow-agent.js` |

Not: `cli.js` ve `server.js` `package.json`'ı okur (sürüm/alan erişimi); bu bir
modül ithali değil, dosya okumasıdır ve taşımada `require` yolu değildir.

### 4.2 `lib/` → kök bağımlılıkları (51 dosya)

`lib/` altından kök modüllere giden kenarlar (test dosyaları hariç). Bir kök
modülü taşındığında bu dosyaların `require` yolları da değişir. `requestGuards.js`
tek başına 19 dosya tarafından ithal edilir — taşıması en geniş blast radius'a sahip
kök modüldür.

| `lib/` modülü | İthal ettiği kök modül(ler) |
|---|---|
| `lib/a2a/exchange-route.js` | `requestGuards.js` |
| `lib/a2a/negotiate-route.js` | `requestGuards.js` |
| `lib/agent-report-renderer.js` | `finalizer.js` |
| `lib/agent-step-executor.js` | `finalizer.js`, `toolPolicy.js` |
| `lib/agent-v3-storage-factory.js` | `storage.js` |
| `lib/causal-edge-strength.js` | `graph.js` |
| `lib/causal/causal-edge.js` | `graph.js` |
| `lib/cli-backup-commands.js` | `backupRestore.js` |
| `lib/cli-doctor.js` | `persistencePaths.js`, `rustGraph.js` |
| `lib/cognitive-lab-m7-runtime.js` | `agent.v3.js`, `graph.js`, `kernel.v2.js`, `llmAdapter.js` |
| `lib/cognitive-lab-m7-value-runtime.js` | `agent.v3.js`, `kernel.v2.js`, `llmAdapter.js`, `storage.js` |
| `lib/company-brain-ingest.js` | `evidence-ranker.js` |
| `lib/dream-experiment-loop-verify.js` | `causalSimulator.js` |
| `lib/evidence-pack/collect.js` | `backupRestore.js` |
| `lib/external-action-receipt-writer-factory.js` | `graph.js` |
| `lib/external-client-http-adapter.js` | `requestGuards.js` |
| `lib/http-trust-query.js` | `requestGuards.js` |
| `lib/http/command-policy-route.js` | `requestGuards.js` |
| `lib/http/core-http-routes.js` | `llmAdapter.js`, `requestGuards.js` |
| `lib/http/global-search-route.js` | `requestGuards.js` |
| `lib/http/ingest-approval-runtime.js` | `storage.js` |
| `lib/http/ingest-http-routes.js` | `requestGuards.js` |
| `lib/http/memory-approval-routes.js` | `mcpServer.js` |
| `lib/http/operator-grant-routes.js` | `requestGuards.js` |
| `lib/http/pr-guardian-auth.js` | `requestGuards.js` |
| `lib/http/public-api-commands.js` | `requestGuards.js` |
| `lib/http/public-api-route.js` | `requestGuards.js` |
| `lib/http/public-receipt-route.js` | `requestGuards-rate-limit.js` |
| `lib/http/runtime-status.js` | `requestGuards.js` |
| `lib/http/server-read-route-runtime.js` | `requestGuards.js` |
| `lib/http/server-request-handler.js` | `requestGuards.js` |
| `lib/kernel-factory.js` | `kernel.js`, `kernel.v2.js` |
| `lib/mcp-agent-approval-execution.js` | `agentRuntime.js` |
| `lib/mcp-approval-store-factory.js` | `storage.js` |
| `lib/mcp/operator-authorization.js` | `requestGuards.js` |
| `lib/mcp/service-main.js` | `mcpServer.js` |
| `lib/memory-blast-radius.js` | `causalSimulator.js` |
| `lib/reason-sandbox.js` | `rustGraph.js` |
| `lib/receipt/receipt-exporter-paths.js` | `persistencePaths.js` |
| `lib/rust-graph-fallback-factory.js` | `graph.js` |
| `lib/self-evolve-adapter.js` | `dream.js` |
| `lib/self-healer/source-dependency-graph.js` | `dream.js`, `graph.js` |
| `lib/self-healer/source-dogfood-simulator.js` | `rustGraph.js`, `sandboxRunner.js` |
| `lib/server-response-helpers.js` | `requestGuards.js` |
| `lib/storage/backup-restore-paths.js` | `persistencePaths.js` |
| `lib/viewer/viewer-gateway-primitives.js` | `requestGuards.js` |
| `lib/viewer/viewer-gateway.js` | `requestGuards.js` |
| `lib/web-research-workflow.js` | `llmAdapter.js` |
| `lib/workflow-run-guidance.js` | `finalizer.js` |
| `lib/workflow-tool-kernel-queries.js` | `evidence-ranker.js` |
| `lib/workflow-tool-registry.js` | `toolPolicy.js` |

## 5. Test bağlaşması

Ölçüm: `0bcb2523`, §0.1'deki "test bağlaşması" tanımı (statik `require`, göreli
yol, test dosyası `*.test.js`/`*.spec.js`).

| Sayı | Değer |
|---|---:|
| Kök modülleri statik `require` eden **benzersiz test dosyası** | 505 |
| Bu test dosyalarındaki **toplam** kök-modül ithali (dedup yok) | 752 |
| **(modül, test dosyası) çifti** — §2 tablosunun `test` sütunu | 715 |
| Retained yüzeye (`cli.js`, `index.js`, `kernel.js`, `kernel.v2.js`, `mcpServer.js`, `server.js`) dokunan test dosyası | 317 |

Üç sayı, aynı dosya kümesi üzerinde üç farklı sayım tanımıdır:

1. **505** — kök modüllerden en az birini `require` eden test dosyası sayısı
   (dosya bir kez sayılır).
2. **752** — bu test dosyalarındaki `require` **çağrı** sayısı; bir dosya aynı
   modülü birden çok kez `require` ediyorsa her çağrı sayılır (dedup yok).
3. **715** — benzersiz `(modül, test dosyası)` çifti sayısı; §2 master
   tablosunun `test` sütunu bu tanımı kullanır. 752 ile 715 arasındaki 37 fark,
   aynı modülü birden çok kez `require` eden dosyalardan gelir.

**Not:** Belgenin önceki sürümünde bu bölüm 520 / 740 / 328 veriyordu. Bu
sayılar `ddf39a44` tabanında da, `0bcb2523` tabanında da §0.1'deki tanımla
yeniden üretilemedi (denenen tüm varyantlar: `require` / `require.resolve` /
`import()` / `child_process` / farklı test-dosyası tanımları). Bu yüzden
kaldırıldılar; bkz. §13.

Kök dizindeki 46 `*.test.js` dosyasından 7'si shard ağırlığı taşır:

| Modül | Onu ithal eden kök test dosyaları (shard ağırlığı sn) |
|---|---|
| `agent.js` | `agent.test.js` |
| `agent.v3.js` | `agent.v3.test.js` |
| `agentRuntime.js` | `agentRuntime.test.js`, `cli.test.js` (4.81), `server.test.js` (3.159) |
| `backupRestore.js` | `backupRestore.test.js`, `path-containment-386.test.js` |
| `causalSimulator.js` | `causalSimulator.test.js` |
| `cli.js` | `cli.test.js` (4.81), `path-containment-386.test.js`, `server.test.js` (3.159) |
| `demo-causal-autolearn.js` | `demo-causal-autolearn.test.js` |
| `dream.js` | `dream.test.js` (2.695), `graph.test.js`, `kernel.test.js` (2.296), `plugin.test.js` |
| `evidence-ranker.js` | `evidence-ranker.test.js` |
| `finalizer.js` | `finalizer.causal.test.js`, `finalizer.test.js` |
| `graph.js` | `causalSimulator.test.js`, `graph.causal.test.js`, `graph.test.js`, `learn-weight-drift.test.js`, `plugin.test.js`, `rustGraph.test.js`, `server.test.js` (3.159), `temporal.test.js` |
| `kernel.js` | `agent.test.js`, `agent.v3.test.js`, `capability.test.js`, `cli.test.js` (4.81), `company-brain.test.js`, `company-mode.test.js`, `contradiction-alert.test.js`, `dream.test.js` (2.695), `fractal-learn.test.js`, `kernel.test.js` (2.296), `kernel.v2.test.js`, `learn-weight-drift.test.js`, `llmAdapter.test.js` (2.102), `mcpServer.test.js` (1.178), `plugin-boundary-contract.test.js`, `plugin-contract.test.js`, `plugin-provenance.test.js`, `plugin.test.js`, `provenance.test.js`, `reasonSandbox.test.js`, `workflow-runtime.test.js` |
| `kernel.v2.js` | `agent.test.js`, `agent.v3.test.js`, `cli.test.js` (4.81), `kernel.v2.test.js`, `provenance.test.js` |
| `llmAdapter.js` | `llmAdapter.test.js` (2.102), `server.test.js` (3.159) |
| `mcpServer.js` | `mcpServer.human-approval-toggle.test.js`, `mcpServer.test.js` (1.178), `mcpServer.tool-naming.test.js` |
| `plugin.js` | `plugin-boundary-contract.test.js`, `plugin-provenance.test.js`, `plugin.test.js` |
| `requestGuards.js` | `requestGuards.test.js`, `server.test.js` (3.159) |
| `rustGraph.js` | `rustGraph.test.js` |
| `sandboxRunner.js` | `sandboxRunner.test.js` (1.437) |
| `server.js` | `server.test.js` (3.159) |
| `toolPolicy.js` | `toolPolicy.test.js` |
| `workflow-agent.js` | `workflow-agent.test.js`, `workflow-runtime.test.js`, `workflow-tools.test.js` |
| `workflow-runtime.js` | `workflow-runtime.test.js` |
| `workflow-tools.js` | `evidence-ranker.test.js`, `workflow-tools.test.js` |

Shard ağırlıkları `config/shard-weights.json` içinde **yol** anahtarlıdır. Bir
test dosyasını başka dizine taşımak, ağırlık anahtarını da taşımayı gerektirir;
aksi hâlde `scripts/run-test-shard.js` o dosyayı ağırlıksız (varsayılan) sayar ve
shard dengesi bozulur. Bu, testleri domain klasörlerine taşımadan önce
ölçülmesi gereken bir bağlaşmadır.

7 modülün **hiç** test ithalcisi yok: `egitim.js`,
`requestGuards-body.js`, `requestGuards-command-policy.js`,
`requestGuards-rate-limit.js`, `sandboxRunner-child.js`,
`sandboxRunner-context.js`, `sandboxRunner-limits.js`. Bunların hepsi başka bir
kök modül (guard'lar `requestGuards.js`, sandbox parçaları `sandboxRunner.js`)
üzerinden dolaylı test edilir.

## 6. Yolu literal pinleyen dosyalar

Taşımada `require` yollarının yanında, yolu **kod içinde sabit yazan** yerler de
güncellenmelidir. Bunlar `require` grafiğinde görünmez; statik require taraması
bunları kaçırır. Ölçüm §0.1'deki "Pin" tanımıyla yapıldı: yorumlar hariç,
çalıştırılabilir kodda kök modül adını taşıyan her site.

Üç site türü ayrı sayıldı:

- **js:** `scripts/**/*.js` (`*.test.js` hariç) + `lib/module-reachability*.js`.
- **json:** `config/*.json` + kök `*.json` (tam `"<modül>.js"` anahtarı).
- **workflow:** `.github/workflows/*.{yml,yaml}` (`#` yorumları hariç).

| Modül | js sitesi | json sitesi | workflow sitesi |
|---|---|---|---|
| `agent.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/file-size-policy.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `agent.v3.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/architecture-snapshot.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `agentRuntime.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/architecture-mermaid.js`<br>`scripts/architecture-snapshot-scope.js`<br>`scripts/check-layers.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `backupRestore.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/backup.js`<br>`scripts/restore.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `causalSimulator.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/ci-impact-rules.js` | `config/coverage-baseline.json`<br>`package.json` | `.github/workflows/benchmark.yml` |
| `cli.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/architecture-mermaid.js`<br>`scripts/architecture-snapshot-scope.js`<br>`scripts/check-layers.js`<br>`scripts/ci-impact-rules.js`<br>`scripts/dead-code-symbols.js`<br>`scripts/retained-deep-imports.js`<br>`lib/module-reachability.js` | `config/coverage-baseline.json`<br>`package-lock.json`<br>`package.json` | `.github/workflows/advanced-testing.yml` |
| `demo-causal-autolearn.js` | `lib/module-reachability.js` | `config/coverage-baseline.json` | — |
| `dream.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/ci-impact-rules.js`<br>`scripts/knowledge-graph-demo.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `egitim.js` | `scripts/architecture-dependency-graph.js`<br>`lib/module-reachability.js` | — | — |
| `evidence-ranker.js` | `scripts/architecture-dependency-graph.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `finalizer.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/ci-impact-rules.js` | `package.json` | `.github/workflows/benchmark.yml` |
| `github-app-server.js` | `scripts/architecture-dependency-graph.js`<br>`lib/module-reachability.js` | `config/coverage-baseline.json` | — |
| `graph.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/ci-impact-rules.js`<br>`scripts/file-size-policy.js` | `config/coverage-baseline.json`<br>`package.json` | `.github/workflows/benchmark.yml` |
| `index.js` | `scripts/api-snapshot-surface.js`<br>`scripts/architecture-dependency-graph.js`<br>`scripts/architecture-layer-exceptions.js`<br>`scripts/architecture-mermaid.js`<br>`scripts/architecture-snapshot-scope.js`<br>`scripts/check-deterministic-path.js`<br>`scripts/check-import-cycles.js`<br>`scripts/check-layers.js`<br>`scripts/dead-code-symbols.js`<br>`scripts/require-scan.js`<br>`scripts/retained-deep-imports.js`<br>`lib/module-reachability-walk.js`<br>`lib/module-reachability.js` | `config/coverage-baseline.json`<br>`deprecations.json`<br>`package.json` | `.github/workflows/conformance.yml` |
| `kernel.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/architecture-snapshot-scope.js`<br>`scripts/ci-impact-rules.js`<br>`scripts/file-size-policy.js`<br>`scripts/knowledge-graph-demo.js`<br>`scripts/retained-deep-imports.js`<br>`lib/module-reachability.js` | `config/coverage-baseline.json`<br>`package.json` | `.github/workflows/benchmark.yml`<br>`.github/workflows/rust-accelerator.yml` |
| `kernel.v2.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/architecture-snapshot.js`<br>`scripts/ci-impact-rules.js`<br>`scripts/file-size-policy.js`<br>`scripts/retained-deep-imports.js` | `config/coverage-baseline.json`<br>`package.json` | `.github/workflows/benchmark.yml` |
| `llmAdapter.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/check-deterministic-path.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `mcpServer.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/architecture-mermaid.js`<br>`scripts/architecture-snapshot-scope.js`<br>`scripts/check-layers.js`<br>`scripts/ci-impact-rules.js`<br>`scripts/dead-code-symbols.js`<br>`scripts/launch-installed-package-smoke-context.js`<br>`scripts/retained-deep-imports.js`<br>`lib/module-reachability.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `persistencePaths.js` | `scripts/architecture-dependency-graph.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `plugin.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/ci-impact-rules.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `requestGuards-body.js` | `scripts/architecture-dependency-graph.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `requestGuards-command-policy.js` | `scripts/architecture-dependency-graph.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `requestGuards-rate-limit.js` | `scripts/architecture-dependency-graph.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `requestGuards.js` | `scripts/architecture-dependency-graph.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `rustGraph.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/ci-impact-rules.js`<br>`scripts/enforcement-coverage-classification.js` | `config/coverage-baseline.json`<br>`coverage-manifest.json`<br>`package.json` | `.github/workflows/benchmark.yml`<br>`.github/workflows/rust-accelerator.yml` |
| `sandboxRunner-child.js` | `scripts/architecture-dependency-graph.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `sandboxRunner-context.js` | `scripts/architecture-dependency-graph.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `sandboxRunner-limits.js` | `scripts/architecture-dependency-graph.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `sandboxRunner.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/architecture-snapshot-scope.js`<br>`scripts/enforcement-coverage-classification.js` | `config/coverage-baseline.json`<br>`coverage-manifest.json`<br>`package.json` | — |
| `server.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/architecture-mermaid.js`<br>`scripts/architecture-snapshot-scope.js`<br>`scripts/check-dead-code.js`<br>`scripts/check-layers.js`<br>`scripts/ci-impact-rules.js`<br>`scripts/container-server.js`<br>`scripts/dead-code-symbols.js`<br>`scripts/huqan-watchdog.js`<br>`scripts/launch-installed-package-smoke-context.js`<br>`scripts/retained-deep-imports.js`<br>`lib/module-reachability.js` | `config/coverage-baseline.json`<br>`package.json` | `.github/workflows/conformance.yml` |
| `storage.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/check-layers.js`<br>`scripts/ci-impact-rules.js`<br>`scripts/measure-journal-durability.js` | `config/coverage-baseline.json`<br>`package.json` | `.github/workflows/benchmark.yml` |
| `toolPolicy.js` | `scripts/architecture-dependency-graph.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `workflow-agent.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/check-deterministic-path.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `workflow-runtime.js` | `scripts/architecture-dependency-graph.js`<br>`scripts/architecture-snapshot-scope.js` | `config/coverage-baseline.json`<br>`package.json` | — |
| `workflow-tools.js` | `scripts/architecture-dependency-graph.js` | `config/coverage-baseline.json`<br>`package.json` | — |

**Yük taşıyan (discriminating) pinler:** `config/coverage-baseline.json` ve
`package.json` neredeyse her modülü listeler; bunlar dosya-listesi taşıyıcısıdır ve
taşımada **her zaman** güncellenir (bkz. §7-E ve §7-F). Asıl ayırt edici pinler
şunlardır:

- `scripts/architecture-dependency-graph.js` — ring ataması `files` listesi; **35/35** modülü pinler.
- `scripts/ci-impact-rules.js` — değişen dosyaya göre test seçimi; 12 modülü pinler.
- `lib/module-reachability.js` — erişilebilirlik grafiği; `cli.js`, `index.js`,
  `kernel.js`, `mcpServer.js`, `server.js`, `egitim.js`, `github-app-server.js`,
  `demo-causal-autolearn.js`.
- `scripts/architecture-snapshot-scope.js`, `scripts/check-layers.js`,
  `scripts/retained-deep-imports.js` — giriş noktası/katman listeleri.
- `scripts/architecture-mermaid.js`, `scripts/dead-code-symbols.js`,
  `scripts/check-deterministic-path.js`, `scripts/file-size-policy.js`,
  `scripts/enforcement-coverage-classification.js` — yardımcı listeler.
- `.github/workflows/benchmark.yml`, `rust-accelerator.yml`, `conformance.yml`,
  `advanced-testing.yml` — yol filtresi ve doğrudan `node <modül>` çağrıları.

**Kanıt:** her pin, `(dosya, satır, literal)` üçlüsü olarak çıkarıldı; 35 modül
için tekilleştirilmiş `(modül, dosya)` çifti **190**'dır. Bu, yük taşıyan ve
tanıma göre kararlı olan sayıdır.

Tekilleştirme **öncesi** ham eşleşme sayısı, sayım kuralına duyarlıdır: §0.1'deki
kural (şablon-literal interpolasyonu hariç, literal başına bir sayım) **209**
verir; JSON anahtarının her tekrarını saymak 212, basename gevşek eşleştirmesi
225 verir. Bu yüzden belgede ham sayı değil, kararlı olan **190** çift esas
alınır. (Not: bu belgenin bir önceki doğrulama notunda geçen **224** ham eşleşme
sayısı, §0.1'deki tanımla ve denenen hiçbir varyantla yeniden üretilemedi; o
yüzden belgeye hiç yazılmadı. Doğrulanabilen ham değer **209**'dur.)
Örnek satırlar:

```
scripts/backup.js:3            require('../backupRestore')            -> backupRestore.js
scripts/restore.js:3           require('../backupRestore')            -> backupRestore.js
scripts/container-server.js:47 require('../server')                   -> server.js
scripts/knowledge-graph-demo.js:27 require('../kernel')               -> kernel.js
scripts/measure-journal-durability.js -> storage.js
scripts/architecture-snapshot.js      -> agent.v3.js, kernel.v2.js
.github/workflows/rust-accelerator.yml:55 -> rustGraph.js, kernel.js
```

**Önceki sürümden fark:** eski §6 yalnız JS scriptlerini sayıyordu ve
`storage.js`→`scripts/measure-journal-durability.js`, `agent.v3.js`→
`scripts/architecture-snapshot.js` (DIP istisna listesi), `index.js`→
`scripts/check-import-cycles.js`, `llmAdapter.js`→`scripts/check-deterministic-path.js`
gibi gerçek pinleri kaçırıyordu; ayrıca `config/*.json` ve `.github/workflows/*.yml`
hiç taranmıyordu. Bu sürüm üç siteyi de kapsar.

**Pin sınıfı tuzağı — yorumda geçen ad pin değildir.** Örnek: `scripts/check-module-boundary.js`
JSDoc başlığında `agent.v3.js` ve `kernel.v2.js` adlarını anar ama bunlar yalnız
açıklama metnidir; modülü taşımak bu dosyada **hiçbir değişiklik gerektirmez**.
`architecture-snapshot.js`'teki aynı adlar ise gerçek koddur (`{ file: 'agent.v3.js', … }`
DIP istisna kaydı) ve taşımada güncellenmelidir. Aynı ad, iki farklı dosyada iki
farklı sınıftır; bu yüzden pin taraması yorum ayıklaması yapmak zorundadır.

## 7. Kapı tuzakları (taşıma öncesi bilinmesi gerekenler)

Bu bölüm, haritayı çıkarırken **ampirik olarak doğrulanan** ve bir taşıma
planını doğrudan etkileyen bulgulardır. Her biri geçici bir worktree'de
denenerek teyit edildi.

### A. `lib/` taşıması `check:module-boundary`'yi düşürür

`toolPolicy.js` dosyası `lib/` altına taşınınca kapı şunu verir:

    FAIL unmapped: lib/toolPolicy.js has no owning context;
    assign it in context-ownership.json with source+caller evidence first

Sebep: `scripts/context-ownership.json` kök dosyayı `owners` altında tutar;
`lib/` altındaki anahtar yoktur ve `never-examined` döner. Yani **her** `lib/`
taşıması, aynı PR'da `context-ownership.json`'a kanıtlı bir satır eklemek
zorundadır. Bu, "küçük taşıma" tanımını genişletir: taşıma + sahiplik kaydı +
`evidence` alanı.

**Uygulama inceliği (yeniden üretim için gerekli):** taşıma `git mv` ile
yapılmalıdır. Düz `mv` ile dosya izlenen ağaçta eski yolda kalır;
`check-module-boundary.js` dosya listesini git'ten aldığı için eski yolu okumaya
çalışır ve yukarıdaki kapı mesajı yerine `ENOENT: no such file or directory`
hatası verir. İki komutun farkı denendi: `git mv` → belgedeki `FAIL unmapped`
mesajı; düz `mv` → `ENOENT`.

### B. `demo` yol parçası bir dosyayı sessizce görünmez yapar

Dört script aynı düzenli ifadeyi paylaşır; `demo` bir yol parçası olarak geçen
her dosya test sayılır ve kaynak ölçümünden çıkar. Bunu paylaşanlar:
`scripts/check-module-boundary.js`, `scripts/check-import-cycles.js`,
`scripts/check-file-size.js`, `scripts/architecture-snapshot.js`.

Bugün etkilenen gerçek dosyalar: `demo-causal-autolearn.js` (212 satır) ve
`lib/demo-authority.js` (141 satır) — ikisi de ne file-size ne architecture
snapshot kapsamında. Ölçüldü: ikisi de kaynak kapsamında `false` döner.

**Taşıma sonucu:** bir dosyayı `demo` parçası taşıyan bir yola taşımak, onu
file-size ratchet'inden ve architecture tracker'dan **sessizce** çıkarır.
Denendi (`0bcb2523`): `egitim.js` `demo/` altına taşınınca `snapshot()` satır
sayısı **1549 → 1548** düştü, `architecture-snapshot --check` yine de
"eşleşiyor" dedi. Bu bir kalite kaybıdır, kazanç değil.

### C. `demo` yoluna taşıma reachability'yi ayrıca uyarır

Aynı denemede `unacknowledged` 0'dan 1'e çıktı. `lib/module-reachability.js`
`STANDALONE_FILES` listesi `egitim.js`'i kök yoluyla tutar; taşıma sonrası eski
anahtar bayatlar, yeni yol onaylanmamış olur. Yani bu yol parçasına taşıma hem
ölçümden düşürür hem reachability kaydını kırar.

### D. `docs/architecture/` bir RECORD yolu değil

`scripts/check-docs-drift.js` içindeki `RECORD_PATHS` şunları muaf tutar
(`0bcb2523`'te okunan tam liste, kaynak regex'ler birebir): `^docs/archive/`,
`^docs/audits/`, `^docs/reviews/`, `^docs/task-packs/`, `^docs/v5/`,
`/evidence/i`, `/-raporu\.md$/i`, `/-(?:plan|closeout|seal|inventory|roadmap|review)\.md$/i`,
`^docs/v0\.\d` ve `^CHANGELOG\.md$`.

`docs/architecture/` bu listede **yok**. Doğrulandı:
`RECORD_PATHS.some(r => r.test('docs/architecture/root-module-dependency-map.md'))`
= `false`. Yani bu dizine eklenen her belge canlı
belge sayılır ve içindeki her kod-yazılı yol (`\`lib/x.js\`` biçiminde) diskte
var olmalıdır; olmayan bir yol `missing-path` hatası verir. Doğrulandı: bu dizine
konan bir sonda belgesi, diskte olmayan yollar için drift hatası üretti.

**Kural:** bu haritadaki her yol gerçek olmalı. Henüz var olmayan (taşınmış)
yollar backtick içinde yazılmamalı; fenced blokta düz metin olarak verilmeli.

### E. `config/coverage-baseline.json` sessiz bayatlığa açık

Baseline 33 kök anahtar taşır; `egitim.js` ve `finalizer.js` yoktur (0bcb2523'te
de doğrulandı). Sebep:
`scripts/check-coverage.js` `minFileLines: 20` altındaki dosyaları atlar
(`egitim.js` 10, `finalizer.js` 18 satır). Baseline'da **bayatlık kontrolü
yoktur**; taşınan bir dosyanın eski anahtarı sessizce kalır. Aynı durum
`STANDALONE_FILES` için de geçerli.

### F. `package.json` `files` listesi dosya-düzeyinde

`files` 1.451 girdidir ve `lib/` girdileri tek tek dosya adıdır (dizin değil).
Yani bir modülü taşımak `files` içindeki satırı da değiştirir. `prepublishOnly`
zaten `check:package-closure` çalıştırır, bu yüzden paket kapanışı taşımanın
gerçekten doğrulanabildiği yerdir.

### G. `config/reachability-baseline.json` içindeki `reachableTotal` ölü alan

`0bcb2523`'te baseline beş alan taşır: `note`, `measuredAt`, `unreachableTotal`,
`reachableTotal`, `measuredNotYetWired`. Bunlardan yalnız `unreachableTotal`
(`test/reachability-baseline.test.js`) ve `measuredNotYetWired` (aynı test)
doğrulanır. `reachableTotal` **hiçbir kod tarafından okunmaz** — `grep -rn
reachableTotal` yalnız baseline dosyasının kendisini bulur.

Sonuç: baseline'ı "canlı reachable sayısı" sanmak yanıltıcıdır. `ddf39a44`'te
canlı `reachable` 1334 iken `reachableTotal` 1321'di ve ratchet testi yine de
geçiyordu (o tabanda 2/2 PASS olarak doğrulandı). Bir taşıma sonrası baseline
güncellemesi gerekirse **yalnız `unreachableTotal`** gerçekten bağlayıcıdır;
`reachableTotal`'ı güncellemek hiçbir kapıyı etkilemez (ama tutarlılık için
güncellenmelidir).

## 8. Taşıma simülasyonlarının sonuçları

Aşağıdakiler geçici worktree'de denendi; ana çalışma ağacı değiştirilmedi.

| Deneme | Sonuç |
|---|---|
| `demo-causal-autolearn.js` → `examples/` | Tüm kapılar PASS; reachability temiz. Ama dosya artık canlı snapshot'ta yok. |
| `demo-causal-autolearn.js` → `demo/` | `check:module-reachability` FAIL (onaylanmamış girdi); onay kaydıyla PASS. |
| `egitim.js` → `demo/` | Kapılar PASS, ama reachability onaylanmamış girdi veriyor ve snapshot satır sayısı 1 azalıyor. |
| `toolPolicy.js` → `lib/` | `check:module-boundary` FAIL (unmapped); diğer kapılar PASS. `lib/` içindeki göreli `require` çağrıları kırılır. |

**Önemli negatif bulgu (0bcb2523'te kesin doğrulandı):** hiçbir kapı, `lib/`
içindeki bir göreli `require` yolunun artık çözülmediğini yakalamıyor.
İzole deney: `lib/workflow-tool-registry.js` satır 5'teki
`require('../toolPolicy')` specifier'ı var olmayan bir yola çevrildi. Sonuç:

| Kontrol | Sonuç |
|---|---|
| `check:cycles` | PASS |
| `check:layers` | PASS |
| `check:module-boundary` | PASS |
| `check:package-closure` | PASS |
| `check:file-size` | PASS |
| `check:docs-drift` | PASS |
| `check:deprecations` | PASS |
| `node -e "require('lib/workflow-tool-registry.js')"` | **MODULE_NOT_FOUND** |

`scripts/check-package-closure.js` "unresolvable specifiers are left to Node"
diyerek çözülemeyen yolu atlıyor; yedi kapının hiçbiri statik require grafiğini
çözemeyen bir specifier için düşmüyor. Kırılmayı yalnızca testler ve modülü
fiilen `require` etmek gösteriyor. Yani bir taşıma sonrası **test suite ve
`npm pack --dry-run`** tek gerçek doğrulamadır.

(Not: `lib/workflow-tool-registry.js` ve `lib/agent-step-executor.js` bugün
`require('../toolPolicy')` yazıyor; bu yol `lib/`'in bir üst dizinine, yani kök
`toolPolicy.js`'e çözülür ve **şu an çalışır** — doğrulandı. Ama `toolPolicy.js`
`lib/` altına taşınırsa bu iki çağrı sessizce kırılır ve yedi kapıdan hiçbiri
düşmez. Bu, §11'deki `egitim.js` pilotunun değil, `lib/` taşımalarının neden
test suite olmadan yapılamayacağının somut kanıtıdır.)

## 9. Kapsam sınırı — bu belgenin önermediği şeyler

- **`README.md` kökte kalır.** `package.json` ve alt paketler kök README'ye
  bağlanır; `scripts/check-package-closure.js` onu `ALWAYS_PUBLISHED` sayar.
- **`kernel.js` ile `kernel.v2.js` birleştirilmez/yeniden adlandırılmaz.**
  `index.js` `KernelV2`'yi dışa aktarır, `KernelV1`'i geriye dönük uyumluluk için
  tutar; substitutability sözleşmesi `docs/adr/ADR-013-kernel-v2-substitutability.md`
  ve `docs/architecture-policy.md` ile sabittir. Dosya adındaki sürüm eki tek
  başına çoğaltma kanıtı değildir.
- **CI sharding / Docker / publish yeniden yazılmaz.** `scripts/run-test-shard.js`,
  `scripts/ci-shard-manifest.js`, çok aşamalı `Dockerfile` ve `v*` tetikleyicili
  publish iş akışı zaten mevcut.
- **`workspaces` dönüşümü ayrı bir iştir.** Paket sınırları, lockfile, yayınlama
  ve CI'yı birlikte ele alır; bu haritanın kapsamı dışındadır.
- **1.497 test dosyası tek PR'da taşınmaz.**
- **`src/` düzeni dayatılmaz.** Depo kökünde `src/` yok; kaynak kök modüller ile
  `lib/` arasında dağılmıştır.

## 10. Kategori özeti

| Grup | Modüller |
|---|---|
| Retained deep-import yüzeyi (6) | `cli.js`, `index.js`, `kernel.js`, `kernel.v2.js`, `mcpServer.js`, `server.js` |
| Ship edilmeyen (3) | `demo-causal-autolearn.js`, `egitim.js`, `github-app-server.js` |
| Hiç ithalcisi olmayan (1) | `egitim.js` (ölü uyumluluk shim'i; 10 satır, yönlendirme + exit 2) |
| Ring koruyan (11) | bölüm 3'teki liste |
| Ring değiştiren (24) | bölüm 3'teki liste |
| `lib/` tarafından ithal edilmeyen (16) | `agent.js`, `cli.js`, `demo-causal-autolearn.js`, `egitim.js`, `github-app-server.js`, `index.js`, `plugin.js`, `requestGuards-body.js`, `requestGuards-command-policy.js`, `sandboxRunner-child.js`, `sandboxRunner-context.js`, `sandboxRunner-limits.js`, `server.js`, `workflow-agent.js`, `workflow-runtime.js`, `workflow-tools.js` |
| Sahipsiz (1) | `demo-causal-autolearn.js` (`never-examined`) |

Sahiplik dağılımı: 21 modül `owners` (domain), 13 modül `platform`, 1 modül
`never-examined`. `outOfScope` (scripts/, examples/, public/) kök modüllerin
hiçbirini kapsamaz.

## 11. Sonraki adım (Aşama 2 — pilot, ayrı PR)

Harita, pilot için aday işaret ediyor; kararı gözden geçirme verir:

- **Aday: `egitim.js`.** Ölü uyumluluk shim'i, 0 ithalci, 0 test, `lib/`
  ithalcisi yok, ringi zaten Core. En küçük blast radius. Ancak dikkat: dosya
  bugün `STANDALONE_FILES` içinde ve `demo` parçası taşımadığı için ölçümde
  **görünür**; onu `demo` parçası taşıyan bir yola taşımak onu ölçümden düşürür
  (bulgu B). Doğru hedef, onu görünür tutan bir konumdur ve
  `scripts/context-ownership.json` + `STANDALONE_FILES` kayıtları aynı PR'da
  güncellenmelidir.
- **İkinci aday grubu: `sandboxRunner-*` (4 dosya).** Aralarında kapalı bir alt
  grafik (`sandboxRunner.js` → child/context/limits; child/context/limits yalnız
  bu grup içinden ithal edilir), toplam **1** `lib/` ithalcisi
  (`lib/self-healer/source-dogfood-simulator.js` → `sandboxRunner.js`; §2'de
  `sandboxRunner.js` lib sütunu 1'dir), kalan ithalciler kök ve test dosyaları.
  Ring değişir (Adapters → Core, dört dosyada da; §3), bu yüzden `check:layers`
  sonucu pilot PR'da yeniden ölçülmelidir.

Her pilot PR, aynı değişiklik dizisinde şunları taşımalıdır: dosya taşıması,
tüm `require` yol düzeltmeleri, `scripts/context-ownership.json` satırı, literal
pin scriptleri, `scripts/architecture-tracker-baseline.json` ve
`config/reachability-baseline.json` güncellemesi, `config/shard-weights.json`
(test taşındıysa) ve yeşil tam test suite + `npm pack --dry-run`.

## 12. Kaynakça (yol doğrulandı)

Scriptler: `scripts/architecture-dependency-graph.js`,
`scripts/architecture-snapshot.js`, `scripts/architecture-snapshot-scope.js`,
`scripts/check-layers.js`, `scripts/check-import-cycles.js`,
`scripts/check-module-boundary.js`, `scripts/check-file-size.js`,
`scripts/check-docs-drift.js`, `scripts/check-package-closure.js`,
`scripts/check-coverage.js`, `scripts/ci-impact-rules.js`,
`scripts/retained-deep-imports.js`, `scripts/file-size-policy.js`,
`scripts/enforcement-coverage-classification.js`, `scripts/run-test-shard.js`,
`scripts/ci-shard-manifest.js`.

Veri: `scripts/context-ownership.json`,
`scripts/architecture-tracker-baseline.json`, `config/shard-weights.json`,
`config/coverage-baseline.json`, `config/reachability-baseline.json`,
`lib/module-reachability.js`.

İlgili belgeler: `docs/architecture/ownership-map-2446.md`,
`docs/architecture/lib-subdivision-plan.md`,
`docs/architecture/refactor-review-2401.md`, `docs/architecture-policy.md`,
`docs/adr/ADR-013-kernel-v2-substitutability.md`.

## 13. Kalan belirsizlikler ve doğrulama

Bu bölüm, belgenin hangi sayılarının **yeniden üretilebildiğini** ve hangi
soruların **açık kaldığını** kayda geçer. Amaç, sonraki okuyucunun bir sayıyı
kabul etmeden önce onu bağımsız doğrulayabilmesidir.

### 13.1 Kaldırılan sayılar (yeniden üretilemedi)

Belgenin önceki sürümü `ddf39a44` tabanında şu sayıları veriyordu. Bunlar
§0.1'deki tanımlarla, `ddf39a44` ve `0bcb2523` tabanlarının ikisinde de
yeniden üretilemedi; bu yüzden belgeden çıkarıldılar ve yerlerine üretilebilen
değerler konuldu. **Hiçbiri "düzeltilmiş tahmin" ile değiştirilmedi.**

| Eski sayı | İddia | Yeniden üretim sonucu |
|---|---|---|
| **520** | Kök modülleri ithal eden benzersiz test dosyası | Üretilemedi. En yakın kararlı değerler: 505 (`require`, `0bcb2523`) / 502 (`require`, `ddf39a44`). |
| **740** | Modül başına toplam test ithali | Üretilemedi. Üretilebilen: 752 (`0bcb2523`, dedup yok) / 715 (`0bcb2523`, benzersiz çift). |
| **328** | Retained yüzeye dokunan test dosyası | Üretilemedi. Üretilebilen: 317 (`0bcb2523`) / 315 (`ddf39a44`). |
| **50** | §4.2 `lib/` → kök kenarı olan dosya | Üretilebilir ama taban değişti: `0bcb2523`'te 51. |
| **18** | §4.1 kök → kök kenar sayısı | Yanlış etiketti: tablo 18 **kaynak** satırı, **41** kenar taşır. |

Denenen tüm varyantlar (§5 için): `require` / `require.resolve` / dinamik
`import()` / `child_process` ile çalıştırma; test dosyası tanımı olarak yalnız
kök, tüm ağaç, yalnız `test/`; dedup'lu ve dedup'suz sayım. Hiçbiri 520 / 740 /
328 üçlüsünü birlikte vermedi.

### 13.2 Taban farkından gelen sayı değişimleri

`ddf39a44` → `0bcb2523` arasında kök 35 modül değişmedi, ama ölçüm altyapısı
değişti. Eski tabanda verilen ve yeni tabanda farklı çıkan sayılar:

**Not — iki ayrı "reachability" sayısı:** aşağıdaki satır **canlı ölçüm**tür
(`analyzeReachability`). `config/reachability-baseline.json` **dosyası** ise bir
ratchet'tır ve başka değerler taşır: `ddf39a44`'te `reachableTotal` 1321 /
`unreachableTotal` 240, `0bcb2523`'te 1335 / 244. İlginç olan: `reachableTotal`
**hiçbir kod tarafından okunmaz** (doğrulandı: `grep -rn reachableTotal`
yalnız dosyanın kendisini bulur). `test/reachability-baseline.test.js` sadece
`unreachableTotal` ve `measuredNotYetWired` alanlarını karşılaştırır. Bu yüzden
`ddf39a44`'te canlı `reachable` 1334 iken baseline `reachableTotal` 1321
olmasına rağmen ratchet testi **geçiyordu** (o tabanda denendi: 2/2 PASS).
`reachableTotal` bir kabul/alt-küme değil, yalnız kaydedilmiş bir sayaçtır.

| Ölçüm | ddf39a44 | 0bcb2523 |
|---|---:|---:|
| reachability reachable / unreachable | 1334 / 240 | 1335 / 244 |
| `lib/` izlenen / `.js` | 1311 / 1294 | 1312 / 1295 |
| test/spec dosyası | 1484 | 1497 |
| `package.json` `files` | 1446 | 1451 |
| `snapshot()` satır sayısı | 1545 | 1549 |
| §4.2 `lib/` → kök dosya | 50 | 51 |
| shard ağırlıklı kök test | 7 | 7 (ağırlıklar değişti) |

Shard ağırlıkları da değişti: `cli.test.js` 6.177→4.81, `server.test.js`
2.907→3.159, `dream.test.js` 2.273→2.695, `kernel.test.js` 2.285→2.296,
`llmAdapter.test.js` 2.079→2.102, `sandboxRunner.test.js` 1.325→1.437,
`mcpServer.test.js` 1.044→1.178.

### 13.3 Bilinen sınır (kapsam dışı bırakılan ölçümler)

- **`demo-causal-autolearn.js` satır sayısı** `architecture-snapshot` tarafından
  ölçülmez (bulgu B). Belgede `?` olarak bırakıldı; `wc -l` ile 212 olduğu
  doğrulandı ama bu, deponun kendi aracının görmediği bir değerdir.
- **Dinamik `require`/`import()`** pin ve ithal taramasına girmez. Bugün kök
  modüller için böyle bir çağrı bulunamadı; ama bu bir yokluk kanıtı değil,
  tarama sınırıdır.
- **`package.json` `files` dışı paketleme** (`.npmignore`, alt paketlerin kendi
  `files` alanları) bu haritada ölçülmedi.
- **Baseline'daki `reachableTotal`** hiçbir kod tarafından okunmaz (bulgu G);
  bir taşıma sonrası baseline güncellemesinde bağlayıcı olan yalnız
  `unreachableTotal` ve `measuredNotYetWired`'dır.

### 13.4 Yeniden üretim komutları

Bu belgedeki sayıları doğrulamak için (temiz bir `origin/main` worktree'sinde):

```
# ölçek
git ls-files lib | wc -l                      # 1312
git ls-files lib | grep -c '\.js$'            # 1295
find . -path ./node_modules -prune -o \( -name '*.test.js' -o -name '*.spec.js' \) -print | wc -l   # 1497
node -e "console.log(require('./package.json').files.length)"   # 1451

# reachability
node -e "const{analyzeReachability}=require('./lib/module-reachability.js');const r=analyzeReachability({root:process.cwd()});console.log(r.reachable.length,r.unreachable.length,r.unacknowledged.length,r.staleAcknowledgements.length)"   # 1335 244 0 0

# kapılar
for g in check:cycles check:layers check:module-boundary check:package-closure \
         check:file-size check:docs-drift check:deprecations; do
  npm run --silent "$g" >/dev/null 2>&1 && echo "$g PASS" || echo "$g FAIL"
done

# snapshot satır sayısı
node -e "console.log(require('./scripts/architecture-snapshot.js').snapshot().length)"   # 1549
```

§2, §4, §5 ve §6 tablolarının sayıları, §0.1'deki tanımlarla bu komutların
genişletilmesiyle üretilir; tanım değişirse sayı değişir.
