# HUQAN V1–V5 Checkpoint System

> Models generate. Agents act. Memory stores. **HUQAN judges.**

This document defines the V1–V5 checkpoint system for HUQAN / AXIOM.

The goal is to prevent roadmap drift, premature product claims, fake completeness, and phase jumps without evidence.

Each phase must have:

```
purpose
main question
scope
negative scope
entry checkpoint
close checkpoint
evidence pack
forbidden claims
phase transition rule
```

---

## Current Product Identity

**External brand:**

```
HUQAN
```

**Technical engine / protocol lineage:**

```
AXIOM
```

**Current safe product definition:**

```
HUQAN is a local-first trust, memory, and action judgment layer for AI systems.
It judges claims, contradictions, memory mutations, provenance, and risky actions
before they become trusted or executable.
```

**HUQAN is not:**

```
a chatbot
just RAG
just a memory tool
just a prompt guardrail
an LLM replacement
a truth guarantee engine
```

**Canonical distinction:**

```
Guardrails filter.
Memory tools store.
Causal AI predicts.
HUQAN judges.
```

---

## Global Phase Rules

- No phase can close without evidence.
- No phase can start just because the roadmap says it is next.
- A phase starts only when the previous phase has passed its close checkpoint or the user explicitly opens a limited blueprint-only phase.

### Required Phase Evidence Pack

Each phase must produce:

```
1. Roadmap / ADR
2. Implementation PRs
3. Tests
4. Clean clone smoke when applicable
5. Runtime or UI evidence when applicable
6. Known gaps
7. Forbidden claims review
8. Final checkpoint report
```

---

## V1 — Trust Kernel / Causal Granite

### Purpose

V1 builds the deterministic trust and reasoning kernel.

V1 judges whether a claim, fact, statement, or edge should become trusted knowledge.

### Main Question

```
Is this claim safe to believe?
```

### Scope

V1 includes:

- graph-backed knowledge
- local-first verification
- causal reasoning
- semantic trust gate
- contradiction detection
- provenance tracking
- audit log
- Trust Receipt
- ATP / .axiom package foundation
- reasoning trace
- claim decomposition
- semantic scoring
- type lattice / relation drift checks
- adversarial self-test

### Negative Scope

V1 does not include:

- real-world action governance
- tool execution approval
- full agent runtime
- team governance
- full workbench UI
- ecosystem marketplace
- industry standard claims
- full legal/medical truth engine

### V1 Entry Checkpoint

V1 may start when:

```
[ ] project has a graph / knowledge representation
[ ] verification behavior can be tested
[ ] claims can be learned or queried
[ ] local-first runtime exists
[ ] basic test harness exists
```

### V1 Close Checkpoint

V1 cannot close unless:

```
[ ] weak match cannot become verified truth
[ ] contradiction cases do not return verified
[ ] unknown claims can remain unknown
[ ] provenance can attach to claims
[ ] audit trail exists
[ ] Trust Receipt exists or has a tested primitive
[ ] reasoning trace exists for verifier decisions
[ ] claim decomposition works for compound claims
[ ] semantic scoring separates support / contradiction / risk
[ ] type lattice or equivalent type safety exists for critical cases
[ ] relation drift is detected or safely downgraded
[ ] adversarial verifier tests exist
[ ] clean clone tests pass
[ ] forbidden V1 claims are absent
```

### V1 Evidence Pack

Required evidence:

```
semantic verifier tests
contradiction regression tests
reasoning trace output
claim decomposition output
Trust Receipt sample
provenance sample
audit log sample
clean clone test result
known gaps list
```

### V1 Forbidden Claims

**Do not claim:**

```
HUQAN guarantees truth.
HUQAN eliminates hallucinations.
HUQAN is a full legal truth engine.
HUQAN is a full medical truth engine.
HUQAN replaces LLMs.
HUQAN verifies every possible claim.
```

**Allowed safer language:**

```
HUQAN provides deterministic trust primitives.
HUQAN can detect selected contradictions.
HUQAN can downgrade weak or risky matches.
HUQAN can explain selected verifier decisions with reasoning trace.
```

