# V5 Trust Evidence Ledger MCP Wiring Closeout

**Status:** `closeout`
**Canonical base:** `main @ 186b58e866a8c0b67d77d88882bee3db18d5b5c5`
**Implementation commit:** `b29d149e790d225e7dd06521f6064e1af213ae40`

## Implementation status

```text
implementation_status: implemented_opt_in_mcp_production_caller_slice
issue: 941
implementation_commit: 7abc951
production_caller: mcp_ingest_approval_runtime
migration_mode: opt_in
fail_closed: true
second_durability_authority: false
second_receipt_family: false
```

Bu closeout, #941 Durable Trust Evidence & Receipt Ledger modülünün MCP `http.ingest` approval execution yoluna bağlanan ilk production-caller dilimini kaydeder. MCP server composition’ı `trustEvidenceLedger` seçeneğini yalnızca açıkça verildiğinde approval runtime’a taşır. Mevcut `runtime.recordIngestApprovalAudit` override’ı önceliğini korur; ledger verilmediğinde mevcut routed audit writer davranışı değişmez.

## Uygulanan sözleşme

`lib/mcp-ingest-execute-tool.js`, default `createIngestApprovalAuditWriter` kurulurken opsiyonel ledger dependency’sini alır. Approval execution sonucunda audit writer, admission sonrasında Trust Evidence Ledger’a canonical `trust_evidence` event’i append eder. Admission refusal ledger’a ulaşmadan fail-closed sonuç üretir; audit gap mevcut `AUDIT_EVIDENCE_MISSING` reconciliation sözleşmesi üzerinden işlenir.

`mcpServer.createServer` yalnızca mevcut Graph ve approval store composition’ına `trustEvidenceLedger` runtime option’ını ekler. Ledger append’i yeni bir SQLite tablosu, signer, receipt family veya durability sistemi oluşturmaz; mevcut `Graph.runMutationOnce` ve Trust Evidence Ledger zincir/replay API’si kullanılmaya devam eder. Mevcut V4 receipt family guard’ı ve MCP custom audit writer injection seam’i değiştirilmemiştir.

## Test kanıtı

| Test kapsamı | Sonuç |
|---|---:|
| MCP direct approval + ledger append/replay | 1/1 |
| MCP `createServer` composition wiring | 1/1 |
| MCP ingest execute contract | 5/5 |
| MCP audit duplicate/source contract | 10/10 |
| Trust Evidence Ledger suite | 5/5 |
| Agent-context hariç repository suite’i | 3.207 geçti, 41 skip, 0 failure |

Tam `node --test` çalışması repository’nin remote-baseline freshness kontrolüne bağlı `agent-context.test.js` dosyasındaki bilinen baseline ayrışması nedeniyle ayrı tutulur. Bu dilimin regresyon değerlendirmesinde agent-context hariç 3.207 test geçti, 41 test skip edildi ve failure oluşmadı.

## Migration ve non-claim sınırları

Bu commit MCP ingest caller’larını global olarak ledger-enforced hâle getirmez. Enforce edilen yol, `trustEvidenceLedger` dependency’sinin receiver composition tarafından açıkça sağlandığı opt-in path’tir. HTTP/workflow ingest, diğer MCP mutasyonları ve tüm mutation-admission çağrılarının zorunlu ledger wiring’i bu dilimin claim’i değildir.

İleride opt-in sınırının genişletilmesi, her caller için event alanlarının, operation idempotency anahtarının, workspace binding’inin ve audit-gap reconciliation davranışının ayrı contract testleriyle kanıtlanmalıdır. Bu genişletme sırasında Graph tek durability otoritesi olarak kalmalı ve mevcut receipt aileleri korunmalıdır.

## Kaynak kod yüzeyi

| Yüzey | Rol |
|---|---|
| `lib/mcp-ingest-execute-tool.js` | Opt-in ledger-backed default audit writer wiring’i |
| `mcpServer.js` | `createServer` composition’dan runtime’a ledger aktarımı |
| `lib/workbench/ingest-approval-audit-writer.js` | Admission sonrası bounded ledger append seam’i |
| `lib/trust-evidence-ledger.js` | Canonical payload, forbidden-field guard, Graph durability ve replay |
| `test/mcp-ingest-trust-evidence-ledger.test.js` | Direct ve `createServer` production-shaped integration kanıtı |

