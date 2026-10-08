Catalog release notes.

Current transform catalog: v1.3.0.

v1.3.0 adds two transforms; no existing transform changes its output.

- `create_file` -- `{ path, content }`. Writes a file that does not exist yet;
  refused with `FILE_ALREADY_EXISTS` when the path already holds content.
- `sequence` -- `{ steps: [...] }`. Runs up to 50 steps (any transform except
  another `sequence`) in order on the same file map, all or nothing, and records
  them as one derivation with one patch entry per file. A failing step is
  reported as `STEP_<n>_<reason>` and nothing is written.

A sequence is how a multi-edit fix stays one coder run on a clean tree and one
record that PR Guardian can re-derive against the PR base.