### V1 Phase Transition Rule

V1 can feed V2 only after claim trust is stable enough that action decisions are not built on fake truth.

If V1 has known verifier gaps, V2 may still proceed only with explicit safety language:

```
Action gate operates on available trust signals and must fail closed when trust is weak.
```

---

## V2 — Action Boundary / Tool Safety Layer

### Purpose

V2 judges whether an agent, tool, automation, or code/action request is safe to perform.

V2 extends HUQAN from claim judgment to action judgment.

### Main Question

```
Is this action safe to perform?
```

### Scope

V2 includes:

- Action Boundary ADR
- Action Risk Classifier
- Tool Call Gate
- Code / Action Gate
- Memory Mutation Gate
- Automation Safety Gate
- Sandbox Isolation Gate
- Agent Brake Layer
- MCP Runtime Integration
- allow / review / dry_run_only / block verdicts

### Negative Scope

V2 does not include:

- full approval runtime
- human-facing workbench
- all connectors governed
- every possible agent framework
- full enterprise control plane
- marketplace
- external ecosystem certification

### V2 Expected Verdicts

```
allow
review
dry_run_only
block
```

### V2 Expected MCP Behavior

Required behavior:

```
axiom.ask      → allow / responds
axiom.verify   → allow / responds
axiom.learn    → review / mutating_requires_review
axiom.agent    → dry_run_only / agent_loop_dry_run_only
unknown tool   → block / unknown-tool-blocked
malformed call → block or fail-closed
null params    → explicit fail-closed response, no crash
```

### V2 Entry Checkpoint

V2 may start when:

```
[ ] V1 trust primitives exist
[ ] tool/action calls can be intercepted
[ ] risk classifier can be tested
[ ] MCP or equivalent tool path exists
[ ] fail-closed behavior can be tested
```

### V2 Close Checkpoint

V2 cannot close unless:

```
[ ] axiom.ask allow/responds
[ ] axiom.verify allow/responds
[ ] axiom.learn review
[ ] axiom.agent dry_run_only
[ ] unknown tools block
[ ] malformed params fail-closed
[ ] null/invalid params do not crash runtime
[ ] action risk classifier has tests
[ ] tool call gate has tests
[ ] memory mutation gate has tests or explicit known gap
[ ] sandbox isolation gate has tests or explicit known gap
[ ] targeted MCP tests pass
[ ] full suite passes from clean clone or unrelated failures are documented
[ ] forbidden V2 claims are absent
```

### V2 Evidence Pack

Required evidence:

```
MCP tool matrix
tool call gate test
unknown tool block test
malformed params test
action classifier test
memory mutation review test
agent dry_run_only test
clean clone test result
known gaps list
```

### V2 Forbidden Claims

**Do not claim:**

```
HUQAN controls all agent execution.
HUQAN is a full inline agent control plane.
HUQAN governs every connector.
HUQAN blocks every unsafe action.
HUQAN is production-ready enterprise agent security.
```

**Allowed safer language:**

```
HUQAN includes tested action gate primitives.
HUQAN supports selected MCP fail-closed paths.
HUQAN can classify selected tool/action risk.
HUQAN can force selected mutating calls into review.
```

### V2 Phase Transition Rule

V2 can feed V3 only when review decisions are real enough to require a workflow.

If review decisions are only labels and not queued, V3 becomes mandatory before "approval runtime" claims.

---

## V3 — Approval Runtime + Memory Admission Gate

### Purpose

V3 turns review-required decisions into a real workflow.

V3 also controls whether new information enters canonical memory.

### Main Question

```
What happens after HUQAN says review required?
```

### Scope

V3 includes:

- pending approval queue
- approve / reject flow
- memory admission gate
- canonical vs candidate memory
- provenance before admission
- audit event for every decision
- Trust Receipt for admission decisions
- connector-to-graph admission
- review decision state transitions

### Negative Scope

V3 does not include:

- full Workbench UI
- marketplace
- external certified ecosystem
- full enterprise governance dashboard
- self-healer loop
- bug bounty engine
- GitHub App viral loop

