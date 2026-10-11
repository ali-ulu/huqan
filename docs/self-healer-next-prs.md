# Self-Healer Next PRs

> Historical implementation split.
>
> This document is not an independent phase authority. Active phase numbering
> is defined by `docs/v0.9.2-self-healer-roadmap.md`.
>
> The SH5-SH11 labels below are preserved only as historical planning labels.

Bu belge, contract pack sonrası implementasyonun küçük ve güvenli PR'lara nasıl bölüneceğini tanımlar.

## Prensip

## Canonical Phase Mapping

| Historical label in this file | Canonical phase | Current status |
| --- | --- | --- |
| SH5 - Minimal `scan_run` / `finding` schema helpers | SH-1 - Finding Schema | IMPLEMENTED |
| SH6 - Read-only repo scanner dry run | SH-2 - Audit-Only Report Helper | IMPLEMENTED |
| SH7 - Memory lookup read-only integration | SH-7 - Memory / Audit Integration | PLANNED |
| SH8 - Fix planner dry-run only | SH-4 - Fix Proposal Generator | PLANNED |
| SH9 - Regression test planner | SH-4 - Fix Proposal Generator | PLANNED |
| SH10 - Trust receipt emitter | SH-7 - Memory / Audit Integration | PLANNED |
| SH11 - Human-gated draft PR writer | SH-6 - Draft PR Mode | PLANNED |

Contract pack tek PR olabilir. Runtime ise küçük PR'larla gelmelidir.

## Planlanan Sonraki PR'lar

### SH5 — Minimal `scan_run` / `finding` schema helpers

Amaç:

- contract alanlarını doğrulayan küçük helper'lar
- runtime mutasyon değil, yalnız schema enforcement başlangıcı

### SH6 — Read-only repo scanner dry run

Amaç:

- yalnız read-only tarama
- finding üretimi
- kod patch veya PR yok

### SH7 — Memory lookup read-only integration

Amaç:

- finding için geçmiş kayıt taraması
- accepted/rejected pattern özetleri
- write yok, sadece read-only lookup

### SH8 — Fix planner dry-run only

Amaç:

- fix strategy önerileri
- approval ve policy sınırları
- patch uygulama yok

### SH9 — Regression test planner

Amaç:

- önerilen regression test kayıtları
- test command ve coverage niyeti

### SH10 — Trust receipt emitter

Amaç:

- karar özeti
- evidence özeti
- risk özeti
- approval ihtiyacı

### SH11 — Human-gated draft PR writer

Amaç:

- yalnız açık izinle draft PR metni üretmek
- otomatik merge veya otomatik publish olmadan ilerlemek

## Sabit Kısıtlar

- auto-fix yok
- auto-merge yok
- destructive cleanup yok
- unknown tool blocked
- human review zorunlu

## Sonuç

Bu plan sayesinde büyük ve dağınık Self-Healer runtime PR'ları yerine küçük, denetlenebilir ve policy-aligned PR akışı korunur.
