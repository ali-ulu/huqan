'use strict';
const { reportCommandStatus } = require('./cli-helpers');
/**
 * `coder` CLI command — run one deterministic coding task.
 *
 *   coder <task.json> [--dry-run] [--root <dir>] [--verify ocr] [--authorize] [--json]
 *
 * This path is deterministic and uses no language model. The task names a transform from
 * lib/deterministic-task-runner.js; the transform is a pure function; the gate
 * decides whether the resulting patch may land. What the command prints is a
 * derivation record, not a report the tool wrote about itself. The determinism
 * is what the recorded derivation rests on.
 *
 * A task that declares a `test` block runs the bounded fix loop instead
 * (#3670): apply -> test -> keep, or roll back and try the next declared
 * candidate. The loop's decision lives in lib/coder/fix-loop.js and the
 * process boundary in lib/coder/test-execution.js; this file stays the
 * validation boundary.
 *
 * Branch and dirtiness are read from git here rather than inside
 * applyDerivation, because asking git is an I/O concern and the pipeline is
 * meant to stay a plain function over explicit inputs. If git cannot be
 * reached, the repo state is reported as unknown and passed through as such --
 * the gate then treats it as a clean non-main tree, so this command says so out
 * loud instead of letting an unverified assumption pass silently.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const nodePath = require('node:path');
const { applyDerivation } = require('./coder/apply-derivation');
const { openCoderJournal, journalPathOf } = require('./coder/journal-store');
const { partitionUntracked } = require('./repo-artifacts');
const { formatCoderText } = require('./cli-coder-format');

function cliError(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

function toTokens(args) {
  if (Array.isArray(args)) return args.map(String).filter(Boolean);
  return String(args || '').trim().split(/\s+/u).filter(Boolean);
}

/**
 * Flag table, not a branch chain: every new coder flag used to lengthen the
 * if/else dispatch below until it tripped the OCP structural signal. A row
 * names the flag, whether it consumes the next token, and where the value
 * goes; the loop stays the same shape no matter how many rows join.
 */
const CODER_FLAG_DEFS = Object.freeze([
  { flag: '--dry-run', takesValue: false, apply: (flags) => { flags.dryRun = true; } },
  // Releases a source change's REVIEW hold into an APPLY for this run. It never
  // lowers a BLOCK or a DRY_RUN_ONLY decision (see applyOperatorAuthorization).
  { flag: '--authorize', takesValue: false, apply: (flags) => { flags.authorize = true; } },
  { flag: '--initialize-project', takesValue: false, apply: (flags) => { flags.initializeProject = true; } },
  { flag: '--synthesize', takesValue: false, apply: (flags) => { flags.synthesize = true; } },
  { flag: '--source-root', takesValue: true, apply: (flags, value) => { flags.sourceRoot = value || ''; } },
  { flag: '--project-memory-out', takesValue: true, apply: (flags, value) => { flags.projectMemoryOut = value || ''; } },
  { flag: '--project-memory', takesValue: true, apply: (flags, value) => { require('./cli-coder-project-memory').addProjectMemoryFile(flags, value); } },
  { flag: '--root', takesValue: true, apply: (flags, value) => { flags.root = value || ''; } },
  { flag: '--journal', takesValue: true, apply: (flags, value) => { flags.journal = value || ''; } },
  { flag: '--candidate-file', takesValue: true, apply: (flags, value) => { flags.candidateFile = value || ''; } },
  { flag: '--use-memory', takesValue: false, apply: (flags) => { flags.useMemory = true; } },
  { flag: '--transfer-memory', takesValue: false, apply: (flags) => { flags.useMemory = true; flags.transferMemory = true; } },
  { flag: '--adapt-memory', takesValue: false, apply: (flags) => { flags.useMemory = true; flags.transferMemory = true; flags.adaptMemory = true; } },
  { flag: '--run-id', takesValue: true, apply: (flags, value) => { flags.runId = value || ''; } },
  { flag: '--verify', takesValue: true, apply: (flags, value) => { flags.verify = value || ''; } },
  // Handled by the caller via opts.json; accepted here so it is not
  // mistaken for the task file when it appears first.
  { flag: '--json', takesValue: false, apply: () => {} },
]);
const CODER_FLAGS_BY_NAME = Object.freeze(Object.fromEntries(
  CODER_FLAG_DEFS.map((def) => [def.flag, def]),
));