### V3 Entry Checkpoint

V3 may start when:

```
[ ] V2 can produce review decisions
[ ] mutating calls can be identified
[ ] memory writes can be separated from read-only calls
[ ] provenance model exists
[ ] audit log exists
[ ] Trust Receipt primitive exists
```

### V3 Close Checkpoint

V3 cannot close unless:

```
[ ] review decisions enter a real queue
[ ] approve changes state
[ ] reject changes state
[ ] rejected memory does not enter canonical graph
[ ] accepted memory has provenance
[ ] candidate memory is distinguishable from canonical memory
[ ] audit log records approval/rejection
[ ] Trust Receipt connects to approval/admission
[ ] connector-to-graph admission is covered for known paths
[ ] MCP mutating paths are review-gated
[ ] post-merge clean smoke passes
[ ] forbidden V3 claims are absent
```

### V3 Evidence Pack

Required evidence:

```
pending approval queue sample
approve sample
reject sample
candidate memory sample
canonical memory sample
audit event sample
Trust Receipt sample
connector admission test
MCP mutation review test
clean clone smoke
known gaps list
```

### V3 Forbidden Claims

**Do not claim:**

```
All memory writes are structurally impossible without admission.
All connector data goes through admission.
All write paths are mandatory-gated.
HUQAN is a complete approval runtime.
```

Unless bare `kernel.learn`, connectors, MCP, API, CLI, plugin paths, and upload paths are all proven gated.

**Allowed safer language:**

```
Known write paths are admission-gated.
Selected connector-to-graph paths require admission.
Mutating MCP calls return review envelopes.
Rejected candidate memory does not enter canonical graph.
```

### V3 Phase Transition Rule

V3 can feed V4 only when approval and memory admission are real runtime behavior, not just labels.

If UI is built before V3 closes, it must be explicitly marked as mock/demo and cannot be presented as production workbench.

---

## V4 — Workbench / Trust Runtime

### Purpose

V4 turns HUQAN from a kernel, library, or gate into a human-facing governed trust runtime.

V4 is the productization phase.

### Main Question

```
Can models, tools, memory, and apps work inside one governed trust boundary?
```

### Scope

V4 includes:

- Huqan Workbench
- Trust Runtime
- Approval Workbench
- Trust Dashboard
- Trust Receipt Viewer
- Reasoning Trace Viewer
- Memory / Context Integrity View
- Causal Impact Preview
- Repo Trust Gate
- Local Agent Execution Gate
- model connector model
- tool connector model
- app connector model
- UI rescue / onboarding
- browser smoke

### Negative Scope

V4 does not include:

- industry standard claims
- external certified ecosystem
- marketplace
- full V5 protocol exchange
- unproven connector governance
- mock UI presented as real runtime

### V4 Entry Checkpoint

V4 must not start until:

```
[ ] V1 claim trust is stable
[ ] V2 action gate is stable
[ ] V3 approval/memory admission is stable
[ ] security P0/P1 issues are closed or explicitly accepted
[ ] live product console exists
[ ] no mock UI is presented as real runtime
[ ] Trust Receipt data exists
[ ] reasoning trace data exists
[ ] approval runtime data exists
[ ] memory/admission data exists
```

### V4 Close Checkpoint

V4 cannot close unless:

```
[ ] UI is connected to real kernel behavior
[ ] Trust Receipt Viewer uses real receipts
[ ] Reasoning Trace Viewer uses real traces
[ ] Approval Workbench uses real approval runtime
[ ] Memory View uses real memory/admission state
[ ] Causal Impact Preview uses real causal data or is clearly marked limited
[ ] no fake/mock path is hidden inside product flow
[ ] browser smoke passes
[ ] clean clone tests pass
[ ] forbidden V4 claims are absent
```

### V4 Evidence Pack

Required evidence:

```
Workbench screenshot
Trust Receipt Viewer screenshot
Reasoning Trace Viewer screenshot
Approval Workbench screenshot
Memory View screenshot
browser smoke result
kernel-backed UI proof
mock-path audit
clean clone test result
known gaps list
```

