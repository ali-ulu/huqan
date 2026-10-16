'use strict';

/**
 * #2610 -- one-time migration of stored prov_ ids from the legacy sha1/64-bit
 * mint to the sha256/128-bit mint.
 *
 * The legacy mint (lib/provenance-ingest.js legacyProvenanceId) is
 * deterministic over the same base string the current mint uses, so every
 * stored legacy id can be re-derived and verified before it is rewritten.
 * An id is only rewritten when the record it sits on re-derives exactly that
 * legacy id; anything else is reported and left untouched.
 *
 * Dry-run by default. --apply writes, after copying each target to
 * <target>.bak-prov-migration.
 *
 * Usage:
 *   node scripts/migrate-prov-ids.js                       # report only
 *   node scripts/migrate-prov-ids.js --apply               # rewrite + backup
 *   node scripts/migrate-prov-ids.js --db <path> --apply
 *   node scripts/migrate-prov-ids.js --memory-json <path> --apply
 */

const fs = require('fs');
const path = require('path');
const {
  legacyProvenanceId,
  makeProvenanceId,
  isLegacyProvenanceId,
} = require('../lib/provenance-ingest');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};

const LEGACY_RE = /prov_[0-9a-f]{16}/g;

function walkProvenanceObjects(value, out = []) {
  if (Array.isArray(value)) {
    for (const v of value) walkProvenanceObjects(v, out);
  } else if (value && typeof value === 'object') {
    if (typeof value.provenanceId === 'string' && isLegacyProvenanceId(value.provenanceId)) {
      out.push(value);
    }
    for (const v of Object.values(value)) walkProvenanceObjects(v, out);
  }
  return out;
}

// Re-derive the id the record must have had, and only accept the rewrite when
// the stored id equals that derivation. Anything else means the id was
// caller-supplied or the stored fields drifted -- rewriting it here would be
// a guess, so it is reported instead.
function plannedNewId(prov) {
  const derived = legacyProvenanceId({
    sourceRef: prov.sourceRef,
    subject: prov.subject,
    object: prov.object,
    timestamp: prov.timestamp,
  });
  if (derived !== prov.provenanceId) return null;
  return makeProvenanceId({
    sourceRef: prov.sourceRef,
    subject: prov.subject,
    object: prov.object,
    timestamp: prov.timestamp,
  });
}

function rewriteText(text, idMap) {
  return text.replace(LEGACY_RE, (id) => idMap.get(id) || id);
}

function collectFromJsonText(text, idMap, stats) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!parsed) {
    const bare = text.match(LEGACY_RE) || [];
    stats.unverifiable += bare.length;
    return;
  }
  for (const prov of walkProvenanceObjects(parsed)) {
    const next = plannedNewId(prov);
    if (next) {
      idMap.set(prov.provenanceId, next);
      stats.rewritable += 1;
    } else {
      stats.unverifiable += 1;
    }
  }
}


function collectSqlite(file, idMap, stats) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  for (const { t, c } of listTextColumns(db)) {
    let rows;
    try {
      rows = db.prepare(`select rowid as rid, "${c}" as v from "${t}"`).all();
    } catch { continue; }
    for (const { v } of rows) {
      if (typeof v === 'string' && LEGACY_RE.test(v)) {
        resetRe();
        collectFromJsonText(v, idMap, stats);
      }
      resetRe();
    }
  }
  db.close();
}

function applySqlite(file, idMap) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  let updated = 0;
  db.exec('begin');
  try {
    for (const { t, c } of listTextColumns(db)) {
      let rows;
      try {
        rows = db.prepare(`select rowid as rid, "${c}" as v from "${t}"`).all();
      } catch { continue; }
      for (const { rid, v } of rows) {
        if (typeof v !== 'string' || !LEGACY_RE.test(v)) continue;
        resetRe();
        const next = rewriteText(v, idMap);
        resetRe();
        if (next !== v) {
          db.prepare(`update "${t}" set "${c}" = ? where rowid = ?`).run(next, rid);
          updated += 1;
        }
      }
      resetRe();
    }
    db.exec('commit');
  } catch (err) {
    db.exec('rollback');
    throw err;
  }
  db.close();
  console.log(`SQLite cells updated: ${updated}`);
}

function main() {
  const dbPath = flagValue('--db') || path.resolve(process.cwd(), 'memory.db');
  const memoryJsonPath = flagValue('--memory-json');
  const idMap = new Map();
  const stats = { rewritable: 0, unverifiable: 0 };

  const targets = [];
  if (fs.existsSync(dbPath)) targets.push({ file: dbPath, sqlite: true });
  if (memoryJsonPath && fs.existsSync(memoryJsonPath)) targets.push({ file: memoryJsonPath, sqlite: false });

  if (!targets.length) {
    console.log(`No target files found (db: ${dbPath}${memoryJsonPath ? `, memory.json: ${memoryJsonPath}` : ''}). Nothing to do.`);
    return;
  }

  // Pass 1: verify every legacy id against a re-derivation and build old->new.
  for (const { file, sqlite } of targets) {
    if (sqlite) collectSqlite(file, idMap, stats);
    else collectFromJsonText(fs.readFileSync(file, 'utf8'), idMap, stats);
  }

  console.log(`Targets scanned: ${targets.length}`);
  console.log(`Legacy prov_ ids verified & rewritable: ${stats.rewritable}`);
  console.log(`Legacy id occurrences NOT verifiable (left untouched): ${stats.unverifiable}`);
  for (const [oldId, newId] of idMap) console.log(`  ${oldId} -> ${newId}`);

  if (!apply) {
    console.log('Dry run: nothing written. Re-run with --apply to rewrite (a .bak-prov-migration backup is made first).');
    return;
  }
  if (!idMap.size) {
    console.log('Nothing to rewrite.');
    return;
  }

  // Pass 2: rewrite, with backup.
  for (const { file, sqlite } of targets) {
    fs.copyFileSync(file, `${file}.bak-prov-migration`);
    if (sqlite) applySqlite(file, idMap);
    else fs.writeFileSync(file, rewriteText(fs.readFileSync(file, 'utf8'), idMap));
    console.log(`Rewritten (backup at ${file}.bak-prov-migration): ${file}`);
  }
}

main();

function resetRe() { LEGACY_RE.lastIndex = 0; }

function listTextColumns(db) {
  const tables = db.prepare("select name from sqlite_master where type='table'").all();
  const out = [];
  for (const { name: t } of tables) {
    const cols = db.prepare(`pragma table_info("${t}")`).all().map((c) => c.name);
    for (const c of cols) out.push({ t, c });
  }
  return out;
}