function parseCoderArgs(args) {
  const tokens = toTokens(args);
  const flags = { taskFile: '', dryRun: false, authorize: false, root: '', journal: '', runId: '', verify: '' };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const def = CODER_FLAGS_BY_NAME[token];
    if (def) {
      if (def.takesValue) {
        def.apply(flags, tokens[index + 1]);
        index += 1;
      } else {
        def.apply(flags);
      }
    } else if (!flags.taskFile && !token.startsWith('--')) {
      flags.taskFile = token;
    }
  }
  return flags;
}

/**
 * Observed verifiers selectable with --verify (#3196). Each runs after the write
 * lands and is recorded beside the derivation, never inside it (#3031). The
 * table is lazy so a run without --verify never loads a verifier.
 */
const OBSERVED_VERIFIERS = Object.freeze({
  ocr: () => {
    const { createOcrVerifier, OCR_COMMAND } = require('./coder/verify-ocr');
    return { verify: createOcrVerifier(), verifyCommand: OCR_COMMAND };
  },
});

function resolveVerifier(name) {
  if (!name) return { verify: null, verifyCommand: null };
  if (!Object.prototype.hasOwnProperty.call(OBSERVED_VERIFIERS, name)) {
    throw cliError(`Unknown verifier "${name}". Available: ${Object.keys(OBSERVED_VERIFIERS).join(', ')}`);
  }
  return OBSERVED_VERIFIERS[name]();
}

