'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// #1929: the Conflicts view used to render every derived signal as one
// uncontrolled list -- 125+ rows in the reporter's workspace, unordered, with
// no way to see which of them mattered. This contract pins the two halves of
// the fix that a rendered page cannot show cheaply:
//
//   1. the triage itself is a pure function of graph data, so severity order
//      and counts are testable without a browser;
//   2. the rendering path is bounded and its filters are labelled.
//
// The behaviour a user actually sees -- filtering, paging, and the empty,
// loading and error states -- is covered in
// test/ui-conflict-triage-browser-smoke.test.js against a real browser.
const { dashboardSource, dashboardScript, readHtml } = require('./helpers/dashboard-source');

const script = dashboardScript();
const html = readHtml();

/**
 * Lifts a named region out of the minified dashboard script.
 *
 * The triage helpers are plain functions in one long script; slicing between
 * two literal markers is the cheapest way to run them in isolation, and it
 * fails loudly (rather than silently testing nothing) when either marker moves.
 */
function region(from, to) {
  const start = script.indexOf(from);
  assert.notEqual(start, -1, `dashboard script no longer contains ${JSON.stringify(from)}`);
  const end = script.indexOf(to, start);
  assert.notEqual(end, -1, `dashboard script no longer contains ${JSON.stringify(to)} after ${JSON.stringify(from)}`);
  return script.slice(start, end);
}

const sandbox = vm.runInNewContext([
  region('const endId=', ';async function json('),
  ';',
  region('function rel(v){', 'const CONFLICT_PAGE='),
  region('function nodeLabel(n){', 'function mesh()'),
  region('const CONFLICT_PAGE=', 'function renderConflicts()'),
  '({triageConflicts,filterConflicts,CONFLICT_PAGE,CONFLICT_TYPES,CONFLICT_SEVERITY})',
// The signal vocabulary is catalogue-backed since #1958. This realm carries no
// catalogue, which is also a browser's state before one loads: the lookup hands
// back the English fallback compiled into the source, so the labels asserted
// below stay exactly the strings the dashboard ships.
].join('\n'), { M: (key, fallback) => fallback, T: (key, fallback) => fallback, Tx: value => value });

const { triageConflicts, filterConflicts, CONFLICT_PAGE, CONFLICT_TYPES, CONFLICT_SEVERITY } = sandbox;

// The helpers run inside a vm realm, so their arrays and objects do not share
// this realm's prototypes; deepStrictEqual would fail on that alone. Comparing
// the JSON projection compares the values these assertions are actually about.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const NOW = Date.parse('2026-09-07T00:00:00.000Z');
const RECENT = new Date(NOW - 60_000).toISOString();
const STALE = new Date(NOW - 90 * 24 * 60 * 60 * 1000).toISOString();

/** A graph that produces every signal type, deliberately out of severity order. */
function fixture() {
  const nodes = [
    { id: 'stale-1', label: 'Stale claim', confidence: 0.9, last_seen: STALE },
    { id: 'low-1', label: 'Weak claim', confidence: 0.1, last_seen: RECENT },
    { id: 'multi-1', label: 'Ambiguous type', confidence: 0.9, last_seen: RECENT },
    { id: 'neg-1', label: 'Contradicted claim', confidence: 0.9, last_seen: RECENT },
    { id: 'clean-1', label: 'Healthy claim', confidence: 0.9, last_seen: RECENT },
  ];
  const links = [
    // Diacritics are stripped by rel(), so the Turkish relations must match.
    { source: 'multi-1', target: 'kind-a', relation: 'tür' },
    { source: 'multi-1', target: 'kind-b', relation: 'tür' },
    { source: 'neg-1', target: 'fact-a', relation: 'değil' },
    { source: 'neg-1', target: 'fact-b', relation: 'ilişki' },
    { source: 'clean-1', target: 'fact-c', relation: 'ilişki' },
  ];
  return { nodes, links };
}

