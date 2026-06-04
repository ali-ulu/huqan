# AXIOM v0.8 PR-10.1 Blocker Triage

| ID | Exists | Severity | Files | Minimal Fix | Test | Release Blocker |
|---|---|---|---|---|---|---|
| AUDIT-1 | fixed | high | lib/audit-log.js, lib/audit-log.test.js | explicit empty workspaceId no longer broadens scope | node --test lib/audit-log.test.js | yes |
| KERNEL-1 | fixed | high | kernel.js, server.test.js | REJECT audit events now use caller workspace | node --test server.test.js | yes |
| PR7-1 | fixed | high | lib/provenance-query.js, lib/provenance-query.test.js | shadowed canonical records no longer surface as canonical receipts | node --test lib/provenance-query.test.js | yes |
| SRV-5 | fixed | high | server.js, server.test.js | trust endpoints now respect existing API key guard | node --test server.test.js | yes |
| PROV-SRC | fixed | high | lib/provenance-ingest.js, lib/provenance-ingest.test.js | invalid sourceType normalizes in non-strict mode, rejects in strict mode | node --test lib/provenance-ingest.test.js | yes |
| PROV-CRANGE | fixed | high | lib/provenance-ingest.js, lib/provenance-ingest.test.js | confidence clamps to 0..1 in non-strict mode, rejects in strict mode | node --test lib/provenance-ingest.test.js | yes |
| AXPKG-1 | fixed | high | lib/axiom-package-format.js, lib/axiom-package-format.test.js | x-* extensions are now handled explicitly | node --test lib/axiom-package-format.test.js | yes |
| AXPKG-4 | fixed | medium | lib/axiom-package-format.js | atpVersion validation uses named supported constant | node --test lib/axiom-package-format.test.js | yes |
| AXPKG-11 | fixed | high | lib/axiom-package-format.js, lib/axiom-package-format.test.js | package index now validates reference collections, not only object types | node --test lib/axiom-package-format.test.js | yes |
| AXPKG-13 | fixed | high | lib/axiom-package-format.js, lib/axiom-package-format.test.js | objectCounts warnings run even when manifest has other errors | node --test lib/axiom-package-format.test.js | yes |
| AXPKG-SC5 | fixed | high | specs/axiom-package-format/0.1/schemas/axiom-object-ref.schema.json | dead schema removed | node --test lib/axiom-package-format.test.js | yes |
