# MemoryStorePort: caller and source map

Scope: the Memory half of [#2906](https://github.com/ali-ulu/huqan/issues/2906).
The Graph half is [graph-store-port.md](graph-store-port.md). The two ports
stay separate: they share no record type, no transaction and no contract.

This map describes the code after the Memory half landed. It introduces no
behavior: the characterization tests named below pass against the code before
the port existed (the contract test aside) and after.

## Contract

| Port | Module | Methods (`MEMORY_STORE_PORT_METHODS`) |
| --- | --- | --- |
| MemoryStorePort | `lib/memory-store-port.js` | `backend`, `hydrate`, `save`, `load`, `persistStoreWrite`, `persistLinkMemories`, `persistPatchMetadata`, `persistTombstone`, `persistSupersede`, `persistImportMemory`, `persistImportEvent`, `persistImportLink`, `withImportTransaction` |

`MemoryStore` builds the port once (`store._storePort`) and the port selects
the backend **per call**, because `close()` and `reopen()` swap the SQLite
handle at runtime:

| `backend()` | Condition | Mutation writes | `save()` / `load()` |
| --- | --- | --- | --- |
| `sqlite` | `store._db` open | `lib/memory-store-sqlite-writer.js`, one `withTransaction` per operation | report only (`skipped: true`); rows were written per mutation |
| `json` | no handle, `memoryPath` set with `useSQLite: false` | `persistJsonMutation` (`lib/memory-store-json-persistence.js`): whole-file atomic rewrite | full rewrite / full reload |
| `memory` | neither | none (`persistJsonMutation` is a no-op without a path) | `PERSISTENCE_DISABLED` / `skipped` |

The mutation methods keep the SQLite writer's operation names, so the facade
still names the operation it runs; the difference is that it now asks the
port, and the writer is SQLite-only (its former inline `if (!store._db)` JSON
branches moved into the port).

## Owned invariants

- **Mirror after persistence (#761).** Write delegates update the in-memory
  collections only after `persist*` succeeds. A failed JSON rewrite or SQLite
  transaction returns `PERSISTENCE_ERROR` and leaves the mirror untouched.
- **SQLite atomicity.** Each operation's rows commit in one transaction; a
  failing row rolls back the whole operation.
- **Import.** `withImportTransaction` runs the import in a SQLite transaction
  or, for JSON, in the in-memory snapshot/restore transaction followed by one
  file rewrite; a failed rewrite throws and the mirror is restored. Row
  writes (`persistImport*`) are SQLite-only.
- **Load errors.** A corrupt JSON file throws at construction (`hydrate`) and
  is reported as `PERSISTENCE_ERROR` / `operation: 'load'` by `load()`.
- Workspace isolation and import/export shapes are owned by the delegates
  (`memory-store-write.js`, `memory-package-*`) and are unchanged.

## Callers

| Caller | Port methods |
| --- | --- |
| `lib/memory-store.js` constructor | `hydrate` (JSON backend) |
| `lib/memory-store.js` `_storeStoreApi`, `_linkWriteStoreApi`, `_patchMetadataStoreApi`, `_tombstoneStoreApi`, `_supersedeStoreApi` | `persistStoreWrite`, `persistLinkMemories`, `persistPatchMetadata`, `persistTombstone`, `persistSupersede` |
| `lib/memory-store.js` `_importPackageStoreApi` | `withImportTransaction`, `persistImportMemory` |
| `lib/memory-store.js` `save()` / `load()` | `save`, `load` |
| `lib/memory-package-import.js` (`importPackageEvents`, `importPackageLinks`) | `persistImportEvent`, `persistImportLink` |
| `lib/memory-store-reopen.js` (`reopenJson`) | `hydrate` |

The builders' shape in `lib/memory-store.js` is unchanged, as #2129/#2960
require: each builder still has one `persist` closure; only its target moved.

## Not behind MemoryStorePort

- **Handle lifecycle:** `openMemoryDatabase`, `initDB` (schema/statements) and
  `close()` stay with the store; `reopenSqlite` in `memory-store-reopen.js`
  owns reopening.
- **SQLite hydration:** `warmup()` (`lib/memory-store-sqlite-warmup.js`) reads
  all rows when a handle opens. It is the public backend-lifecycle method the
  surface audit pins to `memory-store-reopen.js`, so it stays a store method.
- `storage.js` operational records, per the #2906 scope.
- Candidates listed in #2401 / #2402 are not reassigned by this map.

## Evidence

- `test/memory-store-port.test.js`: per-call backend selection across
  `close`/`reopen`, save/load reports for all three backends, JSON round trip
  and write-failure mirror ordering, corrupt JSON on construct and on load,
  JSON import flush and failure restore, memory backend writes nothing, SQLite
  multi-row rollback, SQLite import rows, SQLite link/patch/supersede/tombstone
  rows, SQLite ignores `memoryPath`.
- The existing `test/memory-*-delegation-contract.test.js` files pass
  unchanged.
- Mutation round: 15 source mutations across the port, writer, JSON
  persistence and import routing. 14 turn a test red. The survivor makes the
  constructor set `_jsonPath` for SQLite stores too; the port prefers an open
  handle, so it has no observable effect and is an equivalent mutant.
