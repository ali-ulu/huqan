# V5-VERIFICATION-13 - Trusted-Key Resolver Implementation Task-Pack

**Mode:** Implementation task-pack definition only
**Current checkpoint:** V5-VERIFICATION-12_CLOSEOUT_AUDIT_GREEN
**Canonical branch:** main
**Required base:** main @ 794219023d09d64e4438bff7141bad92b06fbf98

## Purpose

V5-VERIFICATION-13 locks the exact decisions required for the next
separately authorized trusted-key resolver implementation gate. V13 itself is
docs-only and creates no code.

The future implementation-and-test PR may create exactly:

~~~
lib/v5/trusted-key-resolver.js
test/v5-trusted-key-resolver.test.js
~~~

No other file is pre-authorized by this task-pack.

## Exact Future File Scope

The separately authorized implementation gate may modify only the two files
listed above. It must not modify fixtures, verification-core, schemas,
validators, package metadata, dependencies, runtime reader/writer modules,
MCP surfaces, or docs. The existing 12 fixture files are read-only inputs.

## Exact Public API

The future module must follow the existing V5 named-export CommonJS
convention:

~~~
const { resolveTrustedKeyState } = require('../lib/v5/trusted-key-resolver');
~~~

The exact export is:

~~~
module.exports = {
  resolveTrustedKeyState
};
~~~

The function is synchronous and accepts exactly one argument:

~~~
resolveTrustedKeyState({
  keyReference,
  records,
  evaluationTime
});
~~~

It returns a bounded result and does not throw for caller-supplied
JSON-compatible or otherwise inspectable input. All malformed, unsupported, or
unsafe input failures return the canonical malformed result. Exception details
must never appear in the result.

## Exact Input Contract

The root input must be a plain object with exactly these own enumerable keys:

~~~
keyReference
records
evaluationTime
~~~

No additional root key is allowed.

keyReference is required, a string, non-empty after trimming, without leading
or trailing whitespace, and no longer than 256 code units. Matching uses exact
string equality with no coercion, case folding, or normalization.

records is required and must be an array. It may be empty; an empty array
produces unknown. Each entry must be a plain object. Array order must not
determine the result. The input array and record objects must not be mutated.

Each record contains only these own enumerable keys:

~~~
keyReference
status
expiresAt
~~~

Record keyReference uses the bounded string rules. Record status is one of the
six canonical states. expiresAt is optional and, when present, is a canonical
UTC timestamp. No nested public metadata object is authorized. Unknown record
keys are malformed.

evaluationTime is required and must use this exact form:

~~~
YYYY-MM-DDTHH:mm:ss.sssZ
~~~

The implementation parses timestamp instants numerically after validation. It
does not compare timestamp strings lexically, use local-time defaults, accept
an implicit timezone, or infer a timezone.

Malformed, null, array, non-object, wrong-type, unknown-field, and
non-canonical timestamp inputs return the canonical malformed result.

## Exact Output Contract

The output is a new plain object with no additional properties.

Active returns:

~~~
{ "keyState": "active" }
~~~

Every non-active state returns exactly:

~~~
{
  "keyState": "unknown|revoked|expired|unavailable|malformed",
  "reasonCategory": "existing_reason_category"
}
~~~

No output may contain explanation, trust score, authorization verdict, key
material, provider/network metadata, input records, added timestamps,
unspecified properties, or exception details.

## Canonical State and Reason Vocabulary

Only these states are permitted:

~~~
active
unknown
revoked
expired
unavailable
malformed
~~~

The exact existing reason mapping is:

~~~
unknown     -> unknown_key
revoked     -> revoked_key
expired     -> expired_key_metadata
unavailable -> key_lookup_unavailable
malformed   -> malformed_trusted_key_record
active      -> reasonCategory omitted
~~~

No alias, paraphrase, or new state or reason category is allowed.

## Canonical Evaluation Order

Earlier failures dominate later checks. The future implementation must follow:

1. malformed overall input -> malformed / malformed_trusted_key_record
2. malformed keyReference -> malformed / malformed_trusted_key_record
3. unknown or forbidden root field -> malformed / malformed_trusted_key_record
4. recursive secret/private-key/key-material content -> malformed /
   malformed_trusted_key_record
5. recursive network/provider metadata -> malformed /
   malformed_trusted_key_record
