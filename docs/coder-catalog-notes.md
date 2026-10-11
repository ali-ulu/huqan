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

## Producer projection

The catalog above is the runner's transform set. `lib/task-producer.js` projects
only the transforms a failure record can fully determine from what the record
carries — its two strings, `observed` and `expected`, plus its declared
`action.operation`:

- `replace_text` — `find` = observed, `replace` = expected.
- `insert_after` — `anchor` = observed, `insert` = expected.
- `rename_identifier` — `from` = observed, `to` = expected; both must be real
  identifiers or the producer refuses.
- `create_file` — `content` = the record's `payload.content`. A file that does
  not exist yet has no `observed` text, so this is the one row whose input is a
  payload rather than the string pair. The payload is bounded (32 KiB) and read
  from the record, never from disk; a record that declares `create_file` without
  a payload, with a non-string payload, or with one over the bound is refused
  with `CONTENT_MISSING` / `CONTENT_TOO_LARGE`, never truncated.

The declaration selects the transform; the producer never infers one from the
shape of the strings. A declared operation outside this set — `json_schema_route_test`
reads the schema from the tree rather than from the record, so a record cannot
carry what it needs — and any record whose fields do not satisfy the selected
transform's contract both return `NEEDS_HUMAN_DECISION`, never a guessed task.

A payload is bound into the failure fingerprint (#3801): two records that carry
different `payload.content` are two different records, and a record that carries
no payload keeps the id it had before payloads existed.
