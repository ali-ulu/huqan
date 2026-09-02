#!/usr/bin/env node
'use strict';

/**
 * Child entrypoint that exercises an *installed* gate artifact the way its
 * host would, and prints what the artifact decided.
 *
 * Why a child process at all: the whole point of #1792 is that the installed
 * file imports `huqan` by bare specifier, so it resolves from the deployment's
 * node_modules -- not from the installing process. Loading it here, with the
 * artifact's own path as the resolution anchor, is the only way to reproduce
 * what the host will do. It also keeps `manageGate` synchronous while still
 * covering an ESM artifact, which can only be loaded with `await import()`.
 *
 * Contract: argv is `<profile> <target> <root>`, the sentinel payload arrives
 * on stdin, and stdout is one JSON object -- `{ decision, reason }` when the
 * artifact reached a decision, `{ error }` when it could not be loaded or did
 * not expose the hook its host requires.
 */

const { pathToFileURL } = require('node:url');

const GUARD_REFUSAL = /^HUQAN (allow|review|block): ([\s\S]*)$/;

/**
 * Both in-process guards report a refusal as `HUQAN <decision>: <reason>` --
 * `createOpenCodeGuardPlugin` throws it, `registerPiGuard` returns it. Anything
 * that does not match is not a guard decision (a module that failed to load,
 * a TypeError inside the guard) and must not be reported as a block.
 */
function refusal(message) {
  const matched = GUARD_REFUSAL.exec(String(message == null ? '' : message));
  if (!matched) throw new Error(`artifact failed outside the guard decision path: ${message}`);
  return { decision: matched[1], reason: matched[2] };
}

async function exerciseOpenCodePlugin(target, payload, root) {
  const loaded = await import(pathToFileURL(target).href);
  const factory = loaded.HuqanExternalActionGuard;
  if (typeof factory !== 'function') throw new Error('artifact exports no HuqanExternalActionGuard plugin');
  const hooks = await factory({ directory: root });
  const before = hooks && hooks['tool.execute.before'];
  if (typeof before !== 'function') throw new Error('artifact registers no tool.execute.before hook');
  const { cwd: _hostSupplied, ...input } = payload;
  try {
    await before(input, {});
  } catch (error) {
    return refusal(error && error.message);
  }
  return { decision: 'allow', reason: '' };
}

async function exercisePiExtension(target, payload, root) {
  let handler = null;
  const pi = { on: (event, listener) => { if (event === 'tool_call') handler = listener; } };
  const register = require(target);
  if (typeof register !== 'function') throw new Error('artifact exports no Pi extension function');
  register(pi);
  if (typeof handler !== 'function') throw new Error('artifact registers no tool_call handler');
  const outcome = await handler(payload.event, { cwd: root, sessionId: payload.sessionId });
  if (!outcome || !outcome.block) return { decision: 'allow', reason: '' };
  return refusal(outcome.reason);
}

async function main() {
  const [profile, target, root] = process.argv.slice(2);
  try {
    const payload = JSON.parse(require('node:fs').readFileSync(0, 'utf8') || '{}');
    if (!['opencode', 'pi'].includes(profile)) throw new Error(`profile has no loadable artifact: ${profile}`);
    const outcome = profile === 'pi'
      ? await exercisePiExtension(target, payload, root)
      : await exerciseOpenCodePlugin(target, payload, root);
    process.stdout.write(JSON.stringify(outcome));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: String((error && error.message) || error) }));
    process.exitCode = 1;
  }
}

main();
