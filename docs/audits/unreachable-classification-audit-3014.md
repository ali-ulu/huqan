# Unreachable-Module Classification Audit — #3014

**Date:** 2026-09-29 · **Base:** `e29f3331` · **Evidence rule:** every number below is quoted from `node scripts/check-dead-code.js` run in this tree.

## Exact measured output

```text
Dead-code check (module reachability): 988 reachable, 213 unreachable classified or pending
Dead-code check passed: reachability + MCP + CLI + REST + named exports + declaration types (213 classified unreachable modules)
```

(The issue's 216 was measured at #3132; the live number at this base is 213 — the title keeps the issue's original phrasing per its measurement rule, this document carries the current one.)

## Category breakdown of the 213 classified-unreachable modules

| Category | Count | Verdict in this audit |
|---|---|---|
| standalone (benchmarks/, scripts/, packages/, obsidian-plugin/, listed files) | 133 | deliberate — their own entry points, correctly outside the require graph |
| browser assets (public/) | 22 | deliberate — served over HTTP, gated by `test/dashboard-static-assets.test.js` |
| NOT_YET_WIRED ledger | 47 | the only genuine wiring-debt surface (below) |
| non-runtime artifacts (examples/) | 5 | deliberate — source-checkout examples |
| structural/compatibility barrels & aliases | 5 | deliberate — publishable canonical names kept working |
| test-only support | 1 | deliberate — `lib/self-test-oracle.js` |

**Deliberate total: 166. Wiring-debt total: 47.** No module in the deliberate categories is scheduled for removal; unreachability is not deadness, exactly as the issue states.

## The wiring-debt subset (NOT_YET_WIRED, 47 modules)

| Subsystem | Modules | Wiring condition recorded in the ledger |
|---|---|---|
| lib/inference-* | 14 | unification/evaluator/admission runtime wiring |
| lib/experience/* | 13 | procedure-candidate intake + runtime seam |
| other (delegation, bypass, incident, release, provenance, review, graph receipt) | 14 | named slices: runtime-wiring, trust-protocol publish, CLI review command, graph.js extraction |
| schemas/v5/agent-identity-* | 4 | production caller for the schema surface |
| issuer seal (lib/receipt/issuer-seal.js, lib/issuer-seal-config.js) | 2 | emission path + key configuration review |

Every one of the 47 entries carries a recorded wiring condition; none is a bare "unused".

### Findings of the review

1. The ledger had collapsed 26 entries onto one physical line (a formatting accident), which made audit-by-diff impossible. This PR re-renders every acknowledgement on its own line; content is unchanged (47 keys before and after, verified by the check and the export surface).
2. `test-debug.js` (527 bytes, committed by accident in #3164's merge, used by nobody) was the one unclassified module and made the gate fail on `main`. Removed in this PR — the "remove only what is proven unnecessary" clause, exercised.
3. Two entries (`lib/http/crash-recovery-inventory.js`, `lib/http/request-limits.js`) are superseded-by-design inventory/shims rather than future wiring. They were the first candidates if a *retire* category were ever added; that category now exists as `RETIRED_FILES` in `lib/module-reachability.js` and both moved there, so the wiring-debt count no longer carries them.
4. No acknowledgement was removed in this PR: graduation requires a production caller, and none of the 47 gained one here.

## The measurable downward target

`config/reachability-baseline.json` now records `measuredNotYetWired: 47`, and `test/reachability-baseline.test.js` (the wiring-debt ratchet) fails unless the ledger and the baseline agree in the same PR. Therefore:

- **The genuine wiring-debt number can no longer rise silently** — raising it is a reviewed, visible decision, the same idiom as the file-size ratchet.
- **The goal of this issue is now one number: 47 → down.** Each module that gains a real production caller leaves the ledger, the ratchet test forces the baseline to drop in the same PR, and this document's table is where the trend is reported.
- The classified-unreachable *total* is not the target (it legitimately moves with benchmarks and public assets); the NOT_YET_WIRED count is.

## Issue acceptance items this document closes

- Review of the current classifications: done (table above; every category re-derived from `lib/module-reachability.js` in this tree).
- `NOT_YET_WIRED` dispositions: all 47 keep an explicit live reason, now one-per-line auditable; none removed without a caller.
- Measurable downward target: the baseline + ratchet, defined above.
