# HUQAN — Threat Model

## Strategic Threat Landscape

This document defines the primary security threats to HUQAN, categorized using the STRIDE model (Spoofing, Tampering, Information disclosure, Denial of service, Elevation of privilege) with a focus on AI/ML runtime, memory, trust, and governance surfaces.

**Mitigation status vocabulary.** Each control below is labelled against the code it claims:

- **Implemented** — a module, gate, or check that exists and is wired into a production path.
- **Partial** — a real control that covers less than the claim implies (a narrower surface, a different mechanism, or a default that leaves a gap).
- **Planned** — described as intent, not present in the code.

A control that could not be traced to code is listed under **Planned** or **Not implemented**, never under **Existing Mitigations**. This keeps "green test" from reading as "shipped control".

---

## Spoofing

### Trust Content Spoofing

**Description**: An attacker creates malicious factual claims in the HUQAN knowledge base that appear legitimate, leveraging crafted prompts or falsifying attribution sources.

**Impact**: Propagation of false information through the system, damaging downstream reasoning.

**Existing Mitigations**:
- **Implemented** — Trust gate requires explicit approval for external content ingestion (`lib/ingest-approval.js`, `lib/mcp-approval-learn-execution.js`).
- **Partial** — Input validation for known content structure (`lib/pre-ingest.js`, snapshot/`strictString` normalization in `lib/ingest-values.js`); it validates shape and size, not factual plausibility.
- **Partial** — The action risk classifier (`lib/risk-classify.js`) rates an action by risk signals and a source-provenance check (`AGENT_ORIGIN_PROVENANCE_REQUIRED` in `lib/mcp-approval-learn-execution.js`); it does not score a claim by *source reputation*, which does not exist as a code path.

**Remaining Gaps**:
- Adversarial prompt engineering can bypass content reputation checks.
- Lack of provenance-based reputation weighting for novel claims.

**Planned Mitigation**:
- Implement source reputation scoring based on cross-validation with external knowledge sources.
- Enhance training data sanitization against poisoning.

---

### Identity Spoofing

**Description**: Compromise of internal tool identities (e.g., `huqan.ask`, `huqan.learn`) to execute privileged actions.

**Impact**: Unauthorized execution of internal tools, potential system compromise.

**Existing Mitigations**:
- **Implemented** — Hard-coded internal tool list with tools trusted by default if in the internal set (`INTERNAL_TOOLS` in `toolPolicy.js`; `lib/mcp-tool-policy.js` reconciles the MCP view with `lib/mcp-gate-adapter.js`).
- **Implemented** — API key-based authentication for REST endpoints (`requestGuards.js` `requireApiKey`; bearer `HUQAN_API_KEY`/`API_KEY`).

**Remaining Gaps**:
- Lack of per-tool token validation for internal tools.
- No periodic internal tool credential rotation.

**Planned Mitigation**:
- Implement internal tool verification through signed tokens with expiration.
- Add audit logging for internal tool invocation.

---

## Tampering

### Memory Content Tampering

**Description**: Modify existing factual records in the HUQAN knowledge base to spread misinformation or inject malicious content.

**Impact**: System integrity compromised, downstream reasoning corrupted.

**Existing Mitigations**:
- **Implemented** — SHA256 content hashing (`lib/content-hash.js`, `lib/ingest-values.js`) and signed receipt chains for approved modifications (`lib/receipt/receipt-chain.js`, `lib/receipt/signed-bundle.js`). Signatures bind a *decision receipt*, not each memory record.
- **Partial** — The memory mutation gate (`lib/memory-mutation-gate/`) classifies each mutation and derives a review/allow decision, and `lib/memory-admission-gate.js` records a provenance source; there is no source-trust *check* in the mutation path, so "checks request origin and source trust" overstates it.
- **Implemented** — Workspace isolation prevents cross-workspace tampering (`lib/cross-workspace-access-gate.js`, wired as AB11 in `lib/external-action-guard-gate-phase.js`).

