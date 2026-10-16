# Observability Release, Migration and Rollback Checklist

Bu checklist, HUQAN’ın **local-first observability** yüzeyindeki bir release adayını değerlendirmek için kullanılır. Amaç; gözlemlenebilirlik schema’sı, backup/restore, notification adapter, load-smoke, package closure ve güvenlik regresyonlarının aynı aday üzerinde tekrar edilebilir biçimde doğrulanmasıdır.

> Bu belge bir deployment, npm publication veya hosted rollback otomasyonu değildir. Checklist’in yeşil olması yalnızca repository içindeki source/test/CI kanıtlarının release kararına hazır olduğunu gösterir.

## 1. Aday kimliği ve kapsam

| Alan | Değer |
| --- | --- |
| Release adayı commit SHA | `________________` |
| Temel dal / ref | `________________` |
| Değerlendirme tarihi | `________________` |
| Değerlendiren | `________________` |
| Observability değişiklik özeti | `________________` |
| Backup/restore kanıtı | `________________` |
| Migration kanıtı | `________________` |
| CI run kimlikleri | `________________` |

Aday, mutable bir çalışma ağacından değil exact commit SHA’dan değerlendirilmelidir. PR branch’i merge edilecekse required CI’nin terminal yeşil olması, base branch ile conflict bulunmaması ve GitHub merge state’inin `CLEAN/MERGEABLE` olması gerekir. Bu checklist otomatik merge yetkisi vermez; repository’nin ayrı merge politikası uygulanır.

## 2. Temiz clone ve repository kapıları

Aşağıdaki komutlar aynı exact aday commit’ini gösteren temiz bir worktree veya clean clone’da çalıştırılır. Her komutun stdout/stderr’i ve exit code’u release kanıtına eklenir.

| Kontrol | Komut veya kanıt | Pass ölçütü |
| --- | --- | --- |
| Exact source | `git rev-parse HEAD` ve `git status --short` | Beklenen SHA ve boş status |
| Bağımlılık kurulumu | `npm ci` | Hata yok; lockfile değişmiyor |
| Sıralı tam regression | `npm run test:serial` | `0 failed` |
| Paralel tam regression | `npm test` | `0 failed`; concurrency kaynaklı flake varsa aday durdurulur |
| Dosya boyutu | `npm run check:file-size` | File-size ratchet geçer |
| Package closure | `npm run check:package-closure` | Published entry-point closure tamdır |
| Control characters | `npm run check:control-chars` | Tracked text kaynaklarında ham control character yoktur |
| Import cycles | `npm run check:cycles` | Cycle yoktur |
| Workflow governance | `npm run check:workflow-governance` | Workflow sözleşmesi geçer |
| V5 document status | `npm run check:doc-status` | Taranan `docs/v5` belgeleri status/commit sözleşmesine uyar |
| Diff formatı | `git diff --check` | Whitespace hatası yoktur |

`Graphify` ortamda yoksa bu checklist Graphify kanıtı üretmez; sonuç **doğrulanmadı** olarak işaretlenir ve canlı source, test, exact Git ve CI kanıtları kullanılmaya devam edilir.

## 3. Observability schema migration

Schema migration’ın controlling sözleşmesi [`docs/observability-schema-migrations.md`](observability-schema-migrations.md) dosyasıdır. Bu checklist migration davranışını yeniden tanımlamaz.

| Senaryo | Controlling test/kanıt | Beklenen davranış |
| --- | --- | --- |
| Metadata olmayan legacy DB | `test/observability-migrations.test.js` | Additive schema uygulanır ve version `1` kaydedilir |
| Version `1` DB’nin tekrar açılması | `test/observability-migrations.test.js` | Migration idempotent çalışır, mevcut rows korunur |
| Eski queue tablosuna `agent_id` eklenmesi | `test/observability-migrations.test.js` | Compatibility kolonu veri kaybı olmadan eklenir |
| Daha yeni schema version | `test/observability-migrations.test.js` | `UNSUPPORTED_OBSERVABILITY_SCHEMA_VERSION` ile fail-closed durur |
| Version write failure | `test/observability-migrations.test.js` | Transaction rollback olur; kısmi migration başarı sayılmaz |

Migration sırasında SQLite global `PRAGMA user_version` observability version authority’si olarak değiştirilmez. Migration, `observability_schema_meta` içindeki namespaced `observability` kaydını kullanır. **Version `1`’den daha eski schema’ya otomatik downgrade veya cross-version restore bu checklist’in kanıtladığı bir davranış değildir.**

## 4. Backup, restore ve rollback hazırlığı

Backup/restore controlling sözleşmesi [`docs/observability-backup-restore.md`](observability-backup-restore.md) ve gerçek SQLite integration testi [`test/observability-backup-restore.integration.test.js`](../test/observability-backup-restore.integration.test.js) ile doğrulanır. Kanıt; en az iki workspace için event, run, queue ve alert state parity’sini, restore sonrası workspace-scoped read parity’sini ve `memory.db` dahil backup manifest’ini göstermelidir.

