'use strict';

const { AUTHORITY, freezeResult } = require('./contract');

const SCHEMA_VERSION = 'huqan-cognition-workspace-v1';
const IGNITION_THRESHOLD = 0.5;
const BROADCAST_WIDTH = 2;
const MIN_MARGIN = 0.05;
const REFRACTORY_CYCLES = 2;
const CAPTURE_OVERRIDE = 0.9;
const MAX_SCENES = 16;
const MAX_PROPOSALS_PER_SCENE = 8;

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isInt(value) {
  return Number.isSafeInteger(value);
}

function clampCycle(value) {
  if (!isInt(value) || value < 0) return 0;
  return value;
}

function contentHash(cycle, keys) {
  const sorted = Array.isArray(keys) ? [...keys].sort() : [];
  const raw = `${cycle}:${sorted.join(',')}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash) + raw.charCodeAt(i);
    hash |= 0;
  }
  return `sc_${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

function createScene({ cycle, contents } = {}) {
  return freezeResult({
    schemaVersion: SCHEMA_VERSION,
    cycle: clampCycle(cycle),
    sceneId: null,
    status: 'SUBTHRESHOLD',
    contents: Array.isArray(contents) ? contents.map((c) => freezeResult({
      key: isText(c.key) ? c.key.trim() : '',
      perceptId: typeof c.perceptId === 'string' ? c.perceptId : null,
      strength: typeof c.strength === 'number' && Number.isFinite(c.strength) ? Math.min(1, Math.max(0, c.strength)) : 0,
    })) : [],
    proposals: [],
    rejectedProposals: [],
    authority: AUTHORITY.PROPOSAL_ONLY,
  });
}

function compete(workingMemory, cycle, refractoryState = { wins: [] }) {
  if (!workingMemory || workingMemory.schemaVersion !== 'huqan-cognition-working-memory-v1') {
    return { scene: createScene({ cycle }), refractoryState: { wins: [] } };
  }

  const items = Array.isArray(workingMemory.items) ? workingMemory.items : [];
  const contents = items.map((item) => ({
    key: item.key,
    perceptId: item.perceptId,
    strength: item.activation,
  }));

  const scene = createScene({ cycle, contents });
  const nextRefractory = { wins: Array.isArray(refractoryState.wins) ? [...refractoryState.wins] : [] };

  const ignitable = scene.contents.filter((c) => c.strength >= IGNITION_THRESHOLD);
  if (ignitable.length === 0) {
    return { scene: freezeResult({ ...scene, sceneId: contentHash(cycle, []), contents: [] }), refractoryState: nextRefractory };
  }

  const sorted = [...ignitable].sort((a, b) => {
    if (b.strength !== a.strength) return b.strength - a.strength;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const winners = [];
  for (const candidate of sorted) {
    if (winners.length >= BROADCAST_WIDTH) break;
    const recentWins = nextRefractory.wins.filter((w) => w.key === candidate.key && cycle - w.cycle <= REFRACTORY_CYCLES);
    const isRefractory = recentWins.length >= REFRACTORY_CYCLES && candidate.strength < CAPTURE_OVERRIDE;
    if (isRefractory) continue;
    winners.push(candidate);
  }

  if (winners.length === 0) {
    return { scene: freezeResult({ ...scene, sceneId: contentHash(cycle, []), contents: [] }), refractoryState: nextRefractory };
  }

  const margin = winners.length > 1 ? winners[0].strength - winners[1].strength : Infinity;
  const shouldBroadcastTogether = winners.length > 1 && margin < MIN_MARGIN;
  const broadcastWinners = shouldBroadcastTogether ? winners.slice(0, BROADCAST_WIDTH) : [winners[0]];

  const sceneId = contentHash(cycle, broadcastWinners.map((w) => w.key));
  const ignitedScene = freezeResult({
    ...scene,
    sceneId,
    status: 'IGNITED',
    contents: broadcastWinners,
  });

  nextRefractory.wins = [
    ...nextRefractory.wins,
    ...broadcastWinners.map((w) => ({ key: w.key, cycle })),
  ].slice(-MAX_SCENES * BROADCAST_WIDTH * REFRACTORY_CYCLES);

  return { scene: ignitedScene, refractoryState: nextRefractory };
}

const ALLOWED_PROPOSAL_KINDS = Object.freeze([
  'annotate-urgency',
  'focus-hypothesis',
  'route-advice',
  'replay-tag',
]);

function broadcast(scene, specialists, view = {}) {
  if (!scene || scene.schemaVersion !== SCHEMA_VERSION) {
    return createScene({});
  }
  if (scene.status !== 'IGNITED') {
    return scene;
  }

  const proposals = [];
  const rejectedProposals = [];

  if (Array.isArray(specialists)) {
    for (const specialist of specialists) {
      if (!specialist || typeof specialist.fn !== 'function') continue;
      let result;
      try {
        result = specialist.fn(scene, view);
      } catch {
        continue;
      }
      if (!Array.isArray(result)) continue;
      for (const proposal of result) {
        if (proposals.length >= MAX_PROPOSALS_PER_SCENE) break;
        if (!proposal || typeof proposal !== 'object') continue;
        const kind = typeof proposal.kind === 'string' ? proposal.kind : '';
        if (!ALLOWED_PROPOSAL_KINDS.includes(kind)) {
          rejectedProposals.push(freezeResult({
            specialist: specialist.name || 'unknown',
            kind,
            reason: 'proposal_kind_not_allowed',
          }));
          continue;
        }
        proposals.push(freezeResult({
          specialist: specialist.name || 'unknown',
          kind,
          target: typeof proposal.target === 'string' ? proposal.target : '',
          payload: proposal.payload && typeof proposal.payload === 'object' ? proposal.payload : {},
          authority: AUTHORITY.PROPOSAL_ONLY,
        }));
      }
    }
  }

  return freezeResult({
    ...scene,
    proposals,
    rejectedProposals,
  });
}

module.exports = {
  SCHEMA_VERSION,
  IGNITION_THRESHOLD,
  BROADCAST_WIDTH,
  MIN_MARGIN,
  REFRACTORY_CYCLES,
  CAPTURE_OVERRIDE,
  MAX_SCENES,
  MAX_PROPOSALS_PER_SCENE,
  ALLOWED_PROPOSAL_KINDS,
  createScene,
  compete,
  broadcast,
};
