use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{json, Value};

use crate::{Edge, Graph};

// graph.js::CAUSAL_RELATIONS — birebir kopya (5 causal relation).
const CAUSAL_RELATIONS: [&str; 5] = ["CAUSES", "PREVENTS", "ENABLES", "DEPENDS_ON", "LEADS_TO"];

const SEVERITY_ORDER: [(&str, u8); 3] = [("high", 0), ("medium", 1), ("low", 2)];

// lib/hypothesis-review.js#HYPOTHESIS_SOURCE_TYPE birebir kopya.
const HYPOTHESIS_SOURCE_TYPE: &str = "hypothesis-engine";

fn normalize_workspace(value: &str) -> String {
    let v = value.trim();
    if v.is_empty() {
        "default".to_string()
    } else {
        v.to_string()
    }
}

fn get_str(v: &Value, key: &str) -> String {
    match v.get(key) {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

fn bounded_number(v: &Value, key: &str, fallback: f64, min: f64, max: f64) -> f64 {
    let n = v.get(key).and_then(|x| x.as_f64()).unwrap_or(fallback);
    if n.is_finite() && n >= min && n <= max {
        n
    } else {
        fallback
    }
}

fn bounded_int(v: &Value, key: &str, fallback: usize, min: usize) -> usize {
    let n = v.get(key).and_then(|x| x.as_u64()).unwrap_or(fallback as u64) as usize;
    if n >= min {
        n
    } else {
        fallback
    }
}

fn is_causal_relation(relation: &str) -> bool {
    CAUSAL_RELATIONS.contains(&relation)
}

fn severity_rank(severity: &str) -> u8 {
    SEVERITY_ORDER
        .iter()
        .find(|(s, _)| *s == severity)
        .map(|(_, r)| *r)
        .unwrap_or(99)
}

fn edge_confidence(e: &Edge) -> f64 {
    let v = e.confidence.unwrap_or(e.weight);
    v.clamp(0.0, 1.0)
}

fn has_evidence(e: &Edge) -> bool {
    e.evidence.iter().any(|s| !s.trim().is_empty())
}

fn edge_target(e: &Edge) -> String {
    format!("{}-[{}]->{}", e.from, e.relation, e.to)
}

fn canonical_cycle(cycle: &[String]) -> Vec<String> {
    let body = &cycle[..cycle.len() - 1];
    if body.is_empty() {
        return cycle.to_vec();
    }
    let mut rotations: Vec<Vec<String>> = (0..body.len())
        .map(|i| {
            let mut r = body[i..].to_vec();
            r.extend_from_slice(&body[..i]);
            r
        })
        .collect();
    // JS: rotations.sort by join('\u0000') localeCompare — birebir.
    rotations.sort_by_key(|r| r.join("\u{0}"));
    let mut selected = rotations.remove(0);
    selected.push(selected[0].clone());
    selected
}

fn find_causal_cycles(node_ids: &[String], edges: &[&Edge]) -> Vec<Vec<String>> {
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
    for id in node_ids {
        adjacency.insert(id.as_str(), Vec::new());
    }
    for e in edges {
        if !is_causal_relation(&e.relation) {
            continue;
        }
        if adjacency.contains_key(e.from.as_str()) && adjacency.contains_key(e.to.as_str()) {
            adjacency.get_mut(e.from.as_str()).unwrap().push(e.to.as_str());
        }
    }
    for v in adjacency.values_mut() {
        v.sort_unstable();
    }

    fn visit<'a>(
        node: &'a str,
        adjacency: &HashMap<&'a str, Vec<&'a str>>,
        state: &mut HashMap<&'a str, u8>,
        stack: &mut Vec<&'a str>,
        stack_index: &mut HashMap<&'a str, usize>,
        cycles: &mut BTreeMap<String, Vec<String>>,
    ) {
        state.insert(node, 1);
        stack_index.insert(node, stack.len());
        stack.push(node);
        if let Some(nbrs) = adjacency.get(node) {
            for &next in nbrs {
                match state.get(next) {
                    Some(&1) => {
                        let idx = stack_index[next];
                        let mut body: Vec<String> =
                            stack[idx..].iter().map(|s| s.to_string()).collect();
                        body.push(next.to_string());
                        let canon = canonical_cycle(&body);
                        cycles.insert(canon.join("\u{0}"), canon);
                    }
                    None => visit(next, adjacency, state, stack, stack_index, cycles),
                    _ => {}
                }
            }
        }
        stack.pop();
        stack_index.remove(node);
        state.insert(node, 2);
    }

    let mut state: HashMap<&str, u8> = HashMap::new();
    let mut stack: Vec<&str> = Vec::new();
    let mut stack_index: HashMap<&str, usize> = HashMap::new();
    let mut cycles: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for id in node_ids {
        if !state.contains_key(id.as_str()) {
            visit(
                id.as_str(),
                &adjacency,
                &mut state,
                &mut stack,
                &mut stack_index,
                &mut cycles,
            );
        }
    }
    cycles.into_values().collect()
}

fn connected_components(node_ids: &[String], edges: &[&Edge]) -> Vec<Vec<String>> {
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
    for id in node_ids {
        adjacency.insert(id.as_str(), Vec::new());
    }
    for e in edges {
        if adjacency.contains_key(e.from.as_str()) && adjacency.contains_key(e.to.as_str()) {
            adjacency.get_mut(e.from.as_str()).unwrap().push(e.to.as_str());
            adjacency.get_mut(e.to.as_str()).unwrap().push(e.from.as_str());
        }
    }

    let mut visited: HashSet<&str> = HashSet::new();
    let mut components: Vec<Vec<String>> = Vec::new();
    for start in node_ids {
        if visited.contains(start.as_str()) {
            continue;
        }
        let mut component: Vec<String> = Vec::new();
        let mut queue: Vec<&str> = vec![start.as_str()];
        visited.insert(start.as_str());
        while !queue.is_empty() {
            let current = queue.remove(0);
            component.push(current.to_string());
            let mut nbrs: Vec<&str> = adjacency
                .get(current)
                .cloned()
                .unwrap_or_default();
            nbrs.sort_unstable();
            for next in nbrs {
                if !visited.contains(next) {
                    visited.insert(next);
                    queue.push(next);
                }
            }
        }
        component.sort();
        components.push(component);
    }
    components.sort_by(|a, b| a[0].cmp(&b[0]));
    components
}

struct Hyp {
    typ: String,
    severity: String,
    target: String,
    confidence: f64,
    gerekce: String,
}

/// graph-hypotheses.js::generateHypotheses'in Rust portu.
pub fn generate_hypotheses(graph: &Graph, options: &Value) -> Value {
    let workspace = normalize_workspace(&get_str(options, "workspaceId"));
    let confidence_floor = bounded_number(options, "confidenceFloor", 0.4, 0.0, 1.0);
    let critical_in_degree = bounded_int(options, "criticalInDegree", 5, 1);
    let small_component_size = bounded_int(options, "smallComponentSize", 3, 2);

    let nodes = graph.all_nodes(&workspace);
    let edges = graph.all_edges(&workspace);
    let node_ids: Vec<String> = nodes.iter().map(|n| n.id.clone()).collect();
    let node_set: HashSet<&str> = node_ids.iter().map(|s| s.as_str()).collect();

    let mut incoming: HashMap<String, Vec<&Edge>> = HashMap::new();
    let mut outgoing: HashMap<String, Vec<&Edge>> = HashMap::new();
    for e in &edges {
        if !node_set.contains(e.from.as_str()) || !node_set.contains(e.to.as_str()) {
            continue;
        }
        outgoing.entry(e.from.clone()).or_default().push(e);
        incoming.entry(e.to.clone()).or_default().push(e);
    }

    let mut hypotheses: Vec<Hyp> = Vec::new();

    for n in &nodes {
        let in_edges = incoming.get(&n.id).cloned().unwrap_or_default();
        let out_edges = outgoing.get(&n.id).cloned().unwrap_or_default();
        if !in_edges.is_empty() && !in_edges.iter().any(|e| has_evidence(e)) {
            hypotheses.push(Hyp {
                typ: "KANIT_EKSİK".to_string(),
                severity: "medium".to_string(),
                target: n.id.clone(),
                confidence: 0.5,
                gerekce: format!(
                    "{} düğümüne gelen {} kenarın hiçbirinde kanıt yok.",
                    n.id,
                    in_edges.len()
                ),
            });
        }
        if in_edges.len() >= critical_in_degree {
            hypotheses.push(Hyp {
                typ: "KRİTİK_DÜĞÜM".to_string(),
                severity: "high".to_string(),
                target: n.id.clone(),
                confidence: 0.9,
                gerekce: format!(
                    "{} düğümünün in-degree değeri {}; eşik {}.",
                    n.id,
                    in_edges.len(),
                    critical_in_degree
                ),
            });
        }
        if in_edges.is_empty() && out_edges.is_empty() {
            hypotheses.push(Hyp {
                typ: "YALITILMIŞ_DÜĞÜM".to_string(),
                severity: "low".to_string(),
                target: n.id.clone(),
                confidence: 0.2,
                gerekce: format!("{} düğümünün bağlı olduğu hiçbir kenar yok.", n.id),
            });
        }
    }

    for e in &edges {
        let confidence = edge_confidence(e);
        if confidence < confidence_floor {
            hypotheses.push(Hyp {
                typ: "ZAYIF_BAĞ".to_string(),
                severity: "medium".to_string(),
                target: edge_target(e),
                confidence,
                gerekce: format!(
                    "{} confidence={:.2}; eşik {:.2}.",
                    edge_target(e),
                    confidence,
                    confidence_floor
                ),
            });
        }
    }

    for cycle in find_causal_cycles(&node_ids, &edges) {
        let target = cycle.join(" -> ");
        hypotheses.push(Hyp {
            typ: "NEDENSEL_DÖNGÜ".to_string(),
            severity: "high".to_string(),
            target: target.clone(),
            confidence: 0.9,
            gerekce: format!("Nedensel ilişkilerde çevrim bulundu: {}.", target),
        });
    }

    let components = connected_components(&node_ids, &edges);
    let largest = components.iter().map(|c| c.len()).max().unwrap_or(0);
    for component in &components {
        if component.len() > 1
            && component.len() < largest
            && component.len() <= small_component_size
        {
            let target = component.join(" + ");
            hypotheses.push(Hyp {
                typ: "KÜÇÜK_BİLEŞEN".to_string(),
                severity: "low".to_string(),
                target: target.clone(),
                confidence: 0.2,
                gerekce: format!(
                    "Ana graf gövdesinden kopuk {} düğümlü küçük bileşen: {}.",
                    component.len(),
                    target
                ),
            });
        }
    }

    hypotheses.sort_by(|a, b| {
        let sev = severity_rank(&a.severity).cmp(&severity_rank(&b.severity));
        if sev != Ordering::Equal {
            return sev;
        }
        let ty = a.typ.cmp(&b.typ);
        if ty != Ordering::Equal {
            return ty;
        }
        a.target.cmp(&b.target)
    });

    let mut rule_counts: BTreeMap<String, usize> = BTreeMap::new();
    for h in &hypotheses {
        *rule_counts.entry(h.typ.clone()).or_insert(0) += 1;
    }

    let hyps: Vec<Value> = hypotheses
        .iter()
        .map(|h| {
            json!({
                "type": h.typ,
                "severity": h.severity,
                "target": h.target,
                "confidence": h.confidence,
                "gerekce": h.gerekce,
            })
        })
        .collect();

    json!({
        "ok": true,
        "meta": {
            "workspaceId": workspace,
            "nodeCount": nodes.len(),
            "edgeCount": edges.len(),
            "confidenceFloor": confidence_floor,
            "criticalInDegree": critical_in_degree,
            "smallComponentSize": small_component_size,
            "ruleCounts": rule_counts,
        },
        "hypotheses": hyps,
    })
}

// hypothesis-fitness.js::buildFitnessReport'un Rust portu.
// hypothesisAccuracy, candidate deposundan (add_candidate) hesaplanir;
// reviewed>0 degilse null kalir (JS'te de bos grafta acceptanceRate null).

const COMPONENT_WEIGHTS: [(&str, f64); 4] = [
    ("evidenceCoverage", 0.3),
    ("hypothesisAccuracy", 0.3),
    ("connectivity", 0.2),
    ("consistency", 0.2),
];

const COMPONENT_ORDER: [&str; 4] = [
    "evidenceCoverage",
    "hypothesisAccuracy",
    "connectivity",
    "consistency",
];

const GRADE_BANDS: [(f64, &str); 4] = [(0.9, "A"), (0.8, "B"), (0.7, "C"), (0.6, "D")];

fn round(v: f64) -> f64 {
    (v * 10000.0).round() / 10000.0
}

fn grade_for(score: Option<f64>) -> Option<String> {
    let s = score?;
    for (floor, grade) in GRADE_BANDS {
        if s >= floor {
            return Some(grade.to_string());
        }
    }
    Some("F".to_string())
}

fn weight_of(name: &str) -> f64 {
    COMPONENT_WEIGHTS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, w)| *w)
        .unwrap_or(0.0)
}

