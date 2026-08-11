'use strict';

const {
  readCompatibleEnvironmentVariable,
  validateEnvironmentCompatibility,
} = require('../lib/environment-compat');
validateEnvironmentCompatibility();

/**
 * HUQAN BiGG Demo Seed Script
 *
 * Loads a curated knowledge base into the HUQAN graph using
 * direct addEdge so verify() returns reliable dogrulandi/celiski results.
 *
 * Usage:
 *   HUQAN_DB_PATH=/tmp/huqan-demo/memory.db \
 *   HUQAN_MEMORY_PATH=/tmp/huqan-demo/memory.json \
 *   HUQAN_KERNEL_VERSION=v2 \
 *   node scripts/seed-demo.js
 */

const path = require('path');
const fs = require('fs');
const KernelV2 = require('../kernel.v2');

const dbPath = readCompatibleEnvironmentVariable('DB_PATH') || path.join(process.cwd(), 'memory.db');
const memoryPath = readCompatibleEnvironmentVariable('MEMORY_PATH') || path.join(process.cwd(), 'memory.json');

// Ensure parent dir exists
for (const p of [dbPath, memoryPath]) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

const kernel = new KernelV2({ memoryPath, dbPath, loadPlugins: false });

/**
 * Add a fact as a direct graph edge.
 * subjectId and predicateText must be LOWERCASE normalized,
 * matching what normalizeText(verifyStatement) produces.
 *
 * The predicate text must be EXACTLY what the verify engine extracts:
 *   normalizeText(statement).slice(subjectNorm.length).trim()
 */
function addFact(subjectId, predicateText) {
  kernel.graph.addNode(subjectId, subjectId, null, {});
  kernel.graph.addNode(predicateText, predicateText, null, {});
  kernel.graph.addEdge(subjectId, predicateText, 'özellik', {
    weight: 0.95,
    confidence: 0.95,
    source: 'demo-seed',
  });
}

// ──────────────────────────────────────────────────────────────
// SENARYO 1 – TÜBİTAK Kuruluş Yılı
//   ✅ "TÜBİTAK was established in 1963"
//   ❌ "TÜBİTAK was established in 1960"
// ──────────────────────────────────────────────────────────────
addFact('tubitak', 'was established in 1963');
addFact('tubitak', 'is the scientific and technological research council of turkey');

// ──────────────────────────────────────────────────────────────
// SENARYO 2 – Türkiye Coğrafyası
//   ✅ "Istanbul is the most populous city in Turkey"
//   ❌ "Ankara is the most populous city in Turkey"
//   ✅ "Ankara is the capital city of Turkey"
//   ✅ "Istanbul has a population of 15 million"
//   ❌ "Istanbul has a population of 30 million"
//   ✅ "Turkey has a population of 85 million"
//   ❌ "Turkey has a population of 70 million"
// ──────────────────────────────────────────────────────────────
addFact('istanbul', 'is the most populous city in turkey');
addFact('istanbul', 'has a population of 15 million');
addFact('ankara', 'is the capital city of turkey');
addFact('turkey', 'has a population of 85 million');

