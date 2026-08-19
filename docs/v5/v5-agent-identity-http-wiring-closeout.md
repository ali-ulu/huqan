# #940 Runtime Agent Identity — HTTP/workflow wiring closeout

**Implementation scope:** HTTP/workflow ingest approval owner’da opt-in receiver-owned Agent Identity enforcement.

**Source status:** HTTP ingest approval preparation’ı, mevcut Human Oversight lifecycle’ından önce bounded Agent Identity değerlendirmesine bağlandı. Identity config yalnız explicit `agentIdentityRuntime` ile etkinleşir; config yoksa mevcut legacy approval davranışı korunur.

## Implemented

`lib/http-human-oversight-adapter.js` içinde HTTP approval action için receiver-owned identity claim composition, bounded action binding ve Agent Identity evaluation helper’ı eklendi. Evaluation, approval claim’i ve ingest executor çağrısından önce çalışır. Authority, identity reference, receiver binding ve action scope uyuşmazlığı fail-closed olarak `IDENTITY_ENFORCEMENT_BLOCKED` döndürür.

`lib/workbench/ingest-approval-action.js` identity preparation sonucunu mevcut approval/oversight execution akışına bağlar. Identity refusal durumunda approval claim edilmez, executor çağrılmaz ve mevcut pending state korunur. Başarılı path’te yalnız bounded identity evidence response projection’a eklenir; ham claim, token veya sınırsız requester context taşınmaz.

`server.js` HTTP composition root’a explicit opt-in identity config aktarımı eklendi. Legacy approval route ile workflow route aynı HTTP approval closure üzerinden identity runtime seçeneğini kullanır. `lib/http/workflow-data-routes.js` bounded identity failure details’ını workflow error envelope’ine taşır; `server.js` legacy API error envelope’i de aynı details sözleşmesini korur.

## Security and durability boundaries

Bu dilim mevcut `Graph` durability otoritesini, `Graph.runMutationOnce` mutation modelini, mevcut approval store’u, receipt chain’i ve Human Oversight runtime’ını değiştirmez. İkinci SQLite tablosu, ikinci signer veya yeni receipt family oluşturulmadı.

Identity claim receiver-owned authority snapshot’tan türetilir. Request body’den gelen owner/identity iddiası authority yerine kullanılmaz. Workspace, identity reference/hash, delegation scope, capability, tool, connector ve risk tier uyuşmazlıkları allow’a çevrilmez.

Response surface bounded tutulur. Identity reference/hash ve karar özeti gibi güvenlik kanıtları projection’a dahil edilebilir; ham claim veya token response’a çıkarılmaz. `evidenceDigest` ve receipt zinciri bu dilimde yeniden üretilmez; mevcut approval/ledger/receipt bağlantıları korunur.

## Verification

Commit öncesi doğrulama:

| Kontrol | Sonuç |
|---|---:|
| HTTP Agent Identity production-shaped test | 2/2 geçti |
| HTTP Human Oversight production wiring regression | 2/2 geçti |
| Agent Identity Runtime testleri | 8/8 geçti |
| External-client identity wiring regression | geçti |
| MCP identity wiring regression | geçti |
| MCP Human Oversight regression | geçti |
| Human Oversight Runtime regression | geçti |
| CLI Agent Identity/Human Oversight regression | geçti |
| Birleşik hedefli regression kümesi | **26/26 geçti** |
| `git diff --check` | geçti |
| Değiştirilen JS dosyalarında `node --check` | geçti |

## Non-claims

Bu closeout yalnız HTTP/workflow ingest approval identity wiring’ini kapsar. Harici IAM provider entegrasyonu, connector authorization, gerçek deployment identity attestation, tüm workflow family’leri veya bağımsız bir regülasyon sertifikasyonu iddia edilmez. CLI approval wiring’i ayrı #940/#942 CLI commit’i ile kayıt altındadır; MCP ve external-client dilimleri önceki closeout’larda ayrı tutulmuştur.

**Implementation commit:** `f7c9791` — `feat(#940): wire agent identity into HTTP approvals`.
