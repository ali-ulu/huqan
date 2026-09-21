# Migrating from KernelV1 to KernelV2

`require('huqan').KernelV1` is deprecated since 0.12.0 and will be removed in
1.0.0. The default export of `require('huqan')` is already KernelV2.

## Replace

```js
// Before.
const { KernelV1 } = require('huqan');
const kernel = new KernelV1(opts);

// After.
const KernelV2 = require('huqan');
const kernel = new KernelV2(opts);
```

## Notes

- `require('huqan').ProvenanceError`,
  `require('huqan').createAdmissionBypassOpts(...)`, `AXIOM_ERROR` and
  `CONTRACT_VERSION` are unchanged live call patterns: they forward the same
  objects the kernel throws, so `instanceof` checks keep working.
- Constructing `KernelV1` emits a `DeprecationWarning` naming this guide;
  requiring the package does not warn.
