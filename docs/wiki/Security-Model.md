# Security Model

HUQAN treats trust decisions, approval boundaries, provenance, receipts, plugin loading, external-agent actions and transport configuration as security-sensitive surfaces.

The repository contains both a security policy and a STRIDE-oriented threat model. This page summarizes those sources without widening their claims.

## Core principles

### Least privilege

External actions are classified and may be allowed, reviewed, forced into dry-run, quarantined, blocked or rejected depending on the governed path.

Unknown tools are not automatically trusted.

### Fail closed

Where authority is required, missing or malformed trust material should not silently degrade into weaker enforcement.

Examples include:

- deployment-gated A2A routes remain absent until required authority and replay configuration exists;
- malformed A2A authority configuration removes the surface rather than partially enabling it;
- operator-only MCP tools are not exposed through the normal model-visible tool catalog;
- identity/signature enforcement can block when required trust material is absent or invalid.

### Separation of duties

The model that proposes a mutation is not automatically given the operator capability needed to approve it.

### Evidence preservation

Provenance, decision context and Trust Receipts are intended to make trust decisions inspectable after the fact.

## Plugins: signed is not sandboxed

This is one of the most important boundaries in the project.

`plugin.js` loads plugins in-process with Node.js `require()`. A plugin therefore runs with the privileges of the HUQAN host process.

Manifest hashing and HMAC signing can establish that a plugin file is authentic and unchanged relative to approved metadata. They do **not** confine what the plugin can do.

A verified plugin may still access ordinary host capabilities available to the process, including filesystem, network, environment and child-process APIs.

Therefore:

> **Signed does not mean sandboxed.**

The threat model explicitly treats third-party or untrusted plugin confinement as a separate problem that would require a real isolation boundary such as a separate process, container or WASM-style host-call boundary.

## A2A trust roots

The A2A deployment model uses receiver-owned authority configuration and replay state. The documented path verifies identity, delegation, evidence, signatures and policy before a bounded exchange may record an effect.

The authority path itself is protected by path-safety requirements, including absolute paths and symlink refusal.

Replay reservation happens before the effect so an uncertain outcome is not blindly retried and duplicated.

## Human sponsorship and identity

Supported external-agent paths can carry signed identity information and human sponsorship evidence. Production rules described in the external-action documentation require stronger authority for covered actions.

Human sponsorship does not eliminate the normal policy/admission gate. It provides an authority signal inside the governed decision.

## Threat categories tracked

The repository threat model currently covers areas including:

- content and identity spoofing
- memory and governance tampering
- agent-state and knowledge-base disclosure
- resource exhaustion and API flooding
- tool privilege escalation
- plugin code execution
- memory trust-level escalation
- supply-chain and future ecosystem threats

The threat model also records remaining gaps and planned mitigations. A listed planned mitigation should not be read as already implemented.

## Vulnerability reporting

Security issues should use GitHub Private Vulnerability Reporting when available. Sensitive exploit details, credentials or proof-of-concept material should not be placed in public issues.

See the canonical policy for supported versions, scope and disclosure rules.

## Canonical references

- [Security Policy](https://github.com/ali-ulu/huqan/blob/main/SECURITY.md)
- [Threat Model](https://github.com/ali-ulu/huqan/blob/main/THREAT_MODEL.md)
- [External Action Guard](https://github.com/ali-ulu/huqan/blob/main/docs/external-action-guard.md)
- [A2A Deployment](https://github.com/ali-ulu/huqan/blob/main/docs/a2a-deployment.md)
