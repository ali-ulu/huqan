# Verify-status vocabulary migration

HUQAN is an English-positioned product. Its public HTTP API used to answer in
Turkish. This document records what was measured, what changed, and what was
deliberately left alone.

It follows the compatibility contract already set by
[RFC-001](rfcs/RFC-001-huqan-canonical-naming-and-legacy-compatibility.md) and
the [environment-variable migration](environment-variable-migration.md):

> a reader accepts both spellings; a writer emits only the canonical form.

## Canonical vocabulary

| Canonical (emitted) | Legacy (still accepted) | Meaning |
| --- | --- | --- |
| `verified` | `dogrulandi` | the claim is supported by the graph |
| `contradicted` | `celiski` | the claim conflicts with a known fact |
| `unknown` | `bilinmiyor` | insufficient evidence either way |

The legacy value is `celiski`, not `celiskili`. `celiskili` appears only as a
Turkish adjective inside CLI prose (`cli.js`), never as a status value.

Implemented in [`lib/verify-status-vocabulary.js`](../lib/verify-status-vocabulary.js).

## Blast radius — measured, not assumed

The decisive question was whether these values are **persisted, hashed or
signed**. If a signed receipt contained `dogrulandi`, renaming it would
invalidate artifacts users already hold.

**They are not.** The verify-status vocabulary and the receipt vocabulary are
completely disjoint.

| Surface | Carries a verify status? | Evidence |
| --- | --- | --- |
| Canonical receipt payload | **No** | `lib/receipt/canonical-receipt.js` takes `verdict` from `CANONICAL_VERDICTS` in `lib/verdict/action-verdict.js`, which is `allow` / `review` / `block` / `dry_run_only` / `quarantine` / `disabled` — already English. Its `status` field comes from `buildMemoryAdmissionReceipt()` and is `admitted` / `review` / `quarantined` / `rejected`. |
| Receipt bundles / `bundleHash` | **No** | Bundle envelope is `schemaVersion` / `workspaceId` / `exportedAt` / `receiptCount` / `bundleHash` / `receipts`. No verify status reaches it. |
| JSON schemas | **No** | Zero occurrences under `schemas/`. |
| SQLite graph | **No** | Zero occurrences in `graph.js` DDL or row mapping; edges store confidence/provenance/evidence, not verify verdicts. |
| Migrations | **No** | Zero occurrences under `migrations/`. |
| ATP / package-format specs and fixtures | **No** | Zero occurrences under `specs/` examples and `packages/`. |
| `agent.memory.json` | **Yes**, incidentally | `agent.js` `_rememberRun()` clones tool-result `steps`, which embed verify results. This file is **best-effort, unhashed and unsigned** (`_saveMemory()` swallows write errors), and is explicitly excluded from commits by the work protocol. |

Conclusion: **no signed or hashed artifact embeds a verify status.** Receipt
verification and bundle hashes are unaffected by anything in this change.

### Where the values actually live

Internal producers, all left untouched:

```text
lib/verify.js             lib/reasoning-trace.js
lib/semantic-score.js     lib/shield.js
kernel.js  kernel.v2.js   workflow-tools.js  agent.js  finalizer.js
```

The full list of envelope keys that carry a verify status was enumerated by
walking a live `kernel.verify()` result, not by guessing:

```text
result.data.status
result.meta.semanticTrust.status
result.meta.reasoningTrace.status
result.meta.reasoningTrace.steps[].status
result.meta.reasoningTrace.steps[].semanticTrust.status
result.meta.reasoningTrace.trustReceiptPreview.finalStatus
result.meta.trustReceiptPreview.finalStatus
```

Two key names only: `status` and `finalStatus`.

## What changed — edge adapter, not a rename

The internal vocabulary is **not renamed**. Translation happens only where the
HTTP response is serialized.

| Layer | Change |
| --- | --- |
| `lib/verify-status-vocabulary.js` | New. Canonical/legacy mapping in both directions plus `toPublicVerifyEnvelope()`. |
| `server.js` — `legacyVerify()` | Emits canonical English status. Feeds `/verify`, `/dogrula`, `/llm-sor`. |
| `server.js` — `/v2/verify` | Full envelope projected via `toPublicVerifyEnvelope()`. |
| `server.js` — `/llm-sor` | `llmCheck` projected at serialization. |
| `lib/shield.js` — `normalizeCheck()` | Now reads **both** vocabularies, so applying the adapter before or after shield cannot change a verdict. |

