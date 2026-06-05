# PR-ER2C Write-side Anchoring Plan

## 1. Amaç ve Kapsam

Bu plan, entity-resolution canonical sonuçlarının gelecekteki `learn`, `companyBrain` ve `ingest` akışlarında yazma tarafına nasıl bağlanacağını tanımlar.

Bu PR yalnızca plan dokümanıdır. Runtime kod, test, API, CLI, MCP, migration, H-score, embedding, LLM ve domain-risk mekanizmaları kapsam dışıdır.

## 2. Kapalı Durum

Şu kapalı PR'lar referans kabul edilir:

- PR-ER1: entity-resolution core
- PR-ER2: integration plan
- PR-ER2A: verify read-only probe
- PR-ER2B: canonical lookup fallback

Bu plan, ER hattının yazma tarafına geçmeden önce karar çerçevesini sabitler.

## 3. Write-side Anchoring Problem Statement

Read-side canonical lookup, verify sırasında mevcut graph evidence bulduğunda canonical lookup yapabilir.
Write-side anchoring ise, yeni knowledge girişlerinde literal label ile canonical entity id arasındaki ilişkinin nasıl kayıt altına alınacağını belirler.

Yanlış yazma stratejisi graph identity'yi kirletebilir, provenance'ı bozabilir ve ambiguous alias'ları sahte canonical node'lara dönüştürebilir.

## 4. Aday Write Paths

Potansiyel entegrasyon yüzeyleri:

- `kernel.learn`
- `companyBrain`
- `ingest` pipeline
- repo-memory / markdown / GitHub ingestion

Bu yüzeyler farklı domain ve workspace bağlamları taşıyabilir. Write-side anchoring bu bağlam olmadan uygulanmamalıdır.

## 5. Canonical Anchor Policy

Temel kararlar:

- Original literal label asla silinmez.
- Canonical entity id, literal label'a ek metadata olarak bağlanır.
- Canonical anchor, provenance ile birlikte yazılır.
- Workspace / domain context canonical seçimde zorunlu referanstır.
- Canonical anchor, truth verification yerine identity resolution çıktısı olarak kaydedilir.

Önerilen yazım modeli:

- literal label korunur
- canonical entity id metadata/anchor field olarak eklenir
- gerekiyorsa alias edge veya normalized lookup field kullanılır

## 6. Ambiguity Policy

Kurallar:

- Ambiguous alias canonical olarak yazılmaz.
- Ambiguous alias için canonical tahmin yapılmaz.
- Ambiguous alias durumunda uyarı üretilir, örn. `AMBIGUOUS_ALIAS`.
- Belirsiz durumda literal-only davranış korunur.

## 7. Unknown Alias Policy

Unknown alias için:

- yeni synthetic canonical node açılmaz
- literal label korunur
- canonical write yapılmaz
- verify veya learn akışı unknown alias'ı kendiliğinden canonical saymaz

## 8. Provenance ve Audit Policy

Canonical anchor yazılırken:

- original input görünür kalır
- resolved canonical id ayrıca kayıt altına alınır
- provenance hem literal hem canonical bilgiyi taşır
- audit, input label ile resolved canonical id'yi birlikte göstermelidir
- Trust Receipt original label'ı maskelememelidir

## 9. Migration Policy

İlk code PR için:

- mevcut graph migration yok
- yalnızca yeni yazımlar için davranış eklenir
- geçmiş veriler geriye dönük rewrite edilmez

## 10. Feature Flag ve Rollout

Yazma tarafı değişiklikleri varsayılan olarak kapalı olmalı ya da açık bir option ile etkinleştirilmelidir.

Rollout önerisi:

- workspace scoped
- domain scoped
- incremental enablement

## 11. Gelecek Code PR Şekli

Önerilen ayrım:

- ER2C-A: companyBrain-only write-side anchor
- ER2C-B: ingest alignment
- ER2C-C: provenance/search alignment gerekiyorsa ek adım

## 12. Test Stratejisi

Gelecekteki code PR'larda beklenen testler:

- `B737` yazımı original `B737`'yi korur, canonical `boeing_737` metadata olarak eklenir
- `Boeing 737` ve `B737` duplicate canonical anchor üretmez
- `AI` domain olmadan canonicalize edilmez
- `AI` aviation/tech/design domaini ile domain-scoped canonical yazılır
- original literal receipt/audit/provenance içinde görünür kalır
- graph migration oluşmaz
- H-score / embedding davranışı görünmez

## 13. Out of Scope

Bu PR and bu plan için kapsam dışı:

- H-score / Evidence Ranking
- Memory H-score
- Huqan Hazard/Hallucination H-score
- LLM memory plugin
- Plugin capability isolation
- storage/index/performance refactor
- temporal/contextual truth
- high-risk domain admission gate
- yeni API / CLI / MCP yüzeyi
- Self-Healer

## 14. Riskler

Başlıca riskler:

- false canonical collapse
- domain leakage
- provenance kaybı
- duplicate anchors
- backward compatibility kırılması
- tenant / workspace contamination

## 15. Acceptance Criteria

Bu plan kabul edilebilir sayılırsa:

- write-side anchoring için sınırlar nettir
- ambiguous alias yazma engeli açıktır
- original literal korunumu nettir
- migration yoktur
- runtime kod ve test eklenmemiştir
