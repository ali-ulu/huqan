# Competitive positioning

## Position

HUQAN is a **local-first trust, evidence, and verification layer** for AI-mediated work. It connects claims, memory writes, and risky actions to evidence, provenance, workspace scope, policy, approval, and auditable Trust Receipts on its tested local paths.

HUQAN is not another LLM, a chat application, or a generic orchestration shell. Its core graph, verification, gate, provenance, approval, audit, and receipt paths do not require a hosted model or cloud service. That is a product boundary, not a claim that every optional integration or deployment mode is cloud-independent.

> **Short version:** Models generate. Agents act. Memory stores. **HUQAN judges.**

## What HUQAN is good at today

HUQAN is a good fit when the central question is not only “what did the model say?” but also “what evidence supports this claim, which workspace applies, what changed later, and why was this action allowed, blocked, or escalated?” The current repository supports the following bounded capabilities:

- deterministic verification, contradiction checks, and risk classification;
- provenance-aware claims, graph evidence, memory admission, and workspace-scoped reads;
- explicit review, approval, block, escalation, and dry-run boundaries for guarded actions;
- append-oriented audit records, canonical Trust Receipts, and receipt chains;
- an agent-brand-independent external pre-execution contract with bounded
  Claude Code, Codex, OpenCode, Pi, Hermes, and generic adapter projections;
- local CLI, REST, MCP, and UI surfaces on the supported paths; and
- two repository-run conformance suites: `npm run conformance:external` (75 cases) and `npm run conformance:a2a` (50 adversarial cases).

These are repository-backed capabilities, not a universal governance or interoperability certification. The external guard enforces only calls that a client hook, wrapper, gateway, or sandbox sends through it before execution; an unconnected agent remains outside HUQAN's control. The [README Current scope](../README.md#current-scope) remains the source of truth for what is real, deployment-gated, or explicitly not claimed.

## Named alternatives: choose by the problem you need to solve

This is a **focus comparison**, not a claim that any alternative lacks features outside its primary documentation. The relevant question is which boundary should own the problem in a given system.

| Alternative | Primary documented focus | Choose it first when you need | HUQAN’s different center of gravity |
|---|---|---|---|
| [NVIDIA NeMo Guardrails][1] | An open-source Python package for programmable guardrails around LLM applications. It intercepts inputs and outputs, applies configurable safety checks, and supports guardrail configuration, evaluation, logging, observability, and deployment options. | Programmable interaction and content guardrails around an LLM application, including configurable safety, topic, PII, jailbreak, or agentic-security controls. | HUQAN’s primary artifact is an evidence-bound judgment and receipt across claims, memory, scope, policy, approval, and risky actions. NeMo can be the better fit when the problem is guardrailed inference rather than a local trust ledger for decisions. |
| [LangChain Guardrails and human-in-the-loop middleware][2] | Middleware that validates or filters content at agent execution points. The documentation describes deterministic and model-based guardrails, PII handling, custom before/after hooks, and human approval for sensitive tools. | A LangChain agent needs middleware checks, output filtering, PII handling, or a pause/resume approval step around selected tool calls. | HUQAN’s center is not a middleware hook. It is the durable, auditable relationship between evidence, provenance, workspace scope, approval state, risk, and the resulting Trust Receipt. |
| [Docker MCP Gateway][3] | A centralized proxy for MCP servers that manages configuration, credentials, access control, lifecycle, routing, and authentication. It can run MCP servers in isolated Docker containers with restricted privileges, network access, resource usage, logging, and call tracing. | MCP server lifecycle, container isolation, centralized routing, credentials, and operational control are the primary concern. | HUQAN can govern and record supported MCP decisions, approvals, provenance, and receipts, but it does not claim to replace a container runtime, a fleet gateway, or deployment-level isolation. |
| [DeepEval][4] | An LLM evaluation framework organized around test cases, metrics, and evaluation datasets. It supports end-to-end and component-level evaluation, local runs, and CI/CD-oriented test execution; a cloud account is optional for shared reports. | You need dataset-based quality measurement, metric scores, regression evaluation, or CI evaluation of an LLM application, retriever, tool, or agent trajectory. | HUQAN’s conformance and verification paths are evidence for its own bounded trust boundary; they are not a general replacement for an LLM evaluation platform or a claim that HUQAN’s outputs are universally correct. |

