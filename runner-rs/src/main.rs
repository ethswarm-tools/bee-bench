mod cases;
mod fixtures;
mod rss;
mod runner;
mod spec;

use std::env;
use std::path::{Path, PathBuf};
use std::time::Duration;

use bee::Client;
use bee::swarm::BatchId;
use chrono::Utc;

use crate::cases::CaseOutcome;
use crate::fixtures::Fixtures;
use crate::runner::{CaseResult, HostInfo, RUNNER_NAME, RunResult, finalize_result, host_info};
use crate::spec::{
    BenchSpec, CaseSpec, ParamEntry, is_large_param, load_spec, param_label,
};

fn large_enabled() -> bool {
    env::var("BENCH_LARGE").ok().as_deref() == Some("1")
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let repo_root = find_repo_root().expect("could not find bench-spec.json");
    let spec_path = repo_root.join("bench-spec.json");
    let (spec, hash) = load_spec(&spec_path).expect("load spec");

    let bee_url = env::var("BEE_URL").unwrap_or_else(|_| "http://localhost:1633".into());
    let batch_hex = env::var("BEE_BATCH_ID").ok();
    let has_batch = batch_hex.as_deref().map(|s| !s.is_empty()).unwrap_or(false);

    let batch_id_opt = if has_batch {
        match BatchId::from_hex(batch_hex.as_deref().unwrap()) {
            Ok(b) => Some(b),
            Err(e) => {
                eprintln!("runner-rs: parse BEE_BATCH_ID: {e}");
                std::process::exit(1);
            }
        }
    } else {
        eprintln!("warn: BEE_BATCH_ID not set — net.* cases will be skipped");
        None
    };

    let client = Client::new(&bee_url).expect("create bee client");
    let bee_version = match client.debug().versions().await {
        Ok(v) => v.bee_version,
        Err(_) => "unknown".to_string(),
    };

    let fixtures = Fixtures::load(
        &repo_root.join("fixtures"),
        &spec.sizes_mb,
        if large_enabled() && spec.large_size_mb > 0 { Some(spec.large_size_mb) } else { None },
    );

    let started_at = Utc::now().to_rfc3339();
    let stamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let out_path = repo_root.join("results").join(format!("{RUNNER_NAME}-{stamp}.json"));

    let mut results: Vec<CaseResult> = Vec::new();

    for (i, c) in spec.cases.iter().enumerate() {
        if !c.runner_in_subset(RUNNER_NAME) {
            eprintln!("[{}/{}] skip {} (runner_subset excludes {RUNNER_NAME})",
                i + 1, spec.cases.len(), c.id);
            continue;
        }
        if c.kind == "net" && !has_batch {
            eprintln!("[{}/{}] skip {} (no BEE_BATCH_ID)", i + 1, spec.cases.len(), c.id);
            results.push(skip_result(&c.id, "BEE_BATCH_ID not set"));
            continue;
        }
        let params = spec.resolve_params(c);
        for p in params {
            if is_large_param(&p) && !large_enabled() {
                continue;
            }
            let label = param_label(&p);
            eprintln!("[{}/{}] {} {} ...", i + 1, spec.cases.len(), c.id, label);

            // warmup
            let warmup_n = if c.kind == "cpu" { spec.warmup_cpu } else { spec.warmup_net };
            for _ in 0..warmup_n {
                let mut wp = p.clone();
                wp.insert("warmup".into(), serde_json::Value::Bool(true));
                let _ = run_one(&c.id, &wp, &client, batch_id_opt.as_ref(), &fixtures).await;
            }

            let sampler = rss::Sampler::start(spec.rss_sample_interval_ms);
            let (pre_u, pre_s) = runner::get_cpu_ms();
            let outcome = run_one(&c.id, &p, &client, batch_id_opt.as_ref(), &fixtures).await;
            let (post_u, post_s) = runner::get_cpu_ms();
            let peak = sampler.finish_mb().await;

            let mut r = finalize_result(c, p, outcome.ms, outcome.bytes_per_iter, outcome.notes, peak);
            if !r.skipped {
                r.cpu_user_ms = Some(runner::round2(post_u - pre_u));
                r.cpu_sys_ms = Some(runner::round2(post_s - pre_s));
            }
            log_summary(&c.id, &label, &r);
            results.push(r);
        }
        if spec.cooldown_sec > 0 {
            tokio::time::sleep(Duration::from_secs(spec.cooldown_sec)).await;
        }
    }

    let bee_rs_version = read_bee_rs_version(&repo_root).unwrap_or_else(|| "unknown".into());
    let res = RunResult {
        runner: RUNNER_NAME.into(),
        client_version: format!("bee-rs {} (path:../../bee-rs)", bee_rs_version),
        bee_version,
        bench_spec_hash: hash,
        started_at,
        host: host_info(),
        bee_url,
        batch_id: batch_hex.unwrap_or_default(),
        iters: spec.iters,
        results,
    };

    if let Some(parent) = out_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let f = std::fs::File::create(&out_path).expect("create result file");
    serde_json::to_writer_pretty(f, &res).expect("write result");
    eprintln!("\nwrote {}", out_path.display());
}

