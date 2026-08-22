'use strict';

/**
 * Connector-execution coverage — P1-B (#1010).
 *
 * ## What the wrapper alone could not prove
 *
 * `executeConnectorAction()` is a real fail-closed wrapper: an action it
 * refuses does not reach its executor. That says nothing about whether a given
 * production connector execution *goes through it*, and until #1010 most did
 * not. `lib/connectors/repo-memory-firewall.js` gated both of its wrappers on
 *
 *     input.enforceConnectorFirewall === true || input.connectorFirewall?.enabled === true
 *
 * and no caller in the repository sets either. Every production ingest --
 * github, markdown, json, yaml, git-log, pdf, http -- took the other branch,
 * which called the executor directly with no firewall at all. The enforced
 * branch was dead code, and carried the marks of it: `fetchGithubRepoWithFirewall`
 * read a `repoUrl` binding that nothing on that branch ever assigned.
 *
 * The bypass is gone. This file is what keeps it gone.
 *
 * ## What it locks
 *
 * Every call to a registered executor in runtime source, counted per file and
 * classified. A new production call site that does not go through the wrapper
 * cannot be added without moving a number here.
 *
 * The registry in `lib/connector-action-firewall.js` names the executors, so
 * this reads them from `CONNECTOR_ACTIONS` rather than restating the list --
 * a new connector's executor is in scope the moment it is registered.
 *
 * ## The honest limit
 *
 * Like ROUTED_SINK_CALLS in the mutation-boundary contract, GUARDED entries are
 * a reviewed declaration: the scan cannot see that a call sits lexically inside
 * an `execute:` callback. Counts are pinned so a *second*, unguarded call added
 * to a listed file still fails. What is machine-checked rather than declared is
 * the property below it: a blocked decision does not reach the executor.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { listSourceFiles } = require('../scripts/check-file-size.js');
const {
  CONNECTOR_ACTIONS,
  evaluateConnectorAction,
  executeConnectorAction,
} = require('../lib/connector-action-firewall.js');

const repoRoot = path.join(__dirname, '..');

/** Executor names, read from the registry rather than restated. */
function registeredExecutors() {
  const names = new Set();
  for (const actions of Object.values(CONNECTOR_ACTIONS)) {
    for (const spec of Object.values(actions)) names.add(spec.executor);
  }
  return [...names].sort();
}

/**
 * Calls that run inside an `execute:` callback handed to the canonical wrapper.
 * Reviewed by reading the source, not proven by the scan.
 */
const GUARDED_EXECUTOR_CALLS = Object.freeze({
  'plugins/repo-memory.js': {
    why: 'the six file/http ingest paths, each inside executeGuardedConnectorIngest; the github path calls fetchRepoFilesImpl through fetchGithubRepoWithFirewall',
    calls: {
      ingestMarkdown: 1, ingestJson: 1, ingestYaml: 1, ingestGitLog: 1, ingestPdf: 1, ingestUrls: 1,
    },
  },
  'plugins/evidence-validator.js': {
    why: 'HTTP reachability probe inside executeConnectorAction; the only caller that never had an enablement branch',
    calls: { fetchUrl: 1 },
  },
});

/**
 * Calls inside the executor's own module: its definition, and the helpers it
 * calls on itself.
 *
 * These are *downstream* of the boundary, not a second way in. `fetchUrl`
 * calling itself to follow a redirect or read robots.txt happens after the
 * firewall allowed the probe; an adapter's `ingestX` wrapping its own
 * `ingestXWithProvenance` is one executor, not two entry points.
 *
 * The bound that makes this safe is that adapters are leaves: they are
 * required by the plugins above, and by nothing else in runtime source. The
 * scan below asserts that rather than assuming it.
 */
const ADAPTER_INTERNAL_CALLS = Object.freeze({
  'adapters/github-adapter.js': { fetchRepoFiles: 2 },
  'adapters/http-adapter.js': { ingestUrls: 2, fetchUrl: 4 },
  'adapters/markdown-adapter.js': { ingestMarkdown: 2 },
  'adapters/json-adapter.js': { ingestJson: 2 },
  'adapters/yaml-adapter.js': { ingestYaml: 2 },
  'adapters/git-log-adapter.js': { ingestGitLog: 2 },
  'adapters/pdf-adapter.js': { ingestPdf: 2 },
});

