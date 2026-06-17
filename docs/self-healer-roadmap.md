# Self-Healer Roadmap

## Amaç

Self-Healer hattının amacı, AXIOM'un geçmiş scan/fix/test/PR bilgisini Memory Core içinde kullanarak daha tutarlı, daha az tekrarlı ve daha güvenli mühendislik önerileri üretmesidir.

Bu dosya implementasyon değil, yön haritasıdır.

## Başlangıç Varsayımı

Self-Healer hattı, Memory Core readiness doğrulandıktan ve canonical `main` üzerinde V3.1 runtime/MCP güvenlik davranışı sertifikalandıktan sonra başlatılır. Kesin commit hash, branch ve smoke sonuçları release/checkpoint notlarında tutulur; bu roadmap kalıcı tasarım sırasını tanımlar.

## Neden Şimdi

Memory Core hazır olmadan Self-Healer riskli olurdu. Şimdi ise:

- geçmiş bulgular hafızada tutulabilir
- tekrar eden patternler izlenebilir
- trust receipt zinciri korunabilir
- branch / commit / workspace bağlamı kaybolmadan öneri üretilebilir

## Fazlar

### SH0 — Self-Healer Loop Blueprint

Hedef:

- problem tanımı
- güvenlik sınırları
- döngü tasarımı
- Memory Core bağımlılığı

Çıktılar:

- `docs/ADR-006-self-healer-loop.md`
- `docs/self-healer-roadmap.md`

### SH1 — Repo Scanner Contract

Hedef:

- scanner giriş/çıkış sözleşmesi
- finding formatı
- severity / confidence / evidence alanları
- deterministic çıktı beklentisi

Bu fazda henüz runtime fix uygulanmaz.

### SH2 — Bug Classifier + Memory Lookup

Hedef:

- yeni bulguyu sınıflandırmak
- Memory Core içinde benzer finding/fix/test geçmişini aramak
- false positive geçmişini hesaba katmak

Beklenen sonuç:

- aynı bulguya her seferinde sıfırdan davranmayan sistem

### SH3 — Fix Planner

Hedef:

- önerilen fix seçenekleri üretmek
- her seçenek için risk, etki alanı ve test ihtiyacını belirtmek
- hangi önerinin neden seçildiğini görünür kılmak

### SH4 — Regression Test Planner

Hedef:

- her anlamlı bug için kalıcı test önerisi üretmek
- test yoksa neden yok açıklamak
- mevcut testlerle çakışan önerileri filtrelemek

### SH5 — Trust Receipt Emitter

Hedef:

- scan kaynağı
- finding kanıtı
- memory lookup özeti
- önerilen fix gerekçesi
- risk seviyesi
- approval ihtiyacı

tek makbuzda birleştirilir.

### SH6 — Human-Gated Patch Runner

Hedef:

- yalnız açık izinle patch üretmek
- scope dışına çıkmamak
- öneri ile uygulama arasındaki farkı kayıt altına almak

Bu fazda bile auto-merge yoktur.

### SH7 — Human-Gated Draft PR Writer

Hedef:

- insan onayıyla taslak PR metni üretmek
- trust receipt, test çıktısı ve risk özetini PR açıklamasına taşımak

## Safety Guardrails

- Auto-merge forbidden
- Unknown tools blocked
- Destructive actions blocked
- High-risk changes require approval
- Production memory writes require admission/review
- Canonical graph writes require review
- Evidence and tests are mandatory for meaningful fix proposals

## Memory Core'ta Tutulabilecek Kayıtlar

- `scan_run`
- `finding`
- `false_positive`
- `fix_proposal`
- `fix_outcome`
- `test_outcome`
- `pr_outcome`
- `trust_receipt`
- `pattern_cluster`

Bu kayıtlar en az şu bağlamları taşımalıdır:

- `workspaceId`
- `branch`
- `commit`
- `actor`
- `timestamp`
- `sourceRef`

## Kapsam Dışı

- Self-Healer runtime implementasyonu
- GitHub automation
- marketplace packaging
- cloud sync
- Bug Bounty engine
- autonomous patching
- autonomous merge
- unsupervised LLM rewriting

## Hazır Olma Kriterleri

Self-Healer runtime işine geçmeden önce şu sorular net olmalıdır:

- finding şeması sabit mi?
- memory kayıt modeli belirlendi mi?
- trust receipt alanları yeterli mi?
- approval kapıları tanımlı mı?
- destructive ve unknown action blokları net mi?
- regression test öneri biçimi kararlı mı?

## Sonraki Adım

Bu roadmap sonrası doğru iş, kod yazmak değil; önce SH1/SH2 için dar, güvenlik merkezli sözleşme ve veri modeli tasarımı çıkarmaktır.

Yani sıra:

1. docs-first anayasa
2. contract-first tasarım
3. human-gated uygulama

Self-Healer bundan önce "fix bot" gibi ele alınmayacaktır.