// ──────────────────────────────────────────────────────────────
// SENARYO 3 – HUQAN Özellikleri
//
// DOĞRU (dogrulandi):
//   "HUQAN is an LLM-free knowledge verification engine"
//   "HUQAN runs entirely without GPU or cloud"
//   "HUQAN uses a knowledge graph for fact verification"
//   "HUQAN is deterministic"
//   "HUQAN operates completely offline without internet"
//   "HUQAN verifies statements against a local knowledge graph"
//   "HUQAN catches false claims in AI-generated text"
//   "HUQAN identifies factual errors in AI outputs"
//   "HUQAN supports Turkish language"
//   "HUQAN supports English language"
//   "HUQAN was built without using any neural network"
//   "HUQAN was developed in Turkey by a Turkish startup"
//
// YANLIŞ — AI halucinasyonları (celiski):
//   "HUQAN uses GPT-4 to verify statements"
//   "HUQAN is powered by a large language model"
//   "HUQAN requires a GPU to run"
//   "HUQAN needs cloud infrastructure"
//   "HUQAN requires an internet connection"
//   "HUQAN uses neural networks for fact checking"
//   "HUQAN was developed in the United States"
// ──────────────────────────────────────────────────────────────
addFact('huqan', 'is an llm-free knowledge verification engine');
addFact('huqan', 'runs entirely without gpu or cloud');
addFact('huqan', 'uses a knowledge graph for fact verification');
addFact('huqan', 'is deterministic');
addFact('huqan', 'operates completely offline without internet');
addFact('huqan', 'verifies statements against a local knowledge graph');
addFact('huqan', 'catches false claims in ai-generated text');
addFact('huqan', 'identifies factual errors in ai outputs');
addFact('huqan', 'supports turkish language');
addFact('huqan', 'supports english language');
addFact('huqan', 'was built without using any neural network');
addFact('huqan', 'was developed in turkey by a turkish startup');

// ──────────────────────────────────────────────────────────────
// SENARYO 4 – Mevzuat: KVKK / GDPR / EU AI Act
//
// KVKK DOĞRU:
//   "KVKK entered into force on April 7 2016"
//   "KVKK is law number 6698 in Turkey"
//   "KVKK requires explicit consent for sensitive personal data"
//   "KVKK established the personal data protection board"
//   "KVKK imposes administrative fines up to 1 million Turkish lira"
// KVKK YANLIŞ:
//   "KVKK entered into force on April 7 2018"        (yılı yanlış)
//   "KVKK is law number 5651 in Turkey"              (numara yanlış)
//   "KVKK imposes administrative fines up to 5 million Turkish lira" (ceza yanlış)
//
// GDPR DOĞRU:
//   "GDPR applies from 25 May 2018"
//   "GDPR imposes fines up to 20 million euros or 4 percent of global turnover"
//   "GDPR grants individuals the right to erasure of personal data"
// GDPR YANLIŞ:
//   "GDPR applies from 25 May 2016"
//   "GDPR imposes fines up to 10 million euros or 4 percent of global turnover"
//
// EU AI Act DOĞRU:
//   "EU AI Act was adopted in June 2024"             (NOT "officially" — triggers ABSOLUTE)
//   "EU AI Act entered into force on 1 August 2024"
//   "EU AI Act takes a risk-based approach to AI regulation"
//   "EU AI Act imposes fines up to 35 million euros or 7 percent of global turnover"
//   "EU AI Act requires conformity assessment for high-risk AI systems"
//   "EU AI Act classifies biometric identification as high-risk AI"
//   "EU AI Act is the first comprehensive AI regulation in the world"
// EU AI Act YANLIŞ:
//   "EU AI Act was adopted in June 2023"
//   "EU AI Act imposes fines up to 20 million euros or 7 percent of global turnover"
//   "EU AI Act entered into force on 1 January 2025"
// ──────────────────────────────────────────────────────────────

// KVKK
addFact('kvkk', 'entered into force on april 7 2016');
addFact('kvkk', 'is law number 6698 in turkey');
addFact('kvkk', 'requires explicit consent for sensitive personal data');
addFact('kvkk', 'established the personal data protection board');
addFact('kvkk', 'imposes administrative fines up to 1 million turkish lira');
addFact('kvkk', 'applies to data controllers processing personal data in turkey');

// GDPR
addFact('gdpr', 'applies from 25 may 2018');
addFact('gdpr', 'is the general data protection regulation of the european union');
addFact('gdpr', 'imposes fines up to 20 million euros or 4 percent of global turnover');
addFact('gdpr', 'grants individuals the right to erasure of personal data');
addFact('gdpr', 'requires a data protection impact assessment for high-risk processing');
addFact('gdpr', 'applies to organizations processing data of eu residents');

