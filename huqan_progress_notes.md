# Huqan — V5 Görev İlerleme Notları

Son güncelleme: 2026-08-18 (bu görev)

## Kullanıcı talimatı (son mesaj)
"Onay beklemeden kalan tüm görevleri tek tek yap" — otonom çalış.

## Bitmiş işler
- #846 Identity Enforcement: %100 docs-first tamamlandı (PR #904, #905 merged, ratchet 13).
- #847 child 4: PR #907 merged (d7fe8a5) — source snapshot wiring. Suite 4441/0.
- Child 5 docs: docs/v5/v5-package-atomicity-contract.md MERGED (#893 ile). §3 wiring kapsamı:
  1. Unit test (throw mid-chain → no event; success → exactly one event),
  2. route guard (200 behind commit, rollback, 5xx PACKAGE_IMPORT_INCOMPLETE),
  3. UNIT_OF_WORK_TYPE = 'v5-package-import' sabiti.
  Forbidden: writer/audit-log/schema değişmez, outbox yok (child 6).

## Şu an: #847 child 5 wiring PR'ını implement ediyorum
Plan: /home/ubuntu/child5_atomicity_plan.md
- Route: lib/http/v5-package-import-route.js (appendAuditEvent([], event) ardından writeJson 200)
- Test: test/v5-package-import-route.test.js (throw-ing mock audit target push, success→1 event, UNIT_OF_WORK_TYPE)
- Sonra: child 6 outbox/replay (docs-first; mevcut dokümanda child 5 unit order'da checked)

## #847 issue durumu (84 /tmp/issue847.md)
- child 1 (#872), 2 (#888), 3 (#892), 4 (#907) tamamlandı.
- Kalan: child 5 (atomicity), child 6 (outbox+replay). Invariants: fail-closed, partial write
  testiyle kanıtlanır, V4 format değişmez, NOT_YET_WIRED graduation gerçek caller gerektirir.
- Absent: transactional outbox, durable V5 audit store, replay tool.

## Diğer açık issue'lar
- #848 (P3 Registry wiring): blocked — A2A_AUTHORITY_FILE production'da yok. Open PR yok.
- #845 (P0-G): deferred (YAGNI). #849 (P4) düşük öncelik. #846 açık ama docs-first %100 tamamlandı.

## Kurallar
YAGNI; tek PR = tek amaç; 800 satır; docs-first; fail-closed; CI yeşil → squash merge --delete-branch.
CI: mergeState CLEAN gerekir; force push yeni CI tetikler. PR merge: gh pr merge N --squash --delete-branch.
Repo: /home/ubuntu/huqan, branch main = origin/main @ d7fe8a5.
