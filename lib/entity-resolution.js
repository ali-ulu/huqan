// Mutable (not Object.freeze) at the domain-map level so registerAlias() can
// add new domains/aliases at runtime (#442). The per-domain alias maps
// themselves are plain objects too, for the same reason.
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
  return ALIAS_REGISTRY[normalized] || null;
}

/**
 * Register an alias -> canonical mapping at runtime, creating the domain if
 * it doesn't exist yet. Both `alias` and `domain` are normalized the same
 * way a lookup would normalize them, so a caller can't accidentally register
 * an entry that a subsequent resolveEntity() call can't find.
 * @returns {boolean} true if this added or changed an entry, false if the
 *   normalized alias already mapped to this exact canonical in this domain.
 */
function registerAlias(domain, alias, canonical) {
  const normalizedDomain = String(domain || '').trim().toLowerCase();
  const normalizedAlias = normalizeAlias(alias);
  const normalizedCanonical = String(canonical || '').trim();
  if (!normalizedDomain || !normalizedAlias || !normalizedCanonical) return false;

  if (!ALIAS_REGISTRY[normalizedDomain]) {
    ALIAS_REGISTRY[normalizedDomain] = {};
  }
  const registry = ALIAS_REGISTRY[normalizedDomain];
  if (registry[normalizedAlias] === normalizedCanonical) return false;

  registry[normalizedAlias] = normalizedCanonical;
  return true;
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

module.exports = {
  resolveEntity,
  registerAlias,
  listAliases,
  listDomains,
  normalizeAlias,
  ALIAS_REGISTRY,
  get KNOWN_DOMAINS() {
    return listDomains();
  },
};
