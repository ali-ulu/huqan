//! Turkish predicate parsing for the Rust accelerator.
//!
//! This is the Rust half of the parity contract in #3039: the JavaScript
//! reference is `lib/predicate-parser.js` (with `lib/turkish-copula.js`), and
//! `parse_predicate` here must emit the same relation and stem for the same
//! input. Before this module existed the accelerator parsed predicates by
//! trailing letters alone, so `araba` became `yapabilir` and every negated verb
//! became `özellik`.

pub struct Parsed {
    pub object: String,
    pub relation: String,
}

// The Turkish copula and negation rules below are a port of the JavaScript
// reference in `lib/predicate-parser.js` and `lib/turkish-copula.js`. The Rust
// backend must emit the same relation for the same predicate as the JS backend,
// or a fact learned through one backend answers differently through the other
// (#3039). Each helper names the JS function it mirrors.

/// Port of `lib/turkish-copula.js` `stripCopula`.
///
/// Returns the stem when the ending is a copula this stem could actually take,
/// and `None` otherwise. The vowel-harmony and consonant-assimilation checks
/// are what stop `kültür` from becoming `kül` and `müdür` from becoming `mü`:
/// both words merely end in the letters `tür`/`dür`, but the stem they would
/// leave cannot take that suffix.
pub(crate) fn strip_copula(word: &str) -> Option<String> {
    const VOICELESS: [char; 8] = ['p', 'ç', 't', 'k', 'f', 'h', 's', 'ş'];
    const VOWELS: [char; 8] = ['a', 'e', 'ı', 'i', 'o', 'ö', 'u', 'ü'];
    const MIN_STEM_LENGTH: usize = 3;

    let text: String = word.to_lowercase();
    let chars: Vec<char> = text.chars().collect();
    // COPULA_PATTERN = /(d|t)([ıiuü])r$/
    if chars.len() < 3 {
        return None;
    }
    let third_last = chars[chars.len() - 3];
    if third_last != 'd' && third_last != 't' {
        return None;
    }
    let suffix_vowel = chars[chars.len() - 2];
    if !['ı', 'i', 'u', 'ü'].contains(&suffix_vowel) {
        return None;
    }
    if chars[chars.len() - 1] != 'r' {
        return None;
    }

    let stem: Vec<char> = chars[..chars.len() - 3].to_vec();
    if stem.len() < MIN_STEM_LENGTH {
        return None;
    }
    let final_letter = stem[stem.len() - 1];
    if final_letter != 'c' {
        let requires_t = VOICELESS.contains(&final_letter);
        if requires_t != (third_last == 't') {
            return None;
        }
    }

    let last_vowel = stem.iter().rev().find(|c| VOWELS.contains(c)).copied()?;
    let expected = match last_vowel {
        'a' | 'ı' => 'ı',
        'e' | 'i' => 'i',
        'o' | 'u' => 'u',
        'ö' | 'ü' => 'ü',
        _ => return None,
    };
    // foldForComparison folds ı->i and ü->u on both sides.
    let fold = |c: char| match c {
        'ı' => 'i',
        'ü' => 'u',
        other => other,
    };
    if fold(expected) != fold(suffix_vowel) {
        return None;
    }

    Some(stem.into_iter().collect())
}

/// Port of `parseExplicitRelationPredicate`, suffix forms only.
///
/// The prefix forms (`causes X`, `enables X`) are matched by the JS parser
/// against English markers; the Rust learn path only ever sees a Turkish
/// predicate, so the suffix table is the load-bearing half. Order matters and
/// mirrors the JS `patterns` array: `DEPENDS_ON` must be tested before the
/// generic copula rule, or `bağlıdır` is swallowed into `tür`.
///
/// Port of `lib/predicate-parser.js` `normalizeExplicitRelationObject`, without
/// the final `normalizeWord` call (the Rust learn path normalizes separately).
///
/// Only the last word of the object is stemmed, and only when the suffix looks
/// like a case ending: a `y`-buffered form (`arabayı`) always trims, while an
/// unbuffered one (`kitabı`) trims only on a long enough stem, so short nouns
/// like `kap`/`hat` are left alone.
fn normalize_explicit_relation_object(raw: &str) -> String {
    let words: Vec<&str> = raw.split_whitespace().collect();
    if words.is_empty() {
        return String::new();
    }
    let mut out: Vec<String> = words[..words.len() - 1]
        .iter()
        .map(|s| s.to_string())
        .collect();
    out.push(strip_case_suffix(words[words.len() - 1]));
    out.join(" ").trim().to_string()
}

