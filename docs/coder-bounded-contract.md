# Bounded Coder contract and claim boundary

Coder is a bounded executor, not an autonomous general-purpose coder. It runs a
*task-described* deterministic transform through the ordinary code-change gate;
it does not diagnose an arbitrary repository from a free goal, and nothing here
claims arbitrary autonomous bug discovery or general code correctness.

## The one release-grade path

`test/coder-e2e-contract.test.js` holds the whole chain in a single public-CLI
path, on a real Git repository and the real journal, with no mocked I/O:

```
ErrorPrevention.recordFailure()  (verificationStatus:'verified')
  -> produceTask(failure)                                  lib/task-producer.js
     => { operation:{type:'replace_text', path, find, replace} }
  -> coder <task.json> --authorize --root <feature-branch> lib/cli-coder.js
     -> code-change gate                                   lib/code-change-gate.js
     -> bounded fix loop (apply, independent test, rollback) lib/coder/fix-loop.js
     -> independent file read-back                          lib/coder/apply-derivation.js
     -> journal provenance (run_closed verdict `complete`)  lib/coder/experience-reporter.js
```

The same file pins the boundary in both directions:

- A failed candidate is rolled back before the next candidate is tried; the
  accepted candidate changes exactly the declared file.
- A denied (main branch), review-required (dirty tree), or unavailable
  repository state produces no target-file write and runs no test process.
- Learned routing refuses source evidence that is not sealed and present in the
  journal, and does not fall back to an unwritten patch.

## Supported boundary

- Operation: the deterministic catalog `replace_text`, `insert_after`,
  `rename_identifier`, `create_file`, `sequence` (`docs/coder-catalog-notes.md`).
- Targets: only paths declared in `allowedPaths`, under a clean feature-branch
  Git root, through the existing mutation gate.
- Acceptance: an operator-supplied independent `test.command`; Coder never
  supplies its own acceptance oracle.

Anything outside that boundary -- free-form goals, arbitrary bug diagnosis,
targets the task does not name -- is out of scope and is not claimed. Real
learning-gain measurement is separate (`docs/task-packs/`), and the bounded
repair path is not evidence of a general learning gain.
