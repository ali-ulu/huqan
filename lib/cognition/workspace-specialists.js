'use strict';

const { AUTHORITY, freezeResult } = require('./contract');

const SPECIALIST_NAMES = Object.freeze(['scheduler', 'dream', 'dual-process-router', 'replay']);

const SPECIALIST_PROPOSAL_KINDS = Object.freeze({
  scheduler: 'annotate-urgency',
  dream: 'focus-hypothesis',
  'dual-process-router': 'route-advice',
  replay: 'replay-tag',
});

function createSpecialist(name, fn) {
  if (!SPECIALIST_NAMES.includes(name)) {
    return null;
  }
  if (typeof fn !== 'function') {
    return null;
  }
  return freezeResult({ name, kind: SPECIALIST_PROPOSAL_KINDS[name], fn, authority: AUTHORITY.PROPOSAL_ONLY });
}

function createSpecialists() {
  return SPECIALIST_NAMES.map((name) => createSpecialist(name, () => []));
}

function withProposalFn(specialist, fn) {
  if (!specialist || typeof specialist.fn !== 'function') {
    return specialist;
  }
  if (typeof fn !== 'function') {
    return specialist;
  }
  return freezeResult({ ...specialist, fn });
}

module.exports = {
  SPECIALIST_NAMES,
  SPECIALIST_PROPOSAL_KINDS,
  createSpecialist,
  createSpecialists,
  withProposalFn,
};
