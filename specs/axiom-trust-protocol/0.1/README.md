# AXIOM Trust Protocol (ATP) v0.1

> **Superseded compatibility version.** The canonical protocol name is HUQAN
> Trust Protocol (HTP), with the current publication at
> `specs/huqan-trust-protocol/0.2/`. These 0.1 bytes remain frozen for negotiated
> downgrade compatibility. This lineage receives compatibility and security
> fixes only; new protocol work belongs in a new HTP version.

ATP is the portable trust layer for AXIOM.

It defines how claims, provenance, audit history, conflicts, verification results, and exportable trust state should be represented without tying the protocol to one storage engine or one UI.

AVP, the AXIOM Verify Protocol, is the verification-focused subset of ATP.

## What ATP Is

ATP is the public data contract for trusted claims and trust-adjacent evidence.
It covers:

- provenance-bound claims
- deterministic trust outcomes
- conflict routing
- append-only audit surfaces
- portable exchange between AXIOM-compatible tools
- trust receipts as the visible user-facing trust object

## What ATP Is Not

ATP is not:

- a full world model
- a probabilistic prediction engine
- a guarantee that every source is true
- a claim that AXIOM eliminates all hallucinations
- a storage backend
- a stable v1.0 standard in this release

## ATP vs AVP

- `ATP` is the upper protocol.
- `AVP` is the verify-focused subset of ATP.

ATP covers provenance, conflict routing, audit, exchange, causal summary payloads, and simulation outputs. AVP covers verify-facing request/response semantics.

## Design Principles

1. Provenance first.
2. Deterministic trust outcomes.
3. Append-only auditability.
4. Portable exchange over backend coupling.
5. Public evolution starting at `0.1`.

## Core Objects

ATP v0.1 documents these object families:

- provenance records
- audit events
- candidate claims
- conflict results
- verification results
- trust receipts
- causal chains
- simulation results
- error envelopes

## Schemas

Machine-readable schema documents live under:

- `schemas/provenance-record.schema.json`
- `schemas/audit-event.schema.json`
- `schemas/candidate-claim.schema.json`
- `schemas/conflict-result.schema.json`
- `schemas/verification-result.schema.json`
- `schemas/trust-receipt.schema.json`
- `schemas/causal-chain.schema.json`
- `schemas/simulation-result.schema.json`
- `schemas/error.schema.json`

## Examples

Example payloads live under `examples/` and are intended to match the v0.8 runtime shapes where possible.

## Conformance

A lightweight conformance helper lives in `lib/atp-conformance.js` and the test suite exercises the public contract through `lib/atp-conformance.test.js`.

## Minimal Claim

```json
{
  "subject": "autoLearn true",
  "relation": "CAUSES",
  "object": "unsupported output can enter graph"
}
```

## Minimal Provenance Record

```json
{
  "provenanceId": "prov_001",
  "sourceRef": "github://agiulucom42-del/axiom/pull/4821",
  "sourceTitle": "AXIOM PR #4821",
  "sourceType": "github",
  "actor": "axiom-bot",
  "timestamp": "2026-06-02T00:00:00Z",
  "confidence": 0.94,
  "workspaceId": "default",
  "trustPolicyVersion": "0.8.0"
}
```

## Minimal Claim Passport

```json
{
  "claimId": "claim_001",
  "subject": "autoLearn true",
  "relation": "CAUSES",
  "object": "unsupported output can enter graph",
  "polarity": true,
  "confidence": 0.94,
  "provenanceId": "prov_001",
  "workspaceId": "default",
  "createdAt": "2026-06-02T00:00:00Z",
  "updatedAt": "2026-06-02T00:00:00Z",
  "status": "canonical",
  "trustPolicyVersion": "0.8.0"
}
```

## Minimal Verification Result

```json
{
  "ok": true,
  "claim": "autoLearn true causes unsupported output to enter graph",
  "status": "verified",
  "mode": "graph-backed",
  "confidence": 0.94,
  "evidence": [
    {
      "kind": "direct_edge",
      "text": "autoLearn true --[CAUSES]--> unsupported output can enter graph",
      "confidence": 0.94
    }
  ],
  "provenance": {
    "provenanceId": "prov_001"
  },
  "conflict": null,
  "receipt": {
    "receiptId": "receipt_001"
  }
}
```

## Trust Receipt

A Trust Receipt is the core UX object.

It is the visible, read-only evidence package for a claim. It packages provenance, audit trail, conflict status, candidate status, canonical admission status, and trust policy context.

Every serious answer should come with a receipt.

## Claim Passport

A Claim Passport is the identity and trust envelope for a claim.
In `0.1` it is documented as a portable record shape, not a required runtime class.

## ATP Compatibility

ATP-compatible systems should be able to:

- emit valid ATP objects
- validate ATP objects
- preserve `provenanceId`
- preserve `workspaceId`
- preserve `trustPolicyVersion`
- distinguish canonical from pending or rejected claims
- produce or consume Trust Receipts

Badge language for future implementations:

```text
ATP v0.1 Compatible
```

## `.axiom` Package Format

`.axiom` is the exchange format for portable ATP records.
It is not the live runtime storage engine.

```json
{
  "format": "axiom",
  "version": "0.1",
  "workspaceId": "default",
  "exportedAt": "2026-06-02T00:00:00Z",
  "claims": [],
  "nodes": [],
  "edges": [],
  "provenance": [],
  "audit": [],
  "pendingClaims": [],
  "rejectedClaims": [],
  "signatures": []
}
```

## Storage Model

ATP is storage-agnostic.

- SQLite is the intended first canonical runtime store for v0.8.
- An adapter layer should isolate trust semantics from physical storage.
- `.axiom` is for exchange and portability, not live mutation.

## Strategic Standardization Note

AXIOM should not position ATP as a closed product format.

The goal is to become the default trust layer for AI systems by making ATP portable, testable, and implementation-independent.

ATP must eventually support:

- reference implementation through AXIOM
- conformance suite
- external implementations
- Trust Receipt UX
- ATP-compatible badge
- future SDKs and wrappers

Important language:

- AXIOM does not force adoption.
- AXIOM becomes the trust layer serious AI systems prefer.

## Future Conformance Badge

The future **ATP Compatibility Badge** should indicate that a tool:

- preserves provenance fields
- exposes AVP-compatible verification labels
- supports conflict routing semantics
- passes an ATP conformance suite

No badge process is defined in `0.1`.
