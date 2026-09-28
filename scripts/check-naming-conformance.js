#!/usr/bin/env node
'use strict';

/**
 * RFC-001 declares `HUQAN` the canonical product identity and `AXIOM` a legacy
 * compatibility identifier only, "never presented as a current, separate
 * product or protocol family" (#3029).
 *
 * That contract was enforced on the runtime surfaces (env vars, MCP tool names,
 * packages, spec paths) and closed there. It was not enforced on the documents
 * that state what the product *is*. `docs/product-positioning.md` opened with
 * `# AXIOM Product Positioning` while `README.md` opened with `# HUQAN`: the
 * two front doors disagreed about the product's name.
 *
 * This check covers the identity surface -- the documents a reader consults to
 * learn what the product is. It does not cover the whole docs tree: RFC-001
 * keeps AXIOM valid on legacy identifier surfaces, and records (release notes,
 * ADRs, archives, migration guides) say what was true on a past date, so
 * "correcting" them would destroy the record. The identity set is listed
 * explicitly below rather than inferred, so widening it is a visible edit.
 *
 * The polarity is the point: a current-product mention of AXIOM in one of these
 * documents fails, while a legacy identifier (an `AXIOM_*` env var, a `.axiom`
 * package, an `axiom.*` tool alias) passes.
 */

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

/**
 * Documents that define the product's identity to a reader now. A current
 * mention of AXIOM in any of these is drift against RFC-001.
 */
const IDENTITY_DOCS = Object.freeze([
  'README.md',
  'docs/product-positioning.md',
  'docs/pitch-v0.md',
  'docs/demo-positioning.md',
  'docs/vision-next.md',
  'docs/architecture.md',
  'docs/index.html',
]);

/**
 * The legacy surfaces RFC-001 deliberately keeps, each with its migration gate.
 * These are stripped before the AXIOM test, so a reader of this file can see
 * exactly which identifiers are allowed to survive and why.
 */
const LEGACY_IDENTIFIERS = Object.freeze([
  { pattern: /AXIOM_[A-Z0-9_]+/g, why: 'environment-variable compatibility, RFC-001 M1' },
  { pattern: /\.axiom\b/g, why: 'package suffix still read, RFC-001 M4' },
  { pattern: /axiom-[a-z0-9-]+/g, why: 'legacy package / spec-path identifier, RFC-001 M2/M3' },
  { pattern: /\baxiom\.[a-z_]+/g, why: 'MCP tool-name alias still accepted, RFC-001 M5' },
]);

/** Fenced and inline code are quotations, not product claims. */
function stripCode(markdown) {
  return String(markdown)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

function stripLegacyIdentifiers(text) {
  return LEGACY_IDENTIFIERS.reduce((carry, { pattern }) => carry.replace(pattern, ' '), text);
}

/**
 * Current-product mentions of AXIOM in a document, after quotations and legacy
 * identifiers are removed. Any uppercase AXIOM left is presented as the product.
 */
function currentProductMentions(markdown) {
  const prose = stripLegacyIdentifiers(stripCode(markdown));
  return [...prose.matchAll(/\bAXIOM\b/g)].map((match) => match.index);
}

function checkIdentityDoc(relativePath) {
  const absolute = path.join(repoRoot, relativePath);
  const errors = [];
  let text;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    return [`${relativePath}: cannot read identity document: ${error.message}`];
  }

  if (!text.includes('HUQAN')) {
    errors.push(`${relativePath}: names no canonical HUQAN identity`);
  }
  if (currentProductMentions(text).length > 0) {
    errors.push(`${relativePath}: presents AXIOM as the current product (RFC-001 keeps it as a legacy identifier only)`);
  }
  return errors;
}

function collectNamingViolations() {
  return IDENTITY_DOCS.flatMap(checkIdentityDoc);
}

function main() {
  const violations = collectNamingViolations();
  if (violations.length === 0) {
    console.log(`check:naming-conformance — ${IDENTITY_DOCS.length} identity documents name HUQAN, none present AXIOM as the product.`);
    return 0;
  }
  console.error(`check:naming-conformance — ${violations.length} naming violation(s):\n`);
  for (const violation of violations) console.error(`  ${violation}`);
  console.error('\nRe-label the document to HUQAN, or — if the mention is a preserved legacy surface —');
  console.error('express it as an identifier and add the pattern to LEGACY_IDENTIFIERS in scripts/check-naming-conformance.js citing RFC-001.');
  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  IDENTITY_DOCS,
  LEGACY_IDENTIFIERS,
  currentProductMentions,
  collectNamingViolations,
};
