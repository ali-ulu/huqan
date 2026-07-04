# V5 Shared Trust Package / Receipt Bundle Format

## Status

Planning only. No package runtime, package verifier, or marketplace format is
implemented by this document.

## Purpose

A Shared Trust Package is the future portable evidence unit for HUQAN trust
state. It packages receipts, verdicts, provenance, evidence references, and
policy metadata so another boundary can inspect the trust record without
inventing claims.

## Proposed Fields

Future package format should cover:

- package id
- package version
- producer
- workspace
- receipts
- verdicts
- evidence refs
- provenance refs
- policy version
- signature/hash placeholder
- verification status
- non-claims

## Draft Shape

```json
{
  "packageId": "string",
  "packageVersion": "string",
  "producer": {
    "id": "string",
    "name": "string",
    "type": "agent|connector|workspace|system"
  },
  "workspaceId": "string",
  "trustPolicyVersion": "string",
  "receipts": [],
  "verdicts": [],
  "evidenceRefs": [],
  "provenanceRefs": [],
  "verification": {
    "status": "unverified|valid|invalid|stale",
    "hash": "placeholder",
    "signature": "placeholder"
  },
  "nonClaims": []
}
```

This shape is illustrative. It is not a runtime schema.

## Verification Rules

Future verification must check:

- receipt hashes
- chain linkage
- provenance references
- policy version
- producer identity
- evidence hashes
- connector coverage status
- no-mock fixture discipline

## Rejection Rules

A package must be rejected or marked invalid when:

- required provenance is missing
- receipt chain validation fails
- evidence hash is tampered
- producer is unknown
- trust policy version is stale
- connector coverage is overstated
- package claims readiness outside proven evidence

## Non-Claims

This document does not claim:

- package verification exists
- signatures are implemented
- marketplace distribution is safe
- external packages are trusted
- V5 implementation is complete
