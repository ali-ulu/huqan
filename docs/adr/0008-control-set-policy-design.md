# ADR-0008: #2505 control set — decision design (Codex)

Tarih: 2026-09-25. Kaynak: Codex tasarım belgesi (kullanıcı aracılığıyla
taşındı), baz: `origin/main 5d486d374e1a8ef93b6e67b26f8a039032557e3e`.
Durum: **implementation design, not an enabled policy** — aşağıdaki sayısal
değerler önerilen başlangıç limitleridir; gözlenmiş HUQAN trafiği veya
sahip-onaylı üretim politikası değildir. Kayıt-öncelikli dilimler
(#2881–#2889) bu belgenin 1. adımını karşılar; yaptırım için 4. adımdaki
sahip-imzalı politika sürümü şarttır.

Aşağıdaki gövde Codex metninin birebir transkripsiyonudur.

---

# #2505 control set: decision design

Status: **implementation design, not an enabled policy**. Base: `origin/main`
`5d486d374e1a8ef93b6e67b26f8a039032557e3e`, 2026-09-25. This document
specifies the remaining A/B/D/E/G/H/I/J/K decisions together so one control
cannot silently contradict another. Numeric values below are proposed initial
limits; they are not assertions about observed HUQAN traffic or an owner-approved
production policy.

## Source boundary

`lib/session-impact.js` derives totals from verified receipt history, but a
truncated window can omit earlier actions. It records refusal retries by tool
name and input digest; `null` means unread, not zero. `lib/delegation-service.js`
validates plan count/depth/agent bounds without executing or measuring time.
`lib/financial-action-policy.js` holds all financial actions for review.
`lib/agent-capability-report.js` produces a deterministic, unpublished report.
`lib/receipt/v4-receipt-family.js` requires `riskScore === 0` for the frozen
external candidate V2 writer. The public receipt, VC and OTel mappings expose
exactly seven disclosure fields. These are implementation facts, not evidence
that the remaining controls are enforced.

## Shared rules

1. A policy has a stable `policyVersion`, scope, owner, effective time, numeric
   limits and a signed approval record. A gate records the version and the
   evaluated inputs, then returns `allow`, `review`, `quorum` or `block`.
   Unknown evidence cannot produce `allow`. `quorum` is a held approval state,
   never an action that has already run.
2. Separate **risk score** (0–100 per action) from **impact units** (sum of
   admitted action scores). A risk score is an ordinal gate input; the sum is
   an exposure budget, not a probability or a prediction of monetary loss.
   Denied attempts do not consume action budget; they feed bypass signals.
3. A decision record contains `decisionId`, idempotency key, workspace/run/
   session/agent/task identities, action class, risk and impact inputs,
   threshold snapshot, unknown reasons, verdict, approval reference, UTC time,
   and the hash of its canonical input. Raw tool arguments and output bytes
   are not copied into the control record. Store an output digest and a
   separately access-controlled output reference when output retention is
   authorized.
4. Existing V4 and ATP bytes, hash chains and schema versions stay frozen.
   New policy evidence is a separate linked record or a new versioned HTP
   artifact. A verifier must verify both the original receipt and the link;
   the absence of new evidence never retroactively invalidates a legacy
   receipt. It does prevent a new action from claiming the new policy passed.
5. A test of a pure evaluator is not production wiring. Each gate needs a
   caller trace, durable state test, fail-closed test, replay test and a
   runtime receipt before its issue box can be checked.

## A and I: cumulative impact, approval scaling, bypass signals

**Proposed initial policy** (explicitly pending replay and owner approval):

| Scope | Review at | Quorum at | Block at |
| --- | ---: | ---: | ---: |
| Run impact units | 200 | 300 | 400 |
| Session impact units | 400 | 600 | 800 |

The decision uses the **projected** total including the proposed action; the
strictest applicable per-action, run, session, authority-tier or sector verdict
wins. Equality triggers the stated band. The approval applies to that exact
action digest only and cannot reset a budget. A blocked total cannot be
overridden by ordinary review. Session boundaries cannot reset the run counter,
and a new run cannot escape a task-scoped or principal-scoped limit. Before any
production enforcement, replay at least 30 days of verified receipts and
publish false-block counts, missing-score rates and threshold distribution;
if data coverage is inadequate, keep the gate in `review` for unknown, not
`allow`. These values are starting hypotheses, not statistically calibrated
limits.

The current receipt-history summary is **display input only**. Enforcement
requires an atomic, durable, workspace-scoped budget ledger keyed by policy
version and run/session identity. Reserve impact before execution; commit on
admission; release a reservation on confirmed non-execution. Duplicate
idempotency keys return the prior verdict without double charge. A timeout,
truncated history, unverifiable receipt, missing score, missing scope, or
unavailable ledger holds the action for review; a high-risk/irreversible action
blocks. A child A2A run gets `min(parent remaining, delegated ceiling)` and
cannot widen it. Parent and child reservations share one durable accounting
root so concurrent children cannot overspend.

Bypass evidence is separate from impact: repeated verified refusal fingerprint
within a session, a sandbox escape attempt, identity widening and unexpected
egress. **Proposed initial response:** second identical blocked attempt within
10 minutes → review of the run; third → block that fingerprint for the run and
propose emergency stop to an operator. One verified sandbox escape attempt or
one unauthorized identity widening → block the attempted action and propose
emergency stop. Unexpected egress keeps its deployment-defined review/block
policy. No automatic emergency stop from a merely missing or unverified
signal. Cross-session aggregation uses an agent identity plus workspace and
a bounded 24-hour window; absent identity is unknown and cannot be treated
as a clean history. Store only digest, count, time and receipt reference.

## D: financial actions

The existing `review` default remains. A payment is never auto-allowed by an
impact score. Parse an exact positive decimal amount and ISO currency without
floating-point conversion; require a validated destination identity, explicit
reversibility and an authorized payment capability bound to the task. Missing
or ambiguous fields block execution and request review of the proposed action.
No live exchange-rate conversion is inferred; each currency has an owner-signed
limit table. Proposed starter USD bands: up to 100 requires one independent
reviewer, over 100 through 1,000 requires quorum, over 1,000 blocks pending a
separate payment mandate. Other currencies remain held for review until their
own limits are approved. Splitting related payments does not avoid a limit:
sum by destination, task and 24-hour window in a durable ledger. A reviewer
cannot approve their own agent's payment. Record the assessment and final
execution outcome separately.

## E: delegation and spawn rate

Keep the present plan bounds (fan-out 4, tasks 16, depth 4, agents 8) as a
**plan validation** limit. Before execution routing, check the same bounds
against active descendants and reserve a spawn slot atomically. Proposed
rate: at most 4 starts per parent agent per rolling 60 seconds and 16 starts
per workspace per rolling hour; equality is allowed, the next start is held
for review, and an unverified identity or unavailable counter blocks spawning.
A rejected or timed-out start never consumes a slot; a confirmed start does,
even if the child later fails. Check service creation through the same path.
Clock time comes from the ledger service, not caller-supplied timestamps. Receipt
fields include measured count/depth/rate, window, limit, reservation ID and
verdict. Validation-only `DelegationService` must not be reported as
runtime enforcement until every production spawn path reaches this boundary.

## B and G: justification, durable record, reversibility

The internal decision evidence is a versioned object with risk value or
`unknown`, five dimension inputs (action class, breadth, dependency,
reversibility, boundary), applicable threshold snapshot, reason code and
human-readable explanation. Keep this in the Trust Evidence Ledger and bind
it to the action receipt hash with a typed link. MCP decisions use that same
evidence vocabulary, including allow decisions. Every action also records
output hash or explicit `output_unavailable` reason. An output hash proves
byte correspondence only; it does not prove output truth or safety.

For reversibility record `reversible`, `compensatable`, or `irreversible`, the
authority able to perform the reversal, time limit, and operation/receipt
reference. No rollback link means `unknown`, not `reversible`. A compensation
is a new governed action with its own receipt, never deletion of history.
Durable ledger append failure prevents an externally consequential action
from executing; if execution already occurred, preserve an incident record
and reconcile rather than fabricate a successful receipt.

**V4 decision:** retain the exact `riskScore === 0` requirement for the
frozen external candidate V2 writer. Here zero is a legacy contract value,
not a claim that risk was computed as zero. Put measured risk and justification
in a separately versioned, hash-linked policy evidence record. A future V4
schema version may carry it only after an explicit lineage RFC, migration
vectors and writer/verifier release; never relabel historical V1/V2 receipts.

**Public/VC/OTel decision:** the present seven-field disclosure remains exact.
Do not put raw justification, actor, workspace, destination or output in a
public receipt or telemetry attribute. Define a new public schema version
only after a field-by-field privacy review. The proposed public addition is
one opaque `policyEvidenceHash` plus a coarse `riskAssessmentStatus`
(`computed`/`unknown`); it carries no private rationale. Version the redaction
allowlist, checksum, signed projection, JSON schema, fixtures, import/export,
VC subject and OTel mapping together. Old versions remain importable and map
only their original seven fields. VC remains an envelope; its proof must not
claim the envelope itself was signed. OTel output must not be treated as an
independent trust verifier.

## H and J: independent evaluation and calibration

For each release, an evaluator distinct from the implementation author signs
an evaluation record binding release SHA, suite/fixture digests, evaluator
identity, environment, pass/fail counts, critical findings, accepted risk and
expiry. A failed or missing record blocks release publication; an external
third-party claim requires actual external evaluator evidence. Publish a
redacted protocol artifact plus its hash, and retain full findings under
restricted access. A CI run by the same author is internal evaluation.

Treat each risk estimate as a **prediction record** made before the action.
Pair it by immutable decision/action ID with a later outcome: reviewer
rejection, rollback/compensation, contradiction, incident, or a censored
observation window. A missing outcome is `unknown`, never success. Track
calibration by score band and action class, with sample count, observation
window, false-block and missed-incident rates; avoid one global accuracy
number. Existing `hypothesis-fitness` and `fitness-history` measure graph
hypotheses, so an explicit adapter and separate metric namespace are needed;
do not feed action outcomes into their graph-rule denominators. Tuning may
propose weights or thresholds with old/new values, data hashes and expected
tradeoffs, but never apply them. A human-approved, receipted policy version
and replay tests are required for any change. Roll back by restoring the prior
signed policy version, not by rewriting old decisions.

## K: capability report, sector policy, incident exchange

Publish the current deterministic capability report through a new, versioned
HTP artifact bound to card hash, measurement window, source receipt root and
issuer signature. Distinguish declared authority from observed reach and
from enforced limits. `null`, partial and stale measurements remain visible;
publication is refused if the card identity cannot be verified. Export a
public projection only after redaction, with no raw task IDs or target names.

Sector policy is an overlay signed by a deployment owner. It can **tighten**
general limits, require more reviewers, forbid an action class, or require
residency; it cannot silently relax the global guard. No sector label is
inferred from content. Finance, health and critical infrastructure profiles
start at `review` for unknown classifications, with explicit owner-selected
action classes and thresholds. Calling a profile compliant with a regulation
requires separate legal and operational evidence; this design makes no such
claim.

Incident notification has a versioned private envelope: incident ID, event
times, reporter and recipient authority, class (`cyber`, `biological`,
`other`), severity, affected scope, evidence hash, containment status,
contact channel, disclosure basis, and correction/supersession reference.
Send only to a configured authorized recipient after human approval. A
cross-border exchange is a separate signed, minimized projection with
jurisdiction, permitted purpose, recipient and retention limit; no automatic
transmission is implied. Biological misuse classification triggers restricted
handling and expert review, not a detailed public payload. Keep delivery
receipt, failure and retry state without storing sensitive source content in
general telemetry. Notification deadlines and recipients are deployment and
jurisdiction decisions, not guessed in code.

## Implementation order and acceptance

1. **Contract tests and replay corpus:** pin frozen receipt/public vectors,
   collect complete verified impact histories, measure missing data and
   replay the proposed thresholds without changing decisions.
2. **Durable gate foundations:** budget/reservation ledger, delegation clock
   counter, financial aggregation and cross-session bypass state; test
   concurrent children, duplicate keys, crash recovery and ledger loss.
3. **Runtime wiring:** bind each production action, MCP, spawn and external
   output path to the relevant gate. Prove denied action cannot execute and
   every successful action has a durable linked decision.
4. **Policy activation:** obtain an owner-signed policy version using replay
   evidence; activate one scope at a time with a recorded rollback plan.
5. **Evidence publication:** internal linked record first, then versioned
   public/VC/OTel package and conformance vectors. Add release evaluation,
   calibration feed, capability report publisher and incident exchange as
   separate contract changes.

No box in #2505 becomes complete from this document alone. Completion needs
the corresponding caller, tests, mutation/failure cases, CI and runtime
evidence. This document supplies a concrete design for every pending area;
the owner must approve the numeric policy before enforcement is enabled.
