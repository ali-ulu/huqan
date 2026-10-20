'use strict';

/**
 * #4105 — the two audience messages, and the boundary that keeps the second
 * one honest.
 *
 * The product now speaks to two readers. An individual builder is told the
 * agent has an emergency brake; an organization is told it gets an audit
 * record it did not write. Both sentences are only worth printing while the
 * source still backs them, so each one is held against the code that makes it
 * true:
 *
 *   - "emergency brake" is the gate holding a mutating call at `REVIEW` (not
 *     `BLOCK` — a pause, not a refusal) plus `huqan.emergency_stop`;
 *   - "the record is not the agent's own account" is the Trust Receipt being
 *     produced by the gate that decided, not by the actor it describes;
 *   - "independent auditor" is a *conditional* claim. It is true only with a
 *     collector counter-seal held outside the operator's administration. The
 *     issuer seal proves origin and integrity, not operator honesty, and the
 *     README Limits bullet has to keep saying so.
 *
 * The last one is the reason this file exists. "Independent" is the one word
 * in the enterprise message that can become false without any code changing —
 * by being printed unconditionally. The test reads the boundary out of the two
 * seal modules and fails if the docs stop repeating it, so the message and its
 * limit move together.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const README = 'README.md';
const POSITIONING = 'docs/demo-positioning.md';
const ISSUER_SEAL = 'lib/receipt/issuer-seal.js';
const COLLECTOR_SEAL = 'lib/receipt/collector-seal.js';

/** Phrases the positioning document's own "Avoid" list forbids. */
const FORBIDDEN = [
  'guaranteed truth',
  'hallucination-free',
  'fully autonomous',
  'production-scale graph',
  'full NLP engine',
];

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

/** A `## Heading` section of a markdown document, up to the next `##`. */
function section(markdown, headingPattern) {
  const start = markdown.search(headingPattern);
  assert.ok(start !== -1, `the document must keep a section matching ${headingPattern}`);
  const rest = markdown.slice(start);
  const next = rest.slice(1).search(/^##\s/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test('the README introduces both audiences before the quickstart', () => {
  const readme = read(README);
  const audience = section(readme, /^## Who it is for\b/m);

  assert.match(audience, /emergency brake/i,
    'the individual/community message must survive in the README');
  assert.match(audience, /audit record/i,
    'the enterprise message must survive in the README');

  // The section must sit on the first screen, above the runnable command: an
  // audience statement a reader meets after the quickstart is not positioning.
  const quickstart = readme.search(/^## Try it in 30 seconds\b/m);
  const start = readme.search(/^## Who it is for\b/m);
  assert.ok(start !== -1 && start < quickstart,
    'the audience section must come before the quickstart');
});

test('the positioning document carries both messages and their boundary', () => {
  const positioning = read(POSITIONING);
  const section2 = section(positioning, /^## Two Audiences, Two Messages\b/m);

  assert.match(section2, /emergency brake/i, 'the individual message must be stated');
  assert.match(section2, /independent auditor/i, 'the enterprise message must be named');
  // The limit is not optional prose: it is the third part of the section.
  assert.match(section2, /issuer-seal\.js/, 'the section must cite the issuer seal');
  assert.match(section2, /collector-seal\.js/, 'the section must cite the collector counter-seal');
  assert.match(section2, /does not administer/i,
    'the section must state the deployment condition for "independent"');
});

test('the individual message holds a call at REVIEW, not BLOCK', () => {
  const positioning = read(POSITIONING);
  const individual = positioning.slice(
    positioning.search(/^### Individual\b/m),
    positioning.search(/^### Enterprise\b/m),
  );
  assert.match(individual, /`REVIEW`/,
    'the brake pauses a call; the gate decision it names must be REVIEW');

  // The word is not decoration: REVIEW must still be a decision the gate
  // returns, and it must be the one that holds a call for a person.
  const { MCP_GATE_DECISIONS } = require('../lib/mcp-gate-adapter-contract');
  assert.equal(MCP_GATE_DECISIONS.review, 'review');
  const gate = read('lib/tool-call-gate.js');
  assert.match(gate, /TOOL_GATE_DECISIONS\.REVIEW/,
    'the gate must still return a REVIEW decision the message can name');
});

test('the README Limits bounds the word "independent"', () => {
  const limits = section(read(README), /^## Limits\b/m);
  assert.match(limits, /issuer-seal\.js/, 'Limits must name the issuer seal');
  assert.match(limits, /collector-seal\.js/, 'Limits must name the collector counter-seal');
  assert.match(limits, /operator honesty/i,
    'Limits must say the issuer seal does not prove operator honesty');
  assert.match(limits, /does not administer/i,
    'Limits must say the counter-seal needs a party the operator does not administer');
});

test('the seal modules still carry the boundary the docs quote', () => {
  const issuer = read(ISSUER_SEAL);
  assert.match(issuer, /not operator honesty/,
    'the issuer seal must still disclaim operator honesty');
  assert.match(issuer, /collector-seal/,
    'the issuer seal must still point at the collector as the third-party rung');

  const collector = read(COLLECTOR_SEAL);
  assert.match(collector, /does not[\s\S]{0,12}administer/,
    'the collector seal must still state the administration condition');
  assert.match(collector, /one person holds both ends/,
    'the collector seal must still say what both keys on one machine means');
});

test('the positioning text introduces no forbidden claim', () => {
  // Only the new section is checked. The document's own "Avoid" list names
  // every forbidden phrase on purpose, so reading the whole file would fail on
  // the rule rather than on a violation of it.
  const section2 = section(read(POSITIONING), /^## Two Audiences, Two Messages\b/m).toLowerCase();
  for (const phrase of FORBIDDEN) {
    assert.ok(!section2.includes(phrase),
      `the positioning section must not carry the forbidden phrase "${phrase}"`);
  }
});

test('price and licensing stay out of the positioning text', () => {
  const positioning = read(POSITIONING);
  // The two message bodies, not the guard sentence that says to keep
  // commercial language out of the section.
  const messages = [
    positioning.slice(positioning.search(/^### Individual\b/m), positioning.search(/^### Enterprise\b/m)),
    positioning.slice(positioning.search(/^### Enterprise\b/m), positioning.search(/^### The boundary\b/m)),
  ].join('\n').toLowerCase();
  for (const word of ['pricing', 'per seat', 'subscription', 'license fee', '$']) {
    assert.ok(!messages.includes(word),
      `the audience messages must not carry commercial language ("${word}")`);
  }
});
