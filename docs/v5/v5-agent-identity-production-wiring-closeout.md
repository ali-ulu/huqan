# V5 Agent Identity Production Wiring Closeout

**Status:** `closeout`

## Implementation status

```text
implementation_status: implemented_first_production_caller_slice
issue: 940
implementation_commit: 71a1e2b
runtime: receiver_owned_identity_claim_composition
production_caller: external_client_mutation_receipt_owner
migration_mode: opt_in
fail_closed: true
second_durability_authority: false
second_receipt_family: false
```

Bu closeout, #940 Runtime Agent Identity modülünün ilk production-caller dilimini tanımlar. Dilim, external-client mutation receipt owner’ın receiver-owned authority ile identity claim composition ve mutation admission evaluator seam’ine bağlanmasını kapsar.

## Uygulanan sözleşme

`composeReceiverOwnedIdentityClaim` yalnızca snapshot edilmiş authority, identity reference ve receiver binding üzerinden claim üretir. Claim; workspace, owner actor, identity hash, agent ID ve delegation chain alanlarını authority snapshot’tan alır. Request/package payload’ı identity kaynağı olarak kullanılmaz. Workspace veya owner actor uyuşmazlığı fail-closed refusal üretir.

External-client mutation owner’a `agentIdentityRuntime` seçeneği verilirse claim composition yapılır ve `createMutationAdmission` içine receiver-owned evaluator bağlanır. Evaluator, mutation context’teki claim’in receiver tarafından compose edilen claim ile aynı olduğunu, ardından capability, target, tool, connector, delegation scope, expiry ve risk sınırlarını doğrular. Refusal durumunda `graph.runMutationOnce` callback’i çalışmaz; candidate, mutation journal veya receipt yazılmaz.

Existing V4 receipt family sözleşmesi korunmuştur. Identity claim, mevcut receipt metadata allowlist’ine yeni alanlar eklenerek veya `agentId` alanı actor’dan ayrıştırılarak receipt’e sızdırılmamıştır. Bu nedenle mevcut `agentId === actor` ve exact metadata guard’ları değişmeden kalır. Identity enforcement admission katmanında gerçekleşir; ikinci signer, receipt family veya durability otoritesi oluşturulmamıştır.

## Test kanıtı

| Test kapsamı | Sonuç |
|---|---:|
| Agent Identity Runtime ve claim composition | 8/8 |
| External-client production identity wiring | 2/2 |
| External-client route adversarial suite | 16/16 |
| Mutation admission suite | 16/16 |
| Agent-context hariç repository suite’i | 3.205 geçti, 41 skip, 0 failure |

Tam `node --test` çalışması yalnızca repository’nin remote-baseline freshness kontrolüne bağlı `agent-context.test.js` içindeki dört testi çalıştırılamadığı için non-zero döndü. Hata, ürün kodu regresyonu değil; `origin/main` için beklenen `c848a9c6004a1b6de14c0461b8904448444ed9c3` baseline’ının mevcut yerel ilerlemiş HEAD `51ff7390d99117a60040c4b74bed065c7150987c` ile uyuşmaması ve testin önerdiği remote sync’in bulunmamasıdır.

## Migration ve non-claim sınırları

Bu dilim mevcut production caller’ları zorunlu olarak identity-enforced hâle getirmez. Enforcement yalnızca external-client receiver composition’ına `agentIdentityRuntime` açıkça verildiğinde devreye girer; mevcut çağrılar bu seçenek olmadan geriye dönük çalışır. HTTP/workflow, MCP ingest ve diğer mutation caller’larının tamamına global opt-out enforcement bu commit’in claim’i değildir.

Bir sonraki genişletme, aynı receiver-owned composition sözleşmesini başka bir caller’a taşımadan önce o caller’ın authority, workspace ve action mapping’ini ayrı testlerle kanıtlamalıdır. Bu, global enforcement’a geçişte mevcut opt-in migration boundary’nin korunmasını sağlar.
