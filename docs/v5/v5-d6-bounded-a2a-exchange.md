# V5-D6 Bounded A2A Exchange Conformance Harness

**Status:** `implementation`

`npm run conformance:a2a` runs a bounded, local child-process conformance
harness. It is a development verification artifact, not a production A2A
transport, listener, discovery service, marketplace, or interoperability
claim.

## Receiver-owned inputs

The child process accepts exchange requests over stdin, but it does not accept
identity authority, trusted public-receipt keys, package allowlists, target
binding, or an evaluation clock from that input. Those values come from a
separate absolute receiver-authority file. The consumer reads the receiver
clock once and applies it to identity, key, delegation, observation, and
exchange expiry checks.

The authority contains separate domains:

- identity/key records resolve each `identityRef`, canonical identity hash,
  workspace, validity, expiry, and outer/delegation signing key;
- `allowedPackageIds` is receiver policy, so a package manifest cannot approve
  its own identifier;
- public-receipt bindings contain the expected public receipt ID, internal
  receipt hash, bundle hash, signing key ID and the sole supported purpose;
- public-receipt trusted-key records are separate from identity/package keys.

The package is first signature-verified with the receiver allowlist. Its signed
binding metadata supplies the D3 import hashes; those hashes must also equal
the receiver's public-receipt binding. A receipt cannot establish its own
identity, package, key, or hash trust.

## Exchange boundary

The envelope requires a bounded, signed source-to-target chain (maximum 16),
linked parent hashes, exact participant prefixes, immutable child target,
monotone scope/tool/connector/risk/expiry constraints, and canonical identity
records. It requires a signed outer envelope, a signature-verified HUQAN 0.2
package, and a D3 verified public receipt.

Requested and observed action facts are distinct. The observation must state
the action hash, observed risk tier, used tools, used connectors, observation
time and effect hash. Its recorded tool and connector must exactly equal the
requested tool and connector, not merely fall within the delegation allowlist.
Evidence references carry exact SHA-256 digests and canonical byte sizes; their
aggregate is bounded to 1 MiB.

The replay reservation key hashes the complete verified request and stable
receiver authority identifier. It intentionally excludes the receiver clock and
mutable key-status records, so a normal clock advance or restart cannot turn an
already-reserved exchange into a second callback. The trusted directory uses
exclusive creation. Reservation occurs after all checks and before the
callback. A callback failure does not remove the marker: this is at-most-once
callback protection, not a transactional guarantee for an external side effect.
Deliberately changing the stable receiver authority identifier starts a new
replay namespace; that is an operational policy change, not replay recovery.

## Reproducible result

The harness reports a deterministic report object and SHA-256. On the current
fixture contract it must report 50 passed cases, zero failed cases, and:

```text
e3ad2b62259071daaf3fb82159c36198ffe64b3178e4849a38e20d9cab979fd5
```

Coverage includes invalid/expired identities, invalid scope/target/risk/tool/
connector delegation, missing mandatory fields, source and target binding,
outer/delegation/package/receipt signature tampering, independent receipt
binding, bounded evidence references, package self-approval rejection, replay,
failed-effect marker retention, and two concurrent consumer processes with
exactly one allowed callback.

## Non-claims

This local harness does not prove an independent third-party conformance
result, production A2A transport, network delivery, discovery, routing,
external counterparty interoperability, or transactional delivery of an
external effect. The effect boundary exchanges a signed hash reference only,
not effect payload bytes.
