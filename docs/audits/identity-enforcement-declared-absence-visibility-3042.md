# Identity Enforcement: Declared Absence, Visibility, and the Fail-Closed Lever — #3042

**Verdict:** `DECLARED_ABSENCE_VISIBLE__CRITICAL_PATHS_STILL_UNWIRED`

**Canonical base:** `main @ 627eb5dcad84dc159743b99653889660874d53ed`

**Evidence rule:** every count, file path and field name below is quoted from
this tree at that base. The wiring count is deliberately recorded as *still
unenforced* rather than rounded up: the point of this unit is that the
difference is now observable, not that it has been removed.

## 1. What the issue asked

Issue `#3042` corrected its own first wording. `lib/mutation-admission.js` does
**not** let enforcement disappear silently:

- `identityEvaluator` must be explicitly present in the options object;
  omitting it throws `admission.identity_enforcement_undeclared`;
- an intentionally absent evaluator must be written as `absent(reason)`;
- `absent(reason)` itself refuses an empty reason;
- the constructed seam exposes `identityEnforced`.

The remaining gap is narrower and was recorded as two acceptance criteria:

1. an `absent` passage must be **loggable and visible in the receipt**;
2. at least one test must show that a **critical mutation is refused when no
   evaluator is present**.

The issue also stated the scope is not reduced: critical paths still need real
identity evaluation **or an explicit fail-closed policy for the absence case**.

## 2. What was already true at this base (GOZLENDI)

1. **The declaration is mandatory.** `createMutationAdmission` throws
   `admission.identity_enforcement_undeclared` when `identityEvaluator` is not
   an own property of the options object, and
   `admission.identity_evaluator_invalid` for an `absent` marker that is not a
   real one. `test/mutation-admission-identity-coverage.contract.test.js` pins
   both.

2. **Every seam in runtime source has declared which of the two it is.**
   `createMutationAdmission(` appears in exactly **5** call sites across **4**
   runtime files:

   ```text
   lib/external-client-mutation-receipt-owner.js   2  (1 enforced, 1 declared absent)
   lib/http/identity-mutation-admission.js         1  (enforced)
   lib/kernel-mutation-admission.js                1  (declared absent)
   lib/mcp-ingest-execute-tool.js                  1  (declared absent)
   ```

   The enforced/absent split is the ledger in
   `test/mutation-admission-identity-coverage.contract.test.js`, which fails if
   a site is added or moved without a number changing.

## 3. What was missing, and what changed (DEGISTI)

`identityEnforced` reported the seam's construction, but every `admit()` result
looked identical whether identity had been judged or merely declared absent.
The caller that writes the receipt therefore could not tell the two apart, and
neither could an operator reading the audit trail. Two changes close that.

### 3.1 The decision carries the state it was reached in

`lib/mutation-admission.js` now publishes `IDENTITY_STATES` and returns one of
three states on every admitted decision, plus the declared reason when there is
one:

| `identityState` | Meaning |
| --- | --- |
| `enforced` | an evaluator was configured and returned allow |
| `absent` | no evaluator; the context's own claim was declared absent with a reason |
| `not_evaluated` | a real claim was supplied but no evaluator judged it |

`not_evaluated` is a third state on purpose. Folding it into `absent` would
report an unjudged real claim as a declared absence, which is the opposite of
what it is. The state also travels into the `mutate` callback, so a record
written *during* the mutation can name the state it was written in; reading the
returned decision afterwards is too late, because the write has happened.

### 3.2 The durable records name the state

`lib/workbench/ingest-approval-audit-writer.js` stamps the state into the audit
event and the trust-evidence event, and exposes a receipt posture:

- the **audit event** (`details.identityState`, `details.identityReason`) and
  the **ledger evidence event** (`metadata.identityState`,
  `metadata.identityReason`) are built *inside* the admitted write, so they
  carry the decision that was actually reached -- `enforced` when an evaluator
  allowed the mutation, `absent` with the context's declared reason when it did
  not;
