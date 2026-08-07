#![allow(dead_code)]
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

#[derive(Clone, Serialize, Deserialize)]
struct Node {
    id: String,
    label: String,
    weight: f64,
    created: u64,
    last_accessed: u64,
    #[serde(default)]
    vector: HashMap<String, f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provenance: Option<Value>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    workspace_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Edge {
    from: String,
    to: String,
    relation: String,
    weight: f64,
    created: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    evidence: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    source_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provenance: Option<Value>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    workspace_id: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Snapshot {
    #[serde(default)]
    nodes: Vec<Node>,
    #[serde(default)]
    edges: Vec<Edge>,
}

struct Graph {
    nodes: HashMap<String, Node>,
    edges: Vec<Edge>,
    out_index: HashMap<String, Vec<usize>>,
    in_index: HashMap<String, Vec<usize>>,
    decay_lambda: f64,
    prune_threshold: f64,
}

impl Graph {
    fn new() -> Self {
        Graph {
            nodes: HashMap::new(),
            edges: Vec::new(),
            out_index: HashMap::new(),
            in_index: HashMap::new(),
            decay_lambda: 0.05,
            prune_threshold: 0.01,
        }
    }

    fn add_node(&mut self, id: &str, label: &str, opts: &Value) {
        let now = now_ms();
        let provenance = opts.get("provenance").cloned();
        let workspace_id = get_str(opts, "workspaceId");
        if let Some(n) = self.nodes.get_mut(id) {
            n.label = label.to_string();
            n.weight = (n.weight + 0.1).min(1.0);
            n.last_accessed = now;
            if provenance.is_some() {
                n.provenance = provenance;
            }
            if !workspace_id.is_empty() {
                n.workspace_id = workspace_id;
            }
        } else {
            self.nodes.insert(
                id.to_string(),
                Node {
                    id: id.to_string(),
                    label: label.to_string(),
                    weight: 0.5,
                    created: now,
                    last_accessed: now,
                    vector: HashMap::new(),
                    provenance,
                    workspace_id,
                },
            );
        }
    }

    fn remove_node(&mut self, id: &str) -> bool {
        if self.nodes.remove(id).is_none() {
            return false;
        }
        let before = self.edges.len();
        self.edges.retain(|e| e.from != id && e.to != id);
        if self.edges.len() != before {
            self.rebuild_index();
        }
        true
    }

    fn add_edge(&mut self, from: &str, to: &str, relation: &str, opts: &Value) -> bool {
        if !self.nodes.contains_key(from) || !self.nodes.contains_key(to) {
            return false;
        }
        let explicit_weight = get_f64_opt(opts, "weight");
        let explicit_confidence = get_f64_opt(opts, "confidence");
        let provenance = opts.get("provenance").cloned();
        let workspace_id = get_str(opts, "workspaceId");
        let source_ref = get_str(opts, "sourceRef");
        let new_evidence = get_str_vec(opts, "evidence");

        if let Some(e) = self
            .edges
            .iter_mut()
            .find(|e| e.from == from && e.to == to && e.relation == relation)
        {
            e.weight = explicit_weight.unwrap_or_else(|| (e.weight + 0.1).min(1.0)).clamp(0.0, 1.0);
            if explicit_confidence.is_some() {
                e.confidence = explicit_confidence;
            }
            if provenance.is_some() {
                e.provenance = provenance;
            }
            if !workspace_id.is_empty() {
                e.workspace_id = workspace_id;
            }
            if !source_ref.is_empty() {
                e.source_ref = source_ref;
            }
            for item in new_evidence {
                if !e.evidence.contains(&item) {
                    e.evidence.push(item);
                }
            }
            return true;
        }
        let idx = self.edges.len();
        let weight = explicit_weight.unwrap_or(0.5).clamp(0.0, 1.0);
        self.edges.push(Edge {
            from: from.to_string(),
            to: to.to_string(),
            relation: relation.to_string(),
            weight,
            created: now_ms(),
            confidence: explicit_confidence,
            evidence: new_evidence,
            source_ref,
            provenance,
            workspace_id,
        });
        self.index_edge(idx);
        true
    }

    fn get_edges(&self, node: &str) -> Vec<&Edge> {
        let mut res = Vec::new();
        if let Some(indices) = self.out_index.get(node) {
            for &idx in indices {
                res.push(&self.edges[idx]);
            }
        }
        res
    }

    fn get_in_edges(&self, node: &str) -> Vec<&Edge> {
        let mut res = Vec::new();
        if let Some(indices) = self.in_index.get(node) {
            for &idx in indices {
                res.push(&self.edges[idx]);
            }
        }
        res
    }

    fn cosine_similarity(&self, a: &str, b: &str) -> f64 {
        let an = match self.nodes.get(a) {
            Some(n) => n,
            None => return 0.0,
        };
        let bn = match self.nodes.get(b) {
            Some(n) => n,
            None => return 0.0,
        };
        let dims: std::collections::HashSet<&String> =
            an.vector.keys().chain(bn.vector.keys()).collect();
        let (mut dot, mut ma, mut mb) = (0.0, 0.0, 0.0);
        for d in dims {
            let va = an.vector.get(d).copied().unwrap_or(0.0);
            let vb = bn.vector.get(d).copied().unwrap_or(0.0);
            dot += va * vb;
            ma += va * va;
            mb += vb * vb;
        }
        let mag = ma.sqrt() * mb.sqrt();
        if mag == 0.0 {
            0.0
        } else {
            dot / mag
        }
    }

    fn prune(&mut self, threshold: f64) -> usize {
        let before = self.edges.len();
        self.edges.retain(|e| e.weight >= threshold);
        let p = before - self.edges.len();
        if p > 0 {
            self.rebuild_index();
        }
        p
    }

    fn optimize(&mut self) -> (usize, usize) {
        let pruned = self.prune(self.prune_threshold);
        let now = now_ms();
        let ids: Vec<String> = self.nodes.keys().cloned().collect();
        let mut removed = 0;
        for id in &ids {
            if let Some(n) = self.nodes.get(id) {
                let elapsed = (now - n.last_accessed) as f64 / 1000.0;
                let decayed = n.weight * (-self.decay_lambda * elapsed).exp();
                if decayed < 0.01 && self.get_edges(id).is_empty() && self.get_in_edges(id).is_empty() {
                    self.nodes.remove(id);
                    removed += 1;
                }
            }
        }
        (pruned, removed)
    }

    fn index_edge(&mut self, idx: usize) {
        let from = self.edges[idx].from.clone();
        let to = self.edges[idx].to.clone();
        self.out_index.entry(from).or_insert_with(Vec::new).push(idx);
        self.in_index.entry(to).or_insert_with(Vec::new).push(idx);
    }

    fn rebuild_index(&mut self) {
        self.out_index.clear();
        self.in_index.clear();
        for i in 0..self.edges.len() {
            self.index_edge(i);
        }
    }

    fn to_snapshot(&self) -> Snapshot {
        Snapshot {
            nodes: self.nodes.values().cloned().collect(),
            edges: self.edges.clone(),
        }
    }

    fn load_snapshot(&mut self, snapshot: Snapshot) {
        self.nodes.clear();
        self.edges.clear();
        self.out_index.clear();
        self.in_index.clear();
        for n in snapshot.nodes {
            self.nodes.insert(n.id.clone(), n);
        }
        self.edges = snapshot.edges;
        self.rebuild_index();
    }

    fn save(&self, path: &str) -> io::Result<()> {
        let snapshot = self.to_snapshot();
        let data = serde_json::to_vec(&snapshot).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
        std::fs::write(path, data)
    }

    fn load(&mut self, path: &str) -> io::Result<()> {
        let data = std::fs::read(path)?;
        let snapshot: Snapshot =
            serde_json::from_slice(&data).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
        self.load_snapshot(snapshot);
        Ok(())
    }
}

fn edge_to_json(e: &Edge) -> Value {
    json!({
        "from": e.from,
        "to": e.to,
        "relation": e.relation,
        "weight": e.weight,
        "confidence": e.confidence.unwrap_or(e.weight),
        "evidence": e.evidence,
        "sourceRef": e.source_ref,
        "provenance": e.provenance,
        "workspaceId": e.workspace_id,
    })
}

struct Parsed {
    object: String,
    relation: String,
}

fn parse_predicate(predicate: &str) -> Parsed {
    let p = predicate.to_lowercase();
    let tir_suffixes = ["dır", "dir", "dur", "dür", "tır", "tir", "tur", "tür"];
    for s in &tir_suffixes {
        if p.ends_with(s) && p.len() > s.len() {
            let stem = &p[..p.len() - s.len()];
            return Parsed {
                object: stem.to_string(),
                relation: "tür".to_string(),
            };
        }
    }
    let verb_suffixes = ["ar", "er", "ır", "ir", "ur", "ür", "mek", "mak"];
    for s in &verb_suffixes {
        if p.ends_with(s) {
            return Parsed {
                object: p.clone(),
                relation: "yapabilir".to_string(),
            };
        }
    }
    if p.ends_with('r') && p.len() > 2 {
        return Parsed {
            object: p.clone(),
            relation: "yapabilir".to_string(),
        };
    }
    Parsed {
        object: p,
        relation: "özellik".to_string(),
    }
}

fn get_str(cmd: &Value, key: &str) -> String {
    match cmd.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
        None => String::new(),
    }
}

fn get_f64(cmd: &Value, key: &str, default: f64) -> f64 {
    match cmd.get(key) {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(default),
        Some(Value::String(s)) => s.parse().unwrap_or(default),
        _ => default,
    }
}

fn get_f64_opt(cmd: &Value, key: &str) -> Option<f64> {
    match cmd.get(key) {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.parse().ok(),
        _ => None,
    }
}

fn get_str_vec(cmd: &Value, key: &str) -> Vec<String> {
    match cmd.get(key) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

const DEFAULT_MEMORY_PATH: &str = "memory.json";

fn run_command(graph: &mut Graph, cmd: &Value) -> Value {
    match cmd.get("cmd").and_then(|v| v.as_str()).unwrap_or("") {
        "add_node" => {
            let id = get_str(cmd, "id");
            let label = get_str(cmd, "label");
            graph.add_node(&id, &label, cmd);
            json!({ "ok": true })
        }
        "get_node" => {
            let id = get_str(cmd, "id");
            let now = now_ms();
            if let Some(n) = graph.nodes.get_mut(&id) {
                n.last_accessed = now;
                json!({
                    "ok": true,
                    "node": {
                        "id": n.id,
                        "label": n.label,
                        "weight": n.weight,
                        "vector": { "tags": [], "dimensions": n.vector.len() },
                        "provenance": n.provenance,
                        "workspaceId": n.workspace_id,
                    }
                })
            } else {
                json!({ "ok": false, "error": "not_found" })
            }
        }
        "remove_node" => {
            let id = get_str(cmd, "id");
            json!({ "ok": graph.remove_node(&id) })
        }
        "add_edge" => {
            let from = get_str(cmd, "from");
            let to = get_str(cmd, "to");
            let relation = get_str(cmd, "relation");
            json!({ "ok": graph.add_edge(&from, &to, &relation, cmd) })
        }
        "get_edges" => {
            let id = get_str(cmd, "id");
            let edges: Vec<Value> = graph.get_edges(&id).iter().map(|e| edge_to_json(e)).collect();
            json!({ "ok": true, "edges": edges })
        }
        "get_in_edges" => {
            let id = get_str(cmd, "id");
            let edges: Vec<Value> = graph.get_in_edges(&id).iter().map(|e| edge_to_json(e)).collect();
            json!({ "ok": true, "edges": edges })
        }
        "get_weight" => {
            let id = get_str(cmd, "id");
            match graph.nodes.get(&id) {
                Some(n) => {
                    let elapsed = (now_ms() - n.last_accessed) as f64 / 1000.0;
                    let decayed = n.weight * (-graph.decay_lambda * elapsed).exp();
                    json!({ "ok": true, "weight": decayed })
                }
                None => json!({ "ok": false }),
            }
        }
        "cosine_similarity" => {
            let a = get_str(cmd, "a");
            let b = get_str(cmd, "b");
            if !graph.nodes.contains_key(&a) || !graph.nodes.contains_key(&b) {
                return json!({ "ok": false });
            }
            json!({ "ok": true, "similarity": graph.cosine_similarity(&a, &b) })
        }
        "prune" => {
            let threshold = get_f64(cmd, "threshold", graph.prune_threshold);
            let pruned = graph.prune(threshold);
            json!({ "ok": true, "pruned": pruned })
        }
        "optimize" => {
            let (pruned, removed) = graph.optimize();
            json!({ "ok": true, "pruned": pruned, "removed_nodes": removed })
        }
        "learn" => {
            let text = get_str(cmd, "text");
            let parts: Vec<&str> = text.trim().split_whitespace().collect();
            if parts.len() >= 2 {
                let subject = parts[0].to_string();
                let predicate = parts[1..].join(" ");
                graph.add_node(&subject, &subject, cmd);
                let parsed = parse_predicate(&predicate);
                graph.add_node(&parsed.object, &parsed.object, cmd);
                graph.add_edge(&subject, &parsed.object, &parsed.relation, cmd);
                if let Some(n) = graph.nodes.get_mut(&subject) {
                    *n.vector.entry(parsed.object.clone()).or_insert(0.0) += 0.3;
                }
            }
            json!({ "ok": true })
        }
        "ask" => {
            let question = get_str(cmd, "question");
            let parts: Vec<&str> = question.trim().split_whitespace().collect();
            let subject = if parts.is_empty() { String::new() } else { parts[0].to_string() };
            let mut edge_list = graph.get_edges(&subject);
            if !graph.nodes.contains_key(&subject) || edge_list.is_empty() {
                return json!({ "ok": true, "answer": "Bilmiyorum" });
            }
            edge_list.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal));
            let mut results: Vec<String> = Vec::new();
            for e in &edge_list {
                if !results.contains(&e.to) {
                    results.push(e.to.clone());
                }
            }
            if results.is_empty() {
                json!({ "ok": true, "answer": "Bilmiyorum" })
            } else {
                json!({ "ok": true, "answer": format!("{} {}", subject, results.join(", ")) })
            }
        }
        "stats" => {
            json!({
                "ok": true,
                "stats": {
                    "nodes": graph.nodes.len(),
                    "edges": graph.edges.len(),
                    "decay_lambda": graph.decay_lambda,
                }
            })
        }
        "save" => {
            let path = cmd.get("path").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| DEFAULT_MEMORY_PATH.to_string());
            match graph.save(&path) {
                Ok(()) => json!({ "ok": true, "path": path }),
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            }
        }
        "load" => {
            let path = cmd.get("path").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| DEFAULT_MEMORY_PATH.to_string());
            match graph.load(&path) {
                Ok(()) => json!({ "ok": true, "path": path }),
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            }
        }
        "batch" => {
            let commands = cmd.get("commands").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let results: Vec<Value> = commands.iter().map(|c| run_command(graph, c)).collect();
            json!({ "ok": true, "results": results })
        }
        _ => json!({ "ok": false, "error": "unknown_command" }),
    }
}

fn main() {
    let mut graph = Graph::new();

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let cmd: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                let _ = writeln!(out, "{}", json!({ "ok": false, "error": "parse_error" }));
                continue;
            }
        };

        let mut result = run_command(&mut graph, &cmd);
        if let Some(req_id) = cmd.get("_reqId") {
            if let Value::Object(ref mut map) = result {
                let mut new_map = Map::new();
                new_map.insert("_reqId".to_string(), req_id.clone());
                new_map.extend(map.clone());
                result = Value::Object(new_map);
            }
        }

        let _ = writeln!(out, "{}", result);
    }
}
