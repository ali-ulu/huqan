'use strict';

/**
 * The guard's own control plane.
 *
 * Every adapter profile in `external-action-adapter.js` is wired in by a config
 * file that lives inside the workspace it protects. That is the weak point: the
 * guard evaluates a write to `.claude/settings.json` with exactly the rules it
 * uses for `lib/anything.js`, so the file that decides whether the guard runs at
 * all is defended no harder than an ordinary source file. Under the Claude Code
 * profile a `review` becomes `ask` — the same prompt every other write raises —
 * and a single habitual approval removes the guard for every later action.
 *
 * These rules name those files so the guard can rank them above ordinary
 * workspace paths. Disarming the guard has to be a deliberate, separately
 * authorized act, not one more `ask` in a long day of them.
 *
 * Maintenance is a real need, so the block is not absolute: the hook accepts
 * `--allow-control-plane`, which comes from the deployment that installed the
 * hook. It is deliberately not readable from the invocation payload — an agent
 * must not be able to grant itself control-plane access by asking for it, the
 * same reason the identity card is attached from options in
 * `evaluateHookInvocation`.
 */

const CONTROL_PLANE_PATH_RULES = Object.freeze([
  { profile: 'claude-code', pattern: /(?:^|\/)\.claude\/(?:settings\.json|settings\.local\.json|hooks\.json|hooks\/.+)$/ },
  { profile: 'codex', pattern: /(?:^|\/)\.codex\/(?:hooks\.json|hooks\/.+)$/ },
  { profile: 'opencode', pattern: /(?:^|\/)\.opencode\/plugin\/.+$/ },
  { profile: 'pi', pattern: /(?:^|\/)\.pi\/extensions\/.+$/ },
  { profile: 'hermes', pattern: /(?:^|\/)\.hermes\/plugins\/.+$/ },
  { profile: 'huqan', pattern: /(?:^|\/)adapters\/external-action\/.+$/ },
]);

/**
 * Shell verbs that can replace, move or empty a file they are given.
 *
 * `sed` is absent on purpose: it only writes with `-i`, and is otherwise one of
 * the most common read-only ways to inspect a config. It is handled below.
 */
const MUTATING_SHELL_VERBS = new Set([
  'rm', 'unlink', 'shred', 'mv', 'cp', 'install', 'ln',
  'tee', 'truncate', 'dd', 'chmod', 'chown', 'touch', 'patch',
]);

/** Wrappers that prefix a real command without changing what it does. */
const COMMAND_WRAPPERS = new Set([
  'sudo', 'doas', 'command', 'time', 'nohup', 'eval', 'exec', 'nice', 'ionice', 'env', 'xargs',
]);

function normalizeCandidate(candidate) {
  return String(candidate ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '');
}

/**
 * @returns {{profile: string}|null} the profile whose wiring this path is, or null.
 */
function isControlPlanePath(candidate) {
  const normalized = normalizeCandidate(candidate);
  if (!normalized) return null;
  const rule = CONTROL_PLANE_PATH_RULES.find(entry => entry.pattern.test(normalized));
  return rule ? { profile: rule.profile, path: normalized } : null;
}

function tokenize(command) {
  return String(command ?? '').split(/[\s;&|]+/).filter(Boolean);
}

/**
 * Find a control-plane file that a shell command would modify.
 *
 * Reading the config is not a threat — `cat`, `grep` and `git diff` over
 * `.claude/settings.json` are how an operator checks the guard is wired in, and
 * flagging them would train people to approve control-plane prompts.
 *
 * @returns {{profile: string, path: string}|null}
 */
function findControlPlaneCommandTarget(command) {
  const tokens = tokenize(command);
  if (!tokens.length) return null;

  const verbs = [];
  let expectVerb = true;
  for (const token of tokens) {
    if (expectVerb && !token.startsWith('-')) {
      const verb = normalizeCandidate(token).split('/').pop();
      verbs.push(verb);
      expectVerb = false;
    }
    // A pipeline or list separator was consumed by tokenize, so the next bare
    // word after a redirect target is a fresh verb.
    if (token === '>' || token === '>>') expectVerb = true;
  }

  const mutates = verbs.some(verb => MUTATING_SHELL_VERBS.has(verb))
    || (verbs.includes('sed') && /(?:^|\s)-[a-z]*i/.test(String(command)))
    || />>?/.test(String(command));
  if (!mutates) return null;

  for (const token of tokens) {
    if (COMMAND_WRAPPERS.has(token)) continue;
    const match = isControlPlanePath(token);
    if (match) return match;
  }
  return null;
}

