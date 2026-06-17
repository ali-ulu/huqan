# Self-Healer Safety Matrix

`AXIOM judges, human decides.`

Bu belge, Self-Healer için karar seviyelerini ve zorunlu güvenlik kurallarını tanımlar.

## Karar Seviyeleri

- `observe`
- `propose`
- `require_review`
- `block`
- `quarantine`

## Karar Tanımları

### `observe`

Yalnız kayıt altına alma veya trend izleme yapılır. Fix önerisi zorunlu değildir.

### `propose`

Düşük riskli, insan onaylı ilerleyebilecek öneri üretilebilir. Uygulama otomatik yapılmaz.

### `require_review`

İlgili aksiyon yüksek etki veya mutasyon taşıdığı için açık insan review/approval ister.

### `block`

Aksiyon güvenlik veya kapsam nedeniyle yürütülemez.

### `quarantine`

Bulgu veya öneri potansiyel olarak zararlı, manipülatif ya da güvenilmez olduğu için izole edilmelidir.

## Kural Matrisi

| Situation | Decision | Rule |
| --- | --- | --- |
| destructive cleanup | `block` | Yıkıcı cleanup varsayılan olarak yasaktır |
| unknown tool | `block` | Bilinmeyen araçlar fail-closed çalışır |
| production memory write | `require_review` | Admission/review zorunludur |
| canonical graph write | `require_review` | Canonical bilgi review olmadan değişmez |
| runtime code patch | `require_review` | Kod patch otomatik uygulanmaz |
| docs-only proposal | `propose` | Docs-only öneri üretilebilir |
| test execution | `require_review` | Açık izin olmadan test koşulmaz |
| auto-merge | `block` | Self-Healer auto-merge yapmaz |
| release/tag/deploy | `block` | Açık release görevi yoksa yasak |

## Risk Bayrakları

Karar üretirken şu risk bayrakları göz önünde bulundurulmalıdır:

- `destructive_action`
- `unknown_tool`
- `runtime_mutation`
- `memory_mutation`
- `canonical_write`
- `release_operation`
- `insufficient_evidence`
- `cross_workspace_risk`
- `dependency_setup`

## Minimum Evidence Kuralı

Anlamlı bir fix önerisi için:

- gözlenebilir evidence gerekir
- etkilenen dosya/yüzey belirtilmelidir
- önerilen test veya neden test olmadığı açıklanmalıdır

## Human Gate Kuralları

İnsan onayı olmadan yapılamayacaklar:

- runtime patch yazma
- PR açma
- production memory write
- canonical graph write
- destructive cleanup
- deploy/release/tag

## Acceptance Criteria

Bu safety matrix başarılı sayılmak için:

1. Her kritik aksiyon için karar seviyesi tanımlı olmalı.
2. Unknown tool ve destructive action açıkça blocked olmalı.
3. Docs-only ile runtime patch aynı karar seviyesinde olmamalı.
4. Human gate mantığı net olmalı.
