# MCP client envelope 0.1

The authenticated client contract a protected MCP server applies before it
reads protected state or performs any side effect.

- **Status:** draft specification
- **Date:** 2026-10-17
- **Decision record:** `docs/adr/ADR-018-agent-boundary-decisions.md` §4 (Accepted)
- **Implements:** #3997 (this specification). Consumed by #3999 (MCP service conversion).
- **Related:** `docs/adr/ADR-017-agent-user-boundary.md` §4, #3948, #3860.
- **Scope:** a wire contract and its test vectors. This document authorises no
  runtime, installer or test change by itself. The MCP service conversion that
  consumes it is #3999.

## 1. Scope and non-claims

[ADR-017](adr/ADR-017-agent-user-boundary.md) §4 moves shared MCP servers out of
the agent's process tree and onto a loopback endpoint. Loopback reachability is
not client identity: any process that can open the port can call the server.
[ADR-018](adr/ADR-018-agent-boundary-decisions.md) §4 therefore requires every
request to a protected server to carry a signed, single-use, short-lived
envelope, and leaves the envelope fields, the verification rules and the error
codes to this document.

This specification defines:

- the envelope fields and their bounds;
- the canonical JSON used to hash the arguments and to sign the envelope;
- the verification order and one error code per step;
- key enrolment and rotation;
- the nonce-store bounds.

This specification does not claim, and the envelope does not prove:

