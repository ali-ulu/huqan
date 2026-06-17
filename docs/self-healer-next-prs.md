# Self-Healer Next PRs

Bu belge, contract pack sonrası implementasyonun küçük ve güvenli PR'lara nasıl bölüneceğini tanımlar.

## Prensip

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