pub fn build_fitness_report(graph: &Graph, options: &Value) -> Value {
    let workspace = normalize_workspace(&get_str(options, "workspaceId"));
    let report = generate_hypotheses(graph, options);
    let edges = graph.all_edges(&workspace);

    // candidate-feedback: acceptanceRate over reviewed hypothesis candidates
    // (lib/hypothesis-feedback.js#summarize). pending candidates carry no
    // verdict, so they never enter the denominator.
    let mut accepted = 0usize;
    let mut reviewed = 0usize;
    for c in &graph.all_candidates(&workspace) {
        if c.source_type != HYPOTHESIS_SOURCE_TYPE {
            continue;
        }
        match c.status.as_str() {
            "accepted" => {
                accepted += 1;
                reviewed += 1;
            }
            "rejected" => {
                reviewed += 1;
            }
            _ => {}
        }
    }
    let hypothesis_accuracy: Option<f64> =
        if reviewed > 0 { Some(accepted as f64 / reviewed as f64) } else { None };

    let node_count = report["meta"]["nodeCount"].as_u64().unwrap_or(0) as usize;
    let edge_count = edges.len();
    let evidenced = edges.iter().filter(|e| has_evidence(e)).count();
    let rule_counts = &report["meta"]["ruleCounts"];
    let isolated = rule_counts
        .get("YALITILMIŞ_DÜĞÜM")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    let cycles = rule_counts
        .get("NEDENSEL_DÖNGÜ")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;

    let values: Vec<(&str, Option<f64>)> = vec![
        (
            "evidenceCoverage",
            if edge_count > 0 {
                Some(evidenced as f64 / edge_count as f64)
            } else {
                None
            },
        ),
        ("hypothesisAccuracy", hypothesis_accuracy),
        (
            "connectivity",
            if node_count > 0 {
                Some((node_count - isolated) as f64 / node_count as f64)
            } else {
                None
            },
        ),
        (
            "consistency",
            if node_count > 0 {
                Some(1.0 / (1.0 + cycles as f64))
            } else {
                None
            },
        ),
    ];

    let mut components: Vec<Value> = Vec::new();
    let mut weighted_sum = 0.0;
    let mut weight_used = 0.0;
    for name in COMPONENT_ORDER {
        let val = values.iter().find(|(n, _)| *n == name).unwrap().1;
        let weight = weight_of(name);
        let detail = match name {
            "evidenceCoverage" => json!({ "evidencedEdges": evidenced, "edgeCount": edge_count }),
            "hypothesisAccuracy" => json!({ "accepted": accepted, "reviewed": reviewed }),
            "connectivity" => json!({ "isolatedNodes": isolated, "nodeCount": node_count }),
            "consistency" => json!({ "cycles": cycles }),
            _ => json!({}),
        };
        components.push(json!({
            "name": name,
            "value": val.map(round),
            "weight": weight,
            "detail": detail,
        }));
        if let Some(v) = val {
            weighted_sum += v * weight;
            weight_used += weight;
        }
    }
    let score = if weight_used > 0.0 {
        Some(round(weighted_sum / weight_used))
    } else {
        None
    };
    let scored = components.iter().filter(|c| c["value"].is_f64()).count();

    json!({
        "ok": true,
        "meta": {
            "workspaceId": workspace,
            "nodeCount": node_count,
            "edgeCount": edge_count,
            "weightUsed": round(weight_used),
            "scoredComponents": scored,
        },
        "components": components,
        "score": score,
        "grade": grade_for(score),
    })
}
