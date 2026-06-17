# HUQAN — Demo Showcase

> **Think Without Hallucinating**
> A deterministic causal reasoning engine that verifies claims — no LLM, no GPU, no cloud.
> Same input → same output. Every time. $0 per query forever.

This folder contains static demo artifacts you can inspect without running anything. They are documentation, not runtime storage.

---

## What's in this folder

| File | What it is | Size |
|------|------------|------|
| `demo-graph-sample.json` | A 27-node / 29-edge subset of the actual Turkish knowledge graph produced by `node egitim.js` (5 seconds, full graph = 141 nodes / 86 edges). | 9 KB |
| `demo-verify-results.json` | Four real `verify()` outputs (dogrulandi / celiski / bilinmiyor) with confidence scores and evidence trails. | 1.5 KB |
| `demo-causal-result.json` | The canonical "what-if" causal simulation: *what breaks if `autoLearn` defaults to true?* — risk level critical, recommendation "Change is not recommended." | 1.7 KB |
| `demo-screenshot-dashboard.png` | Full-page screenshot of the local web dashboard (`public/index.html`). | 255 KB |
| `demo-screenshot-graph.png` | The D3 force-directed graph view of the live knowledge graph. | 115 KB |
| `demo-screenshot-verify-contradiction.png` | The "Judge" tab in action — `verify: kedi bitkidir` → contradicted (celiski) with full evidence. | 253 KB |
| `demo-screenshot-v2-status.png` | The `/v2-status` dashboard showing 11 version phases, 82% complete, current focus: v3.0 Agent Workflow. | 160 KB |

---

## The 60-second pitch

**Problem:** LLMs hallucinate. In regulated industries — healthcare, finance, legal, engineering — a confident wrong answer is dangerous and expensive. Existing guardrails use another LLM to check the first LLM. Fire fighting fire.

**Solution:** HUQAN takes a different approach — **deterministic verification**.

- Same input → same output. Every time.
- No probability, no guessing, no hallucination.
- No LLM, no GPU, no cloud, no API keys.
- $0 per query, forever.

**Academic grounding:**
- **Kahneman** — LLM = System 1 (fast, intuitive, sometimes wrong); HUQAN `verify()` = System 2 (slow, deliberate, correct)
- **Pearl** — Causal reasoning with `CAUSES`, `PREVENTS`, `ENABLES`, `DEPENDS_ON`, `LEADS_TO` relations
- **Marcus** — Neuro-symbolic AI: symbolic graph + LLM adapter
- **LeCun** — World models via `dream.js` hypothesis generation

---

## Reproduce in 5 seconds

```bash
git clone https://github.com/agiulucom42-del/axiom.git
cd axiom
npm ci --include=optional          # ~1 second, zero runtime deps
node egitim.js                      # ~5 seconds, loads 77 Turkish facts
node server.js                      # opens http://localhost:3000
```

Then try in the dashboard:
- `verify: kedi hayvandir` → **dogrulandi** (verified, confidence 0.90)
- `verify: kedi bitkidir` → **celiski** (contradicted, confidence 0.95)
- `verify: mars ucagini tastir` → **bilinmiyor** (unknown, confidence 0 — refuses to guess)

Or via HTTP:
```bash
curl -X POST http://localhost:3000/v2/verify \
  -H "X-API-Key: $AXIOM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"statement":"kedi bitkidir"}'
```

---

## What the screenshots show

### 1. Dashboard (`demo-screenshot-dashboard.png`)
The local developer UI at `http://localhost:3000`. Five tabs:
- **Fikrini Yargılat** (Judge) — verify any claim
- **Şeytan'ın Avukatı** (Devil's Advocate) — strongest counterargument
- **Geçmiş Çelişkiler** (Past Contradictions) — detected conflicts
- **Hafıza / Graph** (Memory) — D3 visualization of the knowledge graph
- **Güven** (Trust) — Trust Receipt explorer

### 2. Graph view (`demo-screenshot-graph.png`)
D3 force-directed visualization of the live graph. Each node is a Turkish concept; each edge is a typed relation (`tür`, `yapabilir`, `özellik`, `benzer`, `CAUSES`, `PREVENTS`, etc.). Edge color = relation type, edge width = confidence.

### 3. Verify contradiction (`demo-screenshot-verify-contradiction.png`)
Input: `verify: kedi bitkidir`
Output: `celiski` (contradicted), confidence 0.95, with full evidence trail showing the type-lattice conflict (`kedi --[tür]--> hayvan` contradicts the claim that kedi is plant, because `hayvan` and `bitki` are disjoint types).

This is HUQAN's killer feature: **it refuses to be wrong**. Instead of guessing, it surfaces the contradiction with deterministic evidence.

### 4. v2-status dashboard (`demo-screenshot-v2-status.png`)
The `/v2-status` endpoint visualized. Shows:
- 11 version phases (v2.0 through v3.0)
- 9 done, 2 in progress (v2.3 CLI/REST runtime, v3.0 Agent Workflow)
- 82% complete
- Active kernel: v1, Backend: sqlite, 158 nodes, 94 edges

---

## The Causal Demo (`demo-causal-result.json`)

The canonical what-if simulation. Question: *"autoLearn default true olursa ne bozulur?"* (What breaks if autoLearn defaults to true?)

HUQAN traces the causal chain:
```
autoLearn default true
  ──CAUSES──▶ unsupported LLM output can enter graph
  ──CAUSES──▶ graph trust degradation
  ──CAUSES──▶ Shield claim weakens
  ──PREVENTS──▶ AXIOM reliability promise is damaged
```

Verdict:
- **Risk level:** critical
- **Recommendation:** Change is not recommended.
- **Confidence:** 0.84
- **Next questions:** "Bu riski azaltmak için hangi alternatifler var?", "İnsan onayı veya ek kanıt gerekiyor mu?"

This is not a probabilistic forecast. It's a **deterministic consequence trace** through a causal graph — same input, same output, every time.

---

## Competitive positioning

| Feature | HUQAN | LLM-only | Guardrails AI |
|---------|-------|----------|---------------|
| Deterministic answers | ✅ Always | ❌ Never | ⚠️ Partial |
| Contradiction detection | ✅ Built-in | ❌ No | ⚠️ Heuristic |
| Runs fully offline | ✅ Yes | ❌ Needs API | ❌ Needs API |
| GPU required | ❌ No | ✅ Yes | ❌ No |
| Cost per query | **$0** | $/query | $/query |
| Explainable reasoning | ✅ Full trace | ❌ Black box | ⚠️ Limited |
| Causal chains | ✅ CAUSES, PREVENTS, ENABLES… | ❌ No | ❌ No |
| Provenance / Audit | ✅ Append-only | ❌ No | ❌ No |

---

## Public messaging rules (what we can and cannot say)

**Allowed:**
- "local-first partial trust layer"
- "deterministic judgment"
- "claims, receipts, and gates"
- "trusted only when proven"

**NOT allowed:**
- "guarantees truth"
- "eliminates hallucinations"
- "fully autonomous agent control plane"
- "production-grade enterprise governance"
- "full NLP engine"

---

## License

Apache License 2.0 — same as the main repository.

## Disclaimer

These demo artifacts are static snapshots generated on 2026-06-17 from a fresh clone. They are **documentation**, not runtime storage. The full graph regenerates in ~5 seconds on any machine via `node egitim.js`.
