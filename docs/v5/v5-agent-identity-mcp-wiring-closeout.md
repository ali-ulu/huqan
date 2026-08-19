# Runtime Agent Identity — MCP approval ingress wiring closeout

**Status:** implemented production-shaped opt-in slice  
**Issue:** [#940](https://github.com/ali-ulu/huqan/issues/940)  
**Runtime:** Node.js / CommonJS  
**Durability authority:** existing `Graph.runMutationOnce()` and approval/receipt path  
**Migration mode:** explicit opt-in  
**Fail-closed:** yes  
**Second signer / receipt family / durability authority:** none

## Scope

This closeout records the MCP approval-ingress slice of Runtime Agent Identity. The slice composes the receiver-owned identity claim and evaluates the action before the existing Human Oversight executor is allowed to invoke `kernel.learn`. It does not replace the Human Oversight runtime, the Agent Action Firewall, the approval store, the Graph journal, or the existing receipt family.

The wiring is active only when the host supplies both the existing opt-in Human Oversight runtime for a marked MCP approval and an explicit `agentIdentityRuntime` configuration. Existing MCP callers without that option retain their previous behavior. A malformed explicitly supplied identity configuration is not silently converted into an anonymous or default principal; the bounded identity adapter returns a refusal and the approval path returns `IDENTITY_ENFORCEMENT_BLOCKED`.

## Implemented contract

| Boundary | Implementation | Security property |
|---|---|---|
| Runtime option propagation | `mcpServer.js::createServer` passes an explicit `agentIdentityRuntime` option into the MCP call runtime | Opt-in migration boundary remains explicit; omitted option is inert |
| Receiver-owned claim | `lib/mcp-human-oversight-adapter.js::evaluateMcpAgentIdentity` calls `composeReceiverOwnedIdentityClaim` with host-supplied authority, identity reference and receiver binding | Request-body identity fields are not authoritative |
| Action binding | The MCP oversight action supplies receiver-reconstructed `target` and canonical tool name; host config supplies capability, risk tier and connector scope | Identity evaluation is bound to the approved action rather than an arbitrary payload claim |
| Evaluation order | Identity composition/evaluation runs after durable oversight-case lookup and before the approval executor | Refusal occurs before `kernel.learn`, approval claim, or execution finalization |
| Bounded evidence | `identityEvidence` exposes version, decision, bounded reason, evaluation time, identity reference/hash, workspace, owner actor, trust/risk tiers and delegation digest/scope | No raw claim object, token or unrestricted requester input is returned |
| Existing durability | Approval execution continues through the existing claim, executor, receipt finalization and Graph journal path | No second SQLite table, signer, receipt family or durability authority |

## Decision and refusal surface

For an approved Human Oversight case, a valid receiver-owned identity produces `data.identity` with `decision: "allow"`. The surface contains only bounded non-secret identity and authority references. When composition or evaluation refuses, the action returns `error.code: "IDENTITY_ENFORCEMENT_BLOCKED"`, a bounded `meta.identity` evidence object, `retrySafe: false`, and the approval remains pending because no executor or approval finalization is performed.

The identity evaluator reuses the existing Agent Identity Runtime reason vocabulary, including workspace mismatch, unknown identity, malformed authority/claim and evaluation failure reasons. The MCP adapter adds only the ingress-level transport code `IDENTITY_ENFORCEMENT_BLOCKED`; it does not introduce a second identity state vocabulary.

## Verification

| Test | Result |
|---|---:|
| Valid receiver-owned identity allows MCP approval execution | passed |
| Receiver/owner mismatch blocks before executor and leaves approval pending | passed |
| `createServer` propagates the opt-in identity runtime into async approval execution | passed |
| Existing MCP Human Oversight production wiring regression | 3/3 passed |
| New MCP identity wiring regression | 3/3 passed |
| `git diff --check` | passed |

The repository-wide `env -u GIT_CONFIG_COUNT node --test` run remains non-zero for the previously known `agent-context.test.js` remote-baseline synchronization conflict and for repository document-contract checks observing intentionally untracked research/issue markdown files. Those failures are not caused by the MCP identity source/test diff. The slice-level identity and oversight tests are green, and the inherited targeted regression checkpoint remains 45/45 before this new three-test slice.

## Non-claims

This closeout claims only the MCP approval ingress path described above. It does not claim global identity enforcement across HTTP, workflow, CLI/classic, MCP ingest, or every other MCP tool. It does not claim external GitHub, cloud, database, deployment or connector permissions; the MCP identity runtime verifies Huqan’s receiver-owned authority and configured connector/action scope only. It does not claim a general IAM provider, credential issuance, approval UI, universal A2A identity exchange, or legal/regulatory compliance.

The existing Human Oversight and Trust Evidence Ledger production boundaries remain as previously documented. Identity evidence is projected into the bounded MCP approval response and is not smuggled into the existing receipt family or used to create a parallel trust root.

## Files in this slice

| File | Change |
|---|---|
| `mcpServer.js` | Added explicit identity-runtime option propagation and pre-executor approval evaluation |
| `lib/mcp-human-oversight-adapter.js` | Added receiver-owned MCP identity composition/evaluation and bounded evidence projection |
| `test/mcp-agent-identity-production-wiring.test.js` | Added valid, mismatch, and server-option propagation coverage |

