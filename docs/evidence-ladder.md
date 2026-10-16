# Evidence ladder v1

Issue #2152 introduces an explicit evidence-state ladder for HUQAN.

The ladder describes **how far a claim has progressed through local evidence,
admission, and verification**. It is not a source reputation score and it does
not turn an external statement into truth.

| Rank | Layer | Meaning | Canonical |
| ---: | --- | --- | --- |
| 10 | `external_research` | Source-backed external research returned by a provider; unverified and read-only. | no |
| 20 | `review_candidate` | A claim has entered a human-review/candidate path but is not canonical. | no |
| 30 | `canonical_evidence` | Evidence has been admitted into the canonical graph with the normal provenance/approval boundary. | yes |
| 40 | `verified_claim` | A claim has a verification result backed by canonical graph evidence. | yes |

## Safety semantics

- Ladder position is evidence state, not truth probability.
- `external_research` always remains `external_unverified` and
  `canonicalWrite: false`.
- Merely fetching or summarizing web research never advances the ladder.
- Advancement must be owned by the existing candidate, approval, provenance,
  canonical-write, and verification paths.
- Issue #2152 wires only the first layer into web research. Graph candidate and
  external-source opposition work remain owned by #2144 and #2146.

The runtime contract is `lib/evidence-ladder.js` with schema version
`huqan-evidence-ladder-v1`.
