# Huqan V5 — Human Oversight HTTP/Workflow Production Wiring Closeout

**Issue:** [#942](https://github.com/ali-ulu/huqan/issues/942)
**Implementation commit:** `0ff4e79` — `feat(#942): wire human oversight into HTTP ingest approvals`
**Tarih:** 20 Ağustos 2026
**Durum:** HTTP/workflow ingest approval dilimi tamamlandı; global wiring iddiası değildir.

## 1. Kapsam

Bu dilim, mevcut HTTP/workflow ingest approval akışını opt-in **Human Oversight & Approval Runtime** ile bağlar. Varsayılan boot ve mevcut approval caller’ları için legacy davranış korunur. Runtime yalnızca `server.configureHttpHumanOversight({ runtime, humanOversightRequesterContext, humanOversightApproverContext })` ile açıkça yapılandırıldığında devreye girer.

Wiring, mevcut `approvalStore` satırı ile Human Oversight review case’ini deterministik biçimde eşler. Review case, karar ve execution state’i ikinci bir veritabanına yazılmaz; mevcut Graph mutation journal ve Trust Evidence Ledger zinciri üzerinden durable edilir. HTTP action owner yalnızca bounded adapter çağrılarını ve mevcut ingest receipt/audit finalization akışını orkestre eder.

## 2. Uygulanan akış

HTTP ingest approval oluşturulduğunda opt-in runtime aktifse approval context içine yalnızca `oversightRequired: true` marker’ı eklenir. Approval payload’ının ham requester girdisi, token’ı veya sınırsız metadata’sı response yüzeyine aktarılmaz. Aynı approval için review case ID’si deterministik olarak `http-ingest-oversight:<approvalId>` biçiminde üretilir ve Graph mutation idempotency’si ile replay-safe tutulur.

Karar öncesinde adapter, mevcut approval snapshot’ından bounded action/requester context oluşturur. Requester ve approver kimlikleri receiver-owned context resolver üzerinden çözülür; karar gövdesi kimlik otoritesi olarak kabul edilmez. Approver identity, separation-of-duties ve immutable action scope kontrollerinden geçmeden approval claim’i yapılmaz.

`approved` kararı için Human Oversight decision durable edilmeden ingest executor çağrılmaz. Execution öncesinde runtime; review case status, expiry, action fingerprint, workspace, connector/resource reference, policy version, firewall version, evidence digest ve requester identity bağını tekrar doğrular. Firewall sonucu block, mismatch, resolver failure, scope drift, stale case veya durability failure ise akış fail-closed durur ve executor çalışmaz.

Execution sonrasında mevcut ingest action owner, daha önce kullandığı bounded outcome classification, operation-owned evidence, receipt creation, approval finalization ve audit-gap davranışlarını korur. Human Oversight sonucu response’a yalnızca bounded `oversight` projection olarak eklenir; ham review case, identity claim veya token response’a taşınmaz. Unknown execution outcome otomatik başarıya çevrilmez ve mevcut reconciliation sözleşmesi korunur.

## 3. Değişen dosyalar

| Dosya | Değişiklik |
|---|---|
| [`lib/http-human-oversight-adapter.js`](../../lib/http-human-oversight-adapter.js) | HTTP ingest için bounded action/context adapter, receiver-owned requester/approver context, case/decision preparation, execution wrapper ve bounded summary/failure projection. |
| [`lib/workbench/ingest-approval-action.js`](../../lib/workbench/ingest-approval-action.js) | Opt-in oversight decision ve pre-execution runtime wrapper’ının mevcut approval claim/execution/finalization akışına bağlanması; action owner ratchet’i 283 satırda korunmuştur. |
| [`server.js`](../../server.js) | Explicit `configureHttpHumanOversight` composition seam’i, HTTP approval marker’ı ve workflow/legacy approval decision çağrılarına runtime propagation. |
| [`package.json`](../../package.json) | Yeni HTTP adapter’ın dağıtım listesine eklenmesi. |
| [`test/http-human-oversight-production-wiring.test.js`](../../test/http-human-oversight-production-wiring.test.js) | Receiver-owned allow ve approver identity refusal için production-shaped HTTP ingest regression testi. |

## 4. Güvenlik ve durability sözleşmeleri

> **Fail-closed:** Identity refusal, review-case persistence failure, decision persistence failure, pre-execution revalidation failure ve firewall disagreement execution’a ulaşmadan bloklanır.

Bu dilim yeni bir signer, ikinci bir receipt family, ikinci bir SQLite tablosu veya ikinci bir durability authority oluşturmaz. Review case, decision ve execution state’i mevcut Graph mutation journal üzerinden yazılır; Trust Evidence bağlantısı mevcut ledger instance’ı üzerinden korunur. Mevcut v4 receipt family guard’ı ve ingest action owner’ın operation-owned evidence sınırı değiştirilmemiştir.

Migration sınırı opt-in’dir. `humanOversight` yapılandırması yokken approval store marker’ı yazılmaz, case creation yapılmaz ve mevcut HTTP/MCP dışı davranışlar oversight runtime’a zorunlu bağlanmaz. Malformed explicit runtime configuration sessizce legacy opt-out’a dönüştürülmez; server setter’ı gerekli runtime API’lerini doğrular ve hatalı yapılandırmayı reddeder.

## 5. Doğrulama kanıtı

Aşağıdaki hedefli regression kümesi `env -u GIT_CONFIG_COUNT node --test --test-concurrency=1` ile çalıştırılmıştır.

| Test kümesi | Sonuç |
|---|---:|
| HTTP Human Oversight production wiring | 2/2 |
| Human Oversight Approval Runtime | 6/6 |
| V4-B2A ingest approval runtime contract | 1/1 |
| V4-B2B ingest approval authority repair | 11/11 |
| Canonical workflow data routes | 10/10 |
| MCP Human Oversight production wiring | 3/3 |
| MCP Agent Identity production wiring | 3/3 |
| Trust Evidence Ledger | 5/5 |
| MCP ingest Trust Evidence Ledger | 2/2 |
| External-client Agent Identity production wiring | 2/2 |
| **Toplam** | **47/47** |

Ek doğrulamalar başarılıdır: `node --check` ile adapter, action owner ve `server.js` syntax kontrolü; `git diff --check`; action owner ratchet’i `283` satır ile `≤300` sınırı.

## 6. Açık non-claim sınırları

Bu commit, bütün Huqan ingress’lerinin Human Oversight runtime’a bağlandığını iddia etmez. HTTP/workflow ingest approval path’i ile mevcut legacy HTTP approval route’u kapsanır; HTTP dışı CLI ve diğer workflow family’leri bu dilimin kapsamı değildir.

Bu wiring, approval runtime’ını connector authorization, IAM provider, bağımsız policy engine veya insan kimlik sağlayıcısı haline getirmez. Approver context’in receiver-owned resolver’a güvenli biçimde bağlanması bu dilimin sözleşmesidir; gerçek deployment kimlik sağlayıcısının kapsamı değildir. Ingest executor’ın kendi authorization boundary’si ve downstream connector güvenlik kontrolleri ayrıca korunmalıdır.

Bu belge ürün pazar konumlandırması, regülasyon uygunluk hükmü veya hukuki sertifikasyon iddiası değildir; yalnızca repository’deki #942 HTTP/workflow implementation diliminin teknik closeout kaydıdır.

## 7. Repository referansları

1. [Human Oversight & Approval Runtime](../../lib/human-oversight-approval-runtime.js)
2. [HTTP Human Oversight Adapter](../../lib/http-human-oversight-adapter.js)
3. [HTTP ingest approval action owner](../../lib/workbench/ingest-approval-action.js)
4. [HTTP server composition](../../server.js)
5. [HTTP production wiring regression](../../test/http-human-oversight-production-wiring.test.js)
6. [Issue #942](https://github.com/ali-ulu/huqan/issues/942)
7. [Implementation commit `0ff4e79`](https://github.com/ali-ulu/huqan/commit/0ff4e79)

## Sonuç

#942’nin bu dilimiyle HTTP/workflow ingest approval hattı, mevcut Graph/receipt/audit otoritelerini çoğaltmadan opt-in Human Oversight case, decision ve pre-execution revalidation akışına bağlanmıştır. Receiver-owned identity, separation-of-duties, bounded response projection, fail-closed enforcement ve legacy migration boundary hedeflenen kapsam içinde doğrulanmıştır.

**Closeout durumu:** HTTP/workflow production wiring tamamlandı; sonraki kapsam genişletmeleri ayrı, opt-in issue dilimleri olarak ele alınmalıdır.
