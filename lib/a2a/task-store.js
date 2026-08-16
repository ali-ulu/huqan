'use strict';

/**
 * Durable task records for the bounded A2A exchange (P0-E).
 *
 * ## The property this must not break
 *
 * `lib/a2a/bounded-exchange.js` reserves the replay key *before* it runs the
 * effect, and leaves the marker in place if the effect throws. The conformance
 * case `effect_failure_keeps_replay_marker` pins that: a request whose outcome
 * is unknown is never retried. The system chooses at-most-once and an honest
 * "I do not know" over at-least-once and a possible double effect.
 *
 * The naive reading of "idempotency keys" would undo exactly that -- returning a
 * stored success for a retried request requires knowing the first attempt
 * succeeded, and the one case where that is unknowable is the case the marker
 * exists for. So this module does **not** turn a replay into a success. A
 * replayed exchange still gets `replay_detected`, unchanged.
 *
 * What it adds is the missing half: somewhere to *look up* what happened. The
 * caller that got `replay_detected`, or that never saw its response at all, can
 * ask for the task and be told `completed` with the original effect, or
 * `unknown` -- and `unknown` is a real, permanent answer, not a retry prompt.
 *
 * ## Why completion is a second file
 *
 * The reservation file is written by `lib/a2a/replay-store.js` with `wx`, and
 * its exclusive-create is the whole replay guarantee. Rewriting it to append an
 * outcome would put that guarantee behind a second, non-atomic write. Instead a
 * completion is a separate `.completed` file: the reservation's bytes and
 * semantics are untouched, and a deployment that upgrades mid-flight simply has
 * reservations with no completion, which reads as `unknown` -- the correct
 * answer for a task this process cannot account for.
 *
 * ## Why the task id is not the replay key
 *
 * They are one-to-one, but a task id is handed out and a replay key is
 * security-relevant state. Domain-separating them means a task id cannot be
 * replayed back as a reservation probe.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SHA256 = /^[0-9a-f]{64}$/;
const TASK_ID_DOMAIN = 'HUQAN/V5/D6/A2A-TASK-ID/v1';
const MAX_RECORD_BYTES = 64 * 1024;

/**
 * Task states.
 *
 * There is deliberately no `working`: this exchange is evaluated synchronously,
 * so a task is either accounted for or it is not. Inventing an intermediate
 * state would describe a concurrency this route does not have.
 */
const TASK_STATES = Object.freeze({
  COMPLETED: 'completed',
  UNKNOWN: 'unknown',
  NOT_FOUND: 'not_found',
});

function taskIdForReplayKey(replayKey) {
  if (!SHA256.test(String(replayKey || ''))) throw new Error('A2A replay key is invalid');
  return crypto.createHash('sha256').update(`${TASK_ID_DOMAIN}:${replayKey}`, 'utf8').digest('hex');
}

function createA2aTaskStore(directory) {
  const root = path.resolve(directory);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(root) !== root) {
    throw new Error('A2A task directory must be a real directory');
  }

  return Object.freeze({ recordCompletion, readTask, taskIdForReplayKey });

  /**
   * Record that a reserved exchange completed, and return its task id.
   *
   * Exclusive-create again: a completion is written once. A second write for
   * the same key would mean the effect ran twice, which the replay reservation
   * already forbids -- so rather than overwrite, this treats it as the
   * contradiction it is and leaves the first record standing.
   */
  function recordCompletion(replayKey, effect) {
    const taskId = taskIdForReplayKey(replayKey);
    const payload = JSON.stringify({ taskId, state: TASK_STATES.COMPLETED, effect });
    if (Buffer.byteLength(payload, 'utf8') > MAX_RECORD_BYTES) throw new Error('A2A task record too large');
    const target = path.join(root, `${taskId}.completed`);
    let descriptor;
    try {
      descriptor = fs.openSync(target, 'wx', 0o600);
      fs.writeFileSync(descriptor, payload, 'utf8');
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    return taskId;
  }

  /**
   * Read a task by its id.
   *
   * `unknown` is returned only for a task that was reserved but has no
   * completion -- that is the honest answer for an effect whose outcome this
   * receiver cannot account for, and it never becomes `completed` later.
   *
   * A task id that was never reserved is `not_found`, kept distinct so an
   * operator can tell "never happened" from "happened, outcome unknown".
   */
  function readTask(taskId) {
    if (!SHA256.test(String(taskId || ''))) return Object.freeze({ state: TASK_STATES.NOT_FOUND });
    const target = path.join(root, `${taskId}.completed`);
    let bytes;
    try {
      bytes = fs.readFileSync(target, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return Object.freeze({ state: reservationExists(taskId) ? TASK_STATES.UNKNOWN : TASK_STATES.NOT_FOUND, taskId });
    }
    let parsed;
    try {
      parsed = JSON.parse(bytes);
    } catch (_) {
      // A record this process cannot read is not silently a success.
      return Object.freeze({ state: TASK_STATES.UNKNOWN, taskId });
    }
    if (!parsed || parsed.state !== TASK_STATES.COMPLETED || parsed.taskId !== taskId) {
      return Object.freeze({ state: TASK_STATES.UNKNOWN, taskId });
    }
    return Object.freeze({ state: TASK_STATES.COMPLETED, taskId, effect: parsed.effect });
  }

  /**
   * Is there a reservation behind this task id?
   *
   * Task ids are a one-way hash of the replay key, so this cannot be answered by
   * inverting the id. The reservation directory is scanned instead, which is
   * bounded by the same directory the replay owner already writes into.
   */
  function reservationExists(taskId) {
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch (_) {
      return false;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.reserved')) continue;
      const key = entry.slice(0, -'.reserved'.length);
      if (!SHA256.test(key)) continue;
      if (taskIdForReplayKey(key) === taskId) return true;
    }
    return false;
  }
}

module.exports = Object.freeze({
  MAX_RECORD_BYTES,
  TASK_STATES,
  createA2aTaskStore,
  taskIdForReplayKey,
});