### Why the envelope projector is safe

`toPublicVerifyEnvelope()` applies two guards:

1. **key guard** — only `status` and `finalStatus` keys are considered;
2. **value guard** — a value is rewritten only if it is already a recognized
   verify status in either vocabulary.

So an approval `status: "pending"`, a roadmap phase `status: "done"` or a
receipt `status: "admitted"` passes through byte-identical. The projector also
returns a new object and never mutates the kernel result it was handed.

An unrecognized status degrades to `unknown`, never to `verified` — the only
correct direction of failure for a verifier.

## Other English-surface fixes

| Before | After |
| --- | --- |
| `{"error":"statement veya text gerekli"}` | `{"error":"claim, statement or text is required"}` |
| `{"error":"question gerekli"}` | `{"error":"question is required"}` |
| `{"error":"text veya content gerekli"}` | `{"error":"text or content is required"}` |
| `{"error":"İçerik çok büyük (max 1MB)"}` | `{"error":"Payload too large (max 1MB)"}` |
| `🧠 AXIOM web arayüzü: …` | `🧠 HUQAN web interface: …` |
| `   Graf görünümü: … → "Graf" sekmesi` | `   Graph view: … → "Graph" tab` |
| `Plugin yuklenemedi: …` | `Plugin failed to load: …` |
| `"service":"axiom"` | `"service":"huqan"` plus `"legacyService":"axiom"` |

## Input field

`claim` is the canonical English input field for `/verify`, `/dogrula` and
`/v2/verify`. `statement` and `text` remain accepted, in that precedence
order. Identical input through any spelling yields an identical response.

## Compatibility window

Per RFC-001's compatibility-removal rule, the legacy surfaces here cannot be
dropped in a minor or patch release. Removal of `legacyService`, of the
`statement` / `text` input aliases, or of legacy-status acceptance in
`normalizeCheck()` requires an announced breaking release with a migration
guide.

Note that legacy-status **acceptance** is cheap to keep and should probably be
kept indefinitely: it is what makes the boundary adapter order-independent.

## Known gaps — deliberately not done

These are gaps, not completed work.

### 1. MCP tool output schema still declares the Turkish enum

`mcpServer.js:94` declares:

```js
const VERIFY_STATUS = ['dogrulandi', 'celiski', 'bilinmiyor'];
```

used in the `verify` tool's declared output schema. This is a **wire contract
with external MCP clients**, with existing conformance tests and recorded
evidence artifacts under `evidence/archive/`. Changing it is a separate gate
with its own compatibility evidence, following the M1–M4 pattern in RFC-001.
It was not attempted here.

### 2. Internal / persisted vocabulary is unchanged

`lib/verify.js`, `lib/reasoning-trace.js`, `lib/semantic-score.js`,
`lib/shield.js`, `kernel.js`, `kernel.v2.js`, `agent.js`, `finalizer.js` and
`workflow-tools.js` still produce and compare the Turkish values internally.

This is intentional. The measured blast radius shows the rename is *safe with
respect to signed artifacts*, but it is wide (roughly 60 non-test call sites
plus a large body of tests asserting the literals) and is not appropriate as
an unattended change. It should be its own task pack.

### 3. Plugin body strings are hash-pinned

`plugins/*.js` are pinned by `plugins/*.manifest.json` sha256. Editing a
plugin's Turkish log line (for example `[llm-memory] Öğrenildi: …`) invalidates
its manifest hash and requires regenerating it under the plugin signing/
production-enforcement rules. Not attempted here. `plugin.js` — the loader —
is not hash-pinned and was safe to change.

### 4. CLI and web UI

`cli.js`, `public/index.html` and `demo/` remain Turkish. Out of scope for the
API-boundary work.

## Tests

- `test/verify-status-vocabulary.test.js` — mapping, idempotence, fail-safe
  degradation, the two projector guards, non-mutation, and shield vocabulary
  independence.
- `test/http-english-api-contract.test.js` — live server: `/health` identity,
  canonical statuses on `/verify`, `/dogrula` and `/v2/verify`, no legacy
  token anywhere in the serialized envelope, `claim` accepted, `statement` and
  `text` still accepted and equivalent, English error strings, and a positive
  assertion that the internal kernel representation is still `dogrulandi`.
