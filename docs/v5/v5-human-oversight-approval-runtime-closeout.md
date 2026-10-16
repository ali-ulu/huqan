# Human Oversight & Approval Runtime — #942 İlk Dilim

**Status:** `implementation`

**Durum:** İlk bounded runtime dilimi implement edildi; production ingress’lere global geçiş yapılmadı.

**Canonical base:** `main @ 8e5f18f3b2c30f252b882666b40bcbe67d8e7475`

Bu belge, `lib/human-oversight-approval-runtime.js` modülünün mevcut repository kanıtını sınırlar. Modül, yüksek riskli ajan aksiyonları için review case, receiver-owned identity, bounded approval decision, executor öncesi revalidation ve execution outcome kaydı sağlar. İkinci bir SQLite tablo, signer, receipt family veya durability otoritesi oluşturmaz; tüm durable write işlemleri mevcut `Graph.runMutationOnce()` ve Trust Evidence Ledger üzerinden yapılır.

## Source-backed kapsam

| Alan | Mevcut kanıt | Durum |
|---|---|---|
| Review case | `createReviewCase()`; `review`, `dry_run_only` ve `block` firewall kararlarını bounded case’e dönüştürür | Implemented |
| Receiver-owned identity | Inject edilen `resolveIdentity({ role, context, action })`; karar gövdesindeki display name/identity kabul edilmez | Implemented, caller-provided resolver |
| Separation of duties | Requester ve approver identity ref/hash karşılaştırması; self-approval fail-closed | Implemented |
| Approval outcomes | `approve`, `reject`, `expire`, `cancel`, `escalate`, açık policy ile `override` | Implemented |
| Durable state | Mevcut `Graph.runMutationOnce()` mutation journal ve Trust Evidence Ledger receipt zinciri | Implemented |
| Atomic/idempotent transition | Case create, decision ve execution outcome operation ID’leriyle replay-safe | Implemented |
| Executor boundary | Approval sonrası action scope, requester identity, approval interval, latest decision, firewall ve firewall version yeniden doğrulanır | Implemented |
| Dry-run | `dry_run_only` case’i executor’e ulaşamaz; yalnızca explicit `allowDryRun` ile simulation yüzeyi için yetkilendirme sonucu üretir | Implemented, connector simulation caller’ı değil |
| Execution outcome | `succeeded`, `failed`, `unknown`; bilinmeyen sonuç `reconciliation_required` state’ine alınır | Implemented |
| Human-facing evidence | Verified, requested, observed, provenance-linked ve unverified alanları bounded read seam ile ayrıştırılır | Implemented, API/CLI/MCP UI değil |
| Global ingress wiring | MCP/HTTP/automation production caller’larının tamamı bu runtime’a yönlendirilmiş değildir | Non-claim |
| Connector authorization | Human approval connector yetkisi olarak kabul edilmez | Non-claim |
| IAM/provider | Yeni IAM veya operator identity provider oluşturulmamıştır | Non-claim |

## Güvenlik ve veri sınırları

Approval context exact action fingerprint, workspace, connector/resource target, policy version, firewall version, evidence digest ve validity interval’a bağlanır. Raw prompt, input, content, token, secret, credential, password ve private key benzeri alanlar metadata içinde reddedilir; metadata derinliği, dizi uzunluğu ve serialized boyutu bounded tutulur.

`block` kararı implicit approval ile yükseltilemez. `override` yalnızca case policy’si açıkça izin veriyorsa ve ayrı decision type, approver identity, reason ve ledger receipt ile kaydediliyorsa kabul edilir. Her execution çağrısından hemen önce approval state yeniden okunur; stale, expired, scope-mismatched, firewall-mismatched veya durable state’i okunamayan durumlar fail-closed sonuçlanır.

> Bu ilk dilim, approval’ın connector authorization veya genel workflow ürünü olduğu iddiasını taşımaz. Gerçek production caller entegrasyonu, mevcut MCP approval store ve connector-side authorization sözleşmeleriyle ayrı bir migration adımıdır.

## Test kanıtı

`test/human-oversight-approval-runtime.test.js` şu davranışları doğrular: receipt-linked case creation ve idempotent replay; distinct approver ve self-approval reddi; expiry; action drift; `dry_run_only` executor block; pre-approval executor block; firewall revalidation; unknown executor outcome ve reconciliation state.

#941 Trust Evidence Ledger regresyonları da aynı çalışma diliminde `test/trust-evidence-ledger.test.js` ile korunur.
