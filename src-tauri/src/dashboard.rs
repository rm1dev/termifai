use serde::Serialize;
use std::collections::HashMap;

// ─── Public types emitted to frontend ────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMetrics {
    pub cpu_pct: f32,
    pub mem_total_kb: u64,
    pub mem_used_kb: u64,
    pub mem_cached_kb: u64,
    pub swap_total_kb: u64,
    pub swap_used_kb: u64,
    pub disk_total_kb: u64,
    pub disk_used_kb: u64,
    pub load_1m: f32,
    pub load_5m: f32,
    pub load_15m: f32,
    pub uptime_secs: u64,
    pub net_rx_rate: f64,   // bytes/sec since last poll
    pub net_tx_rate: f64,
    pub net_iface: String,
    pub cores: u32,
    pub ip: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerMetric {
    pub id: String,
    pub name: String,
    pub state: String,
    pub cpu_pct: f32,
    pub mem_used_bytes: u64,
    pub mem_limit_bytes: u64,
    pub net_rx_rate: f64,
    pub net_tx_rate: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub user: String,
    pub cpu_pct: f32,
    pub mem_kb: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPollResult {
    pub host_id: String,
    pub ok: bool,
    pub system: Option<SystemMetrics>,
    pub containers: Option<Vec<ContainerMetric>>,
    pub processes: Option<Vec<ProcessInfo>>,
    pub error: Option<String>,
}

// ─── Internal delta state ─────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub(crate) struct CpuSnapshot {
    pub user: u64, pub nice: u64, pub system: u64, pub idle: u64,
    pub iowait: u64, pub irq: u64, pub softirq: u64,
}

impl CpuSnapshot {
    pub fn total(&self) -> u64 {
        self.user + self.nice + self.system + self.idle
            + self.iowait + self.irq + self.softirq
    }
    pub fn idle_total(&self) -> u64 { self.idle + self.iowait }
}

/// raw = output of: cat /proc/stat /proc/meminfo /proc/loadavg /proc/uptime /proc/net/dev
/// prev_cpu: snapshot from previous poll for delta CPU
/// prev_net: (rx_bytes, tx_bytes) from previous poll for rate
/// poll_secs: interval between polls for rate calculation
pub(crate) fn parse_proc_output(
    raw: &str,
    prev_cpu: Option<&CpuSnapshot>,
    prev_net: Option<(u64, u64)>,
    poll_secs: f64,
) -> (SystemMetrics, CpuSnapshot, (u64, u64)) {
    let mut cpu_snap = CpuSnapshot { user:0, nice:0, system:0, idle:0, iowait:0, irq:0, softirq:0 };
    let mut mem: HashMap<&str, u64> = HashMap::new();
    let mut load_1m = 0f32; let mut load_5m = 0f32; let mut load_15m = 0f32;
    let mut uptime_secs = 0u64;
    let mut net_iface = String::new();
    let mut net_rx = 0u64; let mut net_tx = 0u64;
    let mut disk_total_kb = 0u64; let mut disk_used_kb = 0u64;
    let mut cores = 0u32;
    let mut ip = String::new();

    for line in raw.lines() {
        // /proc/stat — cpu aggregate line
        if line.starts_with("cpu ") {
            let p: Vec<u64> = line.split_whitespace().skip(1)
                .filter_map(|v| v.parse().ok()).collect();
            if p.len() >= 7 {
                cpu_snap = CpuSnapshot {
                    user: p[0], nice: p[1], system: p[2], idle: p[3],
                    iowait: p[4], irq: p[5], softirq: p[6],
                };
            }
        }
        // /proc/stat — per-core lines for core count
        if line.starts_with("cpu") && line.len() > 3 && line.chars().nth(3).map(|c| c.is_ascii_digit()).unwrap_or(false) {
            cores += 1;
        }
        // /proc/meminfo
        if let Some((k, v)) = line.split_once(':') {
            let v: u64 = v.split_whitespace().next().and_then(|n| n.parse().ok()).unwrap_or(0);
            match k.trim() {
                "MemTotal" => { mem.insert("MemTotal", v); }
                "MemAvailable" => { mem.insert("MemAvailable", v); }
                "Cached" => { mem.insert("Cached", v); }
                "SwapTotal" => { mem.insert("SwapTotal", v); }
                "SwapFree" => { mem.insert("SwapFree", v); }
                _ => {}
            }
        }
        // /proc/loadavg
        if line.contains('.') && !line.contains(':') && !line.contains('/') {
            let p: Vec<&str> = line.split_whitespace().collect();
            if p.len() >= 3 {
                if let (Ok(a), Ok(b), Ok(c)) = (p[0].parse::<f32>(), p[1].parse::<f32>(), p[2].parse::<f32>()) {
                    if a < 100.0 && b < 100.0 && c < 100.0 {
                        load_1m = a; load_5m = b; load_15m = c;
                    }
                }
            }
        }
        // /proc/uptime
        if !line.contains(' ') || line.split_whitespace().count() == 2 {
            if let Some(first) = line.split_whitespace().next() {
                if let Ok(secs) = first.parse::<f64>() {
                    if secs > 0.0 && uptime_secs == 0 {
                        uptime_secs = secs as u64;
                    }
                }
            }
        }
        // /proc/net/dev — skip lo and headers
        let trimmed = line.trim();
        if trimmed.contains(':') && !trimmed.starts_with("lo:") && !trimmed.starts_with("Inter") && !trimmed.starts_with("face") {
            let parts: Vec<&str> = trimmed.splitn(2, ':').collect();
            if parts.len() == 2 {
                let iface = parts[0].trim();
                let nums: Vec<u64> = parts[1].split_whitespace()
                    .filter_map(|v| v.parse().ok()).collect();
                if nums.len() >= 9 && (net_iface.is_empty() || iface == "eth0" || iface == "ens3" || iface == "ens192") {
                    net_iface = iface.to_string();
                    net_rx = nums[0];
                    net_tx = nums[8];
                }
            }
        }
    }

    // CPU% delta
    let cpu_pct = match prev_cpu {
        Some(prev) => {
            let d_total = cpu_snap.total().saturating_sub(prev.total()) as f64;
            let d_idle = cpu_snap.idle_total().saturating_sub(prev.idle_total()) as f64;
            if d_total > 0.0 { ((1.0 - d_idle / d_total) * 100.0) as f32 } else { 0.0 }
        }
        None => 0.0,
    };

    // Network rate
    let (rx_rate, tx_rate) = match prev_net {
        Some((prev_rx, prev_tx)) if poll_secs > 0.0 => {
            (
                net_rx.saturating_sub(prev_rx) as f64 / poll_secs,
                net_tx.saturating_sub(prev_tx) as f64 / poll_secs,
            )
        }
        _ => (0.0, 0.0),
    };

    let mem_total = *mem.get("MemTotal").unwrap_or(&0);
    let mem_avail = *mem.get("MemAvailable").unwrap_or(&0);
    let mem_cached = *mem.get("Cached").unwrap_or(&0);
    let mem_used = mem_total.saturating_sub(mem_avail);

    let metrics = SystemMetrics {
        cpu_pct,
        mem_total_kb: mem_total,
        mem_used_kb: mem_used,
        mem_cached_kb: mem_cached,
        swap_total_kb: *mem.get("SwapTotal").unwrap_or(&0),
        swap_used_kb: mem.get("SwapTotal").unwrap_or(&0)
            .saturating_sub(*mem.get("SwapFree").unwrap_or(&0)),
        disk_total_kb, disk_used_kb,
        load_1m, load_5m, load_15m,
        uptime_secs,
        net_rx_rate: rx_rate,
        net_tx_rate: tx_rate,
        net_iface,
        cores,
        ip,
    };

    (metrics, cpu_snap, (net_rx, net_tx))
}

