'use strict';

/**
 * The built-in command policy templates (#4102).
 *
 * A template is a starting point for the deployment's own
 * `external-action-policy.json`, not a policy in itself: the deployment still
 * owns the file, and the gate still decides every action. What a template
 * carries is the deployment's `allowedCommands` list -- the commands it does
 * not want to approve on every turn -- in the schema the file already has.
 *
 * ## A template cannot widen the gate
 *
 * `allowedCommands` only promotes a command the classifier would otherwise
 * call a tool chain (see `allowlistMatch` in lib/external-action-envelope.js):
 * a write keeps the write category, a deploy stays a deploy, a permission
 * change stays a permission change, and the denylist is never touched. So
 * every entry below names a command that would otherwise ask a human, and
 * applying a template can never turn a blocked action into an allowed one.
 *
 * ## Every entry is at least two words
 *
 * An allowlist entry matches a whole leading argument run, so a one-word entry
 * would promote every invocation of that program -- `git` alone would promote
 * `git push`. The command allowlist miner refuses to propose a one-word shape
 * for the same reason (lib/command-allowlist-miner.js).
 *
 * ## Nothing here is a security guarantee
 *
 * A template is a documented, tested starting point. The protection a
 * deployment gets is the gate's own rules; the template only decides how many
 * of them a person has to read.
 */

const POLICY_TEMPLATES = Object.freeze({
  'solo-dev': Object.freeze({
    id: 'solo-dev',
    title: 'Solo developer (emergency brake)',
    summary: 'One developer inner loop: test, build and lint run without a prompt; a delete asks, a deploy or a permission change is blocked.',
    // The everyday inner loop of a single developer. `npm ci` is deliberately
    // absent: it installs packages and runs their lifecycle scripts, which is
    // not a command a person would want to approve on every inner loop but
    // also not one a policy file should wave through unattended.
    allowedCommands: Object.freeze(['npm test', 'npm run build', 'npm run lint', 'node --test']),
  }),
  'team-ci': Object.freeze({
    id: 'team-ci',
    title: 'Team / CI',
    summary: 'The solo list plus the CI script names a build agent runs; a delete asks, a deploy or a permission change is blocked.',
    allowedCommands: Object.freeze([
      'npm test',
      'npm run test',
      'npm run build',
      'npm run lint',
      'npm run typecheck',
      'npm run check',
      'node --test',
    ]),
  }),
  'regulated': Object.freeze({
    id: 'regulated',
    title: 'Regulated (bank / health)',
    summary: 'Only the deployment own test suite runs unattended, and a data residency declaration is required; everything else asks.',
    // One entry: the deployment's own test suite. The residency declaration is
    // the operator's to make -- a shipped template cannot know the hosts a
    // bank is allowed to send data to, and an empty list reads as "not
    // declared" rather than "nothing is allowed" (see
    // parseDataResidency in lib/external-action-command-policy.js).
    allowedCommands: Object.freeze(['npm test']),
    requiresResidency: true,
  }),
  'read-only-agent': Object.freeze({
    id: 'read-only-agent',
    title: 'Read-only agent',
    summary: 'Promotes no command at all: only the gate own read-only rules let an action through, everything else asks.',
    allowedCommands: Object.freeze([]),
  }),
});

/** The templates, for a listing that says nothing about their contents. */
function listPolicyTemplates() {
  return Object.values(POLICY_TEMPLATES).map((template) => Object.freeze({
    id: template.id,
    title: template.title,
    summary: template.summary,
    allowedCommands: template.allowedCommands.length,
    requiresResidency: template.requiresResidency === true,
  }));
}

/** The template with this id, or null when there is none. */
function getPolicyTemplate(id) {
  const key = typeof id === 'string' ? id.trim() : '';
  return Object.hasOwn(POLICY_TEMPLATES, key) ? POLICY_TEMPLATES[key] : null;
}

module.exports = {
  POLICY_TEMPLATES,
  listPolicyTemplates,
  getPolicyTemplate,
};
