# EXTERNAL-CLIENT-DURABLE-REPLAY-0 - Authorization

## Gate Identity

- Repository: `ali-ulu/huqan`
- Mode: docs-only exact-base authorization
- Authorization base: `main` at
  `4fecb02b8615396485472f62b4c3839c87e853f2`
- Governing predecessor:
  `docs/task-packs/external-client-enablement-0-authorization.md`
- Required predecessor checkpoint:
  `EXTERNAL_CLIENT_IDENTITY_TRUST_CONFIG_0_IMPLEMENTATION_CLOSEOUT_GREEN`
- Authorized successor after this gate closes:
  `EXTERNAL_CLIENT_DURABLE_REPLAY_0_IMPLEMENTATION`

This authorization base records the source state used to define the gate. It is
not the implementation base. Implementation requires a separate exact
post-merge `main` SHA after this task-pack closes.

## Allowed Change

This authorization may add only:

```text
docs/task-packs/external-client-durable-replay-0.md
```

It authorizes no runtime, test, package, server, route, mutation, receipt,
deployment or public schema change.

## Source Reality

At the authorization base:

1. `enforceExternalClientAuthority()` derives a deterministic replay record
   after package, identity, workspace, key validity and freshness checks pass;
2. the record contains exactly `replayKey`, identity subject and kind,
   workspace, package, package hash, trusted-key ID, permission, package
   `createdAt`, trusted-clock `reservedAt` and trusted-clock `expiresAt`;
3. Authority calls one injected own `replayStore.reserve(record)` function and
   accepts only an exact `{ reserved: true }` success or a bounded duplicate
   result;
4. Authority maps replay-owner exceptions or malformed results to the existing
   `EXTERNAL_CLIENT_AUTHORITY_REPLAY_RESERVATION_FAILED` boundary;
5. Authority maps a duplicate reservation to the existing
   `EXTERNAL_CLIENT_AUTHORITY_REPLAY_DETECTED` boundary;
6. the replay TTL is already fixed by Authority-0 and the store must not read
   system time or invent a second TTL policy;
7. `better-sqlite3` is the only installed SQLite dependency;
8. `lib/memory-store.js` provides WAL, bounded busy timeout, synchronous
   transactions and close patterns, while `lib/memory-store-utils.js` owns the
   existing bounded `SQLITE_BUSY`/`SQLITE_LOCKED` retry primitive;
9. MemoryStore and Graph mutation-journal tables are different ownership
   domains and are not the external-client replay reservation owner;
10. no concrete durable replay store, route, mutation or receipt owner exists;
11. the reserved HTTP endpoint remains unregistered; and
12. production V2 receipt writing remains fail closed.

## Binding Owner Decision

Durable Replay-0 introduces one dedicated internal SQLite owner. It must not
reuse or extend:

- Graph mutation-journal tables;
- MemoryStore memory, event or link tables;
- viewer session storage;
- JSON persistence;
- process-local `Map`, `Set` or other memory-only state as authoritative replay
  evidence; or
- request-controlled database or table names.

The first owner is created explicitly by server composition later. This gate
does not wire it to `server.js` and does not choose a deployment path source.

## Future Implementation Scope

Only a separate exact-base implementation authorization may add:

```text
lib/external-client-replay-store.js
lib/external-client-replay-store.test.js
```

No existing runtime file may change in the implementation gate. In particular,
`lib/external-client-authority.js`, `lib/sdk.js`, `server.js`, `kernel.js`,
`graph.js`, `lib/memory-store.js`, package metadata and endpoint descriptors
remain unchanged.

The module remains internal and is not added to the npm package allowlist until
a later production composition gate needs it and separately proves packed
installation behavior.

## Construction Contract

The implementation exports one internal factory:

```text
createExternalClientReplayStore(options)
```

`options` is an exact plain object containing only:

```text
dbPath
busyRetry
```

The contract is:

- `dbPath` is a non-empty absolute filesystem path supplied by trusted server
  composition;
- the parent directory must already exist;
- the module does not read environment variables, configuration files, network
  services, request data or process-global registries;
- `busyRetry` is optional and is validated through the existing
  `resolveBusyRetryConfig()` contract;
- no default database path or silent path relocation is invented;
- missing `better-sqlite3` fails closed;
- opening the database sets WAL mode, `synchronous = FULL`, foreign keys on and
  the bounded busy timeout; and
- initialization creates and validates only the dedicated replay table and its
  expiry index.

The factory returns one frozen plain object with own functions:

```text
reserve
close
```

`reserve` remains compatible with the existing Authority-0 injected owner
contract. `close` is idempotent. Reserving after close fails with the existing
replay-reservation-failed error vocabulary.

## Exact Replay Record

`reserve(record)` accepts one exact plain object with own enumerable data
properties only:

```text
replayKey
identitySubject
identityKind
workspaceId
packageId
packageHash
trustedKeyId
permission
createdAt
reservedAt
expiresAt
```

Validation requirements:

- no unknown, inherited, accessor-backed, non-enumerable or symbol fields;
- all identity, workspace, package, hash, trusted-key, permission and timestamp
  strings are non-empty exact strings;
- `permission` is exactly `package:admit`;
- `replayKey` starts with the existing Authority-0 version prefix and is not
  normalized or recomputed by the store;
- `createdAt` is canonical ISO-8601;
- `reservedAt` and `expiresAt` are finite safe integer epoch milliseconds;
- `expiresAt` is strictly greater than `reservedAt`;
- no raw package, signature, public-key bytes, private key, request body or
  arbitrary metadata is accepted or persisted; and
- hostile Proxy behavior is converted to the existing bounded
  `EXTERNAL_CLIENT_AUTHORITY_REPLAY_RESERVATION_FAILED` error code.

The store uses the supplied trusted-clock values. It must not call `Date.now()`,
construct a current `Date`, or derive expiry from wall clock.

## SQLite Schema Contract

The implementation owns exactly one table:

```text
external_client_replay_reservations
```

The table stores the exact validated record with:

- `replay_key` as the primary key;
- required text columns for the bounded identity and package evidence;
- integer `reserved_at` and `expires_at` columns;
- an integrity constraint requiring `expires_at > reserved_at`; and
- an index on `expires_at` for bounded expiry cleanup.

Initialization must validate the existing table shape and primary-key ownership.
An incompatible, malformed or partially created table fails closed. The module
must not migrate, drop, rename or reinterpret an incompatible table silently.

No read, list, export, delete-by-caller or administrative mutation API is
introduced in this gate.

## Atomic Reservation Semantics

Each reservation uses one bounded SQLite write transaction that acquires the
write lock before reading the existing replay key.

Inside the same transaction:

1. expired rows at or before the incoming trusted `reservedAt` may be removed;
2. an unexpired row with the same `replayKey` returns an exact frozen
   `{ reserved: false }` result without exposing the existing row;
3. an absent or expired same-key row is inserted and returns an exact frozen
   `{ reserved: true }` result;
4. no partial row or success result survives an exception; and
5. a unique-constraint race is treated as a duplicate only when the committed
   row is proven to exist and remain unexpired at the incoming trusted
   `reservedAt`; otherwise the operation fails closed.

Expiry equality is explicit: an existing row with `expiresAt <= reservedAt` is
expired and may be replaced. An existing row with `expiresAt > reservedAt` is a
duplicate.

The result never includes existing evidence, timestamps, row counts, database
paths or internal errors.

## Locking And Retry

The implementation may reuse only the existing bounded helpers from
`lib/memory-store-utils.js`:

```text
resolveBusyRetryConfig
runWithBusyRetry
```

Retry is allowed only for `SQLITE_BUSY` and `SQLITE_LOCKED` before a successful
reservation result. Attempts, backoff and busy timeout remain bounded. No
application-level automatic retry occurs after an unknown transaction outcome.