// EU AI Act — NOT "officially"/"formally" adopted: those contain "all" substring → ABSOLUTE flag
addFact('eu ai act', 'was adopted in june 2024');
addFact('eu ai act', 'entered into force on 1 august 2024');
addFact('eu ai act', 'takes a risk-based approach to ai regulation');
addFact('eu ai act', 'prohibits ai systems that pose unacceptable risk');
addFact('eu ai act', 'requires conformity assessment for high-risk ai systems');
addFact('eu ai act', 'imposes fines up to 35 million euros or 7 percent of global turnover');
addFact('eu ai act', 'requires transparency for general purpose ai models');
addFact('eu ai act', 'classifies biometric identification as high-risk ai');
addFact('eu ai act', 'is the first comprehensive ai regulation in the world');
addFact('eu ai act', 'prohibits social scoring by public authorities');

// ──────────────────────────────────────────────────────────────
// SENARYO 5 – BiGG Programı
//   ✅ "BiGG provides up to 2 million Turkish lira in funding"
//   ❌ "BiGG provides up to 500 thousand Turkish lira in funding"
// ──────────────────────────────────────────────────────────────
addFact('bigg', 'provides up to 2 million turkish lira in funding');
addFact('bigg', 'is the tubitak individual entrepreneurship grant program');

// ──────────────────────────────────────────────────────────────
// SENARYO 6 – HUQAN Teknik Özellikler (Repo'dan)
//
// Bunlar HUQAN'ın kaynak kodundan çıkarılan gerçek teknik
// özelliklerdir: Trust Receipt, append-only audit, provenance,
// blocking davranışı, trust label sınıflandırması.
//
// DOĞRU (dogrulandi):
//   "HUQAN generates a trust receipt as cryptographic proof of verification"
//   "HUQAN maintains a tamper-proof log of AI outputs it verifies"
//   "HUQAN stores provenance for each fact in the knowledge graph"
//   "HUQAN blocks AI outputs that contradict stored facts"
//   "HUQAN assigns a trust label to each AI output it processes"
//   "HUQAN quarantines flagged claims in a pending review queue"
//   "HUQAN enables human review before high-risk AI decisions take effect"
// ──────────────────────────────────────────────────────────────
addFact('huqan', 'generates a trust receipt as cryptographic proof of verification');
addFact('huqan', 'maintains a tamper-proof log of ai outputs it verifies');
addFact('huqan', 'stores provenance for each fact in the knowledge graph');
addFact('huqan', 'blocks ai outputs that contradict stored facts');
addFact('huqan', 'assigns a trust label to each ai output it processes');
addFact('huqan', 'quarantines flagged claims in a pending review queue');
addFact('huqan', 'enables human review before high-risk ai decisions take effect');

// ──────────────────────────────────────────────────────────────
// SENARYO 7 – EU AI Act Madde Yükümlülükleri
//
// Her madde AYRI subject olarak tanımlanır: böylece farklı madde
// numaraları aynı subject altında NUMERICAL_CONFLICT tetiklemez.
//
// DOĞRU (dogrulandi):
//   "EU AI Act article 9 requires a risk management system for high-risk AI providers"
//   "EU AI Act article 12 requires high-risk AI systems to maintain logs of operation"
//   "EU AI Act article 13 requires high-risk AI systems to be transparent to deployers"
//   "EU AI Act article 14 requires high-risk AI systems to support human oversight"
//   "EU AI Act article 17 requires high-risk AI providers to maintain quality documentation"
// ──────────────────────────────────────────────────────────────
addFact('eu ai act article 9', 'requires a risk management system for high-risk ai providers');
addFact('eu ai act article 12', 'requires high-risk ai systems to maintain logs of operation');
addFact('eu ai act article 13', 'requires high-risk ai systems to be transparent to deployers');
addFact('eu ai act article 14', 'requires high-risk ai systems to support human oversight');
addFact('eu ai act article 17', 'requires high-risk ai providers to maintain quality documentation');

