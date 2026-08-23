'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  REPO_ROOT,
  discoverTestFiles,
} = require('./ci-shard-manifest');

const PLAN_SCHEMA_VERSION = 1;
const DEFAULT_AGENT_PLAN = '.huqan/agent-test-plan.json';

const MUST_HAVE_PATTERNS = Object.freeze([
  'agent.v3.test.js',
  'agentRuntime.test.js',
  'capability.test.js',
  'cli.test.js',
  'graph.test.js',
  'kernel.test.js',
  'kernel.v2.test.js',
  'mcpServer.test.js',
  'requestGuards.test.js',
  'server.test.js',
  'test/action-risk-classifier.test.js',
  'test/agent-action-firewall.test.js',
  'test/approval*.test.js',
  'test/automation-safety-gate.test.js',
  'test/ci-*.test.js',
  'test/classifier-downgrade-fail-closed.test.js',
  'test/code-change-gate.test.js',
  'test/command-exec-gate.test.js',
  'test/connector-action-firewall.test.js',
  'test/connector-firewall-coverage.contract.test.js',
  'test/cross-workspace-access-gate.test.js',
  'test/data-egress-gate.test.js',
  'test/durable-mutation-journal.test.js',
  'test/faz2-admission-*.test.js',
  'test/faz2-*-gate-*.test.js',
  'test/faz2-*-parity.contract.test.js',
  'test/faz2-universal-mutation-boundary.contract.test.js',
  'test/import-cycles.test.js',
  'test/memory-admission-*.test.js',
  'test/memory-mutation-gate.test.js',
  'test/memory-schema*.test.js',
  'test/memory-store*.test.js',
  'test/module-reachability*.test.js',
  'test/mutation-admission*.test.js',
  'test/mutation-journal*.test.js',
  'test/operator-token-constant-time.test.js',
  'test/package-closure.test.js',
  'test/path-containment-*.test.js',
  'test/path-safety.test.js',
  'test/persistence-path-*.test.js',
  'test/plugin-manifest-integrity.test.js',
  'test/plugin-hash-portability.test.js',
  'test/provenance*.test.js',
  'test/receipt-*.test.js',
  'test/route-auth-policy.test.js',
  'test/rustGraph-workspace-isolation.test.js',
  'test/sandbox-*.test.js',
  'test/secret-*-gate.test.js',
  'test/secret-and-sourceref-redaction.test.js',
  'test/tenancy-boundary.test.js',
  'test/tool-call-gate*.test.js',
  'test/tool-policy.test.js',
  'test/traversal-and-policy-fail-closed.test.js',
  'test/verify-*.test.js',
  'test/workflow-action-pinning.test.js',
  'test/workspace-id.test.js',
]);

