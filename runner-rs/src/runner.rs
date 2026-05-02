use serde::Serialize;
use std::time::Instant;

use crate::spec::{BenchSpec, CaseSpec, ParamEntry};

pub const RUNNER_NAME: &str = "rs";

#[derive(Serialize, Default)]
pub struct CaseResult {
    #[serde(rename = "case")]
    pub case_id: String,
    pub param: ParamEntry,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub iters_ms: Vec<f64>,
    pub median_ms: f64,
    pub min_ms: f64,
    pub max_ms: f64,
    pub mean_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub throughput_mbps: Option<f64>,
    pub peak_rss_mb: f64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub notes: String,
    #[serde(skip_serializing_if = "is_false")]
    pub skipped: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub skip_reason: String,
}

fn is_false(b: &bool) -> bool { !*b }

#[derive(Serialize)]
pub struct RunResult {
    pub runner: String,
    pub client_version: String,
    pub bee_version: String,
    pub bench_spec_hash: String,
    pub started_at: String,
    pub host: HostInfo,
    pub bee_url: String,
    pub batch_id: String,
    pub iters: usize,
    pub results: Vec<CaseResult>,
}

#[derive(Serialize, Default)]
pub struct HostInfo {
    pub os: String,
    pub arch: String,
    pub cpu: String,
    pub num_cpu: usize,
}

pub fn host_info() -> HostInfo {
    HostInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        cpu: cpu_model(),
        num_cpu: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
    }
}

fn cpu_model() -> String {
    let raw = match std::fs::read_to_string("/proc/cpuinfo") {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    for line in raw.lines() {
        if let Some(idx) = line.find(':') {
            if line.starts_with("model name") {
                return line[idx + 1..].trim().to_string();
            }
        }
    }
    String::new()
}

pub fn stats(ms: &[f64]) -> (f64, f64, f64, f64) {
    if ms.is_empty() { return (0.0, 0.0, 0.0, 0.0); }
    let mut sorted = ms.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let min = sorted[0];
    let max = *sorted.last().unwrap();
    let median = if sorted.len() % 2 == 1 {
        sorted[sorted.len() / 2]
    } else {
        (sorted[sorted.len() / 2 - 1] + sorted[sorted.len() / 2]) / 2.0
    };
    let mean = ms.iter().sum::<f64>() / ms.len() as f64;
    (round3(min), round3(max), round3(median), round3(mean))
}

pub fn round3(v: f64) -> f64 { (v * 1000.0).round() / 1000.0 }
pub fn round2(v: f64) -> f64 { (v * 100.0).round() / 100.0 }
pub fn round1(v: f64) -> f64 { (v * 10.0).round() / 10.0 }

pub fn time_it<F, T>(f: F) -> (f64, T) where F: FnOnce() -> T {
    let start = Instant::now();
    let r = f();
    let ms = start.elapsed().as_micros() as f64 / 1000.0;
    (ms, r)
}

pub async fn time_async<F, Fut, T>(f: F) -> (f64, T)
where F: FnOnce() -> Fut, Fut: std::future::Future<Output = T>,
{
    let start = Instant::now();
    let r = f().await;
    let ms = start.elapsed().as_micros() as f64 / 1000.0;
    (ms, r)
}

pub fn finalize_result(
    case: &CaseSpec,
    p: ParamEntry,
    ms: Vec<f64>,
    bytes_per_iter: i64,
    notes: String,
    peak_rss_mb: f64,
) -> CaseResult {
    let mut r = CaseResult {
        case_id: case.id.clone(),
        param: p,
        peak_rss_mb: round1(peak_rss_mb),
        ..Default::default()
    };
    if ms.is_empty() {
        r.skipped = true;
        if let Some(rest) = notes.strip_prefix("SKIP: ") {
            r.skip_reason = rest.to_string();
        } else if !notes.is_empty() {
            r.skip_reason = notes;
        } else {
            r.skip_reason = "no iterations recorded".to_string();
        }
        return r;
    }
    let (min, max, median, mean) = stats(&ms);
    r.iters_ms = ms.iter().map(|v| round3(*v)).collect();
    r.min_ms = min;
    r.max_ms = max;
    r.median_ms = median;
    r.mean_ms = mean;
    if bytes_per_iter > 0 {
        let mb = bytes_per_iter as f64 / (1024.0 * 1024.0);
        let t = mb / (median / 1000.0);
        r.throughput_mbps = Some(round2(t));
    }
    r.notes = notes;
    r
}

pub fn iters_for(_spec: &BenchSpec, _p: &ParamEntry) -> usize { 5 }