**Remaining Gaps**:
- Weak consensus for record validation.
- Limited proof-of-work for content modifications.

**Planned Mitigation**:
- Implement append-only ledger for critical content changes.
- Add multi-signature approval for content modifications from multiple trusted sources.

### Governance Tampering

**Description**: Unauthorized modification of HUQAN policies (e.g., tool policy and action risk classification).

**Impact**: Policy bypass, privilege escalation, tool misuse.

**Existing Mitigations**:
- **Not implemented** — Code signing for critical policy files: policy is plain JSON (`config/trust-policy.default.json`) read and validated for shape, not cryptographically signed. Rollback/tamper defence rests on git and the deployment environment, not on a signing step in the code.
- **Planned** — Access control for deployment infrastructure is an operator/environment responsibility. The repository adds no deployment-infrastructure access control of its own beyond the API-key and RBAC surfaces documented elsewhere.

**Remaining Gaps**:
- Lack of formal policy version control.
- Manual deployment increases risk of unauthorized changes.

**Planned Mitigation**:
- GitOps for policy deployment with automated validation.
- Policy versioning to rollback suspicious changes.

---

## Information Disclosure

### Agent State Disclosure

**Description**: Leakage of internal agent state (memory, reasoning chains, tool usage patterns) to external entities.

**Impact**: Exposure of proprietary algorithms, sensitive content, and user interactions.

**Existing Mitigations**:
- **Implemented** — AB6 sandbox isolation policy classification (`lib/sandbox-isolation.js` and its classifier/containment modules); no production MCP sandbox executor is currently wired, so the classification does not yet confine a live process.
- **Partial** — Limited metadata logging (`lib/external-action-receipt.js` records bounded metadata such as `outcomeReceiptId`; there is no general agent-state trace log).
- **Implemented** — Internal tools output filtering for sensitive content: the secret scrub gate (AB7, `lib/secret-scrub-gate.js`) redacts secret-looking values before they are persisted or logged.

**Remaining Gaps**:
- Limited visibility into exported agent state via `huqan.agent`.
- Trace data may contain sensitive user information.

**Planned Mitigation**:
- Implement data redaction for exported traces.
- Add fine-grained access controls for trace export.

### Knowledge Base Exposure

**Description**: Unauthorized access to the HUQAN knowledge base or queries revealing internal knowledge.

**Impact**: Privacy violations, competitive advantage loss.

**Existing Mitigations**:
- **Implemented** — REST API authentication and authorization (`requestGuards.js` API-key auth; `lib/observability/authorization.js` role→permission RBAC: viewer/operator/admin).
- **Partial** — Workspace isolation applies to queries (`lib/claim-read.js`, `lib/provenance-query.js` scope reads by `workspaceId`). There is no consent mechanism in the query path; the consent flag that exists (`lib/browser-hook-outcome.js`) governs page-preview content, not knowledge-base querying, so pairing it with "querying" overstates it.

**Remaining Gaps**:
- Lack of audit logs for knowledge base access.
- No differential privacy for query results.

**Planned Mitigation**:
- Implement audit trails for all knowledge base accesses.
- Add query result obfuscation for high-sensitivity data.

---

## Denial of Service

### Memory Exhaustion Attack

**Description**: Repeated ingestion of large content blocks to exhaust memory resources.

**Impact**: Service unavailability, denial of legitimate service.