### V4 Forbidden Claims

**Do not claim:**

```
production-ready workbench
full enterprise governance
all connectors governed
complete trust runtime
all tools operate inside HUQAN
```

Unless runtime evidence proves it.

**Allowed safer language:**

```
HUQAN Workbench exposes selected real trust decisions.
Selected receipts, traces, approvals, and memory states are visible.
V4 begins the transition from kernel/gate to governed trust runtime.
```

### V4 Phase Transition Rule

V4 can feed V5 only when at least one real runtime/product surface exists and can show trust artifacts from real behavior.

A static landing page is not enough for V5.

A mock demo is not enough for V5.

---

## V5 — Ecosystem / Shared Trust Network

### Purpose

V5 turns HUQAN trust artifacts into a portable ecosystem layer.

V5 is not just internal productization.

V5 requires external verification, protocol exchange, and conformance.

### Main Question

```
Can different tools, agents, teams, and organizations exchange trust evidence?
```

### Scope

V5 includes:

- HTP / ATP evolution
- Trust Receipt exchange
- .axiom / future package format
- axiom / huqan verify package
- conformance suite
- badge / certified integration
- external tool adapter
- GitHub App / CI gate
- marketplace / plugin model
- A2A trust exchange
- portable trust evidence

### Negative Scope

V5 does not include:

- declaring industry standard without adoption
- claiming certification without conformance
- marketing internal draft as ecosystem protocol
- unverified badge program
- unproven external integrations

### V5 Entry Checkpoint

V5 must not start until:

```
[ ] V4 workbench has real runtime evidence
[ ] Trust Receipt format is stable
[ ] package validation exists
[ ] conformance suite exists
[ ] at least one external/client integration is proven
[ ] docs separate draft/spec/final
[ ] no internal-only artifact is marketed as ecosystem standard
```

### V5 Close Checkpoint

V5 cannot close unless:

```
[ ] external package can be verified
[ ] Trust Receipt can be exported/imported
[ ] conformance tests pass
[ ] at least one external integration uses the protocol
[ ] docs clearly separate draft/spec/final
[ ] ecosystem claims are source-backed
[ ] badge/certification criteria are documented
[ ] forbidden V5 claims are absent
```

### V5 Evidence Pack

Required evidence:

```
protocol spec
package example
Trust Receipt export/import example
conformance test result
external integration proof
badge criteria
docs draft/spec/final distinction
known gaps list
```

### V5 Forbidden Claims

**Do not claim:**

```
industry standard
universal trust protocol
certified ecosystem
widely adopted protocol
marketplace-ready ecosystem
```

Unless adoption and conformance evidence exists.

**Allowed safer language:**

```
draft trust protocol
portable Trust Receipt format
early conformance suite
experimental external adapter
candidate ecosystem layer
```

---

## Final Recommended Roadmap Order

The correct order is:

```
1. Foundation / security hardening
2. Product console / real usage surface
3. V3 approval + memory admission closure
4. V4 Workbench / Trust Runtime
5. V5 ecosystem / protocol / marketplace
```

- Do not jump to V4 before V3 is real.
- Do not jump to V5 before V4 has real runtime evidence.
- Do not market protocol ecosystem before conformance and external integration exist.

---

## Phase Transition Report Template

Every phase transition must include:

```
PHASE:
BRANCH:
BASE HEAD:
HEAD COMMIT:
PRs INCLUDED:
TESTS:
RUNTIME EVIDENCE:
UI EVIDENCE:
TRUST / PROVENANCE / GATE IMPACT:
KNOWN GAPS:
FORBIDDEN CLAIM REVIEW:
NEXT PHASE READY:
VERDICT:
```

Allowed transition verdicts:

```
READY
NOT_READY
BLUEPRINT_ONLY
PARTIAL_WITH_GAPS
BLOCKED
```

---

## Canonical Roadmap Discipline

**HUQAN does not advance by roadmap desire.**
**HUQAN advances by checkpoint evidence.**
