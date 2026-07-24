# REFACTOR-4D: Plugin Boundary Contract Acceptance Criteria

> **Gate:** REFACTOR-4D_IMPLEMENTATION_CONTRACT_ACCEPTANCE
> **Durum:** Draft acceptance criteria
> **Canonical main SHA:** `740760799edfd268dc9af4000ebc727663d69ad1`
> **Branch:** `refactor/4d-1-contract-acceptance`
> **Source reality:** `docs/refactor/refactor-4d-plugin-boundary-source-reality.md`

---

## 1. Plugin Boundary Contract Objectives

1. PluginManager kayıt akışı ve hook sözleşmesini test edilebilir şekilde sabitle.
2. Kernel→Plugin ve Plugin→Kernel arayüzü için public/private sınırı netleştir.
3. Required/optional capability davranışını fail-open/fail-closed matrix'te açıkça testle.
4. Private `_` alan ve `_nodes` erişimini minimum güvenli public seam'e çek.
5. Manifest/runtime metadata kopukluğunu belgele ve uyumluluğu koru.

---

## 2. Acceptance Criteria

### AC-1: EVENTS registry correctness
- EVENTS listesi, canonical source ile birebir aynıdır.
- Değişiklik yok.

### AC-2: Hook emission behavior
- `emit()` fail-open davranışı ve `emitStrict()` pipeline davranışı korunur.
- hooks: afterLearn + afterAsk kullanılıyor.

### AC-3: Plugin registration boundary
- required capability eksikse registration throw eder.
- optional capability eksikse warn üretir, registration devam eder.
- production enforcement aktifken manifest yoksa throw eder.

### AC-4: Capability checks
- `hasCapability()` public API üzerinden kontrol edilir.
- plugin içi capability çağrıları `kernel.hasCapability()` ile yapılır.

### AC-5: Hook scope protection
- afterVerify ve beforeVerify eklenmez.
- 4D kapsamında yeni hook tanımlanmaz.

### AC-6: Private access migration
- Her private erişim migration’u tek sınırlı consumer per PR yapılır.
- En küçük public seam sadece mevcut public API yetersizse eklenir.
- Parity testleri gözlemlenebilir davranışın değişmediğini kanıtlar.
- Toplu migration yasaktır.

### AC-7: Manifest/runtime compatibility
- Mevcut SHA-only manifest uyumluluğu korunur.
- Legacy inline runtime metadata uyumluluğu korunur.
- Shared-key imzalı manifest doğrulama kapsamda kalır.
- Yeni manifest platformu veya permission sistemi eklenmez.

### AC-8: Plugin compatibility
- 10 PluginManager-managed plugin load/register uyumluluğu korunur.
- llm-memory afterAsk/afterLearn davranışı uyumlu kalır.
- sandboxRunner PluginManager kapsamı dışında kalır.

### AC-9: Scope protection
- afterVerify/beforeVerify eklenmez.
- 4E1, 4E2, 4E3, 4E4 işleri yapılmaz.
- Dependency, package, release veya ilişkisiz refactor değişikliği girilmez.

---

## 3. Gate Completion

REFACTOR-4D_PLUGIN_BOUNDARY_CONTRACT_TESTS yalnızca şu şartlar sağlanınca GREEN olur:

- Her acceptance kriteri bir veya daha fazla adlandırılmış test tarafından kapsanır.
- Hedefli contract testler geçer.
- Tam test suite geçer.
- Security Checks başarılıdır.
- Benchmark Regression başarılıdır.
- Compatibility inventory’de açıklanamaz regresyon yoktur.

---


</parameter>
<parameter3_name>content</parameter3_name>

- targeted contract tests
- plugin tests
- Kernel/PluginManager tests
- full test suite
- benchmark regression
- security checks