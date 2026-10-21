# Security Invariants

This file is the living map from HUQAN's critical security invariants to the
tests that prove them. It is intentionally small: only invariants whose failure
would change an authorization, trust, isolation, provenance, or emergency
control belong here.

The gate is fail-closed. `npm run check:security-invariants` requires 5–7
invariants, at least one concrete test reference per invariant, unique IDs, and
every referenced test file to exist.

| ID | Security invariant | Test references |
|---|---|---|
| SI-01 | A model or untrusted execution path cannot self-approve a protected action: the decision must carry an envelope signed by the pinned approval authority, and on POSIX the runtime refuses a pin the agent's own user could rewrite. | `test/approval-flow.test.js`, `test/authority-decision-guard.test.js`, `test/authority-posix-path-trust.test.js` |
| SI-02 | Workspace and filesystem boundaries reject paths that escape the authorized root. | `test/path-safety.test.js` |
| SI-03 | Trust receipt chain ordering and stamping stay integrity-consistent; reordered material cannot silently become canonical. | `test/receipt-chain-order-matches-stamp.test.js` |
| SI-04 | The native/Rust graph path does not bypass provenance requirements enforced by the trusted graph boundary. | `test/rustGraph-provenance.test.js` |
| SI-05 | Untrusted memory is not promoted to canonical memory without admission policy evaluation and a recorded decision. | `test/memory-admission-gate.test.js` |
| SI-06 | Blast-radius computation records unknown inputs explicitly rather than treating missing risk as zero. | `test/blast-radius.test.js` |
| SI-07 | Emergency stop is durable and is read by the enforcement points that can execute agent, MCP, external-action, or A2A work. | `test/emergency-stop.test.js` |

SI-01 is the approval-authority invariant (ADR-016, ADR-020). The authority moves
the decision into a service under its own OS user, so the agent's process cannot
mint a valid decision; on POSIX the runtime path trust (`lib/authority/posix-path-trust.js`)
keeps the pin out of reach of a user-writable path. The `os-service` boundary is
reported, not assumed: `huqan-authority status` and `huqan doctor` carry an
`escalation` field when the runtime user can `sudo` past it (ADR-020 section 11).

## Maintenance rule

When a security-critical change alters one of these invariants, update the
mapped test in the same pull request. When a new invariant is important enough
to join this list, keep the total between 5 and 7 by consolidating or replacing
a weaker entry rather than turning this into a catalogue of every security
test.

The document is evidence mapping, not a substitute for the tests themselves.