/**
 * HUQAN CLI subcommands that record an operator's decision (#3560).
 *
 * `terfi` approves a learned candidate's promotion and `onayla`/`approve`
 * decides a queued approval. The CLI is HUQAN's operator surface, so an agent
 * running one of these through its own shell would be approving on the
 * operator's behalf -- for `terfi`, possibly its own promotion. Whatever the
 * hook sees comes from an agent, so these are refused there outright; a human
 * runs them in their own terminal, where no hook stands in between.
 */
const OPERATOR_DECISION_COMMANDS = new Set(['terfi', 'onayla', 'approve']);

/**
 * Words that run the next word as the real command: the wrappers above, the
 * package runners, node itself and a shell given a script with -c.
 */
const LAUNCHERS = new Set([...COMMAND_WRAPPERS, 'npx', 'bunx', 'pnpx', 'node', 'bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell', 'cmd']);
const PACKAGE_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const RUNNER_VERBS = new Set(['exec', 'x', 'dlx']);

/** The word as the shell hands it to the program: quote characters removed. */
function shellWord(token) {
  return String(token ?? '').replace(/["'`]/g, '');
}

/** Entry points that run the HUQAN CLI: the `huqan` bin (any shim) or cli.js. */
function isHuqanCliEntry(token) {
  const word = shellWord(token);
  // A backslash is a path separator on Windows and an escape in POSIX shells.
  const bases = [normalizeCandidate(word).split('/').pop(), word.replace(/\\/g, '')].map(base => base.toLowerCase());
  return bases.some(base => base === 'cli.js' || /^huqan(?:\.(?:cmd|ps1|exe))?$/.test(base));
}

/** Skip launchers, their flags and VAR=value assignments to the word that runs. */
function commandWordIndex(words) {
  let i = 0;
  while (i < words.length) {
    const word = shellWord(words[i]).toLowerCase();
    const isFlag = word.startsWith('-') || /^\/[a-z]$/.test(word);
    const isRunnerVerb = RUNNER_VERBS.has(word) && i > 0 && PACKAGE_RUNNERS.has(shellWord(words[i - 1]).toLowerCase());
    if (!(LAUNCHERS.has(word) || PACKAGE_RUNNERS.has(word) || isRunnerVerb || isFlag || /^\w+=/.test(word))) break;
    i += 1;
  }
  return i;
}

const REDIRECT_WORD = /^(?:\d*[<>]|&>)/;
// A redirect that names its target in the next word (not `2>&1`, `<&3`, `>&-`).
const REDIRECT_WITH_TARGET = /^(?:\d*(?:<<<|<<-?|<>|>>|>\||<|>)|&>>?)$/;
// Anything that hands the program a stdin: `<`, `<<`, `<<<`, `<&3`, `0<`, `<>`.
const STDIN_REDIRECT = /^\d*</;

/** The list separator starting at `i` (; newline | || |& && &), or ''. */
function listSeparatorAt(source, i) {
  return /^(?:\|[|&]?|&&?|;|\n)/.exec(source.slice(i, i + 2))?.[0] ?? '';
}

/**
 * Lex a command line the way a POSIX shell splits it, closely enough to find
 * the commands it runs. Quotes ('…', "…", `…`) and backslash escapes keep their
 * text in one word; list separators (; newline | || |& && &) end a segment;
 * redirect operators (`<`, `2>&1`, `&>`, `<&3`) are words of their own. Words
 * keep their raw text, quotes included.
 *
 * @returns {{words: string[], pipedIn: boolean}[]}
 */
function lexShell(text) {
  const source = String(text);
  const segments = [];
  let words = [];
  let word = '';
  let pipedIn = false;
  let quote = null;
  const endWord = () => {
    if (word) words.push(word);
    word = '';
  };
  const cut = (separator) => {
    endWord();
    segments.push({ words, pipedIn });
    words = [];
    pipedIn = separator === '|' || separator === '|&';
  };
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      // Inside quotes only the closing quote (and, outside '…', an escape) matters.
      const escaped = char === '\\' && quote !== "'" && next !== undefined;
      word += escaped ? char + next : char;
      if (escaped) i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '\\' && next !== undefined) {
      word += char + next;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      word += char;
      continue;
    }
    if (/[^\S\n]/.test(char)) {
      endWord();
      continue;
    }
    if (char === '<' || char === '>' || (char === '&' && next === '>')) {
      // A word of digits right before the operator is its file descriptor.
      const fd = /^\d+$/.test(word) ? word : '';
      if (!fd) endWord();
      const operator = source.slice(i).match(/^(?:&>>?|[<>]+(?:&\d*-?|\|)?)/)[0];
      words.push(fd + operator);
      word = '';
      i += operator.length - 1;
      continue;
    }
    const separator = listSeparatorAt(source, i);
    if (separator) {
      i += separator.length - 1;
      cut(separator);
      continue;
    }
    word += char;
  }
  cut('');
  return segments.filter(segment => segment.words.length > 0);
}

