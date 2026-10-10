'use strict';

// AURA signal-pack bridge: AURA is an external repo (kate8382/AURA). HUQAN does
// not vendor it and does not require it at runtime. This module loads AURA's
// real TypeScript engine through ts-node only when a caller asks for a pack,
// so a HUQAN install without AURA still works (fail-closed: no pack, no signal).
//
// The pack is a deterministic JSON snapshot: AURA's own signal vocabulary, the
// trigger weights it generated, and — when AURA's engine is available — the
// per-case recalculation output (signal_ids, confidence, decision). HUQAN's
// `plugins/aura-risk.js` consumes the snapshot and never shells out itself.

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const PACK_VERSION = 'huqan.aura-signal-pack.v1';

function auraRoot() {
  return process.env.AURA_ROOT || path.resolve(__dirname, '..', '..', 'aura');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

// AURA's signal vocabulary, as a normalized-trigger -> signal_id map. This is
// the piece the pack must carry even when the engine is unavailable: it is
// plain data read from AURA's canonical mapping file.
function loadSignalVocabulary(root) {
  const parsed = readJson(path.join(root, 'config', 'signal-mapping.json'));
  const signals = parsed && parsed.signals ? parsed.signals : {};
  const triggerToSignal = {};
  const signalIds = [];
  for (const [signalId, entry] of Object.entries(signals)) {
    signalIds.push(signalId);
    const triggers = Array.isArray(entry) ? entry : (entry && Array.isArray(entry.triggers) ? entry.triggers : []);
    for (const trigger of triggers) {
      if (typeof trigger !== 'string') continue;
      triggerToSignal[trigger.trim().toLowerCase()] = signalId;
    }
  }
  signalIds.sort();
  return { signalIds, triggerToSignal };
}

// Loads AURA's TS modules via ts-node. Returns null when AURA (or ts-node) is
// not installed, so the caller can fall back to a vocabulary-only pack.
function loadAuraEngine(root) {
  try {
    process.env.TS_NODE_PROJECT = path.join(root, 'tsconfig.json');
    process.env.TS_NODE_TRANSPILE_ONLY = 'true';
    const auraRequire = createRequire(path.join(root, 'package.json'));
    auraRequire('ts-node/register/transpile-only');
    const { RecalcConfidence } = auraRequire(path.join(root, 'scripts', 'recalc_confidence.ts'));
    const PolicyEvaluator = auraRequire(path.join(root, 'scripts', 'policy', 'evaluateDecision.ts')).default;
    if (typeof RecalcConfidence !== 'function' || typeof PolicyEvaluator !== 'function') return null;
    return { RecalcConfidence, PolicyEvaluator };
  } catch (_) {
    return null;
  }
}

function walkJsonFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

// Runs AURA's real recalc over a copy of the cases so AURA's own decision
// engine produces the confidence/decision the pack records. AURA writes only
// to the copy (dry-run writes a temp sibling), so the source cases are never
// touched.
async function recalcCases(engine, root, caseFiles) {
  const tmpDir = path.join(root, '.aura-pack-tmp');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const cases = [];
  try {
    for (const file of caseFiles) {
      const source = readJson(file);
      if (!source) continue;
      const tmpFile = path.join(tmpDir, path.basename(file));
      fs.writeFileSync(tmpFile, JSON.stringify(source, null, 2), 'utf8');
      const recalcer = new engine.RecalcConfidence();
      // eslint-disable-next-line no-await-in-loop
      await recalcer.recalc(tmpFile, false, 0);
      const updated = readJson(tmpFile) || source;
      cases.push(projectCase(updated));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  cases.sort((a, b) => a.case_id.localeCompare(b.case_id));
  return cases;
}

function projectCase(entry) {
  const scenarios = Array.isArray(entry.scenarios) ? entry.scenarios : [];
  return {
    case_id: entry.case_id,
    domain: entry.domain || '',
    category: entry.category || '',
    signal_ids: Array.isArray(entry.signal_ids) ? [...entry.signal_ids] : [],
    confidence: typeof entry.confidence === 'number' ? entry.confidence : 0,
    confidence_raw: typeof entry.confidence_raw === 'number' ? entry.confidence_raw : 0,
    decision: entry.decision || 'pending',
    decision_reasons: Array.isArray(entry.decision_reasons) ? [...entry.decision_reasons] : [],
    scenario_texts: scenarios
      .map((scenario) => (scenario && typeof scenario.text === 'string' ? scenario.text : ''))
      .filter(Boolean),
  };
}

// Vocabulary-only pack: usable when AURA's engine cannot be loaded. Decisions
// are absent by design — the plugin then contributes signals but never a
// decision, so it cannot fake a verdict it did not compute.
function vocabularyPack(root, vocabulary) {
  return {
    packVersion: PACK_VERSION,
    generator: 'aura-signal-pack-bridge',
    engineAvailable: false,
    auraRoot: root,
    generatedAt: null,
    signalIds: vocabulary.signalIds,
    triggerToSignal: vocabulary.triggerToSignal,
    cases: [],
  };
}

async function buildSignalPack(root = auraRoot()) {
  const vocabulary = loadSignalVocabulary(root);
  if (!fs.existsSync(path.join(root, 'config', 'signal-mapping.json'))) {
    const error = new Error(`AURA root not found or incomplete: ${root}`);
    error.code = 'AURA_ROOT_MISSING';
    throw error;
  }
  const engine = loadAuraEngine(root);
  if (!engine) return vocabularyPack(root, vocabulary);

  const caseFiles = walkJsonFiles(path.join(root, 'public_cases'));
  const cases = await recalcCases(engine, root, caseFiles);
  return {
    packVersion: PACK_VERSION,
    generator: 'aura-signal-pack-bridge',
    engineAvailable: true,
    auraRoot: root,
    generatedAt: new Date().toISOString(),
    signalIds: vocabulary.signalIds,
    triggerToSignal: vocabulary.triggerToSignal,
    cases,
  };
}

function defaultPackPath() {
  return path.join(__dirname, '..', 'fixtures', 'aura', 'aura-signal-pack.json');
}

function writeSignalPack(pack, outPath = defaultPackPath()) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  return outPath;
}

// Reads a previously generated pack from disk. Returns a fail-closed empty
// pack (no signals, no cases) when it is absent or malformed, so a caller
// degrades to "AURA contributes nothing" rather than to a wrong signal.
function loadSignalPack(options = {}) {
  const file = options.packPath || process.env.AURA_SIGNAL_PACK || defaultPackPath();
  const parsed = readJson(file);
  if (!parsed || typeof parsed !== 'object') {
    return { packVersion: '', engineAvailable: false, signalIds: [], triggerToSignal: {}, cases: [] };
  }
  return {
    packVersion: parsed.packVersion || '',
    engineAvailable: parsed.engineAvailable === true,
    signalIds: Array.isArray(parsed.signalIds) ? parsed.signalIds : [],
    triggerToSignal: parsed.triggerToSignal && typeof parsed.triggerToSignal === 'object' ? parsed.triggerToSignal : {},
    cases: Array.isArray(parsed.cases) ? parsed.cases : [],
  };
}

module.exports = {
  PACK_VERSION,
  auraRoot,
  buildSignalPack,
  defaultPackPath,
  loadSignalPack,
  loadSignalVocabulary,
  writeSignalPack,
};

if (require.main === module) {
  buildSignalPack()
    .then((pack) => {
      const out = writeSignalPack(pack);
      const engine = pack.engineAvailable ? 'engine' : 'vocabulary-only';
      console.log(`AURA signal pack (${engine}): ${pack.cases.length} cases, ${pack.signalIds.length} signals -> ${out}`);
    })
    .catch((err) => {
      console.error(`AURA signal pack failed: ${err.message}`);
      process.exit(1);
    });
}
