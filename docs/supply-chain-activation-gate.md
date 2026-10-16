# Supply-chain activation gate

`lib/supply-chain-activation-gate.js` is the single provenance decision point
for dynamically activated components. It evaluates an exact allowlist entry:
component type, name, version, SHA-256 content hash, issuer, workspace,
capabilities, and optional expiry. A change to any of those fields is denied.

The plugin loader enables this gate when `HUQAN_SUPPLY_CHAIN_ACTIVATION_POLICY`
(or its `AXIOM_` compatibility name) contains a JSON policy with a `components`
array. The loader evaluates the plugin before registration, and re-attests its
source bytes immediately before `runCapability`. A changed file is denied with
`SUPPLY_CHAIN_ACTIVATION_REJECTED`; `revoke()` targets the exact component
identity, so a matching name in another workspace remains unaffected.

The inventory returned by `inventory()` is the implemented AIBOM/SBOM-like
minimum: component identity, version, content hash, issuer, workspace,
capabilities, and expiry. It is not a registry, publication record, deployment
attestation, package sandbox, or behavioral containment claim. Plugin signing
still proves approval of bytes only; plugins execute in-process, and this gate
does not change that boundary.

The generic gate accepts `tool`, `plugin`, `agent-descriptor`, `package`,
`prompt`, `dataset`, and `endpoint` component types. In this change, only the
real plugin loader/capability boundary is wired. Other activation boundaries
must call `activate()` before trust/registration and `reattest()` immediately
before execution; they are not represented as protected by this plugin wiring.

This scope complements #1103 (publication), #1119 (package-format integrity),
and #1182 (A2A availability). It does not duplicate or claim to solve them.
