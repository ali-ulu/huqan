const readline = require('readline');
const { CLI_MUTATION_GATE } = require('./cli-mutation-gate');
const { runCliArgv } = require('./cli-workflow-adapter');

// #3638: `stop`, `lift`, `integrity` and the `ingest` family are argv-only.
// Their implementation lives in cli-workflow-adapter's runCliArgv (it reads a
// split argv array), and there is no handler for them in the REPL's command
// registry -- so typing `stop --scope ...` at the prompt answered "anlamadım"
// even though `yardım` lists it, while the same words worked from the shell as
// separate arguments. Rather than duplicate the ledger/ingest logic as a second
// parser rule, the REPL hands a line whose first word is one of these families
// to the argv dispatcher, which already owns that logic.
const ARGV_ONLY_COMMANDS = new Set(['stop', 'lift', 'integrity', 'ingest']);

/** Split a REPL line into argv the way the shell would, honouring quotes. */
function tokenizeCommandLine(line) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(line || ''))) !== null) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token !== undefined && token !== '') tokens.push(token);
  }
  return tokens;
}

function isArgvOnlyCommandLine(line) {
  const head = String(line || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
  return ARGV_ONLY_COMMANDS.has(head);
}

// The interactive REPL of cli.js (CLI#start). `cli` is the CLI instance;
// `auditMutation`/`commitMutation` are its mutation-audit hooks.
function runCliRepl(cli, { auditMutation, commitMutation }) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'huqan> ',
  });

  console.log('HUQAN - talk, teach and ask in natural language');
  console.log('  "learn: cats are animals" | Learn a fact');
  console.log('  "ask: what is a cat"      | Ask a question');
  console.log('  "verify: cats are plants" | Guarded verification');
  console.log('  "plan: <goal>"            | Agent plan');
  console.log('  "agent: <goal>"           | Run the agent');
  console.log('  "backup"                  | Back up current state');
  console.log('  "restore[: path]"         | Restore from a backup');
  console.log('  "help"                    | Command reference');
  console.log('  "exit"                    | Exit\n');

  let closing = false;
  const handleLine = async (line) => {
    const parsed = cli.parse(line);
    if (parsed.command === 'anlamadım' && isArgvOnlyCommandLine(line)) {
      // The parser has no rule for this line, but its first word names a
      // command the argv dispatcher owns (#3638). Fall back to it so the
      // command the help lists is reachable from the prompt too.
      const output = [];
      const write = (value) => output.push(value);
      await runCliArgv(tokenizeCommandLine(line), { cli, stdout: write, stderr: write });
      for (const value of output) console.log(value);
      return;
    }
    if (parsed.command === 'kaydet') {
      // Persisting without its audit record is the fail-open this gate
      // exists to prevent, so an unwritable audit stops the write (#760).
      const audit = auditMutation('kaydet', CLI_MUTATION_GATE.kaydet, 'allow', true);
      if (!audit.auditRecorded) {
        console.log(`Kaydetme durduruldu: denetim kaydi yazilamadi (${audit.errorCode}).`);
      } else {
        cli.kernel.persist();
        console.log(`Memory saved.${commitMutation('kaydet', CLI_MUTATION_GATE.kaydet)}`);
      }
    } else if (parsed.command === 'çıkış' || parsed.command === 'exit') {
      const rawCommand = String(line || '').trim().toLowerCase();
      const sourceCommand = rawCommand === 'exit' || rawCommand === 'quit' ? 'exit' : 'cikis';
      const audit = auditMutation(sourceCommand, CLI_MUTATION_GATE.kaydet, 'allow', true);
      if (!audit.auditRecorded) {
        // Exit still exits — refusing to quit would trap the user — but the
        // unaudited save does not happen, and the session says so.
        console.log(`Kaydetmeden cikiliyor: denetim kaydi yazilamadi (${audit.errorCode}).`);
      } else {
        cli.kernel.persist();
        console.log(`Memory saved. Goodbye.${commitMutation(sourceCommand, CLI_MUTATION_GATE.kaydet)}`);
      }
      closing = true;
      rl.close();
      return;
    } else if (parsed.command === 'llm-sor') {
      console.log(cli.execute('llm-sor', parsed.args));
    } else {
      // A command that asks the operator (terfi, #3560) asks through this
      // prompt; a second reader on stdin would take the answer as a command.
      // EOF never calls the question callback, so a close answers empty --
      // a declined approval -- and lineQueue can still drain.
      const operatorAsk = (question) => new Promise((resolve) => {
        // Closed before this queued line ran: the close event is gone and
        // question() would throw ERR_USE_AFTER_CLOSE.
        if (rl.closed === true) {
          resolve('');
          return;
        }
        const onClose = () => resolve('');
        rl.once('close', onClose);
        rl.question(question, (answer) => {
          rl.removeListener('close', onClose);
          resolve(answer);
        });
      });
      const output = await Promise.resolve(cli.execute(parsed.command, parsed.args, { operatorAsk }));
      console.log(parsed.command === 'doctor' && output?.text ? output.text : output);
    }
  };

  let lineQueue = Promise.resolve();
  let closeExit = null;
  rl.prompt();
  rl.on('line', (line) => {
    // The prompt is restored in `finally`, not at the end of handleLine.
    // A throw inside a command branch skipped `rl.prompt()` entirely, so the
    // only thing the user saw was a raw Error object from the catch below and
    // then no prompt at all on the next line (#1029). `closing` keeps the
    // exit branches from printing one last prompt after the goodbye.
    const current = lineQueue.then(() => handleLine(line));
    lineQueue = current
      .catch(error => {
        console.error(error?.message || error);
      })
      .finally(() => {
        if (!closing) rl.prompt();
      });
    return current;
  });
  rl.on('close', () => {
    if (!closeExit) {
      closeExit = lineQueue.then(() => {
        try { cli.approvalStore?.close?.(); } catch (_) {}
        process.exit(0);
      });
    }
    return closeExit;
  });
}

module.exports = { runCliRepl };
