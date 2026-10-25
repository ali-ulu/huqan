'use strict';

const path = require('node:path');

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
  { profile: 'openhands', pattern: /(?:^|\/)\.openhands\/(?:hooks\.json|hooks\/.+)$/ },
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
 *
 * The cmd/PowerShell verbs mirror `WRITE_SHELL` in `external-action-envelope.js`
 * so a `cmd /c "del …"` wrapper is protected the same as its POSIX twin (#4249).
 */
const MUTATING_SHELL_VERBS = new Set([
  'rm', 'unlink', 'shred', 'mv', 'cp', 'install', 'ln',
  'tee', 'truncate', 'dd', 'chmod', 'chown', 'touch', 'patch',
  'del', 'erase', 'copy', 'move', 'ren', 'rename', 'rd',
  'remove-item', 'set-content', 'add-content', 'clear-content', 'out-file', 'new-item',
]);

/** Wrappers that prefix a real command without changing what it does. */
const COMMAND_WRAPPERS = new Set([
  'sudo', 'doas', 'command', 'time', 'nohup', 'eval', 'exec', 'nice', 'ionice', 'env', 'xargs',
]);

/**
 * Wrapper flags that take the next word as their operand, so the word that
 * actually runs can be found past `sudo -u root`, `env -u NAME`, `nice -n 5`
 * and `xargs -n 1`. Only operand-taking flags are listed: `sudo -n` and
 * `nice -n` are different flags with the same spelling, so the map is keyed by
 * wrapper.
 */
const WRAPPER_OPERAND_FLAGS = Object.freeze({
  sudo: new Set(['-u', '--user', '-g', '--group', '-p', '--prompt', '-C', '--close-from', '-h', '--host', '-D', '--chdir', '-R', '--chroot', '-T', '--command-timeout', '-U', '--other-user']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string', '--argv0']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '--class', '-n', '--classdata']),
  xargs: new Set(['-a', '--arg-file', '-d', '--delimiter', '-E', '--eof', '-I', '--replace', '-L', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars']),
});

function normalizeCandidate(candidate) {
  return path.posix.normalize(String(candidate ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/'))
    .replace(/^\.\//, '')
    .replace(/\/+$/g, '');
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

/**
 * Whether one shell segment modifies a file, and which control-plane file it
 * names. A segment mutates when the word that runs (after its wrappers are
 * skipped) is a mutating verb, when it is `sed -i`, or when it carries a
 * redirect.
 */
function controlPlaneTargetInSegment(words) {
  const index = commandWordIndex(words);
  const verb = index < words.length
    ? normalizeCandidate(shellWord(words[index])).split('/').pop().toLowerCase()
    : '';
  const mutates = MUTATING_SHELL_VERBS.has(verb)
    || (verb === 'sed' && words.some(word => /^-[a-z]*i/.test(shellWord(word))))
    || words.some(word => REDIRECT_WORD.test(word));
  if (!mutates) return null;
  for (const word of words) {
    const match = isControlPlanePath(word);
    if (match) return match;
  }
  return null;
}

/**
 * Find a control-plane file a shell command would modify.
 *
 * The command is lexed the way the shell splits it — `;`, `&&`, `|` and a
 * newline end a segment — and each segment is judged on its own after its
 * wrappers (`sudo`, `env FOO=1`, `xargs`) are skipped to the word that runs. A
 * script a launcher is told to run (`bash -c '…'`, `cmd /c …`, `eval …`) and a
 * `$(…)` or backtick substitution are lexed again, so a wrapped or chained
 * command cannot hide the target. The flat tokenizer this replaces read
 * `sudo rm x`, `a; rm x` and `a\nrm x` as having no command word (#4249).
 *
 * Reading the config is not a threat — `cat`, `grep` and `git diff` over
 * `.claude/settings.json` are how an operator checks the guard is wired in, and
 * flagging them would train people to approve control-plane prompts.
 *
 * @returns {{profile: string, path: string}|null}
 */
function findControlPlaneCommandTarget(command, depth = 0) {
  const text = String(command ?? '');
  const nested = [...text.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)].map(match => match[1] ?? match[2]);
  for (const { words } of [text, ...nested].flatMap(lexShell)) {
    const script = depth < MAX_SCRIPT_DEPTH ? launchedScript(words) : null;
    if (script !== null) {
      const inner = findControlPlaneCommandTarget(script, depth + 1);
      if (inner) return inner;
      continue;
    }
    const match = controlPlaneTargetInSegment(words);
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

/** Skip launchers, their flags (and their operands) and VAR=value assignments. */
function commandWordIndex(words) {
  let i = 0;
  let wrapper = '';
  while (i < words.length) {
    const raw = shellWord(words[i]);
    const word = raw.toLowerCase();
    const isFlag = word.startsWith('-') || /^\/[a-z]$/.test(word);
    const isRunnerVerb = RUNNER_VERBS.has(word) && i > 0 && PACKAGE_RUNNERS.has(shellWord(words[i - 1]).toLowerCase());
    const operandFlags = WRAPPER_OPERAND_FLAGS[wrapper];
    const takesOperand = isFlag && operandFlags !== undefined && operandFlags.has(raw);
    if (!(LAUNCHERS.has(word) || PACKAGE_RUNNERS.has(word) || isRunnerVerb || isFlag || /^\w+=/.test(word))) break;
    if (LAUNCHERS.has(word) || PACKAGE_RUNNERS.has(word)) wrapper = word;
    i += 1;
    // `sudo -u root rm x` runs `rm`: the operand belongs to the flag, not the
    // command word, so skip it too (#4249).
    if (takesOperand) i += 1;
  }
  return i;
}

const REDIRECT_WORD = /^(?:\d*[<>]|&>)/;
// A redirect that names its target in the next word: `> f`, `>& f`, `2>& 1`
// (not `2>&1`, `<&3` or `>&-`, which carry it).
const REDIRECT_WITH_TARGET = /^(?:\d*(?:<<<|<<-?|<>|>>|>\||<|>)&?|&>>?)$/;
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
