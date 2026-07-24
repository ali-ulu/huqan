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

### AC-5: Implementation
- TBD — Lead Engineer.

---

## 3. Test Requirements

- targeted contract tests
- plugin tests
- Kernel/PluginManager tests
- full test suite
- benchmark regression
- security checks