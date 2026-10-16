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
- **MCP Server:** `mcpServer.js`, `lib/mcp-gate-adapter.js`, `lib/tool-call-gate.js`, `lib/action-risk-classifier.js`, `lib/memory-mutation-gate/`, `lib/automation-safety-gate/`, and `lib/sandbox-isolation.js`
- **REST API:** `server.js`, verification endpoints, and ingest endpoints
- **Trust Kernel:** `lib/verify.js`, `lib/risk-rules.js`, `lib/contradiction-rules.js`, `lib/semantic-score.js`, and `lib/reasoning-trace.js`
- **Agent Brake Layer:** action-risk classification, tool-call gating, and AB1–AB6 gates
- **Sandbox:** `sandboxRunner.js` and `lib/sandbox-isolation.js`
- **Plugin loader:** `plugin.js` — manifest hash and signature verification, strict/production enforcement, and capability gating
- **Package and receipt formats:** portable package, provenance, audit, and receipt code
- **CI and security configuration:** `.github/workflows/`, `SECURITY.md`, `THREAT_MODEL.md`, and `CODEOWNERS`

## Trust Assumptions

Some properties are design decisions rather than defects. Reports that depend on them will be closed as working-as-documented.

- **Plugins are trusted code, not sandboxed code.** `plugin.js` loads plugins with `require()`, so a plugin runs in-process with the full privileges of the host process. Manifest hashing and HMAC signing prove a plugin file is authentic and unmodified; they do not restrict its behavior. Installing a plugin grants that code full host privileges, and write access to the plugins directory is equivalent to code execution. See `docs/core-plugin-boundary-contract.md`, "Enforcement Boundary: Signed Is Not Sandboxed", and the "Plugin Code Execution" entry in `THREAT_MODEL.md`.

## Out of Scope

- Third-party dependency vulnerabilities that should be reported upstream
- Local-development issues that do not affect HUQAN behavior
- Issues requiring physical access to the host machine
- Demonstrating that a plugin can reach `fs`, `child_process`, or other host capabilities: this is the documented trust model, not a vulnerability. A *bypass of manifest hash or signature verification itself* is in scope.

## Disclosure

We follow coordinated disclosure. Once a fix is available, we will publish a security advisory and update this file when appropriate.
