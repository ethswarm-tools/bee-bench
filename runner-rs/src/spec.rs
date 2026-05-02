use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Deserialize)]
pub struct BenchSpec {
    #[serde(default)]
    pub version: String,
    pub iters: usize,
    #[serde(default)]
    pub warmup_net: usize,
    #[serde(default)]
    pub warmup_cpu: usize,
    #[serde(default, rename = "cooldown_between_cases_sec")]
    pub cooldown_sec: u64,
    pub sizes_mb: Vec<i64>,
    #[serde(default)]
    pub large_size_mb: i64,
    #[serde(default = "default_rss_interval", rename = "rss_sample_interval_ms")]
    pub rss_sample_interval_ms: u64,
    pub cases: Vec<CaseSpec>,
    #[serde(default)]
    pub param_sets: HashMap<String, Vec<ParamEntry>>,
}

fn default_rss_interval() -> u64 { 100 }

#[derive(Deserialize, Clone)]
pub struct CaseSpec {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub params: Vec<ParamEntry>,
    #[serde(default)]
    pub params_from: Option<String>,
    #[serde(default)]
    pub runner_subset: Vec<String>,
    #[serde(default)]
    pub doc: String,
}

pub type ParamEntry = HashMap<String, Value>;

pub fn load_spec(path: &Path) -> Result<(BenchSpec, String), String> {
    let raw = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(&raw);
    let hash = format!("sha256:{}", hex::encode(h.finalize()));
    let s: BenchSpec = serde_json::from_slice(&raw)
        .map_err(|e| format!("parse {}: {e}", path.display()))?;
    Ok((s, hash))
}

impl BenchSpec {
    pub fn resolve_params(&self, c: &CaseSpec) -> Vec<ParamEntry> {
        if !c.params.is_empty() {
            return c.params.clone();
        }
        if let Some(name) = &c.params_from {
            if let Some(entries) = self.param_sets.get(name) {
                return entries.clone();
            }
        }
        vec![ParamEntry::new()]
    }
}

impl CaseSpec {
    pub fn runner_in_subset(&self, runner: &str) -> bool {
        self.runner_subset.is_empty() || self.runner_subset.iter().any(|r| r == runner)
    }
}

pub fn int_param(p: &ParamEntry, key: &str, dflt: i64) -> i64 {
    p.get(key).and_then(|v| v.as_i64()).unwrap_or(dflt)
}

pub fn is_warmup(p: &ParamEntry) -> bool {
    p.get("warmup").and_then(|v| v.as_bool()).unwrap_or(false)
}

pub fn is_large_param(p: &ParamEntry) -> bool {
    if p.get("large").and_then(|v| v.as_bool()).unwrap_or(false) {
        return true;
    }
    if let Some(v) = p.get("size_mb").and_then(|v| v.as_i64()) {
        return v >= 1024;
    }
    false
}

pub fn param_label(p: &ParamEntry) -> String {
    if p.is_empty() { return String::new(); }
    if let Some(v) = p.get("size_mb") { return format!("size_mb={v}"); }
    if let Some(v) = p.get("count") { return format!("count={v}"); }
    if let Some(v) = p.get("files") { return format!("files={v}"); }
    String::new()
}