/** Every executor call site in runtime source, counted per file. */
function executorCallSites() {
  const executors = registeredExecutors();
  const sites = new Map();
  for (const rel of listSourceFiles()) {
    if (!rel.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const calls = {};
    for (const name of executors) {
      // A bare call. `a.fetchUrl(` and `fetchUrlImpl(` are not this name.
      const found = src.match(new RegExp(`(?<![A-Za-z0-9_$.])${name}\\s*\\(`, 'g'));
      if (found) calls[name] = found.length;
    }
    if (Object.keys(calls).length > 0) sites.set(rel, calls);
  }
  return sites;
}

// ─── the ledger ──────────────────────────────────────────────────────────────

test('every connector executor call in runtime source is accounted for', () => {
  const sites = executorCallSites();
  const declared = new Map([
    ...Object.entries(GUARDED_EXECUTOR_CALLS).map(([file, e]) => [file, e.calls]),
    ...Object.entries(ADAPTER_INTERNAL_CALLS),
  ]);

  const unaccounted = [...sites.keys()].filter((f) => !declared.has(f));
  assert.deepEqual(unaccounted, [],
    'these files call a connector executor but are in neither ledger. Route the '
    + 'call through executeConnectorAction, or record why it is out of scope:\n'
    + unaccounted.map((f) => `  ${f}  ${JSON.stringify(sites.get(f))}`).join('\n'));

  const stale = [...declared.keys()].filter((f) => !sites.has(f));
  assert.deepEqual(stale, [], `ledger entries with no call sites left: ${stale.join(', ')}`);

  for (const [file, calls] of sites) {
    assert.deepEqual(calls, declared.get(file),
      `${file}: executor calls changed. A call was added or removed without moving `
      + 'a number, and an added one may not be behind the firewall.');
  }
});

test('adapters are leaves, which is what makes their internal calls safe to exclude', () => {
  // ADAPTER_INTERNAL_CALLS rests on adapters having no runtime caller but the
  // guarded plugins. If a third module starts requiring one directly, its
  // executor calls become a second entry point and this fails first.
  const allowed = new Set([...Object.keys(GUARDED_EXECUTOR_CALLS), ...Object.keys(ADAPTER_INTERNAL_CALLS)]);
  const unexpected = [];
  for (const rel of listSourceFiles()) {
    if (!rel.endsWith('.js') || allowed.has(rel)) continue;
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    for (const adapter of Object.keys(ADAPTER_INTERNAL_CALLS)) {
      const base = path.basename(adapter, '.js');
      if (new RegExp(`require\\([^)]*adapters/${base}['"]`).test(src)) unexpected.push(`${rel} -> ${adapter}`);
    }
  }
  assert.deepEqual(unexpected, [],
    `these modules require a connector adapter directly:\n  ${unexpected.join('\n  ')}`);
});

// ─── the property, machine-checked ───────────────────────────────────────────

test('a refused decision never reaches the executor', async () => {
  const refusals = [
    ['blocked target', { connector: 'http', action: 'ingest', urls: ['https://user:pw@example.com/a'] }],
    ['unknown connector', { connector: 'nope', action: 'ingest', targetPath: '/tmp/a' }],
    ['unknown action', { connector: 'markdown', action: 'delete', targetPath: '/tmp/a' }],
    ['missing target', { connector: 'markdown', action: 'ingest' }],
    ['preview only', { connector: 'markdown', action: 'ingest', targetPath: '/tmp/a', preview: true }],
  ];

  for (const [label, request] of refusals) {
    let ran = false;
    const result = await executeConnectorAction({ request, execute: () => { ran = true; } });
    assert.equal(ran, false, `${label}: the executor ran`);
    assert.equal(result.ok, false, label);
    assert.equal(result.canExecute, false, label);
  }
});

test('an evaluation that throws fails closed rather than escaping', async () => {
  // A caller-shaped request can throw from a getter. Before #1010 that
  // propagated out of executeConnectorAction, and a caller's own catch block --
  // plugins/evidence-validator.js has one -- scored it as an execution failure
  // rather than as a firewall decision. The executor was never reached; the
  // decision saying so was what was missing.
  const hostile = { get connector() { throw new Error('hostile getter'); }, action: 'ingest' };
  let ran = false;

  assert.throws(() => evaluateConnectorAction(hostile));

  const result = await executeConnectorAction({ request: hostile, execute: () => { ran = true; } });
  assert.equal(ran, false);
  assert.equal(result.ok, false);
  assert.equal(result.canExecute, false);
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, 'CONNECTOR_EVALUATION_FAILED');
});

test('a missing executor is refused rather than treated as a no-op success', async () => {
  const result = await executeConnectorAction({
    request: { connector: 'markdown', action: 'ingest', targetPath: '/tmp/a' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CONNECTOR_EXECUTOR_MISSING');
  assert.equal(result.canExecute, false);
});

// ─── the bypass that #1010 removed ───────────────────────────────────────────

test('the connector wrappers have no enablement branch left', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'lib/connectors/repo-memory-firewall.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.doesNotMatch(code, /connectorFirewallIsEnabled/,
    'the opt-in gate is back; every production ingest would bypass the firewall again');
  assert.doesNotMatch(code, /enforceConnectorFirewall/,
    'an enablement flag is back in the execution path');

  // Both wrappers reach the canonical entry point, and nothing else executes.
  assert.equal((code.match(/executeConnectorAction\(/g) || []).length, 2);
  assert.doesNotMatch(code, /await execute\(\)/,
    'an executor is being called outside the wrapper');
});
