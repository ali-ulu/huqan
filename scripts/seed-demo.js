'use strict';

const {
  readCompatibleEnvironmentVariable,
  validateEnvironmentCompatibility,
} = require('../lib/environment-compat');
validateEnvironmentCompatibility();

const path = require('path');
const fs = require('fs');
const KernelV2 = require('../kernel.v2');

function createKernel(options = {}) {
  const dbPath = options.dbPath || readCompatibleEnvironmentVariable('DB_PATH') || path.join(process.cwd(), 'memory.db');
  const memoryPath = options.memoryPath || readCompatibleEnvironmentVariable('MEMORY_PATH') || path.join(process.cwd(), 'memory.json');

  // Ensure parent dir exists
  for (const p of [dbPath, memoryPath]) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  }

  return new KernelV2({ memoryPath, dbPath, loadPlugins: false });
}

function addFact(kernel, subjectId, predicateText) {
  kernel.graph.addNode(subjectId, subjectId, null, {});
  kernel.graph.addNode(predicateText, predicateText, null, {});
  kernel.graph.addEdge(subjectId, predicateText, 'özellik', {
    weight: 0.95,
    confidence: 0.95,
    source: 'demo-seed',
  });
}

function seedFacts(kernel) {
  addFact(kernel, 'tubitak', 'was established in 1963');
  addFact(kernel, 'tubitak', 'is the scientific and technological research council of turkey');
  addFact(kernel, 'istanbul', 'is the most populous city in turkey');
  addFact(kernel, 'istanbul', 'has a population of 15 million');
  addFact(kernel, 'ankara', 'is the capital city of turkey');
  addFact(kernel, 'turkey', 'has a population of 85 million');
  addFact(kernel, 'huqan', 'is an llm-free knowledge verification engine');
  addFact(kernel, 'huqan', 'runs entirely without gpu or cloud');
  addFact(kernel, 'huqan', 'uses a knowledge graph for fact verification');
  addFact(kernel, 'huqan', 'is deterministic');
  addFact(kernel, 'huqan', 'operates completely offline without internet');
  addFact(kernel, 'huqan', 'verifies statements against a local knowledge graph');
  addFact(kernel, 'huqan', 'catches false claims in ai-generated text');
  addFact(kernel, 'huqan', 'identifies factual errors in ai outputs');
  addFact(kernel, 'huqan', 'supports turkish language');
  addFact(kernel, 'huqan', 'supports english language');
  addFact(kernel, 'huqan', 'was built without using any neural network');
  addFact(kernel, 'huqan', 'was developed in turkey by a turkish startup');
  addFact(kernel, 'kvkk', 'entered into force on april 7 2016');
  addFact(kernel, 'kvkk', 'is law number 6698 in turkey');
  addFact(kernel, 'kvkk', 'requires explicit consent for sensitive personal data');
  addFact(kernel, 'kvkk', 'established the personal data protection board');
  addFact(kernel, 'kvkk', 'imposes administrative fines up to 1 million turkish lira');
  addFact(kernel, 'kvkk', 'applies to data controllers processing personal data in turkey');
  addFact(kernel, 'gdpr', 'applies from 25 may 2018');
  addFact(kernel, 'gdpr', 'is the general data protection regulation of the european union');
  addFact(kernel, 'gdpr', 'imposes fines up to 20 million euros or 4 percent of global turnover');
  addFact(kernel, 'gdpr', 'grants individuals the right to erasure of personal data');
  addFact(kernel, 'gdpr', 'requires a data protection impact assessment for high-risk processing');
  addFact(kernel, 'gdpr', 'applies to organizations processing data of eu residents');
  addFact(kernel, 'eu ai act', 'was adopted in june 2024');
  addFact(kernel, 'eu ai act', 'entered into force on 1 august 2024');
  addFact(kernel, 'eu ai act', 'takes a risk-based approach to ai regulation');
  addFact(kernel, 'eu ai act', 'prohibits ai systems that pose unacceptable risk');
  addFact(kernel, 'eu ai act', 'requires conformity assessment for high-risk ai systems');
  addFact(kernel, 'eu ai act', 'imposes fines up to 35 million euros or 7 percent of global turnover');
  addFact(kernel, 'eu ai act', 'requires transparency for general purpose ai models');
  addFact(kernel, 'eu ai act', 'classifies biometric identification as high-risk ai');
  addFact(kernel, 'eu ai act', 'is the first comprehensive ai regulation in the world');
  addFact(kernel, 'eu ai act', 'prohibits social scoring by public authorities');
  addFact(kernel, 'bigg', 'provides up to 2 million turkish lira in funding');
  addFact(kernel, 'bigg', 'is the tubitak individual entrepreneurship grant program');
  addFact(kernel, 'huqan', 'generates a trust receipt as cryptographic proof of verification');
  addFact(kernel, 'huqan', 'maintains a tamper-proof log of ai outputs it verifies');
  addFact(kernel, 'huqan', 'stores provenance for each fact in the knowledge graph');
  addFact(kernel, 'huqan', 'blocks ai outputs that contradict stored facts');
  addFact(kernel, 'huqan', 'assigns a trust label to each ai output it processes');
  addFact(kernel, 'huqan', 'quarantines flagged claims in a pending review queue');
  addFact(kernel, 'huqan', 'enables human review before high-risk ai decisions take effect');
  addFact(kernel, 'eu ai act article 9', 'requires a risk management system for high-risk ai providers');
  addFact(kernel, 'eu ai act article 12', 'requires high-risk ai systems to maintain logs of operation');
  addFact(kernel, 'eu ai act article 13', 'requires high-risk ai systems to be transparent to deployers');
  addFact(kernel, 'eu ai act article 14', 'requires high-risk ai systems to support human oversight');
  addFact(kernel, 'eu ai act article 17', 'requires high-risk ai providers to maintain quality documentation');
  addFact(kernel, 'huqan', 'provides transparency evidence required by the eu ai act');
  addFact(kernel, 'huqan', 'enables human oversight as required by the eu ai act');
  addFact(kernel, 'huqan', 'maintains operation logs as required by the eu ai act');
  addFact(kernel, 'huqan', 'supports eu ai act risk management requirements');
  addFact(kernel, 'huqan', 'helps organizations comply with the eu ai act');
}

function runDemoSeed(options = {}) {
  const kernel = createKernel(options);
  seedFacts(kernel);

  if (kernel.graph && typeof kernel.graph.save === 'function') {
    kernel.graph.save();
  }

  const nodeCount = Object.keys(kernel.graph.getNodes()).length;
  const edgeCount = (kernel.graph._edges || []).length;
  
  if (options.silent !== true) {
    console.log(`Demo seed complete.`);
    console.log(`Nodes added: ${nodeCount}`);
    console.log(`Edges added: ${edgeCount}`);
    console.log(`\nYou can now run verify commands against this memory.`);
    console.log(`Example:`);
    console.log(`  node cli.js dogrula "HUQAN is an LLM-free knowledge verification engine"`);
  }

  return { nodeCount, edgeCount };
}

if (require.main === module) {
  runDemoSeed();
}

module.exports = {
  createKernel,
  addFact,
  seedFacts,
  runDemoSeed
};
