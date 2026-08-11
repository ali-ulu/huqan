# axiom-verify (legacy compatibility path)

`packages/axiom-verify` re-exports the canonical `packages/huqan-verify`
self-test skeleton. Existing imports remain valid, but new code should use the
canonical path.

## What it does

- verifies ATP objects with the root conformance helpers
- verifies Trust Receipts
- verifies AVP-style verification results
- validates `.axiom` package drafts through the package format helper
- exposes HUQAN's existing self-test verification surface

## Supported protocols

- ATP v0.1
- AVP v0.1
- `.axiom` package format v0.1

## Core principle

Every serious answer should come with a receipt.

This package reuses HUQAN's internal conformance modules. It is not an
independent verifier or evidence of third-party interoperability.

## Example

```js
const huqanVerify = require('huqan/packages/huqan-verify');
const receiptResult = huqanVerify.verifyTrustReceipt(receipt);

if (!receiptResult.ok) {
  console.error(receiptResult.errors);
}
```

## Package format support

`.axiom` packages are exchange artifacts, not runtime storage.

`huqan-verify` can validate a package object or a package file path using the package-format helper.

## What it is not

- not a runtime storage engine
- not a mutation API
- not a server route
- not a dashboard
- not a cryptographic signing layer
- not a proof of absolute truth
