'use strict';

const { episodeFromEvent, digest, text } = require('./causal-episode-contract');
const { LearnedCausalEngine, MAX_EPISODES } = require('./learned-causal-engine');
const worldModel = require('./symbolic-world-model');

const PREFIX = 'causal-episode-v1:';
/**
 * Opt-in host API. The ExperienceJournal supplies actual completed verification
 * events; Graph's existing mutation journal supplies durable, scoped idempotency.
 * No second database, table migration, signer, or canonical-rule writer exists.
 */
class CausalRuntime {
  constructor({ graph, journal, workspaceId = 'default', frameId, evaluatePolicy, minSupport, maxOperations } = {}) {
    if (!graph || typeof graph.runMutationOnce !== 'function' || typeof graph.getCommittedMutationResultsByPrefix !== 'function') throw new TypeError('Graph mutation journal required');
    if (!journal || typeof journal.read !== 'function') throw new TypeError('ExperienceJournal required');
    this.graph = graph;
    this.journal = journal;
    this.scope = Object.freeze({ workspaceId: text(workspaceId, 'workspaceId'), frameId: text(frameId, 'frameId') });
    this.prefix = `${PREFIX}${digest(this.scope)}:`;
    this.evaluatePolicy = evaluatePolicy;
    this.options = { minSupport, maxOperations };
  }

  _records() {
    const rows = this.graph.getCommittedMutationResultsByPrefix(this.prefix);
    if (!Array.isArray(rows) || rows.length > MAX_EPISODES * 2) throw new Error('invalid or over-budget causal ledger');
    const episodes = [];
    const withdrawn = [];
    for (const row of rows) {
      const record = row.result;
      if (!record || record.causalRecord !== true || record.scopeHash !== digest(this.scope)) throw new Error('causal ledger scope or record mismatch');
      const { hash, ...body } = record;
      if (hash !== digest(body)) throw new Error('causal ledger integrity mismatch');
      if (record.kind === 'episode') {
        const episode = episodeFromEvent(record.sourceEvent, this.scope);
        if (digest(episode) !== digest(record.episode)) throw new Error('causal episode source binding mismatch');
        episodes.push(episode);
      } else if (record.kind === 'withdrawal') withdrawn.push(record.sourceHash);
      else throw new Error('unknown causal ledger record');
    }
    return { episodes, withdrawn };
  }

  observeJournalEpisode({ runId, eventId } = {}) {
    const run = text(runId, 'runId');
    const event = text(eventId, 'eventId');
    const events = this.journal.read(run);
    const source = Array.isArray(events) ? events.find(item => item.eventId === event) : null;
    if (!source) throw new TypeError('journal source event unavailable');
    const episode = episodeFromEvent(source, this.scope);
    const previous = this._records().episodes;
    const existing = previous.find(item => item.runId === run && item.eventId === event);
    if (existing && digest(existing) !== digest(episode)) throw new Error('episode idempotency conflict');
    if (!existing && previous.length >= MAX_EPISODES) throw new Error('episode budget exhausted');
    const body = { causalRecord: true, scopeHash: digest(this.scope), kind: 'episode', sourceEvent: source, episode };
    const result = this.graph.runMutationOnce(`${this.prefix}episode:${digest([run, event])}`, () => ({ ...body, hash: digest(body) }));
    if (!result || !result.result || result.result.hash !== digest(body)) throw new Error('episode persistence or replay conflict');
    return Object.freeze({ episode, replayed: result.replayed === true });
  }

  withdrawSupport({ sourceHash, reason } = {}) {
    if (typeof sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(sourceHash)) throw new TypeError('sourceHash required');
    const why = text(reason, 'reason');
    if (!this._records().episodes.some(item => item.sourceHash === sourceHash)) throw new TypeError('unknown episode source');
    const body = { causalRecord: true, scopeHash: digest(this.scope), kind: 'withdrawal', sourceHash, reason: why };
    // The first withdrawal remains authoritative on replay; a later reason
    // cannot restore support or rewrite the original audit explanation.
    const result = this.graph.runMutationOnce(`${this.prefix}withdrawal:${sourceHash}`, () => ({ ...body, hash: digest(body) }));
    if (!result || !result.result) throw new Error('withdrawal persistence unavailable');
    return Object.freeze({ sourceHash, replayed: result.replayed === true });
  }

  _engine() { return new LearnedCausalEngine({ ...this._records(), ...this.options }); }
  // One durable read for a multistep query: every step sees the same support.
  // A withdrawal recorded afterwards applies to the next snapshot.
  snapshot() {
    const engine = this._engine();
    const scope = this.scope;
    return Object.freeze({ ...scope, evaluatePolicy: this.evaluatePolicy,
      forward: input => engine.forward({ ...input, ...scope }) });
  }
  // Level 2 world model (#3468) over one snapshot per query.
  rollout(input) { return worldModel.rollout(this.snapshot(), input); }
  compare(input) { return worldModel.compare(this.snapshot(), input); }
  explainPrediction(result) { return worldModel.explainPrediction(result); }
  forward(input) { return this._engine().forward({ ...input, ...this.scope }); }
  inverse(input) { return this._engine().inverse({ ...input, ...this.scope, evaluatePolicy: this.evaluatePolicy }); }
  failure({ prediction, preState, runId, eventId } = {}) {
    // Only an independently recorded verification outcome revises support.
    const before = this._engine();
    const { episode } = this.observeJournalEpisode({ runId, eventId });
    if (digest(preState) !== digest(episode.preState)) throw new TypeError('failure outcome pre-state binding mismatch');
    const issued = before.forward({ ...this.scope, preState, action: episode.action });
    if (!prediction || issued.status !== 'PREDICTED' || issued.modelId !== prediction.modelId) {
      return Object.freeze({ status: 'UNKNOWN', reason: 'stale_or_unbound_prediction' });
    }
    return this._engine().failure({ prediction: issued, preState, observedPostState: episode.postState });
  }
  inspect() {
    const { episodes, withdrawn } = this._records();
    return Object.freeze({ ...this.scope, episodes: episodes.length, withdrawn: Object.freeze([...withdrawn]),
      sourceHashes: Object.freeze(episodes.map(item => item.sourceHash).sort()) });
  }
}
module.exports = { CausalRuntime, PREFIX };