/// The trailing case-suffix trim used by `normalize_explicit_relation_object`.
fn strip_case_suffix(word: &str) -> String {
    let chars: Vec<char> = word.chars().collect();
    let lower: Vec<char> = word.to_lowercase().chars().collect();
    if chars.len() < 2 {
        return word.to_string();
    }
    // /(y[iıuüae]|[iıae])$/i -- prefer the two-char buffered form when present.
    let n = lower.len();
    let last = lower[n - 1];
    let prev = lower[n - 2];
    let vowels = ['i', 'ı', 'u', 'ü', 'a', 'e'];
    let (suffix_len, buffered) = if prev == 'y' && vowels.contains(&last) {
        (2usize, true)
    } else if vowels.contains(&last) {
        (1usize, false)
    } else {
        return word.to_string();
    };

    let stem: String = chars[..chars.len() - suffix_len].iter().collect();
    let can_trim = buffered || stem.chars().count() >= 5;
    if !can_trim || stem.is_empty() {
        return word.to_string();
    }
    if buffered {
        return stem;
    }
    // Consonant alternation: g->k, d->t, b->p on the final letter.
    let mut stem_chars: Vec<char> = stem.chars().collect();
    if let Some(last_char) = stem_chars.last_mut() {
        *last_char = match last_char.to_ascii_lowercase() {
            'g' => 'k',
            'd' => 't',
            'b' => 'p',
            other => {
                let _ = other;
                return stem;
            }
        };
    }
    stem_chars.into_iter().collect()
}

fn parse_explicit_relation(predicate: &str) -> Option<(&'static str, String)> {
    const CAUSES: [&str; 5] = [
        "neden olur",
        "yol acar",
        "yol açar",
        "sebep olur",
        "tetikler",
    ];
    const PREVENTS: [&str; 6] = [
        "onler",
        "önler",
        "engeller",
        "durdurur",
        "onune gecer",
        "önüne geçer",
    ];
    const DEPENDS_ON: [&str; 10] = [
        "bagli",
        "baglı",
        "bağlı",
        "baglidir",
        "baglıdır",
        "bağlıdır",
        "gerektirir",
        "dayanir",
        "dayanır",
        "olmadan",
    ];
    const ENABLES: [&str; 7] = [
        "saglar",
        "sağlar",
        "mumkun kilar",
        "mümkün kılar",
        "olanak verir",
        "etkinlestirir",
        "etkinleştirir",
    ];

    let p = predicate.to_lowercase();
    for (relation, table) in [
        ("CAUSES", &CAUSES[..]),
        ("PREVENTS", &PREVENTS[..]),
        ("DEPENDS_ON", &DEPENDS_ON[..]),
        ("ENABLES", &ENABLES[..]),
    ] {
        for marker in table {
            // JS marker is /^(.*?)\s+(marker)$/: the marker must be a whole
            // final word, so a bare `bağlıdır` or `neden olur` is NOT an
            // explicit relation (it has no object in front of it). The space
            // before the marker is what distinguishes the two cases.
            if let Some(prefix) = p.strip_suffix(marker) {
                if !prefix.ends_with(char::is_whitespace) {
                    continue;
                }
                let object = normalize_explicit_relation_object(prefix.trim_end());
                if !object.is_empty() {
                    return Some((relation, object));
                }
            }
        }
    }
    None
}