A non-lock SQLite error, schema conflict, I/O failure, corrupt database or
ambiguous result fails closed with the existing replay-reservation-failed error
code.

## Required Test Matrix

The implementation test owner must prove:

- one valid record produces exact frozen `{ reserved: true }`;
- an immediate duplicate produces exact frozen `{ reserved: false }` and leaks
  no existing row data;
- reservation persists across close and reopen;
- an exact-expiry reservation replaces the expired row;
- a one-millisecond-before-expiry reservation remains a duplicate;
- the store never reads system time and uses only incoming trusted timestamps;
- malformed root shape, unknown fields, symbols, inherited fields, accessors,
  non-enumerable fields and hostile Proxies fail with the bounded existing error;
- empty or malformed strings, wrong permission, malformed `createdAt`, unsafe
  integers and non-increasing expiry fail closed;
- SQL metacharacters in validated string fields remain bound data, not SQL;
- input mutation after reservation cannot change the committed row;
- two owner instances in one process competing for the same key produce exactly
  one reserve and one duplicate;
- two independent Node processes using the same database and replay key produce
  exactly one reserve and one duplicate;
- restart behavior preserves unexpired duplicates and permits trusted-time
  expiry replacement;
- a forced transaction failure rolls back without a partial row;
- bounded busy retry succeeds when a short lock is released and fails
  predictably when the configured attempts are exhausted;
- incompatible pre-existing schema, corrupt database and missing SQLite
  dependency fail closed;
- `close()` is idempotent and reserve-after-close fails closed;
- no Graph, MemoryStore, server, SDK, endpoint, mutation or receipt file changes;
- no JSON or memory-only fallback exists; and
- related Authority, package, SDK, endpoint-contract and trust-config tests
  remain green with the complete runtime suite.

Cross-process tests may use inline `node -e` workers from the exact test file;
no third fixture file is authorized.

## Stop Conditions

Stop with `EXTERNAL_CLIENT_DURABLE_REPLAY_0_BLOCKED_CONTRACT_CONFLICT` if the
implementation requires:

- changing the Authority replay record, TTL, result contract or error vocabulary;
- a caller-controlled database path, table name, TTL or cleanup policy;
- system time, environment variables, JSON fallback or process-memory
  authority;
- reuse of Graph journal or MemoryStore domain tables;
- adding a read/list/export API for replay rows;
- changing `server.js`, SDK, Authority, endpoint, mutation or receipt code;
- adding a dependency, package export, public API, schema or version;
- registering or partially exposing the HTTP route;
- accepting a pending queue or best-effort reservation;
- automatic retry after an unknown transaction outcome;
- production V2 receipt writing or trust-root owner selection; or
- multi-client registry, distributed database, TLS, proxy or deployment scope.

## Acceptance Criteria

This docs-only authorization closes only when:

1. exactly this task-pack changes;
2. the exact live base and predecessor are recorded;
3. the dedicated SQLite owner is separated from Graph and MemoryStore domains;
4. the exact record, schema, atomic reservation and expiry semantics are bound;
5. retry and unknown-outcome behavior remain fail closed;
6. the exact two-file implementation scope and adversarial matrix are locked;
7. route, mutation, receipt, package and deployment remain downstream;
8. no new public vocabulary, dependency or package surface is invented; and
9. exact-head CI, source-first review, merge and clean post-merge docs smoke
   pass.

## Non-Claims

This authorization does not provide or authorize:

- a concrete replay-store implementation;
- server composition or a deployment database path;
- a reachable external-client route;
- an admitted mutation, approval, audit or receipt effect;
- a production V2 receipt writer or trust-root owner;
- a public replay API, administrative viewer or export;
- multi-client, remote-database or distributed-lock behavior;
- V4 closeout, V5 ecosystem completion, release or deployment.