async fn run_one(
    id: &str,
    p: &ParamEntry,
    client: &Client,
    batch: Option<&BatchId>,
    fix: &Fixtures,
) -> CaseOutcome {
    use crate::cases::*;
    match id {
        "cpu.keccak.chunk-hash" => case_keccak_chunk_hash(p).await,
        "cpu.keccak.parallel" => case_keccak_parallel(p).await,
        "cpu.identity.create" => case_identity_create(p).await,
        "cpu.keccak.bulk" => case_keccak_bulk(p, fix).await,
        "cpu.bmt.file-root" => case_bmt_file_root(p, fix).await,
        "cpu.bmt.encrypted-file-root" => case_bmt_encrypted_file_root(p).await,
        "cpu.ecdsa.sign-1000" => case_ecdsa_sign(p).await,
        "cpu.ecdsa.verify-1000" => case_ecdsa_verify(p).await,
        "cpu.manifest.hash-50files" => case_manifest_hash50(p).await,
        "cpu.manifest.lookup-large" => case_manifest_lookup_large(p).await,
        "net.stamps.list" => case_stamps_list(p, client).await,
        "net.stamps.concurrent" => case_stamps_concurrent(p, client).await,
        "net.bytes.head" => match batch {
            Some(b) => case_bytes_head(p, client, b, fix).await,
            None => CaseOutcome::skip("no batch"),
        },
        "net.bytes.download.range" => match batch {
            Some(b) => case_bytes_download_range(p, client, b, fix).await,
            None => CaseOutcome::skip("no batch"),
        },
        "net.bzz.upload" => match batch {
            Some(b) => case_bzz_upload(p, client, b, fix).await,
            None => CaseOutcome::skip("no batch"),
        },
        "net.bzz.upload.encrypted" => match batch {
            Some(b) => case_bzz_upload_encrypted(p, client, b, fix).await,
            None => CaseOutcome::skip("no batch"),
        },
        "net.bytes.upload" => match batch {
            Some(b) => case_bytes_upload(p, client, b, fix).await,
            None => CaseOutcome::skip("no batch"),
        },
        "net.bzz.download" => match batch {
            Some(b) => case_bzz_download(p, client, b, fix).await,
            None => CaseOutcome::skip("no batch"),
        },
        "net.chunks.upload" => match batch {
            Some(b) => case_chunks_upload(p, client, b).await,
            None => CaseOutcome::skip("no batch"),
        },
        "net.stream-dir.upload" => match batch {
            Some(b) => case_stream_dir_upload(p, client, b).await,
            None => CaseOutcome::skip("no batch"),
        },
        "net.soc.upload" => match batch {
            Some(b) => case_soc_upload(p, client, b).await,
            None => CaseOutcome::skip("no batch"),
        },
        "net.pin.add-list" => match batch {
            Some(b) => case_pin_add_list(p, client, b).await,
            None => CaseOutcome::skip("no batch"),
        },
        "net.tags.upload-with-tag" => match batch {
            Some(b) => case_tags_upload_with_tag(p, client, b, fix).await,
            None => CaseOutcome::skip("no batch"),
        },
        "net.feed.write-read.fresh" => match batch {
            Some(b) => case_feed_fresh(p, client, b).await,
            None => CaseOutcome::skip("no batch"),
        },
        "net.feed.write-read.warm" => match batch {
            Some(b) => case_feed_warm(p, client, b).await,
            None => CaseOutcome::skip("no batch"),
        },
        _ => CaseOutcome::skip("not implemented yet"),
    }
}

fn skip_result(id: &str, reason: &str) -> CaseResult {
    CaseResult {
        case_id: id.to_string(),
        skipped: true,
        skip_reason: reason.to_string(),
        ..Default::default()
    }
}

fn log_summary(_id: &str, label: &str, r: &CaseResult) {
    if r.skipped {
        eprintln!("  → SKIP: {}", r.skip_reason);
        return;
    }
    let tp = r.throughput_mbps.map(|t| format!(" ({t:.2} MB/s)")).unwrap_or_default();
    eprintln!(
        "  → median {:.2}ms (min {:.2}, max {:.2}){} rss={:.1}MB  [{}]",
        r.median_ms, r.min_ms, r.max_ms, tp, r.peak_rss_mb, label
    );
}

fn find_repo_root() -> Option<PathBuf> {
    let mut dir = env::current_dir().ok()?;
    for _ in 0..6 {
        if dir.join("bench-spec.json").exists() {
            return Some(dir);
        }
        let parent = dir.parent()?.to_path_buf();
        if parent == dir { break; }
        dir = parent;
    }
    None
}

/// Read `version = "..."` from the [package] section of the sibling
/// bee-rs Cargo.toml so the result JSON records which client version
/// the runner actually built against. None on any failure — caller
/// substitutes "unknown".
fn read_bee_rs_version(repo_root: &Path) -> Option<String> {
    let path = repo_root.parent()?.join("bee-rs").join("Cargo.toml");
    let raw = std::fs::read_to_string(&path).ok()?;
    let mut in_package = false;
    for line in raw.lines() {
        let t = line.trim();
        if t == "[package]" { in_package = true; continue; }
        if t.starts_with('[') && t != "[package]" { in_package = false; continue; }
        if in_package {
            if let Some(rest) = t.strip_prefix("version") {
                let v = rest.trim_start_matches([' ', '=']).trim();
                let v = v.trim_matches('"').to_string();
                if !v.is_empty() { return Some(v); }
            }
        }
    }
    None
}

// silence unused imports
#[allow(dead_code)]
fn _silence() {
    let _ = HostInfo::default();
    let _: &Path = Path::new(".");
    let _ = CaseSpec { id: String::new(), kind: String::new(), params: vec![], params_from: None, runner_subset: vec![], doc: String::new() };
    let _: BenchSpec = serde_json::from_str("{\"iters\":0,\"sizes_mb\":[],\"cases\":[]}").unwrap();
}
