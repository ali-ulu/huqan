'use strict';

// This gate deliberately evaluates component provenance; it does not execute
// code, publish packages, or claim to sandbox a component.
const crypto = require('crypto');
const COMPONENT_TYPES = new Set(['tool', 'plugin', 'agent-descriptor', 'package', 'prompt', 'dataset', 'endpoint']);
function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function list(value) { return Array.isArray(value) && value.every(item => text(item)) ? [...new Set(value.map(item => item.trim()))].sort() : null; }
function canonical(component) {
  const componentType = text(component && component.componentType); const name = text(component && component.name);
  const version = text(component && component.version); const contentHash = text(component && component.contentHash);
  const issuer = text(component && component.issuer); const workspaceId = text(component && component.workspaceId);
  const capabilities = list(component && component.capabilities);
  if (!COMPONENT_TYPES.has(componentType) || !name || !version || !/^[a-f0-9]{64}$/i.test(contentHash || '') || !issuer || !workspaceId || !capabilities) return null;
  return { componentType, name, version, contentHash: contentHash.toLowerCase(), issuer, workspaceId, capabilities, expiresAt: text(component.expiresAt) };
}
function id(component) { return JSON.stringify(component); }
function receipt(component, decision, reason) {
  return Object.freeze({
    gateVersion: '1',
    componentType: component && component.componentType || null,
    name: component && component.name || null,
    version: component && component.version || null,
    contentHash: component && component.contentHash || null,
    issuer: component && component.issuer || null,
    workspaceId: component && component.workspaceId || null,
    capabilities: Object.freeze(Array.isArray(component?.capabilities) ? [...component.capabilities] : []),
    decision,
    reason: reason || null,
  });
}
function createActivationGate(policy = {}, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const allowed = new Map(); for (const component of Array.isArray(policy.components) ? policy.components.map(canonical) : []) if (component) allowed.set(id(component), component);
  const revoked = new Map();
  function reject(component, reason) { const error = new Error(`Supply-chain activation rejected: ${reason}`); error.code = 'SUPPLY_CHAIN_ACTIVATION_REJECTED'; error.receipt = receipt(component, 'deny', reason); throw error; }
  function evaluate(input) { const component = canonical(input); if (!component) reject(null, 'invalid-component-provenance'); const key = id(component); if (!allowed.has(key)) reject(component, 'not-allowlisted'); if (revoked.has(key)) reject(component, revoked.get(key)); if (component.expiresAt && Date.parse(component.expiresAt) <= now().getTime()) reject(component, 'expired'); return Object.freeze({ ok: true, component, receipt: receipt(component, 'allow') }); }
  return Object.freeze({ activate: evaluate, reattest(input) { return evaluate(input); }, revoke(input, reason = 'revoked') { const component = canonical(input); if (!component) reject(null, 'invalid-component-provenance'); const key = id(component); if (!allowed.has(key)) reject(component, 'not-allowlisted'); revoked.set(key, text(reason) || 'revoked'); return receipt(component, 'revoke', revoked.get(key)); }, inventory() { return Object.freeze([...allowed.values()].map(component => Object.freeze({ ...component }))); } });
}
function hashFile(filePath, fs) { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); }
module.exports = { createActivationGate, hashFile };
