# Replacement sequence memory

Status: implemented in candidate storage, selection and the existing Coder
routing/gate path. This is bounded reuse of a verified textual method, not
general learning gain or automatic multi-target synthesis memory.

A successful, independently tested `sequence` with two through eight distinct
JavaScript/CommonJS `replace_text` steps can be explicitly remembered using
the existing `coder remember` command. The source task must describe the exact
sequence and its `qualificationPaths`. Its run ID is the kept loop candidate
ID, for example `source:c1`, rather than the outer loop ID.

```text
huqan coder remember source-task.json --root <repository> --journal <journal.db> --run-id source:c1 --candidate-file .huqan/coder/candidates/sequence.json --json
```

The stored candidate uses kind `replacement_sequence`, keeps `registered:false`
and binds the complete operation hash to the sealed source. Each load rebuilds
the proposal from that source and compares the record, procedure and artifact
identity. Rehashing edited replacement text cannot grant a new method.

A reuse request supplies no method text:

```json
{
  "id": "reuse-sequence",
  "level": "l0",
  "allowedPaths": ["src/alpha.js", "src/beta.cjs"],
  "operation": { "type": "sequence", "paths": ["src/alpha.js", "src/beta.cjs"] },
  "test": { "command": "node acceptance.js" }
}
```

```text
huqan coder intent.json --root <repository> --journal <journal.db> --use-memory --transfer-memory --authorize --json
```

Target paths bind positionally to the stored steps; they may differ from the
source paths. The specialized procedure keeps the source hash as its parent
and has its own version/hash. Duplicate, escaping or unsupported target paths
are refused. This does not rebind identifiers or infer the intended mapping.
The ordinary write
gate, sealed workspace/source checks, trust replay and independent test remain
mandatory. Selection supplies a proposal, never write authorization.

Qualification inputs are JSON maps from source paths to file contents. As with
existing sequence memory, provide at least two held-out inputs that exercise
the coverage gate's negative outcomes: absent old text and ambiguous matches.
The target qualification checks the complete expected output, including every
untouched file present in the input map. A failed runtime test restores the
whole sequence. Protected blockquote/fenced contexts remain refused.

Stored qualification maps retain the source paths. During reuse, the map is
rebound to the declared target paths while keeping its text unchanged; path
collisions are refused. The full target procedure is rederived and compared,
so retaining an old hash while editing target method text is not accepted.

This contract shares the existing candidate schema and journal rather than
installing a new persistence authority. A routed run cannot mint a replacement
source candidate. Multi-target synthesis can explicitly opt into this contract
with `rememberFile` and `reuseMemory`; see
[multi-target synthesis](coder-multi-target-synthesis.md). Adaptation to changed
identifiers remains unfinished work.

Validation entry point: `node --test test/experience-replacement-sequence.test.js`.
The native case reopens SQLite, reuses the method in a fresh CLI process,
checks unchanged source artifact bytes, denies unauthorized and wrong-workspace
requests, rejects paths outside allowedPaths and rehashed forged text, and verifies rollback
of both files after independent acceptance failure.
It also transfers to previously unseen target paths in a new CLI process while
leaving the original source-path files and stored candidate unchanged.
