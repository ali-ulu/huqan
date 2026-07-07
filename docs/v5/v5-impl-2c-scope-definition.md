# V5-IMPL-2C Scope Definition

**Mode:** Scope definition only
**Current checkpoint:** `SOURCE-RECON-5_POST_CANONICALIZATION_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ f8cc5d49c4ba4d3a511cba6a7b47d65665c0b54d`

## Purpose

`V5-IMPL-2C` defines the narrow validator / conformance boundary for the Shared Trust Package line.

This gate does **not** authorize implementation. It only locks the scope so a later implementation task-pack can be written safely.

The intended question for this gate is:

- What must a future Shared Trust Package validator check?
- What fixture categories are valid vs invalid?
- What deterministic conformance rules apply?
- What is explicitly out of scope?

## Position in the V5 chain

- `V5-IMPL-2A`: Shared Trust Package base shape
- `V5-IMPL-2B`: Route Receipt / Reasoning Metadata extension
- `V5-IMPL-2C`: Validator / conformance boundary definition
- Later gates: runtime writer, runtime reader, package verification, A2A exchange, connector enforcement, marketplace

## Scope

### Allowed

- Define the responsibility of `V5-IMPL-2C`
- Define the validator / conformance boundary
- Define valid fixture categories
- Define invalid fixture categories
- Define deterministic validation expectations
- Define acceptance criteria
- Define likely future allowed files
- Define forbidden scope
- Define non-claims
- Prepare for a later implementation task-pack, but do not write implementation code

### Forbidden

- Runtime Trust Package writer
- Runtime Trust Package reader
- Signing runtime
- Verification runtime
- A2A transport
- Connector enforcement
- Marketplace
- AgentAction policy engine
- Runtime identity enforcement
- UI / Workbench changes
- MCP runtime changes
- Package dependency changes
- Branch cleanup
- Archive adoption
- Old-main-history deletion
- `claude` branch deletion
- Default branch change

## Validator / Conformance Boundary Draft

The future validator should check whether a Shared Trust Package candidate satisfies schema and conformance expectations for:

- Required package identity fields
- Agent identity reference
- Verdict metadata
- Route receipt metadata
- Reasoning metadata
- Provenance / receipt linkage fields
- Deterministic valid / invalid fixture behavior

The future validator should fail closed for:

- Missing required identity fields
- Malformed agent identity reference
- Missing route receipt metadata
- Malformed route receipt metadata
- Missing reasoning metadata
- Malformed reasoning metadata
- Missing verdict metadata
- Unsupported or unknown version
- Invalid fixture that accidentally passes
- Nondeterministic validation result

## Likely future implementation files

These are only candidates for a later implementation task-pack. They are not part of this scope definition:

- `schemas/v5/shared-trust-package-validator.js`
- `test/v5-shared-trust-package-validator.test.js`

## Read-only references for later

- `schemas/v5/shared-trust-package.schema.json`
- `test/fixtures/v5/shared-trust-package/*.json`
- `test/v5-shared-trust-package-schema.test.js`

## Non-Claims

After this scope definition, do **not** claim:

- `V5-IMPL-2C` is implemented
- Shared Trust Package runtime exists
- packages are written at runtime
- packages are read at runtime
- packages are signed
- packages are verified at runtime
- A2A package exchange exists
- Connector enforcement exists
- Marketplace trust layer exists
- V5 is complete

## Expected Output of the Scope-Definition Step

The expected result of this gate is:

- A short written scope note
- Clear allowed / forbidden boundaries
- Clear non-claims
- A recommendation on whether a later `V5-IMPL-2C` implementation task-pack is safe to prepare

## Verdict for This Step

`V5-IMPL-2C_SCOPE_DEFINITION_READY`
