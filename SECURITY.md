# AXIOM / HUQAN — Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| main    | ✅ Current         |
| latest stable release | ✅ |

Only the latest `main` branch and the most recent tagged release receive security updates.

## Reporting a Vulnerability

**Do not disclose sensitive details publicly.**

- Use **GitHub Private Vulnerability Reporting** (Security tab → "Report a vulnerability") if available.
- If private reporting is not available, open a **minimal public issue** without sensitive details and we will coordinate a private channel.
- Do not include proof-of-concept exploits, secrets, or sensitive data in public issues.

## Response Expectations

- Languages: Turkish or English accepted.
- We aim to acknowledge within 3 business days.
- We aim to provide a fix timeline within 10 business days for critical issues.

## Scope

This policy covers the AXIOM / HUQAN runtime and its security-critical components:

- **Runtime**: AXIOM kernel, KernelV2, graph engine, memory store (SQLite/JSON)
- **MCP Server**: `mcpServer.js`, tool gate (`lib/mcp-gate-adapter.js`, `lib/tool-call-gate.js`, `lib/action-risk-classifier.js`, `lib/memory-mutation-gate.js`, `lib/automation-safety-gate.js`, `lib/sandbox-isolation.js`)
- **REST API**: `server.js`, verification endpoints, ingest endpoints
- **Trust Kernel**: `lib/verify.js`, `lib/risk-rules.js`, `lib/contradiction-rules.js`, `lib/semantic-score.js`, `lib/reasoning-trace.js`
- **Agent Brake Layer**: `lib/action-risk-classifier.js`, `lib/tool-call-gate.js`, AB1–AB6 gates
- **Sandbox**: `sandboxRunner.js`, `lib/sandbox-isolation.js`
- **Package Format**: `lib/memory-package.js`, provenance, audit
- **CI / Security Config**: `.github/workflows/`, `SECURITY.md`, `THREAT_MODEL.md`, `CODEOWNERS`

## Out of Scope

- Third-party dependencies (report to upstream)
- Local development environment issues not affecting production behavior
- Issues requiring physical access to the host machine

## Disclosure

We follow coordinated disclosure. Once a fix is available, we will publish a security advisory and update this file.