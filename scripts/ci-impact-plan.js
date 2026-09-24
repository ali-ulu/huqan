'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DOC_ONLY_PATTERNS, FULL_SUITE_PATTERNS, IMPACT_ONLY_PATTERNS, IMPACT_RULES, MUST_HAVE_PATTERNS } = require('./ci-impact-rules');
const { DEFAULT_AGENT_PLAN, PLAN_SCHEMA_VERSION, validateAgentPlan } = require('./ci-impact-plan-agent');
const { buildTestImpactPlan } = require('./ci-impact-plan-build');
const { validateImpactPlan } = require('./ci-impact-plan-validate');
const { discoverKnownTests, globToRegExp, isRuntimeOrTestFile, matchesPattern, readChangedFiles } = require('./ci-impact-plan-paths');

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