const IMPACT_RULES = Object.freeze([
  {
    name: 'graph-kernel-memory',
    changed: ['graph.js', 'kernel.js', 'kernel.v2.js', 'storage.js', 'rustGraph.js', 'lib/graph-*.js', 'lib/memory-*.js', 'lib/ingest*.js'],
    tests: ['graph.test.js', 'kernel*.test.js', 'test/graph-*.test.js', 'test/kernel-*.test.js', 'test/memory-*.test.js', 'test/receipt-*.test.js', 'test/provenance*.test.js', 'test/reasonSandbox.test.js'],
  },
  {
    name: 'server-mcp-http',
    changed: ['server.js', 'mcpServer.js', 'lib/http/**', 'lib/mcp/**', 'lib/a2a/**'],
    tests: ['server.test.js', 'mcpServer*.test.js', 'test/a2a-*.test.js', 'test/http-*.test.js', 'test/mcp-*.test.js', 'test/route-auth-policy.test.js', 'test/approval*.test.js', 'test/workflow-*.test.js', 'test/v4-ui-*.test.js', 'test/v4-wb*.test.js'],
  },
  {
    name: 'cli',
    changed: ['cli.js', 'bin/**', 'lib/cli-*.js'],
    tests: ['cli.test.js', 'test/cli-*.test.js', 'test/quickstart-first-run.test.js'],
  },
  {
    name: 'adapters-connectors',
    changed: ['adapters/**', 'lib/*adapter*.js', 'lib/external-client-*.js', 'lib/*connector*.js'],
    tests: ['adapters/*.test.js', 'test/external-client-*.test.js', 'lib/external-client-*.test.js', 'lib/github-connector.test.js', 'test/github-app-server.test.js', 'test/secret-and-sourceref-redaction.test.js'],
  },
  {
    name: 'approval-policy-receipt-provenance',
    changed: ['lib/*approval*.js', 'lib/*policy*.js', 'lib/*firewall*.js', 'lib/*provenance*.js', 'lib/receipt/**', 'lib/audit-*.js', 'lib/ingest*.js', 'schemas/**'],
    tests: ['test/approval*.test.js', 'test/*firewall*.test.js', 'test/*policy*.test.js', 'test/provenance*.test.js', 'test/receipt-*.test.js', 'test/audit-*.test.js', 'test/ingest-approval-*.test.js', 'test/ingest-*.test.js', 'test/v4-*-receipt-*.test.js', 'test/v5-*-receipt-*.test.js'],
  },
  {
    name: 'plugins',
    changed: ['plugin.js', 'plugins/**', 'lib/plugin-*.js'],
    tests: ['plugin*.test.js', 'plugins/*.test.js', 'test/plugin-*.test.js', 'test/agent-*.test.js'],
  },
  {
    name: 'dream-reasoning-causal',
    changed: ['dream.js', 'reasonSandbox.js', 'causalSimulator.js', 'finalizer.js', 'lib/causal/**'],
    tests: ['dream.test.js', 'reasonSandbox.test.js', 'causalSimulator.test.js', 'finalizer*.test.js', 'test/causal-*.test.js', 'test/dream-*.test.js', 'test/reasoning-trace.test.js'],
  },
  {
    name: 'ui-workbench',
    changed: ['public/**'],
    tests: ['test/ui-*.test.js', 'test/v4-ui-*.test.js', 'test/v4-wb*.test.js', 'test/workbench-*.test.js', 'test/real-user-smoke-blockers.test.js'],
  },
  {
    name: 'ci-selection',
    changed: ['.github/workflows/**', 'scripts/ci-*.js', 'scripts/run-test-shard.js', 'scripts/ci-impact-plan.js', 'package.json', 'package-lock.json'],
    tests: ['test/ci-*.test.js', 'test/package-closure.test.js', 'test/module-reachability*.test.js', 'test/workflow-*.test.js', 'scripts/check-workflow-governance.test.js'],
  },
  {
    name: 'v5-protocol',
    changed: ['test/v5-*.test.js', 'lib/v5/**', 'schemas/v5/**', 'packages/huqan-verify/**'],
    tests: ['test/v5-*.test.js', 'test/a2a-*.test.js', 'lib/atp-conformance.test.js', 'packages/axiom-verify/index.test.js'],
  },
]);

const IMPACT_ONLY_PATTERNS = Object.freeze([
  'public/**',
]);

const FULL_SUITE_PATTERNS = Object.freeze([
  'package.json',
  'package-lock.json',
  '.github/workflows/**',
  'scripts/ci-*.js',
  'scripts/ci-impact-plan.js',
  'scripts/run-test-shard.js',
  'Dockerfile',
  'docker-compose.yml',
]);

