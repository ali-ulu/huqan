# ADR-006: Self-Healer Loop

> Status: Superseded
>
> Superseded by: `docs/ADR-007-self-healer-loop.md`
>
> Historical design record only.
>
> Not authoritative for current phase numbering, contract shape, or
> implementation status.

## Durum

Superseded by `ADR-007`. Historical record only.

## Bağlam

Tek seferlik tarayıcılar ve anlık bug avı çıktıları yeterli değildir. AXIOM artık:

- `V3.1 runtime + live Codex MCP certified`
- `Memory Core M0-M7 main içinde`
- `Memory Core readiness PASS`

durumuna ulaştığı için, tekrar eden mühendislik problemlerini hafızaya dayalı olarak izleyebilecek daha güvenli bir geri besleme döngüsü tanımlanmalıdır.

Self-Healer bundan sonra "hemen kod yazan otonom ajan" olarak değil, Memory Core üzerine oturan kontrollü bir mühendislik yardımcısı olarak tasarlanmalıdır.

## Problem

One-shot scanner modeli şu eksikleri bırakır:

- Aynı bulgu farklı branch veya commitlerde tekrar görüldüğünde geçmiş bilgi kullanılamaz.
- False positive geçmişi tutulmazsa ajan aynı gereksiz önerileri tekrar eder.
- Kabul edilen ve reddedilen fix desenleri öğrenilemez.
- Test sonuçları, PR sonuçları ve trust receipt zinciri aynı yerde toplanmaz.
- Workspace, branch ve commit bağlamı kaybolursa öneriler güvenilmez hale gelir.

## Neden Önce Memory Core

Self-Healer güvenli çalışmak için şunları hatırlamak zorundadır:

- previous scans
- detected bugs
- false positives
- accepted fixes
- rejected fixes
- test outcomes
- PR outcomes
- recurring failure patterns
- workspace / branch / commit context
- trust receipts

Bu nedenle Self-Healer, Memory Core hazır olmadan başlatılmamalıydı. Bu önkoşul artık sağlanmıştır.

## Karar

AXIOM için ilk Self-Healer sürümü docs-first ve safety-first yaklaşımıyla tanımlanacaktır.

Self-Healer döngüsü şu şekilde olacaktır:

1. `scan`
   Repo, test, smoke veya belirli hedef yüzey taranır.
2. `classify finding`
   Bulgu tipi, risk seviyesi, tekrar olasılığı ve etki alanı belirlenir.
3. `check memory for similar findings`
   Memory Core içinde benzer bug, benzer fix, benzer test sonucu ve önceki kararlar aranır.
4. `propose fix`
   Sadece öneri üretilir; doğrudan uygulama zorunlu değildir.
5. `generate regression test suggestion`
   Bulguyu kalıcı olarak kilitleyecek test önerisi oluşturulur.
6. `run tests if explicitly allowed`
   Test çalıştırma ancak açık izinle yapılır.
7. `produce Trust Receipt`
   Önerinin dayanağı, risk seviyesi, hangi kanıta dayandığı ve hangi sınırlar içinde üretildiği kayıt altına alınır.
8. `create draft PR if explicitly allowed`
   Ancak açık izinle taslak PR hazırlanır.
9. `wait for human review`
   Nihai karar insandadır.

## Sert Güvenlik Kuralları

- AXIOM judges, human decides.
- Auto-merge yasaktır.
- Production memory write için admission/review gerekir.
- Canonical graph admission review gerektirir.
- High-risk change açık approval ister.
- Destructive action blocked olmalıdır.
- Unknown tool blocked olmalıdır.
- Her fix önerisi evidence ve test gerekçesi taşımalıdır.
- Self-Healer, insan onayı olmadan kanonik gerçeği güncellemez.
- Memory Core geçmişi, kanıt zinciri olmadan "başarı hikayesi" olarak yeniden yazılamaz.

## Başlangıç Modülleri

İlk aşamada yalnız kavramsal olarak tanımlanırlar:

- `repo-scanner`
- `bug-classifier`
- `fix-planner`
- `regression-test-planner`
- `patch-runner`
- `trust-receipt-emitter`
- `draft-pr-writer`
- `memory-feedback-loop`

Bu modüllerin hiçbiri bu ADR ile implement edilmez.

## Memory Core ile İlişki

Self-Healer, Memory Core'u şu tür kayıtlar için kullanacaktır:

- scan session record
- finding record
- false-positive record
- accepted-fix record
- rejected-fix record
- regression-test proposal
- test-run outcome
- PR outcome
- trust receipt summary

Bu kayıtların tamamı workspace, branch, commit, actor ve zaman bağlamı ile ilişkilendirilmelidir.

## İnsan Onayı Gerektiren Sınırlar

Şu aksiyonlar varsayılan olarak insan onaylı olmalıdır:

- runtime code patch
- canonical graph write
- production memory mutation
- PR creation
- destructive cleanup
- release/tag/deploy benzeri hareketler

## Kapsam Dışı

- GitHub App
- marketplace
- enterprise dashboard
- autonomous merge
- cloud sync
- full Bug Bounty engine
- LLM-driven unsupervised rewriting
- doğrudan otomatik fix execution
- otomatik memory mutation

## Sonuçlar

Bu ADR ile Self-Healer için şu sınır çizilir:

- önce hafıza destekli muhakeme,
- sonra kanıta dayalı öneri,
- en sonda insan onaylı uygulama.

Yani Self-Healer bir "otonom coder" değil, güvenlik kapıları olan memory-backed engineering loop olarak konumlanır.
