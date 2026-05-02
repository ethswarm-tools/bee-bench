use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::task::JoinHandle;

pub fn read_vm_rss_kb() -> u64 {
    let raw = match std::fs::read_to_string("/proc/self/status") {
        Ok(s) => s,
        Err(_) => return 0,
    };
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            let mut it = rest.split_whitespace();
            if let Some(num) = it.next() {
                return num.parse().unwrap_or(0);
            }
        }
    }
    0
}

pub struct Sampler {
    peak_kb: Arc<AtomicU64>,
    stop: Arc<AtomicU64>, // 0 = run, 1 = stop
    handle: JoinHandle<()>,
}

impl Sampler {
    pub fn start(interval_ms: u64) -> Self {
        let peak = Arc::new(AtomicU64::new(read_vm_rss_kb()));
        let stop = Arc::new(AtomicU64::new(0));
        let p2 = peak.clone();
        let s2 = stop.clone();
        let interval_ms = interval_ms.max(20);
        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(interval_ms)).await;
                if s2.load(Ordering::Relaxed) == 1 { break; }
                let cur = read_vm_rss_kb();
                update_peak(&p2, cur);
            }
        });
        Self { peak_kb: peak, stop, handle }
    }

    pub async fn finish_mb(self) -> f64 {
        self.stop.store(1, Ordering::Relaxed);
        let _ = self.handle.await;
        update_peak(&self.peak_kb, read_vm_rss_kb());
        self.peak_kb.load(Ordering::Relaxed) as f64 / 1024.0
    }
}

fn update_peak(peak: &AtomicU64, kb: u64) {
    let mut cur = peak.load(Ordering::Relaxed);
    while kb > cur {
        match peak.compare_exchange_weak(cur, kb, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return,
            Err(observed) => cur = observed,
        }
    }
}