| Release durumu | Güvenli işlem | Bu checklist’in yapmadığı işlem |
| --- | --- | --- |
| Migration testlerinden biri başarısız | Promotion’ı durdur; exact log ve DB kopyasını sakla | Migration’ı zorla sürdürmek veya schema version’ı elle ileri almak |
| Yeni schema oluşturulamıyor | Startup/service davranışının açık hata veya fail-closed olduğunu doğrula | Bozuk veya kısmi schema’yı current kabul etmek |
| Kod release’inden sonra runtime regresyonu | Platformun immutable önceki kod release’ine dön; mevcut DB’yi koru; smoke ve regression’ı yeniden çalıştır | Schema `1`’den eskiye otomatik downgrade iddiası |
| Backup’tan geri dönüş gerekiyor | Mevcut DB ve backup dosyasını koruyarak onaylı backup/restore akışını kullan; restore sonrası integration testini çalıştır | Remote backup storage, encryption veya cross-version restore kanıtı üretmek |
| Notification endpoint erişilemiyor | Telemetry ve alert state persistence’ın etkilenmediğini doğrula; adapter failure’ı typed/non-throwing sonuç olarak izle | Dış endpoint erişilebilirliğini local testten çıkarmak veya otomatik deployment rollback iddiası |

Rollback **kod release’i geri alma hazırlığı** olarak tanımlıdır; bu belge yeni bir deployment sistemi, migration downgrade mekanizması, remote backup orchestration veya otomatik rollback runner eklemez. Başarısız aday için `npm publish`, tag oluşturma veya production deployment yapılmaz.

## 5. Load-smoke ve notification sınırı

Observability performans smoke kanıtı [`benchmarks/observability-load-smoke.js`](../benchmarks/observability-load-smoke.js), hedef fixture’ı [`benchmarks/fixtures/observability-load-targets.json`](../benchmarks/fixtures/observability-load-targets.json) ve test otoritesi [`test/observability-load-smoke.test.js`](../test/observability-load-smoke.test.js) üzerinden alınır. `npm run bench:observability:load` veya repository’nin bu benchmarkı çağıran CI gate’i hedefleri değiştirmeden çalıştırılmalıdır.

Bu load-smoke; event write, list/summary, SSE fan-out, queue claim, DB boyutu, queue lag ve process-local instrumented database operation timing resource’ı için bounded kabulü doğrular. **Uzun süreli production soak, memory leak yokluğu, external notification delivery veya üçüncü taraf receiver interoperability kanıtı değildir.** Bu iddialar ayrı acceptance dilimleridir.

Notification adapter için controlling sözleşme [`docs/observability-notifications.md`](observability-notifications.md) ve [`test/observability-notification-adapter.test.js`](../test/observability-notification-adapter.test.js) dosyalarındadır. Adapter explicit caller configuration ile kullanılabilir; varsayılan server runtime’ı dış endpoint’e kendiliğinden istek göndermez.

## 6. Security, package ve release kararı

Release adayı aşağıdaki koşulların hepsi sağlanmadan promotion-ready kabul edilmez:

- Plaintext goal, prompt, input/output, secret veya credential değerleri observability response, log, benchmark report, backup manifest veya notification payload’ına sızmamalıdır.
- Workspace scope, authorization ve fail-closed hata davranışı ilgili observability negative testleriyle korunmalıdır.
- Backup/restore ve migration testleri gerçek SQLite davranışını kapsamalıdır; yalnız mock statement kanıtı yeterli değildir.
- Package closure ve installed package smoke’ları geçmelidir; package smoke registry publication veya deployment kanıtı sayılmaz.
- Required CI kontrolleri terminal yeşil olmalı; skipped kontrollerin koşullu skip nedeni repository sözleşmesine uygun olmalıdır.
- Aday release için exact SHA, test summary, gate summary, CI run kimlikleri ve bilinen unverified alanlar release kaydına eklenmelidir.

Bu checklist’in tek başına verdiği karar dili şöyledir:

| Karar | Anlam |
| --- | --- |
| `READY_FOR_REVIEW` | Repository kanıtları toplandı; insan/repository merge politikası ayrıca uygulanır |
| `BLOCKED` | En az bir required test/gate başarısız veya kanıt eksik; promotion yapılmaz |
| `UNVERIFIED` | Local/Graphify/external/deployment kanıtı mevcut değil; iddia kurulmaz |

## 7. Açık non-claim’ler

Bu belge şu iddiaları **kurmaz**: npm registry publication, release tag’in yayınlandığı, production deployment, hosted SaaS availability, third-party webhook delivery, external interoperability, public multi-tenant operation, production SLA, persistent distributed notification ledger, schema downgrade veya automated deployment rollback.

#1133 parent issue’sinin kapanması için gereken diğer P2 başlıkları — örnek entegrasyon/SDK, uzun süreli soak ve bağımsız kullanıcı doğrulaması — bu checklist ile tamamlanmış sayılmaz.
