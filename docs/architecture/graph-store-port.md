# GraphStorePort: caller and source map

Scope: the Graph half of [#2906](https://github.com/ali-ulu/huqan/issues/2906).
MemoryStorePort is a separate contract and a separate change; nothing in this
document assigns MemoryStore persistence to GraphStorePort.

This map describes the code as it is after the Graph half landed. It introduces
no behavior: the characterization tests named below pass unchanged against the
code before and after the port was made explicit.

## Contract

| Port | Module | Methods | Implemented by |
| --- | --- | --- | --- |
| GraphStorePort | `lib/graph-store-port.js` | `backend`, `stripEmbeddings`, `restoreEmbeddings`, `save`, `writeStrippedState`, `load` (`GRAPH_STORE_PORT_METHODS`) | JSON backend, SQLite backend |
| RustGraphStorePort | `lib/rust-graph-store-port.js` | `backend`, `save`, `load` (`RUST_GRAPH_STORE_PORT_METHODS`) | huqan-core process, or the JavaScript Graph's GraphStorePort on fallback |

`Graph` selects the backend **per call** from the live SQLite handle
(`graph._db && graph._stmts`), because `closeSqlite()` and `reopen()` swap the
handle at runtime. `port.backend()` reports `json` or `sqlite` for the call
that would run now.

The Rust adapter is async and reports `unstarted`, `rust-process` or
`js-fallback`. It is an accelerator adapter, not a third graph authority: on
fallback it calls the fallback Graph's own `save()`/`load()`, which go through
GraphStorePort.

## Backends and the modules behind them

| Backend | Save path | Load path | Owned invariants |
| --- | --- | --- | --- |
| JSON | `saveSnapshot` (`lib/graph-json-snapshot.js`) → `writeCurrentState` → `writeStrippedState` → `writeJsonFiles` | `loadJsonGraph` (`lib/graph-json-persistence.js`) | snapshot conflict (`GRAPH_JSON_WRITE_CONFLICT`), journal lock, redo recovery and fault seam (`lib/graph-json-transaction.js`), atomic writes, first-file rollback on sidecar failure |
| SQLite | `writeCurrentState` → `writeStrippedState` (one `db.transaction`, then the JSON mirror) | `loadSqliteGraph` (`lib/graph-persistence-runtime.js`); empty DB falls back to `loadJsonGraph` | transaction rollback, `SQLITE_PERSISTENCE_LOAD_FAILED` mapping, embeddings restored on every exit |
| huqan-core | `send({ cmd: 'save', path })` | `send({ cmd: 'load', path })` | result is `res && res.ok`; timeout/process loss resolve `false`, never throw (`send()` in `rustGraph.js`) |
| JS fallback | fallback `Graph.save()` | fallback `Graph.load()` | the Rust `memPath` override is not forwarded; the fallback Graph owns its path |

Both in-process backends share `assertGraphPersistenceWritable`: a recorded
load error blocks `save()` before any write on either backend.

## Callers

Production callers reach persistence only through `Graph.save()` /
`Graph.load()`, which delegate to `graph._storePort`:

| Caller | Call |
| --- | --- |
| `kernel.js` (constructor, `load`, `save`, `learnDocument` flush) | `this.graph.load()` / `this.graph.save()` |
| `server.js` | `kernel.graph.load()` at startup |
| `lib/learn-use-case.js` | `this.graph.save()` after learn |
| `lib/kernel-learn-transaction.js` | `graph.save()` after commit |
| `lib/kernel-self-evolve.js` | `save: () => kernel.graph.save()` |
| `lib/conflict-detector.js` | `kernel.graph.save()` after review |
| `lib/graph-json-persistence.js` | `graph.save()` to seed an empty SQLite DB from JSON |
| `lib/graph-json-snapshot.js` | `graph.load()` to refresh a changed snapshot before a mutation |
| `scripts/seed-demo.js`, `scripts/knowledge-graph-demo.js` | `graph.save()` |

`RustGraph.save()` / `RustGraph.load()` have **no production caller** at the
time of writing; `kernel.js`, `lib/reason-sandbox.js` and
`lib/self-healer/source-dogfood-simulator.js` construct a `RustGraph` for
queries only. The adapter keeps the public methods and their results intact.

## Not behind GraphStorePort

- Record-level SQLite writes during mutations (`upsertNode`, `upsertEdge`,
  `touchNode`, candidate claims, audit events, prune) stay in the per-operation
  store APIs of `lib/graph-store-adapters.js`. They are the in-memory-mirror
  update ordering the issue requires to preserve, and moving them is a
  separate, behavior-sensitive change.
- The mutation journal and receipts (`lib/graph-mutation-runtime.js`,
  `lib/graph-mutation-receipt-*.js`).
- `storage.js` operational records (runs, approvals, tool approvals), per the
  #2906 scope.
- Candidates listed in #2401 / #2402 are not reassigned by this map.

## Known behavior kept as-is

When the huqan-core binary is missing and a `RustGraph` has not started yet,
the first `save()`/`load()` builds the fallback inside `send()` and returns
`undefined` without calling the fallback Graph. This predates the port and is
preserved because the change must not alter behavior; it is tracked
separately.

## Evidence

- `test/graph-store-port-backends.test.js`: backend selection, JSON conflict,
  SQLite no-conflict, load-error guard, SQLite error mapping, empty-DB JSON
  fallback, SQLite rollback with embedding restore.
- `test/rust-graph-store-port.test.js`: fallback routing, wire commands,
  result shape, timeout as `false`.
- `test/graph-store-port.test.js`: JSON and SQLite round trips.
- Mutation round: 14 source mutations across the port, runtime, snapshot and
  Rust adapter; every one turns at least one of these tests red.