- the **receipt** is stamped by `lib/workbench/ingest-approval-action.js` from
  the seam's permanent wiring posture, because the action owner finalizes the
  receipt *before* the audit write runs and therefore before this approval's
  admission exists. Two facts are knowable at that moment and they are not the
  same kind of fact:

  | Seam wiring | Receipt `identityState` | Why |
  | --- | --- | --- |
  | no evaluator | `absent` + declared reason | permanent: this seam will never judge identity |
  | evaluator present | `not_evaluated` | a gate exists, but this approval has not passed it yet |

  Stamping `enforced` on the receipt would label it judged before the admission
  ran, and a subsequent refusal would leave the finalized receipt carrying that
  false label. The receipt says what is true when it is written; the audit and
  ledger events are the records to read for the decision. The receipt is
  therefore **not** operation-cached: a reused writer reports the same wiring
  posture for every approval, so one approval's state can never be stamped onto
  another's receipt.

The two reasons are scoped differently by design: the receipt states why the
writer was wired without an evaluator, the events state why this particular
mutation's identity claim was absent. In production both are the same text;
they diverge only when a caller supplies a custom `identityContext`.

### 3.3 The fail-closed lever for the absence case

`createMutationAdmission` now accepts `identityPolicy`:

| Policy | Behaviour |
| --- | --- |
| `optional` (default) | today's behaviour; the declared absence admits and the decision reports `absent` |
| `required` | only `enforced` admits; `absent` **and** `not_evaluated` are refused with `admission.identity_required` before the effect is reached |

A `required` policy on a seam that already has an evaluator is refused as a
contradiction (`admission.identity_policy_conflict`), and an unrecognised policy
value is refused (`admission.identity_policy_invalid`). This is the explicit
fail-closed policy the issue asks for: a critical path can refuse every
mutation that arrives without enforced identity rather than admitting it on
context shape alone.

`required` refuses `not_evaluated` as well as `absent`. A real claim that no
evaluator judged is still a mutation that arrived without an enforced identity;
admitting it would make the policy's own description false. `enforced` is the
only state a `required` seam admits.

## 4. What is still true and must not be claimed away

The production seams are **still unenforced**. Three of the five construction
sites declare `absent(reason)`, and no `identityPolicy: 'required'` is set on
any of them yet. The change makes that fact:

- visible on every decision (`identityState`);
- visible in the audit trail, the ledger evidence and the receipt;
- refusable, on a per-seam basis, by a one-line policy change.

It does **not** wire a receiver-owned identity claim into the kernel, MCP or
HTTP ingest paths, and it does not flip any critical path to `required`. Moving
an entry from `DECLARED_ABSENT_CONSTRUCTIONS` to `ENFORCED_CONSTRUCTIONS` in
`test/mutation-admission-identity-coverage.contract.test.js` remains the finish
line for P1-A.

## 5. Acceptance evidence

| Issue criterion | Where it is proved |
| --- | --- |
| `absent` is visible in the receipt | `test/ingest-approval-audit-evidence.test.js` — the finalized receipt carries `identityState: 'absent'` and its reason |
| `absent` is loggable / visible in evidence | `test/ingest-approval-audit-writer.test.js` — the audit event and the ledger evidence payload both carry the state |
| a receipt is never pre-labelled `enforced` | `test/ingest-approval-audit-writer.test.js` — an evaluator-backed seam records `not_evaluated` on the receipt while the audit event records the `enforced` decision |
| a reused writer cannot cross approvals | `test/ingest-approval-audit-writer.test.js` — the posture is identical for every approval, so a second approval cannot inherit a first one's state |
| an enforced seam is not confused with a declared absence | `test/mutation-admission.test.js` — `enforced`, `absent` and `not_evaluated` are asserted separately |
| a critical mutation is refused when no evaluator is present | `test/mutation-admission.test.js` — `identityPolicy: 'required'` refuses with `admission.identity_required` and the mutation callback is never called |
| a `required` seam also refuses an unjudged claim | `test/mutation-admission.test.js` — a real claim with no evaluator is refused rather than reaching the effect |