// ──────────────────────────────────────────────────────────────
// SENARYO 8 – Cross-Domain Köprü: HUQAN × EU AI Act Uyumu
//
// HUQAN özelliklerini EU AI Act yükümlülükleriyle eşleştiren
// köprü gerçekler. Predicate'lerde madde numarası YOK:
// böylece aralarında NUMERICAL_CONFLICT tetiklenmez.
//
// DOĞRU (dogrulandi) — HUQAN uyum sağlar:
//   "HUQAN provides transparency evidence required by the EU AI Act"
//   "HUQAN enables human oversight as required by the EU AI Act"
//   "HUQAN maintains operation logs as required by the EU AI Act"
//   "HUQAN supports EU AI Act risk management requirements"
//   "HUQAN helps organizations comply with the EU AI Act"
//
// BİLİNMİYOR (doğru sınır — HUQAN yorum yapmaz):
//   "A raw LLM output satisfies EU AI Act article 13 transparency requirements"
//   "HUQAN is exempt from EU AI Act requirements as a verification tool"
// ──────────────────────────────────────────────────────────────
addFact('huqan', 'provides transparency evidence required by the eu ai act');
addFact('huqan', 'enables human oversight as required by the eu ai act');
addFact('huqan', 'maintains operation logs as required by the eu ai act');
addFact('huqan', 'supports eu ai act risk management requirements');
addFact('huqan', 'helps organizations comply with the eu ai act');

// ──────────────────────────────────────────────────────────────
// Save to disk
// ──────────────────────────────────────────────────────────────
if (kernel.graph && typeof kernel.graph.save === 'function') {
  kernel.graph.save();
}

const nodeCount = Object.keys(kernel.graph.getNodes()).length;
const edgeCount = (kernel.graph._edges || []).length;

