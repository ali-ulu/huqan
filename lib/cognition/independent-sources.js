'use strict';

const { isPlainObject } = require('../is-plain-object');

const text = value => typeof value === 'string' && value.trim() !== '' && value === value.trim();
const source = event => isPlainObject(event)
  && (event.sourceGroup === undefined || event.sourceGroup === null || text(event.sourceGroup))
  && Array.isArray(event.sourceRefs) && event.sourceRefs.every(text);

function countIndependentSources(events, dependencyEvents = events) {
  if (!Array.isArray(events) || !Array.isArray(dependencyEvents)
    || !events.every(source) || !dependencyEvents.every(source)) throw new TypeError('invalid_source_evidence');
  const parents = new Map();
  const root = token => {
    if (!parents.has(token)) parents.set(token, token);
    let current = token;
    while (parents.get(current) !== current) current = parents.get(current);
    while (token !== current) {
      const next = parents.get(token);
      parents.set(token, current);
      token = next;
    }
    return current;
  };
  for (const event of [...dependencyEvents, ...events]) {
    if (event.sourceRefs.length === 0) continue;
    const group = event.sourceGroup ? `group:${event.sourceGroup}` : `ref:${event.sourceRefs[0]}`;
    for (const ref of event.sourceRefs) parents.set(root(`ref:${ref}`), root(group));
  }
  return new Set(events.filter(event => event.sourceGroup && event.sourceRefs.length > 0)
    .map(event => root(`group:${event.sourceGroup}`))).size;
}

module.exports = { countIndependentSources };