### The practical distinction

The alternatives above are complementary boundaries rather than mutually exclusive products. A system may use DeepEval to measure answer quality, NeMo or LangChain middleware to filter or pause execution, Docker MCP Gateway to operate MCP servers, and HUQAN to preserve evidence, scope, policy, approval, and receipt context for decisions that cross a trust boundary.

HUQAN should therefore be evaluated on whether a decision can be **reconstructed and challenged**: which evidence was used, which provenance and workspace scope applied, what policy and risk gate ran, whether approval was required, and which immutable receipt records the outcome. It should not be evaluated as a promise of perfect model quality, universal container isolation, or third-party protocol interoperability.

## When not to use HUQAN

Do not choose HUQAN as the primary tool when the requirement is outside its tested and documented boundary. In particular:

- Choose an LLM evaluation framework when the main deliverable is broad model-quality scoring, benchmark datasets, or experiment dashboards rather than evidence-bound action and memory decisions.
- Choose a guardrails or agent-middleware framework when the main requirement is input/output filtering, PII transformation, jailbreak or topic controls, or a framework-native pause/resume hook.
- Choose an MCP gateway or container platform when the main requirement is server lifecycle, credential injection, network restriction, fleet routing, or process/container isolation.
- Do not choose HUQAN on the assumption that it provides a hosted multi-tenant control plane, universal IAM, a public agent marketplace, or a completed shared-trust ecosystem. Those are not current claims.
- Do not choose HUQAN for Wikipedia-scale or enterprise-scale graph performance without a dedicated benchmark for the target workload. The repository’s measured scale language is local-first, small-to-medium graph tested, with larger-scale support requiring dedicated benchmarking.
- Do not choose HUQAN as proof that an external party has interoperated with its A2A transport. The repository conformance suites are self-run repository checks and do not establish third-party interoperability.

## Evidence and claim discipline

HUQAN’s public positioning should remain tied to repository evidence:

| Claim category | Safe statement | Boundary |
|---|---|---|
| Local operation | The core local graph, verification, gate, and receipt paths do not require a hosted model or cloud service. | Optional integrations and deployment modes may have their own requirements. |
| Verification | HUQAN provides deterministic verification, contradiction, provenance, scope, policy, approval, audit, and receipt primitives on tested paths. | This does not mean that every claim is true or every connector is uniformly enforced. |
| Conformance | The repository provides a 75-case external suite and a 50-case adversarial A2A suite that can be run from the repository. | Self-run conformance is not third-party verification or external interoperability proof. |
| Graph scale | Current public language is small-to-medium graph tested; larger-scale support requires dedicated benchmarking. | Wikipedia-scale, million-node, and enterprise-scale claims are not established. |
| Product maturity | HUQAN is a local-first partial trust layer with bounded memory and action gates. | It is not a finished autonomous self-healer, public certification network, or universal governance suite. |
| External agent guard | `huqan-gate` applies one policy envelope and receipt contract to current adapters and future generic clients. | Native or wrapper pre-execution wiring must be proven per client; it is not OS-level universal interception. |

For implementation details, see the [scale truth pack](scale-truth-pack.md), the [product positioning guide](product-positioning.md), and the [README Current scope](../README.md#current-scope). Claims about deployed, external, or third-party behavior require evidence from that specific environment rather than documentation intent.

## Public language

Prefer:

- `local-first trust, evidence, and verification layer`;
- `deterministic judgment on tested paths`;
- `claims, provenance, scope, policy, approvals, and Trust Receipts`; and
- `trusted only when proven and recorded`.

Avoid:

- `guarantees truth`;
- `fully autonomous`;
- `enterprise-grade governance` unless the specific capability is proven;
- `Wikipedia-scale graph`; and
- `third-party interoperability proven` without an external implementation and recorded evidence.

[1]: https://docs.nvidia.com/nemo/guardrails/home "NVIDIA NeMo Guardrails Library Developer Guide"
[2]: https://docs.langchain.com/oss/python/langchain/guardrails "LangChain Guardrails documentation"
[3]: https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/ "Docker MCP Gateway documentation"
[4]: https://deepeval.com/docs/evaluation-introduction "DeepEval Introduction to LLM Evals"
