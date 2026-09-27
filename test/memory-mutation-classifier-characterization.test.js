'use strict';

// #2401: classifyMemoryMutation is characterized before its eleven ordered
// predicate-to-verdict blocks become a rule table. Inputs are generated here,
// deterministically, from literal action words (not from the vocabulary
// module, so the corpus cannot drift with it): every action family, each
// change flag, a secret-looking payload, and three contexts (default,
// cross-workspace, broad graph change), plus malformed input. Each full
// verdict is compared with test/fixtures/memory-mutation-classifier.golden.json.
// Regenerate only for an intended behavior change:
//   HUQAN_UPDATE_GOLDEN=1 node --test test/memory-mutation-classifier-characterization.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { classifyMemoryMutation } = require('../lib/memory-mutation-gate/memory-mutation-classifier');

const GOLDEN = path.join(__dirname, 'fixtures', 'memory-mutation-classifier.golden.json');

const ACTIONS = [
  'read', 'inspect', 'list', 'query', 'search', 'view', 'show', 'status', 'get',
  'note', 'annotate', 'comment', 'tag', 'label',
  'write', 'upsert', 'update', 'edit', 'patch', 'save', 'store', 'rewrite', 'modify',
  'link', 'unlink', 'supersede', 'tombstone', 'reference', 'related', 'contradict', 'support', 'edge', 'relation', 'graph',
  'delete', 'remove', 'destroy', 'purge', 'erase', 'drop',
  'audit', 'log', 'trail', 'evidence',
  'package', 'import', 'sync', 'rebuild', 'rehydrate', 'batch',
  'release', 'deploy', 'publish', 'ship', 'promote', 'rollout',
  'auto-merge', 'auto_merge', 'autopush', 'auto-push', 'merge',
  'frobnicate', '',
];

const FLAGS = {
  none: {},
  content: { contentChanged: true },
  links: { linksChanged: true },
  audit: { auditChanged: true },
  deleted: { deleted: true },
  tombstoned: { tombstoned: true },
  superseded: { superseded: true },
  metadataOnly: { metadataOnly: true },
  secret: { content: 'api_key=sk-live-123 token' },
};

const CONTEXTS = {
  default: {},
  crossWorkspace: { targetSpace: 'other-space' },
  broadGraph: { mutationMetadata: { entryCount: 500, graphCount: 3, linkCount: 3 }, operationType: 'bulk' },
  // Secret detection reads id/action/diffSummary/mutationMetadata, not entry content.
  secretDiff: { diffSummary: 'set api_key=sk-live-123' },
};

function cases() {
  const out = [];
  out.push({ name: 'secret-id', entry: { id: 'password-reset-token', action: 'update' }, context: {} });
  for (const action of ACTIONS) {
    for (const [flagName, flags] of Object.entries(FLAGS)) {
      for (const [contextName, context] of Object.entries(CONTEXTS)) {
        out.push({
          name: `${action || '(none)'}/${flagName}/${contextName}`,
          entry: { id: 'm1', action, workspaceId: 'default', ...flags },
          context,
        });
      }
    }
  }
  out.push({ name: 'malformed/null', entry: null, context: {} });
  out.push({ name: 'malformed/empty', entry: {}, context: {} });
  out.push({ name: 'malformed/array', entry: [], context: {} });
  out.push({ name: 'changeType-only', entry: { changeType: 'graph' }, context: {} });
  out.push({ name: 'diffSummary-release', entry: { id: 'x', action: 'update' }, context: { diffSummary: 'deploy to prod' } });
  out.push({ name: 'mutationType-auto', entry: { id: 'x', action: 'update' }, context: { mutationType: 'auto-merge' } });
  out.push({ name: 'metadata-workspace', entry: { id: 'x', action: 'read' }, context: { metadata: { workspaceId: 'w2' } } });
  return out;
}

function run() {
  return Object.fromEntries(cases().map(({ name, entry, context }) => [name, classifyMemoryMutation(entry, context)]));
}

test('classifyMemoryMutation matches its recorded verdict for every characterized input', () => {
  const actual = JSON.parse(JSON.stringify(run()));
  if (process.env.HUQAN_UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`);
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(Object.keys(actual), Object.keys(golden), 'the case list and the fixture must match');
  const mismatches = Object.keys(golden).filter((name) => {
    // Compared as serialized JSON, so key order is pinned too: a verdict that
    // reaches a receipt is hashed in the order its fields were written.
    return JSON.stringify(actual[name]) !== JSON.stringify(golden[name]);
  });
  assert.deepEqual(mismatches.slice(0, 10), [], `${mismatches.length} verdict(s) differ`);
});

test('the characterized inputs reach every category and both dynamic reasons/decisions', () => {
  const golden = Object.values(JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
  const categories = new Set(golden.map((row) => row.category));
  for (const category of ['cross_workspace', 'secret', 'audit', 'release_or_auto', 'delete', 'graph', 'package_import', 'read_only', 'metadata', 'content', 'unknown', 'malformed']) {
    assert.ok(categories.has(category), `category ${category} is reached`);
  }
  const releaseReasons = new Set(golden.filter((row) => row.category === 'release_or_auto').map((row) => row.reason));
  assert.equal(releaseReasons.size, 2, 'both release and auto-merge reasons are reached');
  const graphDecisions = new Set(golden.filter((row) => row.category === 'graph').map((row) => row.decision));
  assert.equal(graphDecisions.size, 2, 'both review and dry-run-only graph decisions are reached');
});

// #2253: the 'malformed' branch used to require an empty scope, but
// normalizeEntry always falls back to the default workspace, so no input
// reached it (`null`/`{}` fell through to `unknown`). The scope conjunct was
// removed from the guard, so an entry with no identity and no operation signal
// is now reported as malformed.
test('empty input is reported as malformed', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.equal(golden['malformed/null'].category, 'malformed');
  assert.equal(golden['malformed/empty'].category, 'malformed');
  assert.equal(golden['malformed/array'].category, 'malformed');
  assert.equal(golden['malformed/null'].reason, 'MALFORMED_INPUT_REVIEW_REQUIRED');
  assert.equal(golden['changeType-only'].category, 'graph');
});

test('anonymous flag-bearing entries keep their substantive routing, never malformed', () => {
  // Fail-closed (#2253): the malformed guard must not swallow entries that
  // carry a mutation signal. An anonymous delete still blocks, an anonymous
  // graph flag still reviews as graph, and context signals still route.
  const flagged = [
    [{ deleted: true }, {}, 'delete', 'block'],
    [{ tombstoned: true }, {}, 'graph', 'review'],
    [{ contentChanged: true }, {}, 'content', 'review'],
    [{}, { diffSummary: 'deploy to prod' }, 'release_or_auto', 'block'],
    [{}, { operationType: 'audit rewrite' }, 'audit', 'block'],
  ];
  for (const [entry, context, category, decision] of flagged) {
    const verdict = classifyMemoryMutation(entry, context);
    assert.equal(verdict.category, category, `${JSON.stringify(entry)} must route to ${category}`);
    assert.equal(verdict.decision, decision);
  }
});
