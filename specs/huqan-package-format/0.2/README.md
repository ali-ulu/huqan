# HUQAN Package Format 0.2

This directory defines the canonical HUQAN exchange package wire format.

The manifest discriminator is the exact tuple:

```json
{
  "format": "huqan-package",
  "formatVersion": "0.2",
  "protocolVersion": "0.1"
}
```

`protocolVersion` is the product-neutral replacement for the legacy
`atpVersion` field. It identifies the embedded portable trust-object contract;
it does not claim a successor protocol or alter receipt/bundle schema versions.

Writers emit this format with a `.huqan` or `.huqan.json` suffix. Readers also
accept the frozen AXIOM package 0.1 tuple and retained `.axiom.json` fixtures.
Mixed legacy/canonical discriminator fields are invalid.

The package is an exchange artifact, not mutable runtime storage. Version 0.2
does not remove legacy reader support and does not claim third-party
interoperability.