**Existing Mitigations**:
- **Implemented** — Content size limits on HTTP bodies (`readJsonBody`'s `DEFAULT_MAX_UPLOAD_BODY` = 1 MiB in `requestGuards-body.js`, used by `server.js` and the ingest routes) and on external source snapshots (`MAX_EXTERNAL_SNAPSHOT_BYTES` = 2 MiB, `lib/ingest-values.js`).
- **Implemented** — Rate limiting on API endpoints (`requestGuards-rate-limit.js` for REST; `lib/observability/rate-limiter.js` for observability routes; `lib/http/viewer-mount.js` for the viewer).

**Remaining Gaps**:
- No circuit breaker for rate-limited scenarios.
- Memory leak potentials in long-running queries.

**Planned Mitigation**:
- Implement circuit breakers for API calls and ingestion.
- Add memory monitoring with automated cleanup.

### Network Flood Attack

**Description**: Flooding the HUQAN REST API with requests to exhaust resources.

**Impact**: Service degradation, denial of legitimate service.

**Existing Mitigations**:
- **Implemented** — Rate limiting on REST endpoints (`requestGuards-rate-limit.js`).
- **Partial** — A `/health` endpoint exists for health checks (`lib/http/core-http-routes.js`, public by design in `lib/http/route-auth-policy.js`), and `lib/runtime-watchdog.js` can poll a health URL. The load balancer itself is deployment infrastructure, not part of this repository.

**Remaining Gaps**:
- Lack of intelligent rate limiting based on heuristics.
- No distributed denial-of-service (DDoS) protection.

**Planned Mitigation**:
- Implement intelligent rate limiting based on usage patterns.
- Add DDoS protection via cloud provider WAF (if deployed in cloud).

---

## Elevation of Privilege

### Tool Privilege Escalation

**Description**: Unauthorized elevation of tool privileges through configuration manipulation.

**Impact**: Unauthorized access to high-privilege tools and capabilities.

**Existing Mitigations**:
- **Partial** — Tool privilege is expressed as a hard-coded internal/external split with per-tool decisions (`INTERNAL_TOOLS` in `toolPolicy.js`; `classifyMcpTool` in `lib/mcp-gate-adapter.js`), and `lib/identity-privilege-escalation.js` (AB) detects escalation attempts. There is no numeric per-tool privilege level, so "hard-coded privilege levels" reads stronger than the code.
- **Partial** — Role-based access control exists for the observability API (`lib/observability/authorization.js`: viewer/operator/admin over read/stream/queue:write/alerts:write). External-action tools are gated by risk/policy decisions, not by these roles, so "RBAC for external tools" is not what the code implements.

**Remaining Gaps**:
- Lack of dynamic privilege validation during runtime.
- Insufficient audit trails for privilege changes.

**Planned Mitigation**:
- Implement role-based access control (RBAC) with audit logging.
- Add dynamic privilege validation using policy decision points.

### Plugin Code Execution

**Description**: `plugin.js` loads plugins with `require(filePath)`, so a plugin executes as ordinary in-process Node code with the full privileges of the host process — `fs`, `child_process`, `net`, `https`, `process.env`, and direct kernel internals. Manifest hashing and HMAC signing verify that a plugin file is *authentic and unmodified*; they place no restriction on what it *does*. An attacker who can write to the plugins directory, or who gets a malicious plugin approved and signed, obtains arbitrary code execution on the host and can bypass every trust mechanism in this document from inside the process.

**Impact**: Full host compromise: secret exfiltration, arbitrary graph writes without admission, audit and provenance bypass, action-gate bypass.

**Existing Mitigations**:
- **Implemented** — Manifest `sha256` verification detects modification of a plugin file after its manifest was written (`plugin.js: verifyPluginFile`).
- **Implemented** — HMAC signature verification under `HUQAN_PLUGIN_SIGNING_KEY` binds an approved hash to a deployment key (`lib/plugin-verification.js`).
- **Implemented** — Production enforcement (`HUQAN_PLUGIN_PRODUCTION_ENFORCEMENT=1` / `NODE_ENV=production`) refuses to load anything without a signing key, and `PluginManager.register()` rejects registration without verified provenance (`PLUGIN_UNVERIFIED_REGISTRATION`, `lib/plugin-manager-register.js`).
- **Implemented** — The plugins directory is a deployment-controlled path; write access to it is treated as equivalent to code execution.

**Remaining Gaps**:
- **No runtime confinement of any kind.** Signed ≠ sandboxed: a verified plugin may call any Node module. This is a documented, accepted property of the current design, not an oversight — see `docs/core-plugin-boundary-contract.md`, "Enforcement Boundary: Signed Is Not Sandboxed".
- An attacker with filesystem write access rewrites the plugin and its adjacent manifest together, defeating hash-only verification.
- No declared capability surface, so plugin privilege cannot be reviewed without reading the source.
- Node's `vm` module is not a security boundary and is deliberately **not** used here; a `vm`-based loader would imply confinement the runtime cannot deliver.

**Planned Mitigation**:
- Add a `permissions` manifest field declaring the modules a plugin may `require()`, enforced at load time — defense-in-depth and an audit aid, explicitly **not** a sandbox.
- Evaluate a real isolation boundary (separate process with dropped privileges, container, or WASM isolate with an explicit host-call surface) if third-party or untrusted plugins ever become a supported scenario.

---

### Memory Trust Level Escalation

**Description**: Escalation of memory trust levels through exploitation of trust algorithm vulnerabilities.

**Impact**: Bypassing trust gates, executing unauthorized actions.

**Existing Mitigations**:
- **Implemented** — Score-based trust evaluation for memory content (`lib/trust-score-aggregator.js`; admission/scoring in `lib/memory-admission-gate.js` and `lib/semantic-score.js`).
- **Not implemented** — Trusted sources list for new content: sources are resolved and recorded (`provenanceSource` in `lib/memory-admission-gate-request.js`), but there is no maintained allowlist by which a source is trusted, so this control does not exist as claimed.

**Remaining Gaps**:
- Attackers can manipulate trust scores through adversarial examples.
- No continuous monitoring of trust source reputation.

**Planned Mitigation**:
- Implement reputation-based trust scoring.
- Add anomaly detection for sudden trust level changes.

---

## Strategic Outlook

### Future Threat Landscape

The HUQAN ecosystem will face evolving threats as it scales:

- **AI Model Poisoning**: Compromise of internal reasoning models through adversarial training data.
- **Supply Chain Attacks**: Compromise of dependencies (packages, runtime components).
- **Model Extraction**: Unauthorized extraction of proprietary models and algorithms.
- **Cross-Workspace Cross-Contamination**: Escape of trust boundaries between isolated workspaces.
- **API Key Theft**: Exposure of authentication keys for internal and external tools.

### Safe Positioning

#### Risk Mitigation Philosophy

1. **Least Privilege Execution**: External tool requests are classified and blocked or queued for review; no production sandbox executor is currently claimed.
2. **Defense in Depth**: Multiple layers of security controls (network, sandbox, trust gates, audit).
3. **Continuous Validation**: Ongoing monitoring and validation of security controls.
4. **Fail Secure**: Default deny for unknown tools, explicit allow for known tools.

#### Constraints

1. **Productivity**: Security controls should not impede legitimate user workflows.
2. **Scalability**: Security controls should scale with the number of tools and users.
3. **User Experience**: Security controls should be transparent and easy to understand.

### Validation

The security controls will be validated through:

1. **Automated Testing**: Comprehensive test suite covering security scenarios.
2. **Manual Testing**: Manual testing of security controls to identify gaps.
3. **Third-Party Assessment**: Independent security audit by qualified third-party security firms.

### Response

Security incidents will be responded to according to the following process:

1. **Detection**: Automatic detection of security incidents through monitoring and alerts.
2. **Containment**: Immediate containment of security incidents to prevent spread.
3. **Recovery**: Restoration of normal operations after security incidents.
4. **Post-incident Investigation**: Investigation of root causes and implementation of corrective actions.

### Security Commitment

**We commit to:**

- Maintain a robust security program that evolves with emerging threats.
- Be transparent about security issues and our response processes.
- Engage with the security community to improve the security of the HUQAN ecosystem.

**We will not:**

- Guarantee zero security risk.
- Promise protection against all possible attacks.
- Disclose vulnerabilities before patches are available.

By using HUQAN, you acknowledge and accept these security commitments.
