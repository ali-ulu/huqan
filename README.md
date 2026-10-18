# HUQAN

**A local trust boundary that separates the agent from the operator.**

Most tools make agents stronger.  
With the Approval Authority installed, HUQAN puts an OS boundary between the agent and the power to approve.

Agents can now write code, delete files, spend money, and change memory.  
Without a proper trust layer, that power runs as the same user as you.

On Windows, the Approval Authority moves approval into a separate service protected by TOTP and cryptographic decision envelopes.  
The decision is held by that service's own account, not by your user: an agent running as you cannot sign an approval, though it may still share your user identity with the operator.

Every decision is recorded as a Trust Receipt.

No model. No cloud. No API key required for the core gate.

[![npm](https://img.shields.io/npm/v/huqan?logo=npm&color=cb3837)](https://www.npmjs.com/package/huqan)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13.0-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-AGPL--3.0-22c55e.svg)](./LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/ali-ulu/huqan/badge)](https://scorecard.dev/viewer/?uri=github.com/ali-ulu/huqan)

## Try it in 30 seconds

```console
$ npx -y huqan quickstart
HUQAN quickstart — learn -> review -> approve -> verify -> Trust Receipt
  1. OK   propose: huqan.learn -> review (mutating_requires_review), approval approval-…
  2. OK   approve: huqan.approve -> approved (actor cli-quickstart)
  3. OK   verify: verified (confidence 0.90)
  4. OK   receipt: receiptId … (status canonical)
```

The write in line 1 **did not happen**. It was held until line 2 approved it. The quickstart uses a throwaway store.

No install needed: the same flow runs in the browser at [huqan.com](https://huqan.com). What to run when: [product surfaces](./docs/product-surfaces.md).

## Connect your agent in one line

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

Profiles: `claude-code`, `codex`, `openhands`, `opencode`, `pi`, `hermes`. The gate enforces only when the client calls it before executing. [Details](./docs/external-action-guard.md).

Operator tools (`huqan.approve`, `huqan.approvals`, `huqan.approval_detail`, `huqan.agent_resume`, `huqan.emergency_stop`) are hidden from the model and require `HUQAN_MCP_OPERATOR_TOKEN` — an agent cannot approve its own proposal.

## Install

```bash
npm install -g huqan     # Node.js 22.13.0 or newer
```

Seven binaries: `huqan` (CLI), `huqan-mcp` (MCP server), `huqan-gate` (pre-execution guard), `huqan-authority` (approval authority, ADR-016), plus the experiment CLIs `huqan-cognitive-lab`, `huqan-causal-lab` and `huqan-neural-lab`.  
Run `huqan doctor` to see what is configured.

## How it works

```text
evidence + provenance + workspace scope
        → verification, contradiction, risk
                → policy and approval boundary
                        → outcome + Trust Receipt
```

The outcome is one of:

ALLOW / REVIEW / QUARANTINE / DRY-RUN ONLY / BLOCK / REJECT

**Escalation is a decision a person makes, not one the gate returns.** A reviewer can move a pending case to `escalated`; that needs a second approver, so it is absent in a single-user install. Decision types: `approve`, `reject`, `expire`, `cancel`, `escalate`, `override` — see [`lib/human-oversight-approval-runtime.js`](./lib/human-oversight-approval-runtime.js).

A passing verification is a result inside one configured boundary, not a certificate of truth. The receipt names the boundary.

When the Approval Authority is installed, the decision itself moves behind an OS boundary (Windows service + TOTP + cryptographic envelopes). See [ADR-016](./docs/adr/ADR-016-approval-authority-os-boundary.md).

## Limits (honest)

- HUQAN does **not** eliminate hallucinations. It makes one claim **inspectable and blockable** before it becomes state.
- Only what is wired is governed. An agent that never calls HUQAN is not covered.
- The OS boundary needs the Approval Authority (a Windows service today). Code running as your user can still edit runtime files or the local store; the authority's ledger makes that detectable, not impossible. UAC is not a security boundary ([ADR-016 residual risks](./docs/adr/ADR-016-approval-authority-os-boundary.md#residual-risks)).
- Complements IAM, infrastructure security and human governance — it replaces none of them.
- The conformance suites are **self-run** in this repository, not third-party verification; no third-party attestation is bound yet. See the [interoperability and attestation boundary](./docs/audits/third-party-interoperability-attestation-boundary-3069.md).
- Synthetic graph read/write benchmarks reached 100k nodes and 100k edges on one machine. [Admitted-learning measurements and limits](./docs/scale-truth-pack.md) are separate; this is not a production capacity guarantee.

Full details and edge cases: [docs](./docs).

## License

**Open Source:** AGPL-3.0-only  
Free for open-source use, personal projects, research, and non-commercial evaluation.

**Commercial License**  
Required for:
- Closed-source / proprietary products
- Production use inside companies
- Redistribution as part of a commercial offering
- Multi-user / team deployments with support

Commercial licenses include dual-licensing rights (use HUQAN without AGPL obligations), priority support, and optional future commercial features.

→ Request commercial license: [aliulu@ai-ulu.com](mailto:aliulu@ai-ulu.com)

Until a commercial agreement is signed, this repository grants **no commercial rights**.

---

**Confidence is not truth. Verify before you trust.**

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-aliulu-ffdd00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/aliulu)
