const ALIAS_REGISTRY = Object.freeze({
  aviation: Object.freeze({
    b737: 'boeing_737',
    'boeing 737': 'boeing_737',
    'boeing-737': 'boeing_737',
    thy: 'turkish_airlines',
    'türk hava yolları': 'turkish_airlines',
    'turkish airlines': 'turkish_airlines',
    ai: 'air_india',
    'air india': 'air_india',
    'air-india': 'air_india',
  }),
  tech: Object.freeze({
    ai: 'artificial_intelligence',
    'artificial intelligence': 'artificial_intelligence',
    ml: 'machine_learning',
    'machine learning': 'machine_learning',
    nlp: 'natural_language_processing',
    'natural language processing': 'natural_language_processing',
  }),
  design: Object.freeze({
    ai: 'adobe_illustrator',
    'adobe illustrator': 'adobe_illustrator',
    ps: 'adobe_photoshop',
    'adobe photoshop': 'adobe_photoshop',
    id: 'adobe_indesign',
    'adobe indesign': 'adobe_indesign',
  }),
});

const KNOWN_DOMAINS = Object.freeze(Object.keys(ALIAS_REGISTRY));

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
  return [...KNOWN_DOMAINS];
}

module.exports = {
  resolveEntity,
  listAliases,
  listDomains,
  normalizeAlias,
  ALIAS_REGISTRY,
  KNOWN_DOMAINS,
};