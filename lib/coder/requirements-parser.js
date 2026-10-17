'use strict';
const { plain, jsonValue } = require('./project-spec-data');
const MAX_REQUIREMENTS_BYTES = 16384;
const refuse = (reason, line = 0) => ({ ok: false, reason, line });
const integer = value => Number.isSafeInteger(value) && Math.abs(value) <= 1000000 && !Object.is(value, -0);
const values = value => Array.isArray(value) && value.length <= 128 && value.every(integer);
function json(text) {
  return JSON.parse(text, (_key, value) => {
    if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))
      throw new TypeError('unsupported number');
    return value;
  });
}

function parseRequirements(text) {
  if (typeof text !== 'string') return refuse('REQUIREMENTS_TEXT_INVALID');
  if (Buffer.byteLength(text, 'utf8') > MAX_REQUIREMENTS_BYTES) return refuse('REQUIREMENTS_OVER_CAP');
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  const routes = []; const paths = new Set(); const locations = [];
  let name; let method; let current;
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at].trim();
    if (!line) continue;
    if (name === undefined) {
      const header = /^proje ([a-z][a-z0-9-]{0,63})$/u.exec(line);
      if (!header) return refuse('REQUIREMENTS_PROJECT_INVALID', at + 1);
      name = header[1]; continue;
    }
    const endpoint = /^(GET|POST) (\/(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)?)(?:\s*=>\s*(.+))?$/u.exec(line);
    if (endpoint) {
      const [, verb, path, body] = endpoint;
      if (method !== undefined && method !== verb) return refuse('REQUIREMENTS_MIXED_METHODS', at + 1);
      if (paths.has(path)) return refuse('REQUIREMENTS_ROUTE_DUPLICATE', at + 1);
      if (routes.length === 8) return refuse('REQUIREMENTS_ROUTES_OVER_CAP', at + 1);
      method = verb;
      if (verb === 'GET') {
        let value;
        try { value = json(body); } catch { return refuse('REQUIREMENTS_JSON_INVALID', at + 1); }
        if (!plain(value) || !jsonValue(value)) return refuse('REQUIREMENTS_BODY_INVALID', at + 1);
        current = { path, body: value };
      } else {
        if (body !== undefined) return refuse('REQUIREMENTS_SYNTAX_INVALID', at + 1);
        current = { path, compute: { examples: [], acceptanceExamples: [] } };
      }
      paths.add(path); routes.push(current); locations.push(at + 1); continue;
    }
    const example = /^(örnek|ornek|kabul) (.+?)\s*=>\s*(.+)$/u.exec(line);
    if (!example || method !== 'POST' || !current) return refuse('REQUIREMENTS_SYNTAX_INVALID', at + 1);
    let input; let expected;
    try { input = json(example[2]); expected = json(example[3]); }
    catch { return refuse('REQUIREMENTS_JSON_INVALID', at + 1); }
    if (!values(input) || !(integer(expected) || values(expected))) return refuse('REQUIREMENTS_EXAMPLE_INVALID', at + 1);
    const rows = example[1] === 'kabul' ? current.compute.acceptanceExamples : current.compute.examples;
    if (rows.length === 32) return refuse('REQUIREMENTS_EXAMPLES_OVER_CAP', at + 1);
    rows.push({ input, expected });
  }
  if (name === undefined || !routes.length) return refuse('REQUIREMENTS_INCOMPLETE', lines.length);
  for (let at = 0; at < routes.length; at += 1) {
    const compute = routes[at].compute;
    if (compute && (compute.examples.length < 3 || compute.acceptanceExamples.length < 3))
      return refuse('REQUIREMENTS_INCOMPLETE', locations[at]);
  }
  return { ok: true, spec: { kind: 'project_spec', name,
    archetype: method === 'GET' ? 'node_json_api' : 'node_computed_json_api', routes } };
}
module.exports = { parseRequirements, MAX_REQUIREMENTS_BYTES };
