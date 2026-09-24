const DEFAULT_MAX_INPUT_LENGTH = 500;

const UNSAFE_PUBLIC_API_COMMANDS = Object.freeze([
  'restore',
  'geri yukle',
  'yukle',
  'ogren',
  'ogret',
  'load',
  'import',
  'ingest',
  'company ingest',
  'kaydet',
  'learn',
  'delete',
  'remove',
  'tombstone',
  'supersede',
  'link',
  'backup',
  'export',
  'dusun',
  'autothink',
  'dusunmeye basla',
  'surekli dusun',
  'optimize',
  'konsolide',
  'evolve',
  'ajan',
  'plan',
  'listele',
  'kimler',
  'neler',
]);

/**
 * Commands that answer from a fixed string and never touch workspace state.
 * These are the only ones an unauthenticated caller may run (issue #727).
 */
const UNAUTHENTICATED_PUBLIC_COMMANDS = Object.freeze(new Set([
  'selam',
  'yardim',
  'anlamadim',
]));

/**
 * Commands that are readable over the API surface but read live workspace
 * knowledge, so they require an API key:
 *
 *   sor   -> kernel.ask(), i.e. learned answers from the default workspace
 *   durum -> graph stats plus disconnected-node and contradiction labels
 *
 * They used to sit in the unauthenticated allowlist, which let any caller that
 * could reach the port query learned knowledge and enumerate node names.
 */
const AUTHENTICATED_API_COMMANDS = Object.freeze(new Set([
  'sor',
  'durum',
]));

/**
 * Every command the /api surface may dispatch at all, regardless of auth.
 * Authorization within this set is decided by commandRequiresAuthentication().
 */
const DEFAULT_ALLOWED_PUBLIC_COMMANDS = Object.freeze(new Set([
  ...UNAUTHENTICATED_PUBLIC_COMMANDS,
  ...AUTHENTICATED_API_COMMANDS,
]));

function sanitizeInput(raw, maxLength = DEFAULT_MAX_INPUT_LENGTH) {
  if (typeof raw !== 'string') return '';
  let s = raw.slice(0, maxLength);
  // oxlint-disable-next-line no-control-regex -- deliberate: strips disallowed controls while keeping tab, LF and CR
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return s.trim();
}

function normalizePublicApiCommandText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\uFEFF/g, '')
    .trim()
    .toLowerCase()
    .replace(/[ç]/g, 'c')
    .replace(/[ğ]/g, 'g')
    .replace(/[ı]/g, 'i')
    .replace(/[ö]/g, 'o')
    .replace(/[ş]/g, 's')
    .replace(/[ü]/g, 'u')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUnsafePublicApiCommand(input) {
  const text = normalizePublicApiCommandText(input);
  if (!text) return false;
  return UNSAFE_PUBLIC_API_COMMANDS.some((command) => {
    return text === command || text.startsWith(`${command}:`) || text.startsWith(`${command} `);
  });
}

function isAllowedPublicCommand(command, allowedSet = DEFAULT_ALLOWED_PUBLIC_COMMANDS) {
  if (typeof command !== 'string' || !command) return false;
  const normalized = normalizePublicApiCommandText(command);
  if (!normalized) return false;
  return allowedSet.has(normalized);
}

/**
 * True when the command reads workspace-backed state and therefore may only run
 * for an authenticated caller.
 *
 * Fails closed: anything that does not normalize into the explicitly
 * unauthenticated set is treated as needing a key, so a command added to the
 * allowlist later does not become publicly readable by omission.
 */
function commandRequiresAuthentication(command, publicSet = UNAUTHENTICATED_PUBLIC_COMMANDS) {
  const normalized = normalizePublicApiCommandText(command);
  if (!normalized) return true;
  return !publicSet.has(normalized);
}

module.exports = {
  DEFAULT_MAX_INPUT_LENGTH,
  DEFAULT_ALLOWED_PUBLIC_COMMANDS,
  UNAUTHENTICATED_PUBLIC_COMMANDS,
  AUTHENTICATED_API_COMMANDS,
  commandRequiresAuthentication,
  isAllowedPublicCommand,
  isUnsafePublicApiCommand,
  normalizePublicApiCommandText,
  sanitizeInput,
};