function readTask(taskFile) {
  let raw;
  try {
    raw = fs.readFileSync(taskFile, 'utf8');
  } catch (error) {
    throw cliError(`Task file could not be read: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw cliError(`Task file is not valid JSON: ${error.message}`);
  }
}

function git(root, args) {
  return childProcess.execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Best-effort repo state. `known: false` is returned rather than a guess when
 * git is unavailable or the directory is not a repository, so a caller reading
 * the output can tell "clean tree" apart from "nobody checked".
 *
 * git walks up: asking inside a bare directory that merely sits under a
 * repository would otherwise report the ANCESTOR's branch and dirtiness as
 * the directory's own (#2992). The answer is trusted only when the
 * repository root is the directory asked about.
 *
 * The canonical form of a path, identical for both sides of the comparison.
 *
 * `fs.realpathSync.native` is used rather than the JavaScript `realpathSync`,
 * because only the native one resolves Windows 8.3 short names (`RUNNER~1`)
 * to their long form. Git for Windows can report a `--show-toplevel` in the
 * short form while the caller asked about the long one, so the JS variant saw
 * two different strings for the same directory and the state came back
 * `known: false` on a real repository (#3085). Falls back to the JS variant
 * if the native call is unavailable, so behavior never regresses to a throw.
 */
function canonicalPath(value) {
  const resolved = nodePath.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return fs.realpathSync(resolved);
  }
}

function sameDirectory(left, right) {
  try {
    const a = canonicalPath(left).replace(/[\\/]+$/, '');
    const b = canonicalPath(right).replace(/[\\/]+$/, '');
    if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
    return a === b;
  } catch {
    return false;
  }
}

function readRepoState(root, options = {}) {
  try {
    const toplevel = git(root, ['rev-parse', '--show-toplevel']);
    if (!sameDirectory(toplevel, root)) {
      return { known: false, branch: '', dirty: false, hasUntracked: false, untrackedPaths: [] };
    }
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    // `-z` prints each pathname verbatim (NUL-terminated) instead of quoting
    // non-ASCII names under core.quotePath, so a Turkish-named task file still
    // matches the caller's own path when the gate drops it (#3642).
    const status = git(root, ['status', '--porcelain', '-z']);
    const entries = status
      ? status.split('\0').filter(Boolean).map(record => ({ code: record.slice(0, 2), path: record.slice(3) }))
      : [];
    // `coder` reads its task from a file, and the documented invocation keeps
    // that file in the repository; the command's own store also drops
    // `memory.db` beside it. Neither is source the operator wrote, so neither
    // may count as dirt and hold every run at DIRTY_REPO_REVIEW_REQUIRED
    // (#3642). What is left still counts, and is returned so the CLI can name
    // it instead of reporting a bare "dirty".
    const untrackedPaths = entries.filter(entry => entry.code === '??').map(entry => entry.path);
    const { remaining } = partitionUntracked(untrackedPaths, {
      root,
      ignoredPaths: options.ignoredPaths || [],
    });
    return {
      known: true,
      branch,
      dirty: entries.some(entry => entry.code !== '??'),
      hasUntracked: remaining.length > 0,
      untrackedPaths: remaining,
    };
  } catch {
    return { known: false, branch: '', dirty: false, hasUntracked: false, untrackedPaths: [] };
  }
}

function runCliCoder(args, opts = {}) {
  const tokens = toTokens(args);
  // `coder verify ...` is the other half of the same command: one side derives,
  // the other re-derives. It lives in its own module because the verifier is
  // meant to be run by someone who did not produce the patch, and keeping the
  // two apart makes that separation visible rather than implied.
  if (tokens[0] === 'verify') {
    return require('./cli-coder-verify').runCliCoderVerify(tokens.slice(1), opts);
  }
  // Proposal stops before gated execution.
  if (tokens[0] === 'propose') {
    return require('./cli-coder-propose').runCliCoderPropose(tokens.slice(1), opts);
  }

  const revisionMode = tokens[0] === 'revise';
  const projectMode = tokens[0] === 'create' || revisionMode;
  const rememberMode = tokens[0] === 'remember';
  const flags = parseCoderArgs(projectMode || rememberMode ? tokens.slice(1) : args);
  if (projectMode && flags.candidateFile !== undefined)
    throw cliError('Candidate memory requires a journal, candidate file and a non-project task');
  if (revisionMode && flags.initializeProject)
    throw cliError('Project revision uses the existing repository gate without initialization');
  if (flags.projectMemoryOut !== undefined && flags.projectMemory === undefined) throw new Error('--project-memory-out requires --project-memory');
  if (flags.projectMemory !== undefined && (!projectMode || (!revisionMode && !flags.initializeProject) || flags.dryRun || !flags.journal))
    throw cliError(revisionMode ? 'Project revision memory requires --journal without --dry-run'
      : 'Project memory requires create --initialize-project --journal');
  if (flags.synthesize && (projectMode || rememberMode || flags.useMemory || flags.candidateFile || flags.initializeProject))
    throw cliError('Synthesis requires a non-project task without candidate-memory modes');
  if (flags.useMemory && (projectMode || rememberMode || flags.dryRun || flags.candidateFile))
    throw cliError('Memory selection requires a non-project run without --dry-run or --candidate-file');
  if (!flags.taskFile) {
    throw cliError('Usage: coder <task.json> [--dry-run] [--authorize] [--root <dir>] [--journal <db>] [--run-id <id>] [--verify ocr] [--json]');
  }
  const verifier = resolveVerifier(flags.verify);
  const root = nodePath.resolve(flags.root || process.cwd());
  let task = readTask(flags.taskFile);
  if (flags.projectMemory !== undefined) {
    const memory = require('./cli-coder-project-memory');
    const run = revisionMode ? memory.runCliProjectRevisionMemory : memory.runCliProjectMemory;
    return run({ spec: task, root, flags, opts, openJournal: openCoderJournal,
      repoState: readRepoState(root, { ignoredPaths: [flags.taskFile] }) });
  }
  if (flags.synthesize && !task?.test) throw cliError('Synthesis requires independent test.command');
  if (flags.synthesize && typeof opts.coderLoop?.runArithmeticSynthesis !== 'function') throw cliError('Coder synthesis is unavailable');
  let projectPlan = null;
  let projectSpec = null;
  if (projectMode) {
    const produceProject = opts.coderLoop?.[revisionMode ? 'produceProjectRevision' : 'produceProject'];
    if (typeof produceProject !== 'function') throw cliError('Coder project producer is unavailable');
    const produced = produceProject(task);
    projectSpec = task;
    if (!produced.ok) {
      reportCommandStatus(opts, 'refused');
      return opts.json ? { status: 'refused', data: produced } : `Project: needs_human_decision — ${produced.reason}`;
    }
    task = produced.task;
    projectPlan = produced.plan;
    if (flags.dryRun) return opts.json ? { status: 'proposed', data: produced }
      : `Project: proposed\nRecipe: ${projectPlan.archetype}\nFiles: ${projectPlan.files.join(', ')}\nTest: ${projectPlan.acceptanceCommand}` + require('./cli-coder-project-memory').formatProjectTrainingQuestions(projectPlan);
  }
  const repoState = readRepoState(root, { ignoredPaths: [flags.taskFile] });

  const journalPath = journalPathOf(flags);
  let coderJournal = null;
  if (journalPath) {
    try {
      coderJournal = openCoderJournal(journalPath);
    } catch (error) {
      throw cliError(error.message);
    }
  }
  try {
    if (rememberMode || flags.candidateFile || flags.useMemory) {
      if (projectMode || flags.dryRun || !coderJournal || (flags.useMemory ? rememberMode || flags.candidateFile : !flags.candidateFile)) {
        throw cliError('Candidate memory requires a journal, candidate file and a non-project task');
      }
      const collaborator = opts.coderLoop?.[rememberMode ? 'rememberCandidate' : flags.useMemory ? 'selectCandidate' : 'resolveCandidate'];
      if (typeof collaborator !== 'function') throw cliError('Coder candidate memory is unavailable');
      const candidateResult = collaborator({ task, journal: coderJournal.journal, root,
        file: flags.candidateFile, runId: flags.runId, workspaceId: opts.workspaceId || 'default',
        qualificationPaths: task.qualificationPaths, allowTransfer: flags.transferMemory === true,
        allowAdaptation: flags.adaptMemory === true });
      if (rememberMode || !candidateResult.ok) {
        reportCommandStatus(opts, candidateResult.ok ? 'remembered' : 'refused');
        return opts.json ? { status: candidateResult.ok ? 'remembered' : 'refused', data: candidateResult }
          : `Candidate: ${candidateResult.ok ? 'remembered' : candidateResult.reason}`;
      }
      task = candidateResult.task;
    }
    const executionOptions = { task, root,
      repoState: { branch: repoState.branch, dirty: repoState.dirty, hasUntracked: repoState.hasUntracked },
      dryRun: flags.dryRun, authorized: flags.authorize, workspaceId: opts.workspaceId || 'default',
      journal: coderJournal ? coderJournal.journal : null, runId: flags.runId || null };
    // Declared tests select the bounded loop; application decisions live there.
    if (task && task.test !== undefined && task.test !== null) {
      if (typeof task.test !== 'object' || Array.isArray(task.test)) {
        throw cliError('Task "test" must be an object: { "command": "...", "timeoutMs": 120000 }');
      }
      const { runFixLoop, formatLoopText } = opts.coderLoop || {};
      if (typeof runFixLoop !== 'function' || typeof formatLoopText !== 'function') {
        throw cliError('Coder test loop collaborator is unavailable');
      }
      const loopResult = projectMode && flags.initializeProject === true
        ? opts.coderLoop.initializeProject(projectSpec, { root, sourceRoot: flags.sourceRoot,
          initialize: true, journal: coderJournal?.journal, workspaceId: opts.workspaceId || 'default',
          runId: flags.runId || null, projectMemory: flags.projectMemory }) : flags.synthesize
          ? opts.coderLoop.runArithmeticSynthesis(executionOptions) : runFixLoop(executionOptions);
      reportCommandStatus(opts, loopResult.ok ? 'completed' : 'refused');
      if (opts.json) {
        return {
          status: loopResult.ok ? 'completed' : 'refused',
          data: {
            outcome: loopResult.outcome,
            reason: loopResult.reason,
            attempts: loopResult.attempts,
            kept: loopResult.kept,
            record: loopResult.record,
            ...(projectPlan ? { plan: projectPlan } : {}),
            ...(loopResult.projectMemory ? { projectMemory: loopResult.projectMemory } : {}),
            ...(loopResult.synthesis ? { synthesis: loopResult.synthesis } : {}),
            repoStateKnown: repoState.known,
          },
        };
      }
      return flags.synthesize ? opts.coderLoop.formatSynthesisText(loopResult, repoState) : formatLoopText(loopResult, repoState);
    }

    const result = applyDerivation({
      ...executionOptions,
      verify: verifier.verify,
      verifyCommand: verifier.verifyCommand,
    });

    reportCommandStatus(opts, result.ok ? 'completed' : 'refused');
    if (opts.json) {
      return {
        status: result.ok ? 'completed' : 'refused',
        data: {
          outcome: result.outcome,
          reason: result.reason,
          detail: result.detail,
          repoStateKnown: repoState.known,
          record: result.record,
          runId: result.experience ? result.experience.runId : null,
          experience: result.experience || null,
        },
      };
    }
    return formatCoderText(result, repoState);
  } finally {
    if (coderJournal) coderJournal.close();
  }
}

module.exports = {
  parseCoderArgs,
  readRepoState,
  formatCoderText,
  runCliCoder,
};