- that the agent runs as a separate OS user (that is #3948 and #3998);
- that the server runs under its own service account (that is #3999);
- that the operator's key was not stolen — the envelope proves possession of an
  enrolled private key, nothing about who holds it;
- that the operation is authorised — the existing MCP gate and admission policy
  decide that (step 7), after the envelope is accepted.

## 2. Canonical JSON and hashing

Two envelope fields are derived from bytes that must agree between two
independent implementations: `args_sha256` and the signature. Both use the
canonical JSON algorithm the repository already publishes for the trust
protocol, `canonicalJson(value)` in
[`specs/huqan-trust-protocol/0.2/RECEIPT-BUNDLE.md`](../specs/huqan-trust-protocol/0.2/RECEIPT-BUNDLE.md),
implemented by `lib/hash-chain.js` as `stableStringify`. It is reused here
without change; this specification does not define a second serialization.

In summary, `canonicalJson(value)` is RFC 8259 JSON with no insignificant
whitespace, object keys sorted ascending by UTF-16 code unit at every level,
array order preserved, strings emitted as UTF-8 with only the mandatory
escapes, numbers using ECMAScript `Number::toString`, and no Unicode
normalization. The full rules, including the UTF-16 key-ordering and the
non-ASCII literal rules, are the ones in `RECEIPT-BUNDLE.md` §"canonicalJson".

`sha256Hex(text)` is SHA-256 over the UTF-8 bytes of `text`, rendered as
lowercase hexadecimal.

## 3. Envelope

An envelope is a JSON object with exactly these fields. Every field is
required; an unknown field is a `malformed` refusal.

| Field | Type | Bound |
| --- | --- | --- |
| `v` | string | exactly `huqan.mcp.envelope.v1` |
| `client_id` | string | non-empty, at most 512 UTF-8 bytes |
| `workspace_id` | string | non-empty, at most 512 UTF-8 bytes |
| `op` | string | non-empty, at most 512 UTF-8 bytes |
| `args_sha256` | string | 64 lowercase hex characters |
| `nonce` | string | unpadded base64url, 22 to 86 characters (16 to 64 bytes) |
| `issued_at` | string | strict UTC instant, `YYYY-MM-DDTHH:MM:SS(.mmm)Z` |
| `expires_at` | string | strict UTC instant; see the window rule below |
| `key_id` | string | 16 lowercase hex characters |
| `sig` | string | unpadded base64url of a 64-byte Ed25519 signature |

Field meanings:

- `client_id` is the enrolled agent client identity (§5).
- `workspace_id` is the workspace the request is bound to.
- `op` is the MCP operation name.
- `args_sha256` is `sha256Hex(canonicalJson(args))` over the arguments of the
  actual call.
- `nonce` is a single-use random value with at least 128 bits of entropy.
- `issued_at` and `expires_at` bound the freshness window. `expires_at` must be
  strictly after `issued_at`, and `expires_at - issued_at` must be at most
  **60 000 ms**.
- `key_id` identifies the enrolled public key that signed the envelope.
- `sig` is the signature defined below.

### 3.1 Key identifier

`key_id` is the first 16 lowercase hex characters of
`sha256Hex(raw_public_key)`, where `raw_public_key` is the 32-byte raw Ed25519
public key. This is the identifier `lib/authority/decision-envelope.js` already
computes in `keyIdFor`, so the approval authority and the MCP envelope name the
same key the same way.

### 3.2 Signature

Let `unsigned` be the envelope without its `sig` field, and let

```text
DOMAIN = "huqan.mcp.envelope.v1\n"
```

`sig` is the unpadded base64url encoding of the 64-byte Ed25519 signature over
the UTF-8 bytes of `DOMAIN || canonicalJson(unsigned)`.

The `DOMAIN` prefix is a domain separator, the same construction
`lib/authority/decision-envelope.js` uses for its decision and response
signatures: a signature produced for an MCP envelope can never be presented as
a decision signature, or the reverse, even if the payloads were byte-identical.

## 4. Verification order and error codes

A verifier checks the envelope against the actual call — the `client_id`,
`workspace_id`, `op` and `args` the server is about to act on — and the
enrolled key registry (§5). It runs the steps below **in order** and stops at
the first failure. A failed envelope is rejected with the code from the failing
step and **no side effect**: no protected-state read, no mutation, no receipt
for the refused operation other than the refusal record the server already
emits.

| # | Step | Failure code |
| --- | --- | --- |
| 1 | Structure: required fields, types, bounds, version, TTL window | `malformed` |
| 2 | Known key: `client_id` is enrolled and `key_id` is the active key for it | `unknown_key` |
| 3 | Signature: Ed25519 verify over `DOMAIN \|\| canonicalJson(unsigned)` | `signature_invalid` |
| 4 | Freshness: `issued_at - MAX_CLOCK_SKEW_MS <= now < expires_at` | `not_yet_valid` / `expired` |
| 5 | Nonce replay: the nonce has not been consumed (§6) | `replayed` |
| 6 | Binding: `client_id`, `workspace_id` and `op` equal the actual call | `binding_mismatch` |
| 7 | Arguments: `args_sha256` equals `sha256Hex(canonicalJson(args))` | `args_mismatch` |

Steps 1–7 are the envelope's own contract. After step 7 the request proceeds to
the existing MCP gate and admission policy in `lib/mcp`, which decides whether
the operation is allowed. That decision is not part of this specification; the
requirement this document carries is only that the envelope is verified
**before** the gate runs and before any protected-state access or side effect.

Step 4 reports two codes because the two ends of the window are different
conditions: `not_yet_valid` means the envelope's clock is ahead of the server's,
`expired` means the window has closed. `expired` is inclusive at `expires_at`.

`MAX_CLOCK_SKEW_MS` is 5000. Client and server are separate processes whose
clock reads can differ by a few milliseconds, so an envelope stamped "now" may
arrive at a verifier whose clock is slightly behind. The allowance applies to
the not-before end only: `expires_at` is not extended, so the window never
grows past `MAX_TTL_MS`, and a nonce store must retain a record at least until
`expires_at + MAX_CLOCK_SKEW_MS` (the durable store's sweep grace is 60 s).

Step 6 is the refinement ADR-017 §4 asks for when it says the envelope must
"bind the client and workspace to the operation and its arguments": the
envelope's `client_id`, `workspace_id` and `op` are compared with the call, and
its `args_sha256` is compared with the call's arguments. The two comparisons
report distinct codes so an operator can tell a misrouted call from a tampered
argument list.

A refusal response carries the code and a bounded message. It must not echo the
arguments, the signature, or any key material.

## 5. Key enrolment and rotation

The operator enrols, for each agent client, the public key that client signs
with. An enrolment record is:

```json
{
  "client_id": "agent-claude-code",
  "key_id": "0123456789abcdef",
  "public_key": "<unpadded base64url of the 32-byte raw Ed25519 public key>"
}
```

Rules:

- `key_id` is derived from `public_key` (§3.1); a record whose `key_id` does not
  match its `public_key` is rejected at enrolment.
- A `client_id` has exactly one active `key_id` at a time.
- **Rotation** never reuses a `key_id`. The operator enrols the new key under a
  new `key_id` and both keys are accepted during an overlap window no longer
  than the shortest freshness window the server accepts; after the window the
  old record is removed. An envelope signed with a removed key fails step 2
  with `unknown_key`.
- **Revocation** is removal of the record; it takes effect on the next request
  because step 2 reads the live registry.
- Enrolment is an operator action behind the approval authority boundary, not an
  agent action. How the registry is stored and protected is #3998 and #3999; the
  envelope only requires that a verifier can resolve `client_id` to a `key_id`
  and a public key.

## 6. Nonce store bounds

The nonce is single-use. A verifier records a consumed nonce and refuses a
second request that presents it (step 5, `replayed`). The store must hold across
process restarts and across concurrent workers, and it must fail closed.

The bounds below reuse the mechanism already shipped for MCP operator
capabilities in `lib/mcp-capability-nonce-store.js`:

- A nonce is recorded as one small file created with the exclusive `wx` flag.
  `open(O_CREAT|O_EXCL)` is atomic on POSIX and on Windows, so the reservation
  and the replay check are a single operation; no lock file and no
  read-modify-write window exists.
- The record's name is `sha256Hex(nonce)`, not the nonce itself, so a
  client-chosen nonce cannot escape the store directory or collide with a
  special filesystem name.
- A record is written with the envelope's `expires_at`. It may be swept only
  after `expires_at` plus a grace period of at least **60 000 ms**, so a slower
  worker cannot accept a nonce the fastest worker already dropped.
- The store is bounded by the freshness window: because no envelope is accepted
  more than 60 000 ms after it was issued, the number of live records is bounded
  by the request rate times 120 seconds, not by history.
- Every error other than "already consumed" is a refusal. If the store cannot be
  created, read or written, verification denies the request rather than falling
  back to accepting it. An unavailable durable store must not silently restore
  the replayable behaviour it exists to remove.

## 7. Test vectors

The executable form of this specification is the vector set produced by
`scripts/generate-mcp-client-envelope-vectors.js` and committed under
`test/fixtures/mcp-client-envelope/`. `test/mcp-client-envelope-vectors.test.js`
asserts that the committed vectors are exactly what the generator produces and
that each one fails at exactly one step.

Each vector is a JSON document:

```json
{
  "name": "expired",
  "description": "the freshness window has closed",
  "expect": { "ok": false, "code": "expired" },
  "envelope": { "...": "..." },
  "call": {
    "client_id": "agent-claude-code",
    "workspace_id": "default",
    "op": "huqan.learn",
    "args": { "...": "..." },
    "now": "2026-01-01T00:00:31.000Z",
    "consumed_nonces": []
  },
  "enrolled": [
    { "client_id": "agent-claude-code", "key_id": "...", "public_key": "..." }
  ]
}
```

The vector set covers, one vector each: a valid envelope, and a single isolated
failure for every code in §4 — `malformed` (missing field, wrong version, TTL
over the window), `unknown_key`, `signature_invalid`, `not_yet_valid`,
`expired`, `replayed`, `binding_mismatch` and `args_mismatch`. A test asserts
that every code in the §4 table has at least one vector, so a code added to the
table without a vector fails.

The keys in the vectors are derived from fixed seeds and the instants are
fixed, so the vectors are byte-reproducible: regenerating them after an
unrelated change produces no diff. The vectors carry no private key.

## 8. What this does not claim

- Accepting an envelope does not mean the operation is authorised; that is the
  MCP gate's decision (step 7).
- The envelope does not prove the agent is a separate OS user, or that the
  server is a separate service account. Those are #3948, #3998 and #3999.
- A published envelope format is not a deployed one. This document specifies the
  contract; the protected loopback transport that speaks it is #3999
  (`lib/mcp/loopback-service.js`, `lib/mcp/client-envelope.js`), whose
  production verifier is kept conformant with the vectors this document
  defines.