test('triage classifies each signal type at a fixed severity', () => {
  const { nodes, links } = fixture();
  const { findings } = triageConflicts(nodes, links, NOW);
  const bySubject = new Map(findings.map(f => [f.subject, f]));

  assert.deepEqual(
    [...bySubject.keys()].sort(),
    ['Ambiguous type', 'Contradicted claim', 'Stale claim', 'Weak claim'],
    'a node with no conflicting signal must not produce a finding',
  );
  assert.equal(bySubject.get('Ambiguous type').type, 'multi-type');
  assert.equal(bySubject.get('Ambiguous type').severity, 'high');
  assert.equal(bySubject.get('Contradicted claim').type, 'negation');
  assert.equal(bySubject.get('Contradicted claim').severity, 'high');
  assert.equal(bySubject.get('Weak claim').type, 'low-confidence');
  assert.equal(bySubject.get('Weak claim').severity, 'medium');
  assert.equal(bySubject.get('Stale claim').type, 'stale');
  assert.equal(bySubject.get('Stale claim').severity, 'low');
});

test('high-priority signals are ordered first, whatever order the graph arrives in', () => {
  const { nodes, links } = fixture();
  const { findings } = triageConflicts(nodes, links, NOW);
  const ranks = plain(findings).map(f => CONFLICT_SEVERITY[f.severity].rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'findings must be sorted by severity');
  assert.equal(findings[0].severity, 'high', 'the first row a user reads must be the worst one');

  // Reversing the input must not reorder the output: the ordering is a
  // property of the finding, not of graph iteration order.
  const reversed = triageConflicts([...nodes].reverse(), [...links].reverse(), NOW);
  assert.deepEqual(plain(reversed.findings), plain(findings), 'triage order must be deterministic');
});

test('counts summarise the full result set, not the rendered page', () => {
  const nodes = [];
  const links = [];
  for (let i = 0; i < 30; i += 1) {
    nodes.push({ id: `low-${i}`, label: `Weak ${i}`, confidence: 0.1, last_seen: RECENT });
  }
  nodes.push({ id: 'multi-1', label: 'Ambiguous', confidence: 0.9, last_seen: RECENT });
  links.push({ source: 'multi-1', target: 'a', relation: 'tür' });
  links.push({ source: 'multi-1', target: 'b', relation: 'tür' });

  const { findings, counts } = triageConflicts(nodes, links, NOW);
  assert.equal(counts.total, 31);
  assert.equal(counts.total, findings.length);
  assert.equal(counts.high, 1);
  assert.equal(counts.medium, 30);
  assert.equal(counts.low, 0);
  assert.equal(counts.byType['multi-type'], 1);
  assert.equal(counts.byType['low-confidence'], 30);
  assert.equal(counts.byType.stale, 0);
  assert.ok(counts.total > CONFLICT_PAGE, 'this fixture must exceed one page, or it proves nothing');
});

test('filters narrow by severity, by type, and by both together', () => {
  const { nodes, links } = fixture();
  const { findings } = triageConflicts(nodes, links, NOW);

  assert.equal(filterConflicts(findings, { severity: '', type: '' }).length, findings.length);
  assert.deepEqual(plain(filterConflicts(findings, { severity: 'high', type: '' })).map(f => f.type).sort(),
    ['multi-type', 'negation']);
  assert.deepEqual(plain(filterConflicts(findings, { severity: '', type: 'stale' })).map(f => f.subject),
    ['Stale claim']);
  assert.deepEqual(plain(filterConflicts(findings, { severity: 'high', type: 'stale' })), [],
    'contradictory filters must produce an empty set, not a fallback to everything');
  assert.deepEqual(plain(filterConflicts(findings, { severity: 'high', type: 'negation' })).map(f => f.subject),
    ['Contradicted claim']);
});

test('every declared signal type carries a severity and a human label', () => {
  for (const [type, meta] of Object.entries(CONFLICT_TYPES)) {
    assert.ok(CONFLICT_SEVERITY[meta.severity], `${type} maps to unknown severity ${meta.severity}`);
    assert.ok(meta.label && meta.label !== type, `${type} must carry a human-readable label`);
  }
});

