# Laya risk plugin

`plugins/laya-risk.js` bridges the local [Laya](https://github.com/NandhaKishorM/laya)
decision model into HUQAN's gate vocabulary. It is a **signal producer**, never
a decision authority: it can raise a gate decision, and it can never lower one.
The boundary it lives inside is `docs/core-plugin-boundary-contract.md`.

## What it does

HUQAN's own manipulation layer (`lib/text-safety-scorer.js`) is a rule matcher,
not a calibrated classifier, so it cannot answer a *typed* risk question about an
arbitrary candidate action. Laya is a local, non-autoregressive decision model
that answers `noul` (binary), `choice` (multi-class) and `score` (ordinal)
questions in one forward pass and returns calibrated probabilities. It runs
CPU-only and is deterministic per input.

The plugin asks Laya a small fixed question set and maps the calibrated answer
into HUQAN's vocabulary in one place:

| Question id | Kind | Asks | Non-allow reading |
|---|---|---|---|
| `scope` | `noul` | is this action outside the workspace's declared scope | P(true) `>=` threshold |
| `risk_class` | `choice` | which risk class does this payload fall in | any class other than `allow` |
| `severity` | `score` | how severe is this payload on a 0 to 1 scale | expected level `>=` threshold |

The question set is pinned in `plugins/laya-risk.pack.json`. The sidecar is
addressed by command and environment, not bundled, so hashing its bytes is
meaningless; the pack pins the *questions* the operator approved instead. When
the pack hash does not match the pinned hash the plugin asks no questions and
contributes nothing (fail-closed on a drifted pack).

## Where it plugs in

The plugin exposes `gateSignal(kernel, data)`, the contribution half of the
boundary contract. `lib/gate-signal-provider.js` calls it for every loaded
plugin and folds the returned signals into one most-restrictive verdict that the
gate merges using `block > dry_run_only > review > allow`
(`lib/mcp-gate-adapter-decisions.js`). Merging can only raise a decision, so the
plugin can escalate a call the gates would have allowed but can never lower one
they would have stopped.

The plugin also exposes `status()`, a bounded report of whether the bridge can
answer right now, so an operator can tell a degraded sidecar apart from an
ordinary allow.

## Environment variables

The bridge reads these from the process environment. The client-side values are
also settable per call through plugin options; the environment is the operator
surface.

| Variable | Default | Meaning |
|---|---|---|
| `LAYA_RISK_CALL_THRESHOLD` | `0.6` | the `noul`/`score` probability at or above which a question reads as a review; a non-finite value falls back to the default |
| `LAYA_RISK_PACK` | `plugins/laya-risk.pack.json` | path to the question pack to ask |
| `LAYA_RISK_PACK_HASH` | (none) | expected sha256 of the pack's question set; when set and it does not match, the plugin asks no questions |
| `LAYA_MCP_CMD` | `laya-mcp-server` | the sidecar command to launch |
| `LAYA_MCP_ARGS` | (none) | extra arguments for the sidecar command |
| `LAYA_MCP_TIMEOUT_MS` | `5000` | per-call wall-clock bound; the helper enforces it and the caller gives a little more room so the helper's timeout wins the race |
| `LAYA_MCP_MAX_OUTPUT_BYTES` | `1048576` | output cap; a larger reply is treated as no reading |

`HUQAN_LAYA_MCP_HELPER` is an internal marker the client sets on the helper
child it spawns; it is not an operator setting.

## Degraded-answer contract

The gate seam is synchronous, so an unbounded wait would block it for as long as
the sidecar lives. Every failure mode below yields **no reading** rather than a
low-risk one, and a degraded answer never downgrades a core decision — it simply
stops being mistaken for evidence.

| Condition | Effect |
|---|---|
| Sidecar not configured or not launchable | no reading; the plugin contributes nothing |
| Timeout, non-zero exit, JSON-RPC error, `isError` result, oversized output | no reading for that call |
| `engineAvailable` is false | no reading; `gateSignal` returns `undefined` |
| The answer for a question is missing, or the answer map itself is null | that question is skipped; it is not read as `0` |
| A `noul` answer that is not a finite number in `[0, 1]` — including `null`, `''`, `false`, a numeric string and `NaN` | the question is skipped, not read as a confident low score (#4005) |
| A `score` answer that is not a finite number | the question is skipped |
| A `choice` answer of `null` or `undefined` | the question is skipped |
| A `choice` answer that is any other value | read as its label; anything other than `allow` is a review |
| The pack hash does not match the pin | the plugin asks no questions at all |
| The plugin throws or returns a thenable the synchronous seam cannot await | the provider floors the verdict at `review`, never `block` and never `allow` |

A reading that is a clean `allow` also produces no signal, so the gate sees no
evidence from this plugin — the same effect as a degraded answer, reached from
the opposite direction. Neither path can produce a permission the core gates did
not already grant.

## Fail-closed by construction

The client (`lib/laya-mcp-client.js`) speaks the sidecar's MCP stdio protocol in
a short-lived helper process and drives it with `spawnSync`, so nothing
platform-specific is left on the synchronous path and an unresponsive sidecar
cannot block the gate. There is no cloud call and no API key. The sidecar is
killed with `SIGKILL` so a child that ignores `SIGTERM` cannot block the gate
path either.
