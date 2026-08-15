// Mutable registry so plugins and config can extend the alias set at runtime
// via registerAlias. Each domain map is also a plain object (not frozen) so
// new aliases can be added without recreating the whole registry.
const ALIAS_REGISTRY = {
  aviation: {
    b737: 'boeing_737',
    'boeing 737': 'boeing_737',
    'boeing-737': 'boeing_737',
    thy: 'turkish_airlines',
    'turk hava yollari': 'turkish_airlines',
    'turkish airlines': 'turkish_airlines',
    ai: 'air_india',
    'air india': 'air_india',
    'air-india': 'air_india',
  },
  tech: {
    ai: 'artificial_intelligence',
    'artificial intelligence': 'artificial_intelligence',
    ml: 'machine_learning',
    'machine learning': 'machine_learning',
    nlp: 'natural_language_processing',
    'natural language processing': 'natural_language_processing',
  },
  design: {
    ai: 'adobe_illustrator',
    'adobe illustrator': 'adobe_illustrator',
    ps: 'adobe_photoshop',
    'adobe photoshop': 'adobe_photoshop',
    id: 'adobe_indesign',
    'adobe indesign': 'adobe_indesign',
  },
};

// Same Turkish -> ASCII fold kernel.v2.js's (unexported, private) normalizeAscii()
// uses, duplicated here rather than reaching into another module's internals.
// Folding both the stored alias keys (once, below) and every lookup query
// means 'Türk Hava Yolları' and 'Turk Hava Yollari' resolve to the same
// registry entry instead of only the exact diacritic form matching (#442).
function foldTurkishAscii(word) {
  return String(word || '')
    // JS's locale-agnostic toLowerCase() turns 'İ' into 'i' + a combining dot
    // above (U+0307), not plain 'i', so an İ-spelled alias would otherwise
    // fold to a different string than its plain-i ASCII spelling. Map the
    // dotted capital explicitly before the general lowercase pass.
    .replace(/İ/g, 'i')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c');
}

function normalizeAlias(raw) {
  if (typeof raw !== 'string') return '';
  return foldTurkishAscii(raw.trim()).replace(/\s+/g, ' ');
}

/**
 * Keys that must never index a registry (#748).
 *
 * ALIAS_REGISTRY was an ordinary object, so `ALIAS_REGISTRY['__proto__']`
 * resolved to Object.prototype: the "create the domain if missing" branch saw
 * a truthy value, skipped initialization, and the following assignment wrote
 * the alias straight onto Object.prototype. registerAlias() is exported for
 * runtime plugin/config extension, which makes that a reachable
 * prototype-pollution primitive able to alter unrelated logic that tests
 * properties on ordinary objects.
 *
 * Storage below is prototype-inert, which removes the primitive on its own.
 * These names are still rejected outright so a registry can never be *named*
 * after one either, and lookups for them find nothing.
 */
const UNSAFE_REGISTRY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeRegistryKey(key) {
  return typeof key === 'string' && key.length > 0 && !UNSAFE_REGISTRY_KEYS.has(key);
}

/** Copy a plain object into prototype-inert storage, dropping unsafe keys. */
function toInertMap(source) {
  const inert = Object.create(null);
  for (const key of Object.keys(source)) {
    if (isSafeRegistryKey(key)) inert[key] = source[key];
  }
  return inert;
}

// Rebuild the literal above as prototype-inert maps, top level and per domain.
for (const domain of Object.keys(ALIAS_REGISTRY)) {
  ALIAS_REGISTRY[domain] = toInertMap(ALIAS_REGISTRY[domain]);
}
Object.setPrototypeOf(ALIAS_REGISTRY, null);

// Fold the built-in registry's own keys once at load time, so a lookup that
// folds its query (normalizeAlias does this) always lands on a folded key.
for (const registry of Object.values(ALIAS_REGISTRY)) {
  for (const key of Object.keys(registry)) {
    const folded = normalizeAlias(key);
    if (folded !== key) {
      registry[folded] = registry[key];
      delete registry[key];
    }
  }
}

function getDomainRegistry(domain) {
  if (!domain) return null;
  const normalized = String(domain).trim().toLowerCase();
  if (!isSafeRegistryKey(normalized)) return null;
  return Object.hasOwn(ALIAS_REGISTRY, normalized) ? ALIAS_REGISTRY[normalized] : null;
}

