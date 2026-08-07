// Mutable registry so plugins and config can extend the alias set at runtime
// via registerAlias. Each domain map is also a plain object (not frozen) so
// new aliases can be added without recreating the whole registry.
const ALIAS_REGISTRY = {
  aviation: {
    b737: 'boeing_737',
    'boeing 737': 'boeing_737',
    'boeing-737': 'boeing_737',
    thy: 'turkish_airlines',
    'türk hava yolları': 'turkish_airlines',
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

function normalizeAlias(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getDomainRegistry(domain) {
  if (!domain) return null;
  const normalized = String(domain).trim().toLowerCase();
  return ALIAS_REGISTRY[normalized] || null;
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
    const canonical = registry[normalized];
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
    if (reg[normalized]) {
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
 * Creates the domain if it does not exist yet.
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

  if (!ALIAS_REGISTRY[normalizedDomain]) {
    ALIAS_REGISTRY[normalizedDomain] = {};
  }
  const existing = ALIAS_REGISTRY[normalizedDomain][normalizedAlias];
  if (existing === normalizedCanonical) return false;
  ALIAS_REGISTRY[normalizedDomain][normalizedAlias] = normalizedCanonical;
  return true;
}

module.exports = {
  resolveEntity,
  listAliases,
  listDomains,
  registerAlias,
  normalizeAlias,
  ALIAS_REGISTRY,
};