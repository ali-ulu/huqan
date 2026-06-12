# AXIOM Memory Core

AXIOM Memory Core is the deterministic, workspace-scoped memory layer used by the `kernel.memory` API. It stores immutable memory records, records audit events, keeps provenance intact, and preserves graph relations across persistence reloads.

## API Surface

The public API is exposed through `kernel.memory`:

- `store(input)`
- `get(memoryId, opts?)`
- `list(opts?)`
- `search(query, opts?)`
- `findById(memoryId, opts?)`
- `findByContentHash(contentHash, opts?)`
- `findBySourceRef(sourceRef, opts?)`
- `findByKind(kind, opts?)`
- `findByStatus(status, opts?)`
- `link(input)`
- `findLinks(memoryId, opts?)`
- `findLinkedMemories(memoryId, opts?)`
- `getBacklinks(memoryId, opts?)`
- `traverseLinks(memoryId, opts?)`
- `timeline(opts?)`
- `since(timestamp, opts?)`
- `before(timestamp, opts?)`
- `between(start, end, opts?)`
- `history(memoryId, opts?)`
- `tombstone(memoryId, opts?)`
- `supersede(memoryId, newContent, opts?)`
- `contradict(memoryId, targetMemoryId, opts?)`
- `patchMetadata(memoryId, patch?, opts?)`

## Core Invariants

Memory Core follows these rules:

1. Memory content is immutable.
2. Duplicate content inside the same workspace is idempotent.
3. Delete means tombstone, not physical deletion.
4. `supersede` creates a new memory plus a relation, not an overwrite.
5. `contradict` creates a new relation, not an overwrite.
6. Workspace isolation is the default.
7. Cross-workspace access must be explicit and is rejected by default for linked operations.
8. Provenance fields are preserved end-to-end.
9. Audit events are preserved end-to-end.
10. Persistence reload must preserve memory, provenance, audit, and workspace state.

## Provenance Fields

The memory layer preserves these fields when present:

- `sourceType`
- `sourceRef`
- `actor`
- `provenanceId`
- `trustPolicyVersion`
- `confidence`
- `workspaceId`

## Relation Types

Graph relations currently used by Memory Core include:

- `supports`
- `contradicts`
- `supersedes`
- `related_to`
- `derived_from`

## Query Helper Notes

Query helpers are deterministic and workspace-scoped. Results are stable-sorted and do not leak data across workspaces.

Common helper groups:

- memory filters: `findById`, `findByContentHash`, `findBySourceRef`, `findByKind`, `findByStatus`
- graph helpers: `findLinks`, `findLinkedMemories`, `getBacklinks`, `traverseLinks`
- temporal helpers: `timeline`, `since`, `before`, `between`
- audit helpers: `history`, `getEvents`

## Usage Examples

### Store memory

```js
const result = kernel.memory.store({
  content: { text: 'kedi memelidir' },
  workspaceId: 'default',
  kind: 'fact',
  actor: 'user',
  sourceRef: 'cli:note-1',
});
```

### Search memory

```js
const result = kernel.memory.search('kedi', { workspaceId: 'default' });
```

### Link two memories

```js
const result = kernel.memory.link({
  fromMemoryId: 'mem-a',
  toMemoryId: 'mem-b',
  relation: 'supports',
  workspaceId: 'default',
});
```

### Tombstone memory

```js
const result = kernel.memory.tombstone('mem-a', { workspaceId: 'default' });
```

### Supersede memory

```js
const result = kernel.memory.supersede(
  'mem-a',
  { text: 'updated fact' },
  { workspaceId: 'default', actor: 'reviewer' }
);
```

### Contradiction link

```js
const result = kernel.memory.contradict('mem-a', 'mem-b', { workspaceId: 'default' });
```

### Workspace-scoped query

```js
const result = kernel.memory.list({ workspaceId: 'default', status: 'active' });
```

### Temporal query

```js
const result = kernel.memory.between('2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z', {
  workspaceId: 'default',
  field: 'createdAt',
});
```