test('the signal list is rendered as a bounded page, never as the whole set', () => {
  assert.match(script, /const CONFLICT_PAGE=10;/);
  assert.match(script, /limit=Math\.max\(0,Math\.min\(state\.conflicts\.limit,shown\.length\)\)/);
  assert.match(script, /page=shown\.slice\(0,limit\)/);
  // A surface that is loading, locked or failed must not keep painting the
  // previous verdict underneath a "checking" status line.
  assert.match(script, /const shown=ready\?filterConflicts\(triage\.findings,state\.conflicts\.filters\):\[\]/);
  assert.match(script, /\$\('clist'\)\.innerHTML=page\.map\(/);
  assert.doesNotMatch(script, /\$\('clist'\)\.innerHTML=(shown|f)\.map\(/,
    'the conflict list must never render the unpaged result set');
  // Changing a filter must not leave the user scrolled into a page of a
  // different result set.
  assert.match(script, /function setConflictFilter\(key,value\)\{state\.conflicts\.filters\[key\]=value\|\|'';state\.conflicts\.limit=CONFLICT_PAGE;renderConflicts\(\)\}/);
});

test('the conflict view exposes counts and an explicit path to the rest of the set', () => {
  for (const id of ['ctriage', 'csummary', 'clistmeta', 'cstatus', 'clist', 'cmore', 'cless', 'cclear']) {
    assert.ok(html.includes(`id="${id}"`), `conflict view must render #${id}`);
  }
  assert.match(script, /const more=\$\('cmore'\);more\.hidden=remaining<=0/);
  assert.match(script, /remaining=Math\.max\(0,shown\.length-limit\)/);
  assert.match(script, /\$\('cmore'\)\.onclick=\(\)=>\{state\.conflicts\.limit\+=CONFLICT_PAGE;renderConflicts\(\)\}/);
});

test('the filters are labelled and keyboard reachable', () => {
  const view = html.slice(html.indexOf('id="v-conflicts"'), html.indexOf('id="v-integrations"'));
  assert.ok(view.includes('id="v-conflicts"'), 'the conflicts view must exist');

  for (const control of ['cseverity', 'ctype']) {
    assert.match(view, new RegExp(`<label for="${control}"[^>]*>`), `#${control} needs an associated <label for>`);
    assert.ok(view.includes(`<select id="${control}">`), `#${control} must be a real form control`);
  }
  assert.match(view, /role="group"[^>]*aria-label="Conflict signal filters"/);
  assert.match(view, /role="group"[^>]*aria-label="Filter signals by severity"/);
  assert.match(view, /id="cstatus"[^>]*role="status"[^>]*aria-live="polite"/);
  // The severity summary chips are filters, so they have to be buttons with a
  // pressed state rather than clickable divs.
  assert.match(script, /<button type="button" class="chip\$\{[^`]*data-conflict-severity="\$\{k\}" aria-pressed=/);
});

test('empty, loading and error states are distinct and name a next step', () => {
  assert.match(script, /Conflict triage is \$\{label\.toLowerCase\(\)\}\. \$\{Tx\(s\.reason\)\}/);
  assert.match(script, /'No conflict signals in current graph data\.'/);
  assert.match(script, /'No signals match the selected filters\.'/);
  assert.match(script, /data-action="conflicts-clear"/);
  assert.match(script, /if\(b\.dataset\.action==='conflicts-clear'\)\{clearConflictFilters\(\);return\}/);
  // The unreachable-surface empty state reuses the shared recovery CTA so a
  // locked or failed graph offers the same next action as every other surface.
  assert.match(script, /Conflict triage is \$\{esc\(label\.toLowerCase\(\)\)\}\.<\/b><br>\$\{esc\(Tx\(s\.reason\)\)\}<div class="actions">\$\{surfaceCta\('graph'\)\}/);
  // A refresh has to repaint the conflict view, or the loading state is a
  // state the user can never see.
  assert.match(script, /forEach\(k=>surface\(k,'checking'\)\);renderGraph\(\);await Promise\.allSettled/);
});

test('the patched dashboard still compiles and the triage CSS ships', () => {
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(dashboardSource(), /#ctriage \.chip\{/);
});
