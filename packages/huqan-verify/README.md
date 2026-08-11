# huqan-verify

`huqan-verify` is the canonical package path for HUQAN's existing ATP / AVP
self-test helpers. It validates canonical `.huqan` package format 0.2 and
legacy `.axiom` package format 0.1 by reusing HUQAN's internal conformance
modules. Its writer emits only the canonical HUQAN format.

Its `status` is `skeleton`. It is not an independent implementation or evidence
of third-party interoperability. The legacy `packages/axiom-verify` path
re-exports this module for compatibility.