/** The words a program receives as argv: redirects and their targets dropped. */
function withoutRedirects(words) {
  const kept = [];
  for (let i = 0; i < words.length; i += 1) {
    if (REDIRECT_WITH_TARGET.test(words[i])) {
      i += 1;
      continue;
    }
    if (REDIRECT_WORD.test(words[i])) continue;
    kept.push(words[i]);
  }
  return kept;
}

/** A word's text with one matching pair of surrounding quotes removed. */
function unquote(raw) {
  const match = /^(["'])([\s\S]*)\1$/.exec(raw);
  if (!match) return shellWord(raw);
  return match[1] === '"' ? match[2].replace(/\\(["\\$`])/g, '$1') : match[2];
}

const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

/**
 * The script a launcher runs as a command line of its own -- `bash -c '…'`,
 * `cmd /c …`, `powershell -Command …`, `eval …` -- or null.
 */
function launchedScript(words) {
  const prefix = commandWordIndex(words);
  for (let i = 0; i <= prefix && i < words.length; i += 1) {
    const name = shellWord(words[i]).toLowerCase().replace(/\.exe$/, '');
    const rest = words.slice(i + 1);
    if (name === 'eval') return rest.map(unquote).join(' ');
    const flag = rest.findIndex(word => {
      const value = shellWord(word).toLowerCase();
      if (POSIX_SHELLS.has(name)) return /^-[a-z]*c$/.test(value);
      if (name === 'cmd') return value === '/c' || value === '/k';
      if (name === 'pwsh' || name === 'powershell') return value === '-c' || value === '-command';
      return false;
    });
    if (flag < 0) continue;
    const script = rest.slice(flag + 1);
    return POSIX_SHELLS.has(name) ? unquote(script[0] ?? '') : script.map(unquote).join(' ');
  }
  return null;
}

/**
 * Find a HUQAN CLI invocation whose subcommand records an operator decision.
 * Only the word each shell command segment actually runs counts as the entry,
 * so `echo huqan terfi` is left alone. The subcommand is the first bare word
 * after it, which is how the CLI reads its argv (only `--json` may precede
 * it), compared after the shell would have removed its quotes. A subcommand
 * the shell would still expand (`$V`, `$(...)`, a backtick) cannot be read
 * here, so it counts as a decision: fail-closed.
 *
 * A bare HUQAN CLI is the REPL. Fed through a pipe, a redirect or a heredoc it
 * runs whatever lines it is given -- `echo "onayla x" | huqan` -- which the
 * hook cannot read, so that is refused too (`repl-stdin`). An agent has no
 * interactive REPL to lose: it has no terminal.
 *
 * @returns {{profile: 'huqan', command: string}|null}
 */
const MAX_SCRIPT_DEPTH = 4;

function findOperatorDecisionCommand(command, depth = 0) {
  const text = String(command ?? '');
  // Substitutions run commands of their own, so their bodies are segments too.
  const nested = [...text.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)].map(match => match[1] ?? match[2]);
  for (const { words, pipedIn } of [text, ...nested].flatMap(lexShell)) {
    // `bash -c '…'` and friends run a command line of their own.
    const script = depth < MAX_SCRIPT_DEPTH ? launchedScript(words) : null;
    const inner = script === null ? null : findOperatorDecisionCommand(script, depth + 1);
    if (inner) return inner;
    const entry = commandWordIndex(words);
    if (entry >= words.length || !isHuqanCliEntry(words[entry])) continue;
    const rest = words.slice(entry + 1);
    // Any stdin redirect feeds the CLI text the hook cannot read: fail-closed.
    if (rest.some(word => STDIN_REDIRECT.test(word))) return { profile: 'huqan', command: 'repl-stdin' };
    const subcommand = withoutRedirects(rest).find(word => !shellWord(word).startsWith('-'));
    if (subcommand === undefined) {
      if (pipedIn) return { profile: 'huqan', command: 'repl-stdin' };
      continue;
    }
    if (/[$`]/.test(subcommand)) return { profile: 'huqan', command: 'unresolved' };
    const verb = shellWord(subcommand).replace(/\\/g, '').toLowerCase();
    if (OPERATOR_DECISION_COMMANDS.has(verb)) return { profile: 'huqan', command: verb };
  }
  return null;
}

module.exports = {
  CONTROL_PLANE_PATH_RULES,
  OPERATOR_DECISION_COMMANDS,
  findOperatorDecisionCommand,
  MUTATING_SHELL_VERBS,
  isControlPlanePath,
  findControlPlaneCommandTarget,
};