6. malformed record structure -> malformed / malformed_trusted_key_record
7. more than one matching record -> malformed / malformed_trusted_key_record
8. no matching record -> unknown / unknown_key
9. unavailable matching record -> unavailable / key_lookup_unavailable
10. revoked matching record -> revoked / revoked_key
11. expired active record -> expired / expired_key_metadata
12. bounded active record -> { keyState: active }

No failure may fall through to active. Not revoked is not an active condition.

## Expiry Semantics

All comparisons use parsed timestamp instants and the supplied evaluationTime:

~~~
expiresAt < evaluationTime  -> expired
expiresAt == evaluationTime -> expired
expiresAt > evaluationTime  -> eligible to continue toward active
~~~

Validity ends at the expiry instant. Malformed expiresAt returns malformed /
malformed_trusted_key_record. No lexical comparison, system clock, Date.now(),
implicit current time, local-time default, or timezone inference is allowed.

## Record Matching and Duplicate Handling

The exact matching predicate is:
record.keyReference === input.keyReference.

No coercion, case folding, trimming, fallback, or normalization is applied
during matching.

~~~
zero matching records      -> unknown / unknown_key
one matching record        -> evaluate that record
more than one matching    -> malformed / malformed_trusted_key_record
~~~

Identical duplicates remain ambiguous. No first-match, last-match, merge,
precedence, or fallback behavior is allowed. Reordering records cannot change
a bounded result.

## Recursive Forbidden-Field Detector

The detector recursively traverses plain objects, nested objects, arrays, and
arrays of objects. The canonical field concepts are:

~~~
privateKey
private_key
private-key
secret
token
credential
password
keyMaterial
key_material
pem
certificate
jwk
provider
endpoint
networkEndpoint
network_endpoint
url
uri
~~~

Rules:

- inspect own enumerable string keys only
- normalize only by lowercase comparison
- preserve underscores and hyphens; do not remove punctuation or invent aliases
- arrays are traversed in every position
- null is not an object and is malformed where an object is required
- non-plain objects are malformed
- inherited properties cannot supply accepted fields
- non-plain prototypes are rejected
- PEM/private-key block markers and equivalent key-material text are rejected
- provider, endpoint, URL, and network configuration are covered by the
  canonical fields and values above

No additional forbidden vocabulary is introduced. No generic metadata bag may
bypass the record allowlist.

## Unknown Fields and Error Policy

The only root keys are keyReference, records, and evaluationTime. The only
record keys are keyReference, status, and expiresAt. There is no authorized
nested public metadata object.

Every supplied value is untrusted input. Invalid input returns:

~~~
{ keyState: malformed, reasonCategory: malformed_trusted_key_record }
~~~

Nulls, arrays, primitives, wrong types, unknown fields, malformed timestamps,
forbidden content, and invalid records do not throw. Exception details never
appear in output. No separate programmer-misuse exception API is introduced.

## Immutability and Determinism

The implementation and tests must prove that the root input, records array,
record objects, and fixture objects are not mutated, reordered, or annotated.
No hidden cache or module-global mutable state is allowed.

Same semantic input plus the same fixed evaluationTime must produce deep-equal
output on every execution. Behavior must not vary with record order,
environment variables, locale, host timezone, randomness, network state,
database state, filesystem writes, or hidden global state.

## Exact Fixture Mapping

Every existing fixture appears exactly once:

| Fixture | Step | State | Reason | Assertion |
| --- | ---: | --- | --- | --- |
| 01-active-key-reference.json | 12 | active | omitted | one bounded active match |
| 02-unknown-key-reference.json | 8 | unknown | unknown_key | no matching record |
| 03-revoked-key-reference.json | 10 | revoked | revoked_key | explicit revoked match |
| 04-expired-key-metadata-boundary.json | 11 | expired | expired_key_metadata | expiry before fixed time |
| 05-lookup-unavailable.json | 9 | unavailable | key_lookup_unavailable | unavailable match |
| 06-malformed-key-reference.json | 2 | malformed | malformed_trusted_key_record | empty reference |
| 07-unknown-top-level-metadata.json | 3 or 6 | malformed | malformed_trusted_key_record | unknown record field |
| 08-nested-secret-private-key-material.json | 4 | malformed | malformed_trusted_key_record | recursive private material |
| 09-nested-network-provider-metadata.json | 5 | malformed | malformed_trusted_key_record | recursive network field |
| 10-unsafe-key-material-alias.json | 4 | malformed | malformed_trusted_key_record | array alias rejection |
| 11-ambiguous-duplicate-record.json | 7 | malformed | malformed_trusted_key_record | duplicate rejection |
| 12-deterministic-repeat.json | 12 | active | omitted | repeated active result |

