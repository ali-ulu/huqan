#![allow(dead_code)]
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::time::{SystemTime, UNIX_EPOCH};

mod hypotheses;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

const DEFAULT_WORKSPACE: &str = "default";

/// Absent/blank workspace means `default`, never "all workspaces" (#759).
fn normalize_workspace(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        DEFAULT_WORKSPACE.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Authoritative storage/lookup key for a node.
///
/// Mirrors `lib/graph-record-utils.js#nodeStorageKey` exactly, so the two
/// backends agree on identity and a snapshot written before workspaces existed
/// still loads: the default workspace keeps the bare id, every other workspace
/// is prefixed.
fn storage_key(id: &str, workspace: &str) -> String {
    let ws = normalize_workspace(workspace);
    if ws == DEFAULT_WORKSPACE {
        id.to_string()
    } else {
        format!("{}::{}", ws, id)
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
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
pub struct Edge {
    pub from: String,
    pub to: String,
    pub relation: String,
    pub weight: f64,
    created: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<String>,
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

pub struct Graph {
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
        let workspace_id = normalize_workspace(&get_str(opts, "workspaceId"));
        let key = storage_key(id, &workspace_id);
        if let Some(n) = self.nodes.get_mut(&key) {
            n.label = label.to_string();
            n.weight = (n.weight + 0.1).min(1.0);
            n.last_accessed = now;
            if provenance.is_some() {
                n.provenance = provenance;
            }
            n.workspace_id = workspace_id;
        } else {
            self.nodes.insert(
                key,
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

    fn remove_node(&mut self, id: &str, workspace: &str) -> bool {
        let ws = normalize_workspace(workspace);
        if self.nodes.remove(&storage_key(id, &ws)).is_none() {
            return false;
        }
        let before = self.edges.len();
        // Only this workspace's edges follow the node out; an identically named
        // node in another workspace keeps its own relationships.
        self.edges.retain(|e| {
            normalize_workspace(&e.workspace_id) != ws || (e.from != id && e.to != id)
        });
        if self.edges.len() != before {
            self.rebuild_index();
        }
        true
    }

    fn add_edge(&mut self, from: &str, to: &str, relation: &str, opts: &Value) -> bool {
        let workspace_id = normalize_workspace(&get_str(opts, "workspaceId"));
        if !self.nodes.contains_key(&storage_key(from, &workspace_id))
            || !self.nodes.contains_key(&storage_key(to, &workspace_id))
        {
            return false;
        }
        let explicit_weight = get_f64_opt(opts, "weight");
        let explicit_confidence = get_f64_opt(opts, "confidence");
        let provenance = opts.get("provenance").cloned();
        let source_ref = get_str(opts, "sourceRef");
        let new_evidence = get_str_vec(opts, "evidence");

        // Workspace is part of edge identity: the same (from,to,relation) in two
        // workspaces is two edges, not one shared edge (#759).
        if let Some(e) = self.edges.iter_mut().find(|e| {
            e.from == from
                && e.to == to
                && e.relation == relation
                && normalize_workspace(&e.workspace_id) == workspace_id
        }) {
            e.weight = explicit_weight.unwrap_or_else(|| (e.weight + 0.1).min(1.0)).clamp(0.0, 1.0);
            if explicit_confidence.is_some() {
                e.confidence = explicit_confidence;
            }
            if provenance.is_some() {
                e.provenance = provenance;
            }
            e.workspace_id = workspace_id;
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

    fn get_edges(&self, node: &str, workspace: &str) -> Vec<&Edge> {
        let mut res = Vec::new();
        if let Some(indices) = self.out_index.get(&storage_key(node, workspace)) {
            for &idx in indices {
                res.push(&self.edges[idx]);
            }
        }
        res
    }

    fn get_in_edges(&self, node: &str, workspace: &str) -> Vec<&Edge> {
        let mut res = Vec::new();
        if let Some(indices) = self.in_index.get(&storage_key(node, workspace)) {
            for &idx in indices {
                res.push(&self.edges[idx]);
            }
        }
        res
    }

    fn cosine_similarity(&self, a: &str, b: &str, workspace: &str) -> f64 {
        let an = match self.nodes.get(&storage_key(a, workspace)) {
            Some(n) => n,
            None => return 0.0,
        };
        let bn = match self.nodes.get(&storage_key(b, workspace)) {
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
        // (storage key, node id, workspace): the key deletes, the pair reads.
        let entries: Vec<(String, String, String)> = self
            .nodes
            .iter()
            .map(|(key, n)| (key.clone(), n.id.clone(), normalize_workspace(&n.workspace_id)))
            .collect();
        let mut removed = 0;
        for (key, id, ws) in &entries {
            if let Some(n) = self.nodes.get(key) {
                let elapsed = (now - n.last_accessed) as f64 / 1000.0;
                let decayed = n.weight * (-self.decay_lambda * elapsed).exp();
                if decayed < 0.01
                    && self.get_edges(id, ws).is_empty()
                    && self.get_in_edges(id, ws).is_empty()
                {
                    self.nodes.remove(key);
                    removed += 1;
                }
            }
        }
        (pruned, removed)
    }

    fn index_edge(&mut self, idx: usize) {
        let ws = normalize_workspace(&self.edges[idx].workspace_id);
        let from = storage_key(&self.edges[idx].from, &ws);
        let to = storage_key(&self.edges[idx].to, &ws);
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

    fn all_nodes(&self, workspace: &str) -> Vec<&Node> {
        let ws = normalize_workspace(workspace);
        let mut out: Vec<&Node> = self
            .nodes
            .values()
            .filter(|n| normalize_workspace(&n.workspace_id) == ws)
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    fn all_edges(&self, workspace: &str) -> Vec<&Edge> {
        let ws = normalize_workspace(workspace);
        let mut out: Vec<&Edge> = self
            .edges
            .iter()
            .filter(|e| normalize_workspace(&e.workspace_id) == ws)
            .collect();
        out.sort_by(|a, b| {
            let ka = format!("{}\u{0}{}\u{0}{}", a.from, a.to, a.relation);
            let kb = format!("{}\u{0}{}\u{0}{}", b.from, b.to, b.relation);
            ka.cmp(&kb)
        });
        out
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
            // A snapshot written before workspaces existed carries an empty
            // workspace_id, which normalizes to `default` and so keys by the
            // bare id exactly as it did before (#759).
            let key = storage_key(&n.id, &n.workspace_id);
            self.nodes.insert(key, n);
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

fn node_to_json(n: &Node) -> Value {
    json!({
        "id": n.id,
        "label": n.label,
        "weight": n.weight,
        "vector": { "tags": [], "dimensions": n.vector.len() },
        "provenance": n.provenance,
        "workspaceId": n.workspace_id,
    })
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
            let workspace = normalize_workspace(&get_str(cmd, "workspaceId"));
            let now = now_ms();
            if let Some(n) = graph.nodes.get_mut(&storage_key(&id, &workspace)) {
                n.last_accessed = now;
                json!({ "ok": true, "node": node_to_json(n) })
            } else {
                json!({ "ok": false, "error": "not_found" })
            }
        }
        "remove_node" => {
            let id = get_str(cmd, "id");
            let workspace = get_str(cmd, "workspaceId");
            json!({ "ok": graph.remove_node(&id, &workspace) })
        }
        "add_edge" => {
            let from = get_str(cmd, "from");
            let to = get_str(cmd, "to");
            let relation = get_str(cmd, "relation");
            json!({ "ok": graph.add_edge(&from, &to, &relation, cmd) })
        }
        "get_edges" => {
            let id = get_str(cmd, "id");
            let workspace = get_str(cmd, "workspaceId");
            let edges: Vec<Value> = graph
                .get_edges(&id, &workspace)
                .iter()
                .map(|e| edge_to_json(e))
                .collect();
            json!({ "ok": true, "edges": edges })
        }
        "get_in_edges" => {
            let id = get_str(cmd, "id");
            let workspace = get_str(cmd, "workspaceId");
            let edges: Vec<Value> = graph
                .get_in_edges(&id, &workspace)
                .iter()
                .map(|e| edge_to_json(e))
                .collect();
            json!({ "ok": true, "edges": edges })
        }
        "get_weight" => {
            let id = get_str(cmd, "id");
            let workspace = normalize_workspace(&get_str(cmd, "workspaceId"));
            match graph.nodes.get(&storage_key(&id, &workspace)) {
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
            let workspace = normalize_workspace(&get_str(cmd, "workspaceId"));
            if !graph.nodes.contains_key(&storage_key(&a, &workspace))
                || !graph.nodes.contains_key(&storage_key(&b, &workspace))
            {
                return json!({ "ok": false });
            }
            json!({ "ok": true, "similarity": graph.cosine_similarity(&a, &b, &workspace) })
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
                let workspace = normalize_workspace(&get_str(cmd, "workspaceId"));
                if let Some(n) = graph.nodes.get_mut(&storage_key(&subject, &workspace)) {
                    *n.vector.entry(parsed.object.clone()).or_insert(0.0) += 0.3;
                }
            }
            json!({ "ok": true })
        }
        "ask" => {
            let question = get_str(cmd, "question");
            let parts: Vec<&str> = question.trim().split_whitespace().collect();
            let subject = if parts.is_empty() { String::new() } else { parts[0].to_string() };
            let workspace = normalize_workspace(&get_str(cmd, "workspaceId"));
            let mut edge_list = graph.get_edges(&subject, &workspace);
            if !graph.nodes.contains_key(&storage_key(&subject, &workspace)) || edge_list.is_empty() {
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
        // #1142: the JS backend's Graph.query() is a real label lookup, so the
        // Rust backend needs one too -- otherwise the same call returns rows
        // without the accelerator and nothing with it.
        "query" => {
            let label = get_str(cmd, "label");
            let workspace = normalize_workspace(&get_str(cmd, "workspaceId"));
            let mut matches: Vec<&Node> = graph
                .nodes
                .values()
                .filter(|n| n.label == label && normalize_workspace(&n.workspace_id) == workspace)
                .collect();
            // HashMap iteration order is unspecified; the JS side returns
            // insertion order. Sort by id so both backends are deterministic.
            matches.sort_by(|a, b| a.id.cmp(&b.id));
            let nodes: Vec<Value> = matches.iter().map(|n| node_to_json(n)).collect();
            json!({ "ok": true, "nodes": nodes })
        }
        "hypotheses" => hypotheses::generate_hypotheses(graph, cmd),
        "fitness" => hypotheses::build_fitness_report(graph, cmd),
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