/// raw = output of docker ps --no-trunc --format '{"id":"{{.ID}}","name":"{{.Names}}","state":"{{.State}}"}'
/// One JSON object per line (JSONL)
pub(crate) fn parse_docker_ps(raw: &str) -> Vec<(String, String, String)> {
    raw.lines()
        .filter(|l| l.trim_start().starts_with('{'))
        .filter_map(|line| {
            // Parse manually — no serde_json derive needed for this simple structure
            let get = |key: &str| -> String {
                let needle = format!("\"{}\":\"", key);
                line.find(&needle)
                    .map(|i| {
                        let start = i + needle.len();
                        let end = line[start..].find('"').map(|j| start + j).unwrap_or(start);
                        line[start..end].to_string()
                    })
                    .unwrap_or_default()
            };
            let id = get("id");
            let name = get("name");
            let state = get("state");
            if id.is_empty() { None } else { Some((id, name, state)) }
        })
        .collect()
}

/// raw = output of cat /proc/<pid>/cgroup + memory.current + cpu.stat + /proc/<pid>/net/dev
/// prev_cpu_ns: CPU nanoseconds from previous poll for delta
/// poll_secs: poll interval
pub(crate) fn parse_container_cgroup(
    cgroup_raw: &str,
    prev_cpu_ns: Option<u64>,
    prev_net: Option<(u64, u64)>,
    poll_secs: f64,
) -> (f32, u64, u64, f64, f64, Option<u64>) {
    let mut mem_used: u64 = 0;
    let mut mem_limit: u64 = u64::MAX;
    let mut cpu_usage_ns: u64 = 0;
    let mut net_rx: u64 = 0;
    let mut net_tx: u64 = 0;

    for line in cgroup_raw.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() == 1 {
            if let Ok(v) = parts[0].parse::<u64>() {
                if mem_used == 0 { mem_used = v; }
                else if mem_limit == u64::MAX { mem_limit = v; }
            }
        }
        if parts.len() == 2 {
            match parts[0] {
                "usage_usec" => { cpu_usage_ns = parts[1].parse().unwrap_or(0) * 1_000; }
                "usage" => { cpu_usage_ns = parts[1].parse().unwrap_or(0); }
                _ => {}
            }
        }
        // /proc/<pid>/net/dev lines
        let trimmed = line.trim();
        if trimmed.contains(':') && !trimmed.starts_with("lo:") && !trimmed.starts_with("Inter") && !trimmed.starts_with("face") {
            let ps: Vec<&str> = trimmed.splitn(2, ':').collect();
            if ps.len() == 2 {
                let nums: Vec<u64> = ps[1].split_whitespace().filter_map(|v| v.parse().ok()).collect();
                if nums.len() >= 9 {
                    net_rx = nums[0];
                    net_tx = nums[8];
                }
            }
        }
    }

    let cpu_pct = match prev_cpu_ns {
        Some(prev) if poll_secs > 0.0 => {
            let delta_ns = cpu_usage_ns.saturating_sub(prev) as f64;
            ((delta_ns / (poll_secs * 1_000_000_000.0)) * 100.0) as f32
        }
        _ => 0.0,
    };

    let (rx_rate, tx_rate) = match prev_net {
        Some((prev_rx, prev_tx)) if poll_secs > 0.0 => (
            net_rx.saturating_sub(prev_rx) as f64 / poll_secs,
            net_tx.saturating_sub(prev_tx) as f64 / poll_secs,
        ),
        _ => (0.0, 0.0),
    };

    let next_cpu = if cpu_usage_ns > 0 { Some(cpu_usage_ns) } else { None };
    (cpu_pct, mem_used, mem_limit, rx_rate, tx_rate, next_cpu)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_PROC: &str = "\
cpu  100 10 50 800 5 2 3 0 0 0
cpu0 50 5 25 400 2 1 1 0 0 0
cpu1 50 5 25 400 3 1 2 0 0 0
MemTotal:       16384000 kB
MemFree:         4096000 kB
MemAvailable:    8000000 kB
Cached:          2048000 kB
SwapTotal:       2097152 kB
SwapFree:        2000000 kB
0.45 0.32 0.28 2/456 12345
12345.67 23456.78
Inter-|   Receive   |  Transmit
 face |bytes packets|bytes packets
    lo:   1000      0    0 1000   0
  eth0: 5000000  50000    0    0    0     0          0         0 2000000  20000
