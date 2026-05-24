const fs = require('fs');
const path = require('path');
const Kernel = require('../kernel');

function loadFixture(name) {
  const file = path.join(__dirname, 'fixtures', `${name}.json`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data)) throw new Error(`Fixture must be an array: ${name}`);
  return data;
}

function createKernel() {
  return new Kernel({ noLoad: true, loadPlugins: false, useSQLite: false });
}

// Ground truth positives: statements directly learnable or verifiable from grapheval fixture
const TRUE_STATEMENTS = [
  'kedi hayvandir',
  'kedi memelidir',
  'kedi balik yer',
  'kedi miyavlar',
  'kedi uyur',
  'kopek hayvandir',
  'kopek havlar',
  'kus hayvandir',
  'kus ucar',
  'kus kanatlidir',
  'kus yumurtlar',
  'balik suda yasar',
  'balik yuzer',
  'yilan hayvandir',
  'yilan surunur',
  'orumcek hayvandir',
  'orumcek ag orer',
  'at memelidir',
  'tavuk hayvandir',
  'araba tasitdir',
  'elma meyvedir',
  'gunes sicaktir',
  'buz soguktur',
  'insan canlidir',
  'insan dusunur',
  'bitki canlidir',
  'ates sicaktir',
  'su akiskandir',
];

// Ground truth negatives: statements that conflict with learned graph
// Includes: negation conflicts, opposite predicates, type mismatches, cross-ontology conflicts
const FALSE_STATEMENTS = [
  'kedi ucar',
  'kedi kanatlidir',
  'kedi balik degildir',
  'kopek ucar',
  'kus yuzmez',
  'balik kosar',
  'elma hayvandir',
  'araba ucar',
  'araba yuzer',
  'insan hayvan degildir',
  'bitki hayvandir',
  'tas canlidir',
  'su gazdir',
  'ates soguktur',
  'gunes soguktur',
  'buz sicaktir',
  'kopek miyavlar',
  'kedi havlar',
  'at ucar',
  'tavuk ucar',
];

function runVerificationBench() {
  const statements = loadFixture('grapheval');
  const kernel = createKernel();
  for (const stmt of statements) {
    kernel.learn(stmt);
  }

  const results = {
    truePositives: 0,
    falsePositives: 0,
    trueNegatives: 0,
    falseNegatives: 0,
    truths: [],
    falsehoods: [],
  };

  for (const stmt of TRUE_STATEMENTS) {
    const raw = kernel.verify(stmt);
    const result = raw.data || raw;
    const isVerified = result && result.status === 'dogrulandi';
    if (isVerified) {
      results.truePositives++;
      results.truths.push({ stmt, status: 'correct', confidence: result.confidence });
    } else {
      results.falseNegatives++;
      results.truths.push({ stmt, status: 'missed', confidence: result.confidence || 0 });
    }
  }

  for (const stmt of FALSE_STATEMENTS) {
    const raw = kernel.verify(stmt);
    const result = raw.data || raw;
    const isRejected = result && (result.status === 'celiski' || result.status === 'bilinmiyor');
    if (isRejected) {
      results.trueNegatives++;
      results.falsehoods.push({ stmt, status: 'correct', confidence: result.confidence || 0 });
    } else {
      results.falsePositives++;
      results.falsehoods.push({ stmt, status: 'missed', confidence: result.confidence || 0 });
    }
  }

  const total = TRUE_STATEMENTS.length + FALSE_STATEMENTS.length;
  const correct = results.truePositives + results.trueNegatives;
  const precision = results.truePositives / (results.truePositives + results.falsePositives) || 0;
  const recall = results.truePositives / (results.truePositives + results.falseNegatives) || 0;
  const f1 = 2 * (precision * recall) / (precision + recall) || 0;

  return {
    total,
    correct,
    accuracy: correct / total,
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1: Number(f1.toFixed(4)),
    truePositives: results.truePositives,
    falsePositives: results.falsePositives,
    trueNegatives: results.trueNegatives,
    falseNegatives: results.falseNegatives,
    truths: results.truths,
    falsehoods: results.falsehoods,
    comparison: {
      axiom: `AXIOM F1: ${Number(f1.toFixed(4))}`,
      llmAsJudge: '0.82 – 0.86 (LLM-as-Judge, academic baseline)',
      nli: '0.78 – 0.81 (NLI-only, academic baseline)',
    },
  };
}

if (require.main === module) {
  const result = runVerificationBench();
  console.log('=== GraphEval Verification Benchmark ===\n');
  console.log(`Total:      ${result.total}`);
  console.log(`Correct:    ${result.correct}`);
  console.log(`Accuracy:   ${(result.accuracy * 100).toFixed(1)}%`);
  console.log(`Precision:  ${result.precision}`);
  console.log(`Recall:     ${result.recall}`);
  console.log(`F1 Score:   ${result.f1}`);
  console.log(`\nConfusion Matrix:`);
  console.log(`  TP: ${result.truePositives}  FP: ${result.falsePositives}`);
  console.log(`  FN: ${result.falseNegatives}  TN: ${result.trueNegatives}`);
  console.log(`\nComparison:`);
  console.log(`  ${result.comparison.axiom}`);
  console.log(`  ${result.comparison.llmAsJudge}`);
  console.log(`  ${result.comparison.nli}`);

  if (result.truths && result.truths.some(t => t.status === 'missed')) {
    console.log(`\nMissed truths:`);
    for (const t of result.truths.filter(t => t.status === 'missed')) {
      console.log(`  ✗ ${t.stmt} (conf: ${t.confidence})`);
    }
  }
  if (result.falsehoods && result.falsehoods.some(f => f.status === 'missed')) {
    console.log(`\nMissed falsehoods:`);
    for (const f of result.falsehoods.filter(f => f.status === 'missed')) {
      console.log(`  ✗ ${f.stmt} (conf: ${f.confidence})`);
    }
  }
}

module.exports = { runVerificationBench };