pub fn parse_predicate(predicate: &str) -> Parsed {
    // "bir" gibi belirsiz artikelleri temizle
    let mut p = predicate.trim().to_lowercase();
    if let Some(rest) = p.strip_prefix("bir ") {
        p = rest.trim().to_string();
    }

    // -değil/-değildir → olumsuzluk. Checked before the copula rule, because
    // `farkındalıkdeğildir` ends in `dir` and would otherwise become `tür`.
    if let Some(outer) = p.strip_suffix("değildir") {
        let object = outer.trim();
        if !object.is_empty() {
            return Parsed {
                object: object.to_string(),
                relation: "değil".to_string(),
            };
        }
    }

    // -mez/-maz olumsuz fiil: "hissetmez", "duyguyu hissetmez".
    if let Some(stem) = p.strip_suffix("mez").or_else(|| p.strip_suffix("maz")) {
        if !stem.is_empty() {
            return Parsed {
                object: p.clone(),
                relation: "değil".to_string(),
            };
        }
    }

    // Explicit DEPENDS_ON before the generic copula catch-all (#3039):
    // `bağlıdır` must not be read as `bağlı` + `tür`.
    if let Some((relation, object)) = parse_explicit_relation(&p) {
        if relation == "DEPENDS_ON" {
            return Parsed {
                object,
                relation: relation.to_string(),
            };
        }
    }

    // -dır/-dir/... → tür, but only when the ending is a copula the stem could
    // take. Single-word predicates only, mirroring the JS branch.
    if !p.contains(' ') {
        if let Some(stem) = strip_copula(&p) {
            return Parsed {
                object: stem,
                relation: "tür".to_string(),
            };
        }
    } else {
        // Multi-word: only the final word may carry the copula.
        let words: Vec<&str> = p.split_whitespace().collect();
        if words.len() >= 2 {
            if let Some(stem) = strip_copula(words[words.len() - 1]) {
                let mut parts: Vec<String> = words[..words.len() - 1]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                parts.push(stem);
                return Parsed {
                    object: parts.join(" "),
                    relation: "tür".to_string(),
                };
            }
        }
    }

    if let Some((relation, object)) = parse_explicit_relation(&p) {
        return Parsed {
            object,
            relation: relation.to_string(),
        };
    }

    // Fiil ekleri → yapabilir ilişkisi. `yor/acak/ecek` are part of the JS
    // alternation; leaving them out stored `gelecek`/`bakacak` as `özellik`.
    let verb_suffixes = [
        "ar", "er", "ır", "ir", "ur", "ür", "yor", "acak", "ecek", "mak", "mek",
    ];
    for s in &verb_suffixes {
        if p.ends_with(s) {
            return Parsed {
                object: p,
                relation: "yapabilir".to_string(),
            };
        }
    }

    // -r ile biten kısa fiiller
    if p.ends_with('r') && p.chars().count() > 2 {
        return Parsed {
            object: p,
            relation: "yapabilir".to_string(),
        };
    }

    Parsed {
        object: p,
        relation: "özellik".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every expectation below was read from the JavaScript reference
    // (`lib/predicate-parser.js`) rather than invented. `relation` parity is the
    // contract: a predicate must not answer as one relation through the JS
    // backend and another through the Rust backend (#3039).

    fn relation(predicate: &str) -> String {
        parse_predicate(predicate).relation
    }

    #[test]
    fn bare_nouns_are_ozellik_not_yapabilir() {
        // The issue's exact report: a word ending in `a` is not a verb.
        assert_eq!(relation("araba"), "özellik");
        assert_eq!(relation("kitap"), "özellik");
        assert_eq!(relation("kedi"), "özellik");
        assert_eq!(relation("masa"), "özellik");
        assert_eq!(relation("su"), "özellik");
    }

    #[test]
    fn copula_is_stripped_only_when_the_stem_could_take_it() {
        assert_eq!(relation("sıcaktır"), "tür");
        assert_eq!(parse_predicate("sıcaktır").object, "sıcak");
        assert_eq!(relation("başkenttir"), "tür");
    }

    #[test]
    fn words_that_merely_end_in_copula_letters_are_refused() {
        // `kültür` -> would-be stem `kül`; `müdür` -> `mü`. Neither stem can
        // take the `-tür`/`-dür` suffix, so neither is a copula.
        assert_eq!(relation("kültür"), "yapabilir");
        assert_eq!(relation("müdür"), "yapabilir");
        assert_eq!(relation("tür"), "yapabilir");
    }

    #[test]
    fn negation_verbs_become_degil() {
        assert_eq!(relation("hissetmez"), "değil");
        assert_eq!(relation("anlamaz"), "değil");
        assert_eq!(relation("bilmez"), "değil");
    }

    #[test]
    fn degildir_is_copula_tür_unless_one_word_carries_it_whole() {
        // JS parity, read from `parsePredicate`: a bare `değildir` ends in
        // `dir`, so `stripCopula` strips it to `değil` → `tür`. Only the
        // single-token `...değildir` form (no space) is the negation rule.
        assert_eq!(relation("değildir"), "tür");
        assert_eq!(relation("farkındalıkdeğildir"), "değil");
    }

    #[test]
    fn future_and_progressive_verb_suffixes_are_recognised() {
        assert_eq!(relation("gelecek"), "yapabilir");
        assert_eq!(relation("bakacak"), "yapabilir");
        assert_eq!(relation("yazıyor"), "yapabilir");
    }

    #[test]
    fn a_bare_marker_is_not_an_explicit_relation() {
        // The JS markers require a leading space: the marker must be a whole
        // final word with an object in front. A one-word predicate therefore
        // falls through to the copula or verb rules.
        assert_eq!(relation("bağlıdır"), "tür");
        assert_eq!(relation("gerektirir"), "yapabilir");
        assert_eq!(relation("neden olur"), "yapabilir");
        assert_eq!(relation("engeller"), "yapabilir");
        assert_eq!(relation("sağlar"), "yapabilir");
    }

    #[test]
    fn explicit_relation_markers_are_recognised_when_an_object_precedes() {
        assert_eq!(relation("aşılama hastalığa neden olur"), "CAUSES");
        assert_eq!(relation("ilaç hastalığı engeller"), "PREVENTS");
        assert_eq!(relation("sistem bağlıdır"), "DEPENDS_ON");
        assert_eq!(relation("sistem gerektirir"), "DEPENDS_ON");
        assert_eq!(relation("spor sağlık sağlar"), "ENABLES");
    }

    #[test]
    fn copula_helper_rejects_a_stem_that_is_too_short() {
        assert_eq!(strip_copula("müdür"), None);
        assert_eq!(strip_copula("kültür"), None);
        assert_eq!(strip_copula("sıcaktır"), Some("sıcak".to_string()));
    }
}
