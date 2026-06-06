# Action Taxonomy

> Status: planning / spec only. No runtime implementation in this PR.
> Companion document: `docs/agent-brake-layer.md`.

## 1. Action Category Table

Each action an agent proposes is classified into exactly one of the following categories. The table fixes the default risk and default decision per category. AB1 (Action Risk Classifier) will use this as the seed table.

| Category                  | Description                                                                 | Examples                                                                                                  | Default Risk | Default Decision                  | Notes                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `READ_ONLY`               | Read state without side effects.                                            | `kernel.ask`, `kernel.verify`, `kernel.reason`, `kernel.compare`, `kernel.dream`, file read inside allowlisted root. | `LOW`        | `ALLOW`                           | Path must be verified against allowlist. Reads outside the allowlist escalate to `QUARANTINE` or `HUMAN_REVIEW`. |
| `MEMORY_WRITE`            | Write to a memory store.                                                    | `MemoryStore.store`, `MemoryStore.patchMetadata`, `MemoryStore.linkMemories`.                              | `HIGH`       | `QUARANTINE` or `HUMAN_REVIEW`     | Production memory writes require Memory Core admission (workspace isolation, provenance, schema validation).    |
| `CANONICAL_GRAPH_WRITE`   | Write to canonical graph.                                                   | New claim admission, edge write, supersede, tombstone.                                                     | `HIGH`       | `HUMAN_REVIEW`                     | Must go through trust boundary / provenance gate. Untrusted input must never directly reach canonical graph.   |
| `CODE_CHANGE`             | Modify source code.                                                         | Patch to `lib/`, `kernel.js`, `kernel.v2.js`, plugin sources.                                              | `HIGH`       | `HUMAN_REVIEW`                     | Should open a draft PR, never direct commit to main. AB3 (Code Change Gate) will harden enforcement.            |
| `TEST_CHANGE`             | Modify tests.                                                               | Test addition, mutation, deletion.                                                                        | `HIGH`       | `HUMAN_REVIEW`                     | Security tests (trust policy, risk rules, security gate, sandbox) require extra review.                        |
| `SECURITY_POLICY_CHANGE`  | Modify trust policy, risk rules, or security gate.                          | `lib/trust-policy.js`, `lib/risk-rules.js`, `docs/SECURITY-GATE.md`, sandbox config.                       | `CRITICAL`   | `HUMAN_REVIEW` or `BLOCK`          | Default to `BLOCK` unless explicit human approval is recorded.                                                |
| `DEPLOYMENT`              | Trigger deployment.                                                         | CI/CD pipeline invocation, server restart, container rollout, `git push` to deploy ref.                    | `CRITICAL`   | `BLOCK` by default                 | Auto-deploy is blocked.                                                                                        |
| `PERMISSION_CHANGE`       | Modify agent or user permissions.                                           | Scope expansion, API key grant, capability add, role escalation.                                          | `CRITICAL`   | `BLOCK` by default                 | No self-escalation. Even humans must use a separate audit path.                                                 |
| `FILESYSTEM_WRITE`        | Write files (path-dependent).                                               | Generic `fs.writeFile` to user paths, scratch file creation.                                               | `MEDIUM` / `HIGH` | `QUARANTINE` or `HUMAN_REVIEW` | Inside allowlisted root → `MEDIUM`; outside → `HIGH` and `HUMAN_REVIEW`.                                       |
| `NETWORK_CALL`            | Outbound network request.                                                   | HTTP fetch, webhook call, DNS lookup, SMTP send.                                                           | `MEDIUM` / `HIGH` | `HUMAN_REVIEW` for unknown external | Allowlisted destinations may auto-allow; unknown or first-time destinations require review.                     |
| `TOOL_CHAIN_EXECUTION`    | Multi-step tool call sequence.                                              | Plan-and-execute workflow, agent loop iteration.                                                           | `HIGH`       | `HUMAN_REVIEW`                     | Each step in the chain is re-evaluated. No silent chains.                                                      |
| `SANDBOX_SIMULATION`      | Run code in isolated sandbox.                                               | `node:vm` execution, eval in sandbox, isolated worker.                                                     | `MEDIUM`      | `QUARANTINE`                      | Must not write to a real DB or canonical store.                                                                |
| `PRODUCTION_MUTATION`     | Mutate production state (DB, deployment, canonical).                        | Direct SQL write to prod, prod memory patch, prod config edit, prod environment variable change.           | `CRITICAL`   | `BLOCK` by default                 | Even with admission gate, default is `BLOCK`. Production mutation requires explicit, audited human approval.   |

## 2. Compatibility Map

Mapping existing `toolPolicy.js` concepts to AB0 decision classes. The actual rename happens in **PR-AB2** (Tool Call Gate).

| `toolPolicy.js`               | AB0                                                |
| ----------------------------- | -------------------------------------------------- |
| `action: 'allow'`             | `ALLOW`                                            |
| `action: 'block'`             | `BLOCK`                                            |
| `action: 'review'`            | `HUMAN_REVIEW`                                     |
| `sandbox` (execution mode)    | `QUARANTINE`-like execution mode                   |
| `riskScore` 0-100             | Maps to AB0 risk levels (see §3)                   |
| `category: 'internal'`        | Implicit `ALLOW` for internal tools                |
| `category: 'external'`        | Routed to AB0 classifier                           |
| `INTERNAL_TOOLS` set          | Treated as `READ_ONLY` + `ALLOW`                   |
| `EXTERNAL_BLOCK_PATTERNS`     | Boosts risk to `CRITICAL` and defaults to `BLOCK`  |
| `INJECTION_PATTERNS`          | Boosts risk and forces `HUMAN_REVIEW` or `BLOCK`   |
| `reasons[]`                   | Forwarded to the Trust Receipt                     |

This map is informational. No `toolPolicy.js` change happens in this PR.

## 3. Risk Score Mapping

`toolPolicy.js` returns `riskScore` as a 0-100 number. AB0 uses 4 discrete risk levels. The mapping is fixed:

| Numeric range | AB0 Risk Level |
| ------------- | -------------- |
| 0-24          | `LOW`          |
| 25-49         | `MEDIUM`       |
| 50-74         | `HIGH`         |
| 75-100        | `CRITICAL`     |

The mapping is deterministic and applied in **PR-AB2**.

## 4. Default Policy

- **Unknown action category** → default `HUMAN_REVIEW` (fail-safe). The classifier never silently allows an action it does not recognize.
- **Unknown high-impact write** (filesystem, network, memory) → default `QUARANTINE` or `BLOCK`.
- **Production / deployment / security-policy actions** → default `BLOCK` or `HUMAN_REVIEW`.
- **Determinism:** the classifier must be a pure function. Same action input + same context → same decision. No time-of-day, no randomness, no hidden state.
- **No execution:** the brake layer only returns a decision. It must not execute actions itself. Execution is the responsibility of the caller, after the decision is in hand.
- **Receipts:** every `BLOCK`, `QUARANTINE`, or `HUMAN_REVIEW` decision produces a Trust Receipt containing: action, category, risk level, decision, reason, timestamp.

## 5. Out of Scope

This PR is spec-only. The following are explicitly out of scope:

- Runtime implementation of the classifier
- Tool call interception hooks
- Memory admission implementation changes
- Code patching hooks
- Deploy system integration
- MCP integration
- New HTTP API endpoints
- New CLI commands
- New UI surfaces
- New package, new version, new tag

Future PRs (AB1 through AB6) will introduce these incrementally, each with its own `docs/SECURITY-GATE.md` pass and tests.
