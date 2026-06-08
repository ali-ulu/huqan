# Show HN: Huqan — Deterministic AI reasoning with an agent safety brake

## Title candidates

1. **Show HN: Huqan – Deterministic reasoning engine that blocks AI from hallucinating**
2. **Show HN: Huqan – An AI that can't hallucinate, with a safety brake for agents**
3. **Show HN: Huqan – Deterministic causal reasoning + 6-layer safety brake for MCP agents**
4. **Show HN: Huqan – What if AI never guessed? Deterministic reasoning with agent safety**
5. **Show HN: Huqan – I built an AI that doesn't need to guess, and a brake layer to keep it safe**

**Recommended: #4 or #5** — they tell a story and hook curiosity.

---

## Post body

Hey HN,

I've been working on something that started as a frustration: every time I use an LLM, I have to second-guess it. "Did it make that up? Is that actually true?"

So I built [Huqan](https://github.com/agiulucom42-del/axiom) — a deterministic causal reasoning engine. No LLM, no GPU, no API key. Runs fully local on your machine.

**How it works:**

- You teach it facts ("cats are animals", "animals need oxygen")
- You ask it questions ("do cats need oxygen?")
- It traces causal chains deterministically and returns an answer with full evidence trail
- If evidence is missing → it says so. If there's a contradiction → it rejects and explains why.
- No probability. No black box. $0/query. Forever.

**The interesting part — the Agent Brake Layer:**

As I started connecting Huqan to LLMs as a verification layer via MCP, I realized something: giving an AI agent write access to a knowledge graph is dangerous. What if it teaches itself wrong things?

So I built a 6-layer safety brake (AB1–AB6) that sits between the AI agent and Huqan's internals:

- Every tool call gets classified by risk level
- Mutating tools (like "learn") require human approval
- Unknown tools are blocked by default
- The agent loop runs in dry-run-only mode during alpha
- All gate decisions are deterministic and auditable

The result: an AI can *read* from Huqan freely, but it can never *write* without you saying yes.

**What works today:**
- Deterministic causal reasoning engine (Turkish + English)
- Contradiction detection with evidence trails
- MCP server with Agent Brake Layer (private alpha)
- 1226 passing tests, 0 failures, 16 skipped
- Runs locally, no cloud dependency

**What's not done:**
- English UI polish (CLI is Turkish-first)
- Public API / hosted version
- Distributed trust layer
- The Dream/Hypothesis Engine (planned for V3)

**Tech:** Node.js, in-memory causal graph, no external dependencies. ~55 test files, ~275 lines in the gate adapter alone.

I'm looking for:
- Feedback on the architecture (is the 6-layer brake overkill? underkill?)
- People who'd want to try the MCP private alpha
- Thoughts on whether this is useful as an LLM verification layer vs. standalone

GitHub: https://github.com/agiulucom42-del/axiom

Happy to answer any questions.

---

## Comment prep (anticipate HN reactions)

**"How is this different from a database?"**
A database stores data. Huqan reasons over it — it traces causal chains, detects contradictions, and returns structured evidence trails. You ask "why does X happen?" and it walks the graph step by step.

**"Why Turkish first?"**
I'm based in Turkey. The engine is language-agnostic internally — the knowledge base just happens to be Turkish. English support is straightforward.

**"6 safety layers seems like overkill for an alpha"**
Fair point. They're cascading — each gate is fast (microseconds) and only the relevant ones fire for a given tool. The overkill is intentional: it's easier to remove gates that prove unnecessary than to add them after something goes wrong.

**"What about scaling?"**
It's in-memory right now. For alpha/demos this is fine. Persistent storage and distributed trust are on the roadmap but not the priority — correctness first, scale second.
