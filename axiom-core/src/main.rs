#![allow(dead_code)]
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn js_num(n: f64) -> String {
    let s = format!("{:.6}", n).trim_end_matches('0').trim_end_matches('.').to_string();
    if !s.contains('.') { s + ".0" } else { s }
}

fn js_bool(b: bool) -> String { if b { "true".to_string() } else { "false".to_string() } }

fn js_obj(entries: Vec<(&str, String)>) -> String {
    let mut s = String::from('{');
    for (i, (k, v)) in entries.iter().enumerate() {
        if i > 0 { s.push(',') }
        s.push_str(&format!("{}:{}", js_string(k), v));
    }
    s.push('}');
    s
}

fn with_req_id(json: String, req_id: Option<&str>) -> String {
    match req_id {
        Some(rid) => format!("{{\"_reqId\":{},{}", rid, &json[1..]),
        None => json,
    }
}

fn js_arr(items: Vec<String>) -> String {
    let mut s = String::from('[');
    for (i, v) in items.iter().enumerate() {
        if i > 0 { s.push(',') }
        s.push_str(v);
    }
    s.push(']');
    s
}

fn js_num_arr(items: Vec<f64>) -> String {
    js_arr(items.iter().map(|v| js_num(*v)).collect())
}

fn js_str_arr(items: Vec<&str>) -> String {
    js_arr(items.iter().map(|v| js_string(v)).collect())
}

fn parse_json_line(line: &str) -> Option<HashMap<String, String>> {
    let line = line.trim();
    if !line.starts_with('{') || !line.ends_with('}') { return None; }
    let inner = &line[1..line.len()-1].trim();
    if inner.is_empty() { return Some(HashMap::new()); }

    let mut map = HashMap::new();
    let mut i = 0;
    let chars: Vec<char> = inner.chars().collect();
    while i < chars.len() {
        while i < chars.len() && (chars[i] == ' ' || chars[i] == ',') { i += 1; }
        if i >= chars.len() { break; }
        // parse key
        if chars[i] != '"' { return None; }
        i += 1;
        let mut key = String::new();
        while i < chars.len() && chars[i] != '"' {
            if chars[i] == '\\' { i += 1; if i < chars.len() { key.push(chars[i]); } }
            else { key.push(chars[i]); }
            i += 1;
        }
        if i >= chars.len() { return None; }
        i += 1; // skip closing "
        while i < chars.len() && chars[i] != ':' { i += 1; }
        i += 1;
        while i < chars.len() && chars[i] == ' ' { i += 1; }
        // parse value
        let val = if i < chars.len() && chars[i] == '"' {
            i += 1;
            let mut v = String::new();
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' { i += 1; if i < chars.len() { v.push(chars[i]); } }
                else { v.push(chars[i]); }
                i += 1;
            }
            i += 1;
            v
        } else {
            let mut v = String::new();
            while i < chars.len() && chars[i] != ',' && chars[i] != '}' && chars[i] != ' ' && chars[i] != '\t' && chars[i] != '\n' && chars[i] != '\r' {
                v.push(chars[i]);
                i += 1;
            }
            v
        };
        map.insert(key, val);
    }
    Some(map)
}

#[derive(Clone)]
struct Node {
    id: String,
    label: String,
    weight: f64,
    created: u64,
    last_accessed: u64,
    vector: HashMap<String, f64>,
}