";

    #[test]
    fn test_parse_cpu_first_poll_returns_zero() {
        let (metrics, snap, _) = parse_proc_output(SAMPLE_PROC, None, None, 30.0);
        assert_eq!(metrics.cpu_pct, 0.0, "first poll should be zero");
        assert_eq!(snap.user, 100);
        assert_eq!(snap.idle, 800);
    }

    #[test]
    fn test_parse_cpu_delta() {
        let prev = CpuSnapshot { user: 100, nice: 10, system: 50, idle: 800, iowait: 5, irq: 2, softirq: 3 };
        // second poll: 50 ticks work, 200 ticks idle
        let raw2 = "\
cpu  150 10 50 1000 5 2 3 0 0 0
cpu0 75 5 25 500 2 1 1 0 0 0
cpu1 75 5 25 500 3 1 2 0 0 0
MemTotal: 16384000 kB
MemFree: 4096000 kB
MemAvailable: 8000000 kB
Cached: 2048000 kB
SwapTotal: 0 kB
SwapFree: 0 kB
0.45 0.32 0.28 2/456
123.0 456.0
lo: 0 0 0 0 0 0 0 0 0 0
eth0: 5100000 0 0 0 0 0 0 0 2100000 0
";
        let (metrics, _, _) = parse_proc_output(raw2, Some(&prev), Some((5000000, 2000000)), 30.0);
        // delta: total=250 idle=200 → cpu=(250-200)/250*100 = 20%
        assert!((metrics.cpu_pct - 20.0).abs() < 1.0, "CPU should be ~20%, was: {}", metrics.cpu_pct);
        assert_eq!(metrics.cores, 2);
        assert_eq!(metrics.mem_total_kb, 16384000);
        // net rate: (5100000-5000000)/30 = 3333 bytes/sec
        assert!((metrics.net_rx_rate - 3333.0).abs() < 10.0);
    }

    #[test]
    fn test_parse_docker_ps() {
        let raw = r#"{"id":"abc123","name":"web-app","state":"running"}
{"id":"def456","name":"db","state":"exited"}
"#;
        let result = parse_docker_ps(raw);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].0, "abc123");
        assert_eq!(result[0].1, "web-app");
        assert_eq!(result[0].2, "running");
        assert_eq!(result[1].2, "exited");
    }

    #[test]
    fn test_parse_docker_ps_no_docker() {
        let result = parse_docker_ps("__nodock__");
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_container_cgroup_first_poll() {
        let raw = "10485760\n8589934592\nusage_usec 500000\n";
        let (cpu, mem_used, mem_limit, _, _, next_cpu) = parse_container_cgroup(raw, None, None, 30.0);
        assert_eq!(cpu, 0.0);
        assert_eq!(mem_used, 10485760);
        assert_eq!(mem_limit, 8589934592);
        assert_eq!(next_cpu, Some(500_000_000)); // 500_000 µs × 1000 = 500_000_000 ns
    }
}
