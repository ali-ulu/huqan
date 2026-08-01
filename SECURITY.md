# HUQAN Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| `main` | ✅ Current |
| Latest stable release | ✅ |

Only the latest `main` branch and the most recent tagged release receive security updates.

Canonical repository: `https://github.com/ali-ulu/huqan`

## Reporting a Vulnerability

**Do not disclose sensitive details publicly.**

- Use **GitHub Private Vulnerability Reporting** (Security tab → "Report a vulnerability") if available.
- If private reporting is not available, open a **minimal public issue** without sensitive details so a private channel can be coordinated.
- Do not include proof-of-concept exploits, secrets, credentials, or sensitive data in public issues.

## Response Expectations

- Reports in Turkish or English are accepted.
- We aim to acknowledge reports within 3 business days.
- We aim to provide a fix timeline within 10 business days for critical issues.

## Scope

This policy covers the HUQAN runtime and its security-critical components. Some internal filenames and compatibility identifiers still use the historical AXIOM name; those identifiers do not refer to a separate repository.

- **Runtime:** kernel, KernelV2, graph engine, and SQLite/JSON memory stores
- **MCP Server:** `mcpServer.js`, `lib/mcp-gate-adapter.js`, `lib/tool-call-gate.js`, `lib/action-risk-classifier.js`, `lib/memory-mutation-gate.js`, `lib/automation-safety-gate.js`, and `lib/sandbox-isolation.js`
- **REST API:** `server.js`, verification endpoints, and ingest endpoints
- **Trust Kernel:** `lib/verify.js`, `lib/risk-rules.js`, `lib/contradiction-rules.js`, `lib/semantic-score.js`, and `lib/reasoning-trace.js`
- **Agent Brake Layer:** action-risk classification, tool-call gating, and AB1–AB6 gates
- **Sandbox:** `sandboxRunner.js` and `lib/sandbox-isolation.js`
- **Package and receipt formats:** portable package, provenance, audit, and receipt code
- **CI and security configuration:** `.github/workflows/`, `SECURITY.md`, `THREAT_MODEL.md`, and `CODEOWNERS`

## Out of Scope

- Third-party dependency vulnerabilities that should be reported upstream
- Local-development issues that do not affect HUQAN behavior
- Issues requiring physical access to the host machine

## Disclosure

We follow coordinated disclosure. Once a fix is available, we will publish a security advisory and update this file when appropriate.