#[derive(Clone)]
struct Edge {
    from: String,
    to: String,
    relation: String,
    weight: f64,
    created: u64,
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
        Graph { nodes: HashMap::new(), edges: Vec::new(), out_index: HashMap::new(), in_index: HashMap::new(), decay_lambda: 0.05, prune_threshold: 0.01 }
    }

    fn add_node(&mut self, id: &str, label: &str) {
        let now = now_ms();
        if let Some(n) = self.nodes.get_mut(id) {
            n.label = label.to_string();
            n.weight = (n.weight + 0.1).min(1.0);
            n.last_accessed = now;
        } else {
            self.nodes.insert(id.to_string(), Node { id: id.to_string(), label: label.to_string(), weight: 0.5, created: now, last_accessed: now, vector: HashMap::new() });
        }
    }

    fn remove_node(&mut self, id: &str) -> bool {
        if self.nodes.remove(id).is_none() { return false; }
        let before = self.edges.len();
        self.edges.retain(|e| e.from != id && e.to != id);
        if self.edges.len() != before { self.rebuild_index(); }
        true
    }

    fn add_edge(&mut self, from: &str, to: &str, relation: &str) -> bool {
        if !self.nodes.contains_key(from) || !self.nodes.contains_key(to) { return false; }
        if let Some(e) = self.edges.iter_mut().find(|e| e.from == from && e.to == to && e.relation == relation) {
            e.weight = (e.weight + 0.1).min(1.0);
            return true;
        }
        let idx = self.edges.len();
        self.edges.push(Edge { from: from.to_string(), to: to.to_string(), relation: relation.to_string(), weight: 0.5, created: now_ms() });
        self.index_edge(idx);
        true
    }

    fn get_edge(&self, from: &str, to: &str, relation: &str) -> Option<&Edge> {
        if let Some(indices) = self.out_index.get(from) {
            for &idx in indices {
                let e = &self.edges[idx];
                if e.to == to && e.relation == relation { return Some(e); }
            }
        }
        None
    }

    fn get_edges(&self, node: &str) -> Vec<&Edge> {
        let mut res = Vec::new();
        if let Some(indices) = self.out_index.get(node) {
            for &idx in indices { res.push(&self.edges[idx]); }
        }
        res
    }

    fn get_in_edges(&self, node: &str) -> Vec<&Edge> {
        let mut res = Vec::new();
        if let Some(indices) = self.in_index.get(node) {
            for &idx in indices { res.push(&self.edges[idx]); }
        }
        res
    }

    fn cosine_similarity(&self, a: &str, b: &str) -> f64 {
        let an = match self.nodes.get(a) { Some(n) => n, None => return 0.0 };
        let bn = match self.nodes.get(b) { Some(n) => n, None => return 0.0 };
        let dims: HashSet<&String> = an.vector.keys().chain(bn.vector.keys()).collect();
        let (mut dot, mut ma, mut mb) = (0.0, 0.0, 0.0);
        for d in dims {
            let va = an.vector.get(d).copied().unwrap_or(0.0);
            let vb = bn.vector.get(d).copied().unwrap_or(0.0);
            dot += va * vb; ma += va * va; mb += vb * vb;
        }
        let mag = ma.sqrt() * mb.sqrt();
        if mag == 0.0 { 0.0 } else { dot / mag }
    }

    fn prune(&mut self, threshold: f64) -> usize {
        let before = self.edges.len();
        self.edges.retain(|e| e.weight >= threshold);
        let p = before - self.edges.len();
        if p > 0 { self.rebuild_index(); }
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
        for i in 0..self.edges.len() { self.index_edge(i); }
    }
}

fn edge_to_obj(e: &Edge) -> String {
    js_obj(vec![
        ("from", js_string(&e.from)),
        ("to", js_string(&e.to)),
        ("relation", js_string(&e.relation)),
        ("weight", js_num(e.weight)),
    ])
}

fn edges_to_arr(edges: Vec<&Edge>) -> String {
    js_arr(edges.iter().map(|e| edge_to_obj(e)).collect())
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
            return Parsed { object: stem.to_string(), relation: "tür".to_string() };
        }
    }
    let verb_suffixes = ["ar", "er", "ır", "ir", "ur", "ür", "mek", "mak"];
    for s in &verb_suffixes {
        if p.ends_with(s) { return Parsed { object: p.clone(), relation: "yapabilir".to_string() }; }
    }
    if p.ends_with('r') && p.len() > 2 {
        return Parsed { object: p.clone(), relation: "yapabilir".to_string() };
    }
    Parsed { object: p, relation: "özellik".to_string() }
}

