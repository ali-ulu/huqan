# Huqan workflow BDD senaryoları

Bu dizin, GitHub issue [#785](https://github.com/ali-ulu/huqan/issues/785), [#786](https://github.com/ali-ulu/huqan/issues/786), [#787](https://github.com/ali-ulu/huqan/issues/787) ve [#788](https://github.com/ali-ulu/huqan/issues/788) kabul kriterlerini BDD/Gherkin formatına dönüştürür.

## Dosyalar

| Feature | Issue | Katman | Senaryo sayısı |
|---|---:|---|---:|
| `ui_claim_workspace.feature` | #785 | UI | 10 |
| `api_workflow_contract.feature` | #786 | API | 10 |
| `mcp_workflow_contract.feature` | #787 | MCP | 12 |
| `cli_workflow_contract.feature` | #788 | CLI | 14 |
| **Toplam** |  |  | **46** |

Her senaryo kabul kriteri etiketiyle izlenebilir: örneğin `@ac-785-3`, UI issue #785’in üçüncü kabul kriterini temsil eder. `Scenario Outline` içindeki `Examples` tabloları; aynı davranışın farklı workflow, status veya hata koşulları için veri güdümlü çalıştırılmasını sağlar.

## Otomasyon sözleşmesi

Senaryolar şu ortak davranış sözleşmesini varsayar:

- Her workflow canonical `workflowId` ve version ile tanımlanır.
- Sonuçlar `ok`, `status`, `data`, `evidence`, `confidence`, `approval`, `trace`, `receiptId` ve `error` alanlarını taşıyan ortak envelope’a dönüştürülür.
- Workspace, authentication, policy, approval, idempotency ve Trust Receipt sınırları step definition’lar tarafından gerçek runtime’da doğrulanır.
- `completed`, `review_required`, `blocked`, `paused`, `partial`, `failed`, `unauthorized`, `invalid_input`, `unsupported` ve `rate_limited` durumları başarı gibi yorumlanmaz.
- Mutation workflow’ları approval veya açık policy kararı olmadan canonical memory’ye yazamaz.

## Mevcut test altyapısına bağlama

Repo şu anda Node.js yerleşik test runner’ını kullanıyor; `package.json` içindeki `test` komutu `node --test --test-concurrency=1` çalıştırıyor. Gherkin dosyaları davranış sözleşmesidir; gerçek otomasyon için Cucumber.js, Playwright veya mevcut Node testleriyle step definition/adapter katmanı eklenmelidir.

Önerilen bağlama modeli şöyledir:

| Gherkin katmanı | Önerilen adapter |
|---|---|
| UI | Playwright veya mevcut HTTP test server’ı üzerinden browser smoke/route contract adapter’ı |
| API | Node `fetch`/HTTP integration adapter’ı ve OpenAPI/schema validator |
| MCP | MCP test client’ı, tool schema validator ve deterministic fixture adapter’ı |
| CLI | `child_process.spawn`, JSON stdout parser, stable exit-code assertion ve installed-tarball smoke adapter’ı |

Bu paket, step definition’lar eklenmeden önce bile acceptance-test tasarımını, isimlendirmeyi ve kapsamı sabitler. `scripts/validate_workflow_gherkin.py` basit bir yapısal validator olarak dört dosyada Feature/Background/Scenario sayısını, kabul kriteri etiketlerini ve desteklenen Gherkin satırlarını kontrol eder.

## Doğrulama

```bash
python3 scripts/validate_workflow_gherkin.py
```

Beklenen çıktı:

```text
ui_claim_workspace.feature: issue=785 scenarios=10 acceptance_tags=10
api_workflow_contract.feature: issue=786 scenarios=10 acceptance_tags=10
mcp_workflow_contract.feature: issue=787 scenarios=12 acceptance_tags=12
cli_workflow_contract.feature: issue=788 scenarios=14 acceptance_tags=14
VALIDATION_OK
```

Bu doğrulama Gherkin parser’ının yerine geçmez; syntax ve kabul kriteri kapsamı için erken bir guard’dır. Cucumber/Playwright adapter’ı eklendiğinde aynı `@issue-*` ve `@ac-*` tag’leri üzerinden seçici test çalıştırma yapılabilir.
