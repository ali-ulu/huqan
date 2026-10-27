# HUQAN

**Stops an AI agent's risky action before it runs — and lets reads and the commands your policy allows straight through.**

HUQAN sits on the execution path of shell, git, infrastructure and memory-write calls. A force-push, a `terraform apply` or a `kubectl delete` is blocked or held for a person *before* state changes; a `git status` or a `cat` goes straight through. That boundary is what lets you give an agent more room instead of less.

Every decision is recorded as a verifiable Trust Receipt — the evidence behind the block, not a substitute for it.

**Every decision is made on your machine. No model. No cloud. No API key.**

## What it stops, what it lets through

Default `claude-code` gate profile, no custom policy:

| Agent runs | HUQAN |
|---|---|
| `git status`, `git diff`, `cat`, `ls`, `rg` | passes, no prompt |
| `npm test`, `terraform plan`, `kubectl get`, `rm -rf build` | held for review — unknown commands never pass silently |
| `git push --force`, `terraform apply`, `kubectl delete` | blocked |

Held-by-default is deliberate, and it is also the noise you will feel first. Allow your routine commands once in `external-action-policy.json` (`{ "allowedCommands": ["npm test", "terraform plan"] }`) so review is spent only where the blast radius is real — see [shell command categories](./docs/external-action-guard.md).

## Why

Agents can write code, delete files, spend money, and change memory — usually running as *your* user. HUQAN sits between the agent and that power:

- Risky calls are **blocked or held before they execute**, not explained afterwards.
- With the Approval Authority — an OS service (a Windows service today, systemd on Linux or launchd on macOS, [ADR-020](./docs/adr/ADR-020-posix-authority-parity.md)) guarded by TOTP and cryptographic envelopes — the agent cannot approve its own actions.
- Every decision produces a **Trust Receipt** — a local record you can verify from the receipt itself.

## Who it is for

**Individual and community — your agent's emergency brake.** HUQAN holds a mutating call until a person approves it, and `huqan.emergency_stop` stops one agent or a whole workspace. This is the [Agent Brake Layer](./docs/demo-mcp-agent-brake-layer.md).

**Team and enterprise — an audit record the operator does not write.** A Trust Receipt is produced by the gate that made the decision, held locally, and verifiable from the receipt itself, so the record of an action is not the agent's own account of it. Where "independent" is claimed, read the boundary under [Limits](#limits-honest).

## Try it in 30 seconds

```bash
npx -y huqan quickstart
```

A 30-second tour: propose → approve → verify → Trust Receipt. No global install is required; the run uses a throwaway store. The same flow runs in the browser at [huqan.com](https://huqan.com). What to run when: [product surfaces](./docs/product-surfaces.md).

## Install

```bash
npm install -g huqan    # Node.js 22.13.0 or newer
```

Seven binaries: `huqan` (CLI), `huqan-mcp` (MCP server), `huqan-gate` (pre-execution guard), `huqan-authority` (approval authority, ADR-016), plus the experiment CLIs `huqan-cognitive-lab`, `huqan-causal-lab` and `huqan-neural-lab`.

## Connect your agent

**MCP (Claude, Cursor, any MCP client):**

```json
{
  "mcpServers": {
    "huqan": {
      "command": "npx",
      "args": ["-y", "--package=huqan", "huqan-mcp"]
    }
  }
}
```

**Gate (pre-execution guard for other agents):**

```bash
npx -y --package=huqan huqan-gate install --profile claude-code
```

Profiles: `claude-code`, `codex`, `openhands`, `opencode`, `pi`, `hermes`.

Operator tools (`huqan.approve`, `huqan.approvals`, `huqan.approval_detail`, `huqan.agent_resume`, `huqan.emergency_stop`) are hidden from the model and require `HUQAN_MCP_OPERATOR_TOKEN` — an agent cannot approve its own proposal.

The gate only governs actions when the client calls it before execution.

## How it works

```text
evidence + provenance + workspace scope
        → verification, contradiction, risk
                → policy + human approval
                        → outcome + Trust Receipt
```

The outcome is one of:

ALLOW / REVIEW / QUARANTINE / DRY-RUN ONLY / BLOCK / REJECT

Escalation and overrides are human decisions, recorded in the receipt. **Escalation is a decision a person makes, not one the gate returns**: a reviewer can move a pending case to `escalated`, which needs a second approver, so it is absent in a single-user install. Decision types: `approve`, `reject`, `expire`, `cancel`, `escalate`, `override` — see [`lib/human-oversight-approval-runtime.js`](./lib/human-oversight-approval-runtime.js).

## Limits (honest)

- HUQAN does **not** eliminate hallucinations. It makes one claim **inspectable and blockable** before it becomes state.
- Only what is wired is governed. An agent that never calls HUQAN is not covered.
- The OS boundary needs the Approval Authority, and it holds only where the service is actually installed and answers. The installers exist for Windows (a service), Linux (systemd) and macOS (launchd) — the Linux and macOS installers live in this repo and are exercised end-to-end in a CI job that is **not** a required release gate. Windows installs are the most field-tested; Linux and macOS ship the same design but with less mileage. Containers, VMs and remote hosts are **not** supported. Code running as your user can still edit runtime files or the local store; the authority's ledger makes that detectable, not impossible. UAC is not a security boundary ([ADR-016 residual risks](./docs/adr/ADR-016-approval-authority-os-boundary.md#residual-risks); [ADR-020](./docs/adr/ADR-020-posix-authority-parity.md), [ADR-021](./docs/adr/ADR-021-container-support-model.md)).
- Complements IAM, infrastructure security and human governance — it replaces none of them.
- "Independent" is a bounded word. An issuer signature ([`lib/receipt/issuer-seal.js`](./lib/receipt/issuer-seal.js)) proves a receipt's origin and integrity, not operator honesty: whoever holds the issuing key can edit the trail, re-sign it, and ship a clean history where every signature verifies. Independence needs a collector counter-seal ([`lib/receipt/collector-seal.js`](./lib/receipt/collector-seal.js)) signed with a key the audited host does not have, held by a party the operator does not administer; both keys on one machine means one person holds both ends, and the seal then detects accidental corruption and nothing more.
- The conformance suites are **self-run** in this repository, not third-party verification; no third-party attestation is bound into a bundle yet. See the [interoperability and attestation boundary](./docs/audits/third-party-interoperability-attestation-boundary-3069.md).

Full details and edge cases: [docs](./docs).

## License

- **Core — [Apache-2.0](./LICENSE).** The gate, CLI, MCP server, Approval Authority (including RBAC and N-of-M approval) and Trust Receipts. Free for any use, including commercial.
- **Enterprise — [HUQAN Enterprise License](./LICENSE-ENTERPRISE).** SSO (`lib/oidc/`, `lib/saml/`), SIEM export (`lib/siem/`) and the SOC 2-mapped evidence pack (`lib/evidence-pack/`). Free to develop, test and evaluate; production use needs a subscription — contact Ali Ulu, `aliulu@ai-ulu.com`.

Versions up to `1.1.1` were published under AGPL-3.0-only and stay available under it. Record and contribution terms: [`docs/legal/dual-licensing-status.md`](./docs/legal/dual-licensing-status.md).

---

**Confidence is not truth. Verify before you trust.**