fn cross_link(nodes: &mut HashMap<String, Node>, subject: &str, object: &str) {
    let keys: Vec<String> = {
        if let Some(n) = nodes.get(subject) { n.vector.keys().cloned().collect() }
        else { return; }
    };
    if !nodes.contains_key(object) { return; }
    for tag in &keys {
        if tag != object && nodes.contains_key(tag) {
            if let Some(n) = nodes.get(object) {
                if n.vector.contains_key(tag) {
                    // will add "benzer" edge below via caller
                }
            }
        }
    }
}

fn main() {
    let mut nodes: HashMap<String, Node> = HashMap::new();
    let mut edges: Vec<Edge> = Vec::new();
    let mut out_index: HashMap<String, Vec<usize>> = HashMap::new();
    let mut in_index: HashMap<String, Vec<usize>> = HashMap::new();
    let decay_lambda: f64 = 0.05;
    let prune_threshold: f64 = 0.01;

    let stdin = io::stdin();

    for line in stdin.lock().lines() {
        let line = match line { Ok(l) => l, Err(_) => break };
        let line = line.trim().to_string();
        if line.is_empty() { continue; }

        let cmd = match parse_json_line(&line) {
            Some(m) => m,
            None => { println!("{}", js_obj(vec![("ok", js_bool(false)), ("error", js_string("parse_error"))])); continue; }
        };
        let req_id = cmd.get("_reqId").cloned();
        macro_rules! emit {
            ($json:expr) => {
                println!("{}", with_req_id($json, req_id.as_deref()));
            };
        }

        let result = match cmd.get("cmd").map(|s| s.as_str()).unwrap_or("") {
            "add_node" => {
                let id = cmd.get("id").cloned().unwrap_or_default();
                let label = cmd.get("label").cloned().unwrap_or_default();
                let now = now_ms();
                if let Some(n) = nodes.get_mut(&id) {
                    n.label = label;
                    n.weight = (n.weight + 0.1).min(1.0);
                    n.last_accessed = now;
                } else {
                    nodes.insert(id.clone(), Node { id, label, weight: 0.5, created: now, last_accessed: now, vector: HashMap::new() });
                }
                js_obj(vec![("ok", js_bool(true))])
            }
            "get_node" => {
                let id = cmd.get("id").cloned().unwrap_or_default();
                let now = now_ms();
                if let Some(n) = nodes.get_mut(&id) {
                    n.last_accessed = now;
                    let vec_str: Vec<String> = n.vector.iter().map(|(k, v)| {
                        js_obj(vec![("key", js_string(k)), ("value", js_num(*v))])
                    }).collect();
                    js_obj(vec![
                        ("ok", js_bool(true)),
                        ("node", js_obj(vec![
                            ("id", js_string(&n.id)),
                            ("label", js_string(&n.label)),
                            ("weight", js_num(n.weight)),
                            ("vector", js_obj(vec![
                                ("tags", js_arr(vec![])),
                                ("dimensions", js_num(vec_str.len() as f64)),
                            ])),
                        ])),
                    ])
                } else {
                    js_obj(vec![("ok", js_bool(false)), ("error", js_string("not_found"))])
                }
            }
            "remove_node" => {
                let id = cmd.get("id").cloned().unwrap_or_default();
                if nodes.remove(&id).is_none() {
                    js_obj(vec![("ok", js_bool(false))])
                } else {
                    let before = edges.len();
                    edges.retain(|e| e.from != id && e.to != id);
                    if edges.len() != before {
                        out_index.clear(); in_index.clear();
                        for i in 0..edges.len() {
                            let f = edges[i].from.clone();
                            let t = edges[i].to.clone();
                            out_index.entry(f).or_default().push(i);
                            in_index.entry(t).or_default().push(i);
                        }
                    }
                    js_obj(vec![("ok", js_bool(true))])
                }
            }
            "add_edge" => {
                let from = cmd.get("from").cloned().unwrap_or_default();
                let to = cmd.get("to").cloned().unwrap_or_default();
                let relation = cmd.get("relation").cloned().unwrap_or_default();
                if !nodes.contains_key(&from) || !nodes.contains_key(&to) {
                    js_obj(vec![("ok", js_bool(false))])
                } else if let Some(e) = edges.iter_mut().find(|e| e.from == from && e.to == to && e.relation == relation) {
                    e.weight = (e.weight + 0.1).min(1.0);
                    js_obj(vec![("ok", js_bool(true))])
                } else {
                    let idx = edges.len();
                    edges.push(Edge { from: from.clone(), to: to.clone(), relation: relation.clone(), weight: 0.5, created: now_ms() });
                    out_index.entry(from).or_default().push(idx);
                    in_index.entry(to).or_default().push(idx);
                    js_obj(vec![("ok", js_bool(true))])
                }
            }
            "get_edges" => {
                let id = cmd.get("id").cloned().unwrap_or_default();
                let mut res = Vec::new();
                if let Some(indices) = out_index.get(&id) {
                    for &idx in indices { res.push(&edges[idx]); }
                }
                js_obj(vec![("ok", js_bool(true)), ("edges", edges_to_arr(res))])
            }
            "get_in_edges" => {
                let id = cmd.get("id").cloned().unwrap_or_default();
                let mut res = Vec::new();
                if let Some(indices) = in_index.get(&id) {
                    for &idx in indices { res.push(&edges[idx]); }
                }
                js_obj(vec![("ok", js_bool(true)), ("edges", edges_to_arr(res))])
            }
            "get_weight" => {
                let id = cmd.get("id").cloned().unwrap_or_default();
                let n = match nodes.get(&id) { Some(n) => n, None => { emit!(js_obj(vec![("ok", js_bool(false))])); continue; } };
                let elapsed = (now_ms() - n.last_accessed) as f64 / 1000.0;
                let decayed = n.weight * (-decay_lambda * elapsed).exp();
                js_obj(vec![("ok", js_bool(true)), ("weight", js_num(decayed))])
            }
            "cosine_similarity" => {
                let a = cmd.get("a").cloned().unwrap_or_default();
                let b = cmd.get("b").cloned().unwrap_or_default();
                let an = match nodes.get(&a) { Some(n) => n, None => { emit!(js_obj(vec![("ok", js_bool(false))])); continue; } };
                let bn = match nodes.get(&b) { Some(n) => n, None => { emit!(js_obj(vec![("ok", js_bool(false))])); continue; } };
                let dims: HashSet<&String> = an.vector.keys().chain(bn.vector.keys()).collect();
                let (mut dot, mut ma, mut mb) = (0.0, 0.0, 0.0);
                for d in dims {
                    let va = an.vector.get(d).copied().unwrap_or(0.0);
                    let vb = bn.vector.get(d).copied().unwrap_or(0.0);
                    dot += va * vb; ma += va * va; mb += vb * vb;
                }
                let mag = ma.sqrt() * mb.sqrt();
                let sim = if mag == 0.0 { 0.0 } else { dot / mag };
                js_obj(vec![("ok", js_bool(true)), ("similarity", js_num(sim))])
            }
            "prune" => {
                let threshold: f64 = cmd.get("threshold").and_then(|v| v.parse().ok()).unwrap_or(prune_threshold);
                let before = edges.len();
                edges.retain(|e| e.weight >= threshold);
                let p = before - edges.len();
                if p > 0 { out_index.clear(); in_index.clear(); for i in 0..edges.len() { let f = edges[i].from.clone(); let t = edges[i].to.clone(); out_index.entry(f).or_default().push(i); in_index.entry(t).or_default().push(i); } }
                js_obj(vec![("ok", js_bool(true)), ("pruned", js_num(p as f64))])
            }
            "optimize" => {
                let before_e = edges.len();
                edges.retain(|e| e.weight >= prune_threshold);
                let pruned = before_e - edges.len();
                if pruned > 0 { out_index.clear(); in_index.clear(); for i in 0..edges.len() { let f = edges[i].from.clone(); let t = edges[i].to.clone(); out_index.entry(f).or_default().push(i); in_index.entry(t).or_default().push(i); } }
                let now = now_ms();
                let ids: Vec<String> = nodes.keys().cloned().collect();
                let mut removed = 0;
                for id in &ids {
                    if let Some(n) = nodes.get(id) {
                        let elapsed = (now - n.last_accessed) as f64 / 1000.0;
                        let decayed = n.weight * (-decay_lambda * elapsed).exp();
                        let has_out = out_index.contains_key(id);
                        let has_in = in_index.contains_key(id);
                        if decayed < 0.01 && !has_out && !has_in { nodes.remove(id); removed += 1; }
                    }
                }
                js_obj(vec![("ok", js_bool(true)), ("pruned", js_num(pruned as f64)), ("removed_nodes", js_num(removed as f64))])
            }
            "learn" => {
                let text = cmd.get("text").cloned().unwrap_or_default();
                let parts: Vec<&str> = text.trim().split_whitespace().collect();
                if parts.len() >= 2 {
                    let subject = parts[0].to_string();
                    let predicate = parts[1..].join(" ");
                    let now = now_ms();
                    if !nodes.contains_key(&subject) { nodes.insert(subject.clone(), Node { id: subject.clone(), label: subject.clone(), weight: 0.5, created: now, last_accessed: now, vector: HashMap::new() }); }
                    let parsed = parse_predicate(&predicate);
                    if !nodes.contains_key(&parsed.object) { nodes.insert(parsed.object.clone(), Node { id: parsed.object.clone(), label: parsed.object.clone(), weight: 0.5, created: now, last_accessed: now, vector: HashMap::new() }); }
                    if edges.iter().all(|e| e.from != subject || e.to != parsed.object || e.relation != parsed.relation) {
                        let idx = edges.len();
                        edges.push(Edge { from: subject.clone(), to: parsed.object.clone(), relation: parsed.relation.clone(), weight: 0.5, created: now });
                        out_index.entry(subject.clone()).or_default().push(idx);
                        in_index.entry(parsed.object.clone()).or_default().push(idx);
                    }
                    if let Some(n) = nodes.get_mut(&subject) {
                        *n.vector.entry(parsed.object.clone()).or_insert(0.0) += 0.3;
                    }
                }
                js_obj(vec![("ok", js_bool(true))])
            }
            "ask" => {
                let question = cmd.get("question").cloned().unwrap_or_default();
                let parts: Vec<&str> = question.trim().split_whitespace().collect();
                let subject = if parts.is_empty() { String::new() } else { parts[0].to_string() };
                if !nodes.contains_key(&subject) { emit!(js_obj(vec![("ok", js_bool(true)), ("answer", js_string("Bilmiyorum"))])); continue; }
                let mut edge_list = Vec::new();
                if let Some(indices) = out_index.get(&subject) {
                    for &idx in indices { edge_list.push(&edges[idx]); }
                }
                if edge_list.is_empty() { emit!(js_obj(vec![("ok", js_bool(true)), ("answer", js_string("Bilmiyorum"))])); continue; }
                edge_list.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal));
                let mut results: Vec<String> = Vec::new();
                for e in &edge_list {
                    if e.relation == "tür" {
                        if !results.contains(&e.to) { results.push(e.to.clone()); }
                    } else if e.relation == "yapabilir" {
                        if !results.contains(&e.to) { results.push(e.to.clone()); }
                    } else if !results.contains(&e.to) {
                        results.push(e.to.clone());
                    }
                }
                if results.is_empty() { emit!(js_obj(vec![("ok", js_bool(true)), ("answer", js_string("Bilmiyorum"))])); continue; }
                emit!(js_obj(vec![("ok", js_bool(true)), ("answer", js_string(&format!("{} {}", subject, results.join(", "))))]));
                continue;
            }
            "stats" => {
                js_obj(vec![
                    ("ok", js_bool(true)),
                    ("stats", js_obj(vec![
                        ("nodes", js_num(nodes.len() as f64)),
                        ("edges", js_num(edges.len() as f64)),
                        ("decay_lambda", js_num(decay_lambda)),
                    ])),
                ])
            }
            _ => js_obj(vec![("ok", js_bool(false)), ("error", js_string("unknown_command"))]),
        };

        emit!(result);
    }
}