The 07 fixture may be asserted at step 3 or step 6, but its final bounded
result remains identical. Additional synthetic cases are planned only for
expiry equality, immutability, record-order independence, repeated execution,
and malformed timestamp behavior. The fixture corpus remains unchanged.

## Required Future Test Groups

test/v5-trusted-key-resolver.test.js must cover:

- API and malformed-input validation
- allowed and unknown root fields
- recursive forbidden-material rejection
- record structural validation
- record selection and duplicate ambiguity
- state evaluation
- expiry <, ==, and > boundaries
- fixture corpus execution
- determinism and immutability
- record-order independence
- exact output-shape restriction
- verification-core handoff shape boundary
- permanent non-claims

No artificial target test count is prescribed.

## Verification-Core Boundary

The resolver may provide bounded key-state information as a separate input to
the existing verification-core contract. Tests may prove shape compatibility
only. They must not modify verification-core, bypass payload/digest identity,
algorithm, or signature-evidence checks, perform cryptographic verification,
or produce trust or authorization decisions.

## Implementation Algorithm Pseudocode

~~~
resolveTrustedKeyState(input):
  if input is not a plain object:
    return malformed result
  if root keys are not exactly keyReference, records, evaluationTime:
    return malformed result
  if keyReference is not bounded:
    return malformed result
  if evaluationTime is not canonical UTC:
    return malformed result
  evaluationInstant = parse evaluationTime
  if parsing fails:
    return malformed result
  if records is not an array:
    return malformed result
  recursively scan all records for forbidden fields and values
  if forbidden content is found:
    return malformed result
  if any record is not plain:
    return malformed result
  if any record key is outside keyReference, status, expiresAt:
    return malformed result
  if any record field has invalid type or timestamp:
    return malformed result
  matches = records where record.keyReference === keyReference
  if matches.length > 1:
    return malformed result
  if matches.length === 0:
    return unknown result
  record = matches[0]
  if record.status === unavailable:
    return unavailable result
  if record.status === revoked:
    return revoked result
  if record.status is not active:
    return malformed result
  if expiresAt exists:
    expiryInstant = parse expiresAt
    if expiryInstant <= evaluationInstant:
      return expired result
  return { keyState: active }
~~~

The implementation constructs fresh bounded output and returns without mutating
input.

## Planned Validation Commands

The separately authorized implementation gate must run:

~~~bash
node --test test/v5-trusted-key-resolver.test.js

node --test ^
  test/v5-trusted-key-resolver-fixtures.test.js ^
  test/v5-trusted-key-resolver.test.js ^
  test/v5-verification-core.test.js

npm test

git diff --check main...HEAD
git diff --name-only main...HEAD
git status --short
~~~

## Future Implementation Gate Boundary

When separately authorized, the next implementation gate may modify only:

~~~
lib/v5/trusted-key-resolver.js
test/v5-trusted-key-resolver.test.js
~~~

No other file is pre-authorized. V14 is not started by this docs-only task-pack.

## Permanent Non-Claims

This task-pack does not mean that any of the following exists:

- real cryptographic verification
- certificate parsing or chain validation
- live key store
- network or database provider
- key generation or rotation
- revocation service
- package trust decision
- authorization decision
- A2A or connector enforcement
- runtime exchange, transport, or persistence
- a V5-complete system

## Forbidden Scope In V13

V13 must not contain resolver implementation, test implementation, fixture
changes, verification-core changes, schema or validator changes, package or
dependency changes, crypto or certificate code, runtime or MCP changes,
network/database/key-store integration, trust/authorization output, or broad
staging.

## Exit Criteria

The docs-only task-pack may close only if the only changed file is:

docs/v5/v5-verification-13-trusted-key-resolver-implementation-taskpack.md

Also required:

- git diff --check main...HEAD passes
- V7-V12 and V11A remain consistent
- exact API, input, output, error, state, reason, expiry, duplicate, and
  recursion policies are fully pinned
- all 12 fixtures are mapped exactly once
- no code, fixture, schema, package, runtime, or MCP file changes
- no implementation authorization leaks into V13
- no trust, authorization, or V5-complete claim exists

No next gate is opened automatically.

