const readline = require('readline');
const { CLI_MUTATION_GATE } = require('./cli-mutation-gate');

// The interactive REPL of cli.js (CLI#start). `cli` is the CLI instance;
// `auditMutation`/`commitMutation` are its mutation-audit hooks.
function runCliRepl(cli, { auditMutation, commitMutation }) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'axiom> ',
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
      const output = await Promise.resolve(cli.execute(parsed.command, parsed.args));
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