function resolveEntity(alias, options = {}) {
  const normalized = normalizeAlias(alias);
  if (!normalized) {
    return {
      matched: false,
      reason: 'empty_alias',
    };
  }

  const domain = options.domain ? String(options.domain).trim().toLowerCase() : undefined;
  const registry = domain ? getDomainRegistry(domain) : null;

  if (registry) {
    const canonical = Object.hasOwn(registry, normalized) ? registry[normalized] : undefined;
    if (canonical) {
      const allAliases = Object.entries(registry)
        .filter(([, c]) => c === canonical)
        .map(([a]) => a);
      return {
        matched: true,
        canonical,
        domain,
        confidence: 1,
        reason: 'exact_alias',
        aliases: allAliases,
      };
    }
    return {
      matched: false,
      reason: 'unknown_alias_in_domain',
      domain,
    };
  }

  const candidates = [];
  for (const [dom, reg] of Object.entries(ALIAS_REGISTRY)) {
    if (Object.hasOwn(reg, normalized) && reg[normalized]) {
      candidates.push({ canonical: reg[normalized], domain: dom });
    }
  }

  if (candidates.length === 1) {
    const { canonical, domain: matchedDomain } = candidates[0];
    const allAliases = Object.entries(ALIAS_REGISTRY[matchedDomain])
      .filter(([, c]) => c === canonical)
      .map(([a]) => a);
    return {
      matched: true,
      canonical,
      domain: matchedDomain,
      confidence: 1,
      reason: 'exact_alias',
      aliases: allAliases,
    };
  }

  if (candidates.length > 1) {
    return {
      matched: false,
      ambiguous: true,
      candidates: candidates.map((c) => c.canonical),
      reason: 'ambiguous_alias_requires_domain',
    };
  }

  return {
    matched: false,
    reason: 'unknown_alias',
  };
}

function listAliases(domain) {
  const reg = getDomainRegistry(domain);
  if (!reg) return [];
  return Object.entries(reg).map(([alias, canonical]) => ({ alias, canonical }));
}

function listDomains() {
  return Object.keys(ALIAS_REGISTRY);
}

/**
 * Register an additional alias → canonical mapping at runtime.
 * Creates the domain if it does not exist yet. Both `alias` and `domain`
 * are normalized the same way a lookup would normalize them (including the
 * Turkish-ASCII fold), so a caller can't register something a later
 * resolveEntity() call can't find.
 *
 * @param {string} domain - Domain name (e.g. 'aviation', 'medical')
 * @param {string} alias - Alias text to recognize (case-insensitive, whitespace-collapsed)
 * @param {string} canonical - Canonical entity id the alias resolves to
 * @returns {boolean} true if a new alias was added, false if it already existed
 *                   with the same canonical (no-op)
 */
function registerAlias(domain, alias, canonical) {
  const normalizedDomain = normalizeAlias(domain);
  const normalizedAlias = normalizeAlias(alias);
  const normalizedCanonical = typeof canonical === 'string' ? canonical.trim() : '';
  if (!normalizedDomain || !normalizedAlias || !normalizedCanonical) return false;
  // A prototype name is not a domain or an alias, in either position (#748).
  if (!isSafeRegistryKey(normalizedDomain) || !isSafeRegistryKey(normalizedAlias)) return false;

  if (!Object.hasOwn(ALIAS_REGISTRY, normalizedDomain)) {
    ALIAS_REGISTRY[normalizedDomain] = Object.create(null);
  }
  const registry = ALIAS_REGISTRY[normalizedDomain];
  const existing = Object.hasOwn(registry, normalizedAlias) ? registry[normalizedAlias] : undefined;
  if (existing === normalizedCanonical) return false;
  registry[normalizedAlias] = normalizedCanonical;
  return true;
}

module.exports = {
  resolveEntity,
  listAliases,
  listDomains,
  registerAlias,
  normalizeAlias,
  // Exported so the prototype-inertness contract (#748) can be asserted
  // directly rather than inferred from resolveEntity's behavior.
  getDomainRegistry,
  ALIAS_REGISTRY,
};