console.log(`✅ Demo knowledge base loaded`);
console.log(`   DB:     ${dbPath}`);
console.log(`   Memory: ${memoryPath}`);
console.log(`   Nodes:  ${nodeCount}`);
console.log(`   Edges:  ${edgeCount}`);
console.log();
console.log('Test statements (copy/paste into the UI):');
const tests = [
  // TÜBİTAK
  ['✅', 'TÜBİTAK was established in 1963'],
  ['❌', 'TÜBİTAK was established in 1960'],
  // Türkiye coğrafyası
  ['✅', 'Istanbul is the most populous city in Turkey'],
  ['❌', 'Ankara is the most populous city in Turkey'],
  ['✅', 'Ankara is the capital city of Turkey'],
  ['✅', 'Istanbul has a population of 15 million'],
  ['❌', 'Istanbul has a population of 30 million'],
  // HUQAN — doğru özellikler
  ['✅', 'HUQAN is an LLM-free knowledge verification engine'],
  ['✅', 'HUQAN runs entirely without GPU or cloud'],
  ['✅', 'HUQAN uses a knowledge graph for fact verification'],
  ['✅', 'HUQAN is deterministic'],
  ['✅', 'HUQAN operates completely offline without internet'],
  ['✅', 'HUQAN catches false claims in AI-generated text'],
  ['✅', 'HUQAN identifies factual errors in AI outputs'],
  ['✅', 'HUQAN supports Turkish language'],
  ['✅', 'HUQAN was built without using any neural network'],
  ['✅', 'HUQAN was developed in Turkey by a Turkish startup'],
  // HUQAN — AI halucinasyonları
  ['❌', 'HUQAN uses GPT-4 to verify statements'],
  ['❌', 'HUQAN is powered by a large language model'],
  ['❌', 'HUQAN requires a GPU to run'],
  ['❌', 'HUQAN needs cloud infrastructure'],
  ['❌', 'HUQAN requires an internet connection'],
  ['❌', 'HUQAN uses neural networks for fact checking'],
  ['❌', 'HUQAN was developed in the United States'],
  // KVKK
  ['✅', 'KVKK entered into force on April 7 2016'],
  ['❌', 'KVKK entered into force on April 7 2018'],
  ['✅', 'KVKK is law number 6698 in Turkey'],
  ['❌', 'KVKK is law number 5651 in Turkey'],
  ['✅', 'KVKK imposes administrative fines up to 1 million Turkish lira'],
  ['❌', 'KVKK imposes administrative fines up to 5 million Turkish lira'],
  // GDPR
  ['✅', 'GDPR applies from 25 May 2018'],
  ['❌', 'GDPR applies from 25 May 2016'],
  ['✅', 'GDPR imposes fines up to 20 million euros or 4 percent of global turnover'],
  ['❌', 'GDPR imposes fines up to 10 million euros or 4 percent of global turnover'],
  ['✅', 'GDPR grants individuals the right to erasure of personal data'],
  // EU AI Act — "officially"/"formally" YASAK: içinde "all" substring var
  ['✅', 'EU AI Act was adopted in June 2024'],
  ['❌', 'EU AI Act was adopted in June 2023'],
  ['✅', 'EU AI Act entered into force on 1 August 2024'],
  ['❌', 'EU AI Act entered into force on 1 January 2025'],
  ['✅', 'EU AI Act imposes fines up to 35 million euros or 7 percent of global turnover'],
  ['❌', 'EU AI Act imposes fines up to 20 million euros or 7 percent of global turnover'],
  ['✅', 'EU AI Act classifies biometric identification as high-risk AI'],
  ['✅', 'EU AI Act is the first comprehensive AI regulation in the world'],
  // BiGG
  ['✅', 'BiGG provides up to 2 million Turkish lira in funding'],
  ['❌', 'BiGG provides up to 500 thousand Turkish lira in funding'],
  // SENARYO 6 — HUQAN Teknik Özellikler (Repo'dan)
  ['✅', 'HUQAN generates a trust receipt as cryptographic proof of verification'],
  ['✅', 'HUQAN maintains a tamper-proof log of AI outputs it verifies'],
  ['✅', 'HUQAN stores provenance for each fact in the knowledge graph'],
  ['✅', 'HUQAN blocks AI outputs that contradict stored facts'],
  ['✅', 'HUQAN assigns a trust label to each AI output it processes'],
  ['✅', 'HUQAN enables human review before high-risk AI decisions take effect'],
  // SENARYO 7 — EU AI Act Madde Yükümlülükleri
  ['✅', 'EU AI Act article 9 requires a risk management system for high-risk AI providers'],
  ['✅', 'EU AI Act article 12 requires high-risk AI systems to maintain logs of operation'],
  ['✅', 'EU AI Act article 13 requires high-risk AI systems to be transparent to deployers'],
  ['✅', 'EU AI Act article 14 requires high-risk AI systems to support human oversight'],
  // SENARYO 8 — HUQAN × EU AI Act Cross-Domain Köprü
  ['✅', 'HUQAN provides transparency evidence required by the EU AI Act'],
  ['✅', 'HUQAN enables human oversight as required by the EU AI Act'],
  ['✅', 'HUQAN maintains operation logs as required by the EU AI Act'],
  ['✅', 'HUQAN helps organizations comply with the EU AI Act'],
  // Bilgi sınırı: yorum gerektiren, saklanmamış iddialar → bilinmiyor
  ['⚠️', 'A raw LLM output satisfies EU AI Act article 13 transparency requirements'],
  // Zekice çelişki: "exempt" claim, "helps organizations comply" gerçeğiyle çelişiyor → celiski
  ['❌', 'HUQAN is exempt from EU AI Act requirements as a verification tool'],
];
for (const [icon, stmt] of tests) {
  console.log(`  ${icon}  ${stmt}`);
}
