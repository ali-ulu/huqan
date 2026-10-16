# ADR-001: Causal Reasoning Engine

## Status
Proposed

## Context
AXIOM şu an "Bilgi Modeli" (Knowledge Model) olarak çalışıyor:
- "X, Y'dir" (deklaratif ilişkiler)
- Tutarlılık denetimi
- Çelişki tespiti

Bu yapı AXIOM'u güçlü bir "doğrulama katmanı" yapıyor ama "öngörü yeteneği" eksik. AXIOM'un "Dünya Modeli"ne (World Model) geçişi için nedensellik (causality) katmanı gerekiyor.

## Problem
1. AXIOM sadece "nedir" sorusunu cevaplayabiliyor, "neden olur" sorusunu cevaplayamıyor
2. "What-if" simülasyon yeteneği yok
3. Kararların olası sonuçlarını öngöremiyor
4. Nedensel zincirleri (causal chains) analiz edemiyor

## Decision
v0.7'de Causal Reasoning Engine ekleniyor:

### 1. Causal Relation Types
5 temel nedensel ilişki tipi:
- `CAUSES` - Neden olur
- `PREVENTS` - Engelleyen
- `ENABLES` - Mümkün kılan
- `DEPENDS_ON` - Bağımlı olduğu
- `LEADS_TO` - Sonuçlanan

### 2. Causal Edge Schema
```javascript
{
  from: "node_id",
  relation: "CAUSES",
  to: "node_id",
  strength: 0.8,        // 0-1 arası güç
  confidence: 0.72,     // 0-1 arası güven
  evidence: ["source1", "source2"],
  sourceType: "design_decision|observation|inference"
}
```

### 3. Deterministic Causal Traversal
- Forward chaining: X olursa → Y → Z
- Backward chaining: Y olmak için → X gerekli
- Causal loop detection
- Risk assessment

### 4. What-If Simulator
```javascript
kernel.simulateChange({
  action: "set_autoLearn_true",
  graph: currentGraph
})
// → {
//   outcomes: [...],
//   risks: [...],
//   confidence: 0.85,
//   causalChains: [...]
// }
```

### 5. Causal Finalizer Output
Causal analiz sonuçlarını yapılandırılmış çıktı formatında sunma.

## Consequences

### Positive
- AXIOM "doğrulama aracı" → "öngörü aracı" dönüşür
- Karar analizi yeteneği kazanır
- "What-if" senaryoları simüle edilebilir
- OpenAI/Anthropic için "Guardrail" → "Co-pilot" dönüşümü mümkün olur

### Negative
- Graph complexity artar
- Performans overhead'i olabilir
- Causal relation'ların kalitesi kritik (garbage in, garbage out)

### Risks
- Yanlış causal relation'lar yanlış öngörülere yol açabilir
- Causal loop'lar sonsuz döngüye neden olabilir
- Confidence hesaplaması karmaşıklaşabilir

## Implementation Plan
1. PR-1: Causal relation schema implementasyonu
2. PR-2: Deterministic causal traversal
3. PR-3: What-if simulator
4. PR-4: Causal finalizer output
5. PR-5: Demo scenario (autoLearn true olursa ne bozulur?)

## Success Criteria
- 5 causal relation tipi çalışıyor
- Basit what-if simülasyonu çalışıyor
- "autoLearn true olursa ne bozulur?" demo'su çalışıyor
- Causal chain traversal deterministik
- Test coverage %80+

## Alternatives Considered
- Full probabilistic causal inference (çok karmaşık, v0.8'e ertelendi)
- Temporal causal reasoning (temporal tamamlanmadan ertelendi)
- Machine learning-based causal discovery (çok erken)

## References
- ROADMAP.md v0.7 section
- SPEC_TODO.md temporal metadata
- Pearl, Judea. "Causality" (2009)