const DOC_ONLY_PATTERNS = Object.freeze([
  'docs/**',
  'specs/**',
  'fixtures/**',
  'benchmarks/fixtures/**',
]);

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function globToRegExp(pattern) {
  const value = normalizePath(pattern);
  let source = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '*') {
      if (value[index + 1] === '*') {
        if (value[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function matchesPattern(value, pattern) {
  return globToRegExp(pattern).test(normalizePath(value));
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => matchesPattern(value, pattern));
}

function isTestFile(file) {
  const normalized = normalizePath(file);
  const base = path.posix.basename(normalized);
  return normalized.startsWith('test/')
    || base.endsWith('.test.js')
    || base.endsWith('.spec.js')
    || base.endsWith('-test.js')
    || base.endsWith('_test.js')
    || base.startsWith('test-')
    || base === 'test.js';
}

function isRuntimeOrTestFile(file) {
  const normalized = normalizePath(file);
  if (isTestFile(normalized)) return true;
  if (matchesAny(normalized, DOC_ONLY_PATTERNS)) return false;
  if (matchesAny(normalized, [
    'package.json',
    'package-lock.json',
    'plugins/**',
    'lib/**',
    'nlp/**',
    'packages/**',
    'migrations/**',
    'schemas/**',
    'adapters/**',
    'scripts/**',
    'benchmarks/**',
    'bin/**',
  ])) return true;
  if (normalized.includes('/')) return false;
  return normalized.endsWith('.js');
}

function discoverKnownTests(root = REPO_ROOT) {
  return discoverTestFiles(root).map(normalizePath).sort();
}

function addMatchingTests(target, reasons, knownTests, patterns, reason) {
  for (const file of knownTests) {
    if (!matchesAny(file, patterns)) continue;
    target.add(file);
    if (!reasons.has(file)) reasons.set(file, []);
    reasons.get(file).push(reason);
  }
}

function readChangedFiles({ root = REPO_ROOT, base, head, changedFiles } = {}) {
  if (Array.isArray(changedFiles)) return changedFiles.map(normalizePath).filter(Boolean).sort();
  if (!base || !head) throw new Error('base and head are required when changedFiles is not provided');
  const result = spawnSync('git', ['diff', '--name-only', base, head], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git diff exited with ${result.status}`);
  return result.stdout.split('\n').map(normalizePath).filter(Boolean).sort();
}

function validateAgentPlan(raw, knownTests) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('agent plan must be a JSON object');
  }
  if (raw.schemaVersion !== PLAN_SCHEMA_VERSION) {
    throw new Error(`agent plan schemaVersion must be ${PLAN_SCHEMA_VERSION}`);
  }
  const allowedKeys = new Set(['schemaVersion', 'addTests', 'confidence', 'rationale', 'fallback']);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) throw new Error(`agent plan field is not allowed: ${key}`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'removeTests')) {
    throw new Error('agent plan cannot remove tests');
  }
  if (!Array.isArray(raw.addTests)) throw new Error('agent plan addTests must be an array');
  if (!['high', 'medium', 'low'].includes(raw.confidence)) throw new Error('agent plan confidence must be high, medium or low');
  const known = new Set(knownTests);
  const addTests = [...new Set(raw.addTests.map(normalizePath))].sort();
  const unknown = addTests.filter((file) => !known.has(file));
  if (unknown.length > 0) throw new Error(`agent plan references unknown test files: ${unknown.join(', ')}`);
  if (raw.fallback !== undefined && !['full', 'none'].includes(raw.fallback)) {
    throw new Error('agent plan fallback must be full or none');
  }
  return { addTests, confidence: raw.confidence, rationale: String(raw.rationale || ''), fallback: raw.fallback || 'none' };
}

function loadAgentPlan({ root = REPO_ROOT, agentPlanPath, knownTests }) {
  const relative = agentPlanPath || DEFAULT_AGENT_PLAN;
  const absolute = path.isAbsolute(relative) ? relative : path.join(root, relative);
  if (!fs.existsSync(absolute)) return { status: 'not-provided', addTests: [], confidence: null, rationale: '', fallback: 'none' };
  try {
    const raw = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    const plan = validateAgentPlan(raw, knownTests);
    return { status: 'valid', ...plan };
  } catch (error) {
    return { status: 'invalid', addTests: [], confidence: 'low', rationale: error.message, fallback: 'full' };
  }
}

function buildTestImpactPlan({ root = REPO_ROOT, base, head, changedFiles, mode = 'pr', runtimeOrTest, agentPlanPath } = {}) {
  const knownTests = discoverKnownTests(root);
  const changed = (!changedFiles && (mode === 'nightly' || mode === 'release') && (!base || !head))
    ? []
    : readChangedFiles({ root, base, head, changedFiles });
  const runtimeSignal = runtimeOrTest === undefined
    ? changed.some(isRuntimeOrTestFile)
    : Boolean(runtimeOrTest);
  const allTests = mode === 'nightly' || mode === 'release';
  const fullByPath = matchesAny(changed, FULL_SUITE_PATTERNS);
  const impactOnlyByPath = matchesAny(changed, IMPACT_ONLY_PATTERNS);
  const shouldRun = allTests || runtimeSignal || fullByPath || impactOnlyByPath;
  const deterministic = new Set();
  const reasons = new Map();
  let matchedRuleNames = [];

  if (shouldRun) {
    addMatchingTests(deterministic, reasons, knownTests, MUST_HAVE_PATTERNS, 'mandatory safety and contract union');
    for (const changedFile of changed) {
      if (knownTests.includes(changedFile)) {
        deterministic.add(changedFile);
        reasons.set(changedFile, ['changed test file']);
      }
      for (const rule of IMPACT_RULES) {
        if (!matchesAny(changedFile, rule.changed)) continue;
        matchedRuleNames.push(rule.name);
        addMatchingTests(deterministic, reasons, knownTests, rule.tests, `impact rule: ${rule.name}`);
      }
    }
  }

  const agent = loadAgentPlan({ root, agentPlanPath, knownTests });
  const fallbackFull = allTests || fullByPath || agent.status === 'invalid' || agent.confidence === 'low' || agent.fallback === 'full';
  const selected = fallbackFull && shouldRun ? [...knownTests] : [...deterministic, ...agent.addTests].filter((file, index, list) => list.indexOf(file) === index).sort();
  const selectedTests = selected.filter((file) => knownTests.includes(file));
  const selectedReasons = Object.fromEntries(selectedTests.map((file) => [file, reasons.get(file) || (agent.addTests.includes(file) ? ['agent addition'] : ['full-suite fallback'])]));

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    mode,
    base: base || null,
    head: head || null,
    changedFiles: changed,
    runTests: shouldRun,
    fullSuite: fallbackFull && shouldRun,
    knownTestCount: knownTests.length,
    selectedTestCount: selectedTests.length,
    selectedTests,
    mandatoryPatterns: [...MUST_HAVE_PATTERNS],
    matchedImpactRules: [...new Set(matchedRuleNames)].sort(),
    agent: {
      status: agent.status,
      confidence: agent.confidence,
      rationale: agent.rationale,
      addedTests: agent.addTests,
      fallback: agent.fallback,
    },
    selectedReasons,
    fallbackReason: fallbackFull ? (allTests ? 'nightly/release mode' : fullByPath ? 'high-risk manifest or workflow path' : agent.rationale || 'agent confidence or validation fallback') : null,
  };
}

function validateImpactPlan(plan, knownTests) {
  if (!plan || plan.schemaVersion !== PLAN_SCHEMA_VERSION) throw new Error('impact plan schemaVersion is invalid');
  if (!Array.isArray(plan.selectedTests) || !Array.isArray(plan.changedFiles)) throw new Error('impact plan arrays are invalid');
  const known = new Set(knownTests);
  const selected = [...new Set(plan.selectedTests)];
  if (selected.length !== plan.selectedTests.length) throw new Error('impact plan contains duplicate selected tests');
  const unknown = selected.filter((file) => !known.has(file));
  if (unknown.length > 0) throw new Error(`impact plan references unknown tests: ${unknown.join(', ')}`);
  if (!plan.runTests && selected.length > 0) throw new Error('non-runtime impact plan must not select tests');
  if (plan.runTests) {
    const mandatory = new Set();
    addMatchingTests(mandatory, new Map(), knownTests, MUST_HAVE_PATTERNS, 'mandatory');
    for (const file of mandatory) {
      if (!selected.includes(file)) throw new Error(`impact plan omitted mandatory test: ${file}`);
    }
  }
  if (plan.fullSuite && plan.runTests && selected.length !== knownTests.length) {
    throw new Error('full-suite impact plan must select every known test');
  }
  if (!plan.agent || !Array.isArray(plan.agent.addedTests)) throw new Error('impact plan agent metadata is invalid');
  for (const file of plan.agent.addedTests) {
    if (!selected.includes(file)) throw new Error(`agent-added test is absent from selectedTests: ${file}`);
  }
  return true;
}

function parseArgs(argv) {
  const options = { base: null, head: null, output: null, mode: 'pr', agentPlanPath: null, runtimeOrTest: undefined };
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`unsupported argument: ${arg}`);
    const [, key, value] = match;
    if (key === 'base') options.base = value;
    else if (key === 'head') options.head = value;
    else if (key === 'output') options.output = value;
    else if (key === 'mode') options.mode = value;
    else if (key === 'agent-plan') options.agentPlanPath = value;
    else if (key === 'runtime-or-test') options.runtimeOrTest = value === 'yes' || value === 'true';
    else throw new Error(`unsupported argument: ${arg}`);
  }
  return options;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const plan = buildTestImpactPlan(options);
    validateImpactPlan(plan, discoverKnownTests());
    const output = JSON.stringify(plan, null, 2);
    if (options.output) {
      fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
      fs.writeFileSync(options.output, `${output}\n`);
    } else {
      process.stdout.write(`${output}\n`);
    }
    process.exitCode = 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = {
  DEFAULT_AGENT_PLAN,
  DOC_ONLY_PATTERNS,
  FULL_SUITE_PATTERNS,
  IMPACT_ONLY_PATTERNS,
  IMPACT_RULES,
  MUST_HAVE_PATTERNS,
  PLAN_SCHEMA_VERSION,
  buildTestImpactPlan,
  discoverKnownTests,
  globToRegExp,
  isRuntimeOrTestFile,
  matchesPattern,
  parseArgs,
  readChangedFiles,
  validateAgentPlan,
  validateImpactPlan,
};
