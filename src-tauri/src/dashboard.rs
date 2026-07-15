use serde::Serialize;
use ssh2::Session;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// ─── Internal type aliases ────────────────────────────────────────────────────

/// Return of `parse_container_cgroup`: current-poll rates plus the cumulative counters to
/// hand back as `prev_*` on the next poll (`None` when the source file was unreadable, so a
/// stale delta isn't computed against a value that was never actually read).
pub(crate) struct ContainerCgroupSample {
    pub cpu_pct: f32,
    pub mem_used: u64,
    pub mem_limit: u64,
    pub net_rx_rate: f64,
    pub net_tx_rate: f64,
    pub disk_read_rate: f64,
    pub disk_write_rate: f64,
    pub next_cpu_ns: Option<u64>,
    pub next_net: Option<(u64, u64)>,
    pub next_io: Option<(u64, u64)>,
}

// ─── Public types emitted to frontend ────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreMetrics {
    pub total: f32,
    pub user: f32,
    pub system: f32,
    pub nice: f32,
    pub iowait: f32,
    pub steal: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMetrics {
    pub cpu_pct: f32,
    pub cpu_cores: Vec<CoreMetrics>,
    pub mem_total_kb: u64,
    pub mem_used_kb: u64,
    pub mem_cached_kb: u64,
    pub swap_total_kb: u64,
    pub swap_used_kb: u64,
    pub disk_total_kb: u64,
    pub disk_used_kb: u64,
    pub disk_read_rate: f64,        // bytes/sec
    pub disk_write_rate: f64,       // bytes/sec
    pub disk_iops: f64,             // ops/sec
    pub disk_read_latency_ms: f32,  // avg ms per read op
    pub disk_write_latency_ms: f32, // avg ms per write op
    pub disk_dev: String,
    pub load_1m: f32,
    pub load_5m: f32,
    pub load_15m: f32,
    pub uptime_secs: u64,
    pub net_rx_rate: f64, // bytes/sec since last poll
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
    pub status_text: String,               // e.g. "Up 3 hours", "Exited (137) 2 minutes ago"
    pub health: Option<String>,             // "healthy" | "unhealthy" | "starting", from the status suffix
    pub restart_count: u32,
    pub cpu_pct: f32,
    pub mem_used_bytes: u64,
    pub mem_limit_bytes: u64,
    pub net_rx_rate: f64,
    pub net_tx_rate: f64,
    pub disk_read_rate: f64,  // bytes/sec, from cgroup blkio/io.stat
    pub disk_write_rate: f64, // bytes/sec
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

/// Cheap running/stopped container counts, collected on every poll (including the 30s
/// overview poll) so container trouble is visible on the overview cards without opening a
/// host's detail view. `None` means Docker isn't installed on the host.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSummary {
    pub running: u32,
    pub stopped: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPollResult {
    pub host_id: String,
    pub ok: bool,
    pub system: Option<SystemMetrics>,
    pub container_summary: Option<ContainerSummary>,
    pub containers: Option<Vec<ContainerMetric>>,
    pub processes: Option<Vec<ProcessInfo>>,
    pub error: Option<String>,
    pub latency_ms: Option<f32>,
}

/// Connection lifecycle event for a host actor, independent of poll results —
/// lets the frontend show Connecting/Online/Offline/Reconnecting without
/// waiting on (or inferring from) the next poll payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashStatus {
    pub host_id: String,
    pub phase: String, // "connecting" | "online" | "offline" | "reconnecting"
    pub error: Option<String>,
}

fn emit_status(app: &AppHandle, host_id: &str, phase: &str, error: Option<String>) {
    let _ = app.emit(
        "dash:status",
        DashStatus {
            host_id: host_id.to_string(),
            phase: phase.to_string(),
            error,
        },
    );
}

// ─── Internal delta state ─────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub(crate) struct DiskSnapshot {
    pub dev: String,
    pub reads_completed: u64,
    pub sectors_read: u64,
    pub ms_reading: u64,
    pub writes_completed: u64,
    pub sectors_written: u64,
    pub ms_writing: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct CpuSnapshot {
    pub user: u64,
    pub nice: u64,
    pub system: u64,
    pub idle: u64,
    pub iowait: u64,
    pub irq: u64,
    pub softirq: u64,
}

impl CpuSnapshot {
    pub fn total(&self) -> u64 {
        self.user + self.nice + self.system + self.idle + self.iowait + self.irq + self.softirq
    }
    pub fn idle_total(&self) -> u64 {
        self.idle + self.iowait
    }
}

/// raw = output of: cat /proc/stat /proc/meminfo /proc/loadavg /proc/uptime /proc/net/dev
/// prev_cpu: snapshot from previous poll for delta CPU
/// Returns (metrics, aggregate_snap, net, per_core_snaps, disk_snap)
pub(crate) fn parse_proc_output(
    raw: &str,
    prev_cpu: Option<&CpuSnapshot>,
    prev_net: Option<(u64, u64)>,
    poll_secs: f64,
    prev_cpu_cores: &[CpuSnapshot],
    prev_disk: Option<&DiskSnapshot>,
) -> (
    SystemMetrics,
    CpuSnapshot,
    (u64, u64),
    Vec<CpuSnapshot>,
    Option<DiskSnapshot>,
) {
    let mut cpu_snap = CpuSnapshot {
        user: 0,
        nice: 0,
        system: 0,
        idle: 0,
        iowait: 0,
        irq: 0,
        softirq: 0,
    };
    let mut cpu_core_snaps: Vec<CpuSnapshot> = Vec::new();
    let mut mem: HashMap<&str, u64> = HashMap::new();
    let mut load_1m = 0f32;
    let mut load_5m = 0f32;
    let mut load_15m = 0f32;
    let mut uptime_secs = 0u64;
    let mut net_iface = String::new();
    let mut net_rx = 0u64;
    let mut net_tx = 0u64;
    let disk_total_kb = 0u64;
    let disk_used_kb = 0u64;
    let mut cores = 0u32;
    let ip = String::new();
    // Collect all real disk devices from /proc/diskstats; pick highest-traffic one
    let mut disk_snaps: Vec<DiskSnapshot> = Vec::new();

    for line in raw.lines() {
        // /proc/stat — cpu aggregate line
        if line.starts_with("cpu ") {
            let p: Vec<u64> = line
                .split_whitespace()
                .skip(1)
                .filter_map(|v| v.parse().ok())
                .collect();
            if p.len() >= 7 {
                cpu_snap = CpuSnapshot {
                    user: p[0],
                    nice: p[1],
                    system: p[2],
                    idle: p[3],
                    iowait: p[4],
                    irq: p[5],
                    softirq: p[6],
                };
            }
        }
        // /proc/stat — per-core lines: count and snapshot each core
        if line.starts_with("cpu")
            && line.len() > 3
            && line
                .chars()
                .nth(3)
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
        {
            cores += 1;
            let p: Vec<u64> = line
                .split_whitespace()
                .skip(1)
                .filter_map(|v| v.parse().ok())
                .collect();
            if p.len() >= 7 {
                cpu_core_snaps.push(CpuSnapshot {
                    user: p[0],
                    nice: p[1],
                    system: p[2],
                    idle: p[3],
                    iowait: p[4],
                    irq: p[5],
                    softirq: p[6],
                });
            }
        }
        // /proc/meminfo
        if let Some((k, v)) = line.split_once(':') {
            let v: u64 = v
                .split_whitespace()
                .next()
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
            match k.trim() {
                "MemTotal" => {
                    mem.insert("MemTotal", v);
                }
                "MemAvailable" => {
                    mem.insert("MemAvailable", v);
                }
                "Cached" => {
                    mem.insert("Cached", v);
                }
                "SwapTotal" => {
                    mem.insert("SwapTotal", v);
                }
                "SwapFree" => {
                    mem.insert("SwapFree", v);
                }
                _ => {}
            }
        }
        // /proc/loadavg — exactly 5 tokens, 4th contains '/' (e.g. "0.45 0.32 0.28 2/456 12345")
        {
            let p: Vec<&str> = line.split_whitespace().collect();
            if p.len() == 5 && p[3].contains('/') {
                if let (Ok(a), Ok(b), Ok(c)) = (
                    p[0].parse::<f32>(),
                    p[1].parse::<f32>(),
                    p[2].parse::<f32>(),
                ) {
                    load_1m = a;
                    load_5m = b;
                    load_15m = c;
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
        if trimmed.contains(':')
            && !trimmed.starts_with("lo:")
            && !trimmed.starts_with("Inter")
            && !trimmed.starts_with("face")
        {
            let parts: Vec<&str> = trimmed.splitn(2, ':').collect();
            if parts.len() == 2 {
                let iface = parts[0].trim();
                let nums: Vec<u64> = parts[1]
                    .split_whitespace()
                    .filter_map(|v| v.parse().ok())
                    .collect();
                if nums.len() >= 9
                    && (net_iface.is_empty()
                        || iface == "eth0"
                        || iface == "ens3"
                        || iface == "ens192")
                {
                    net_iface = iface.to_string();
                    net_rx = nums[0];
                    net_tx = nums[8];
                }
            }
        }
        // /proc/diskstats — "  8   0 sda reads_completed reads_merged sectors_read ms_reading writes ..."
        // Fields: major minor devname [14 numeric fields]
        {
            let f: Vec<&str> = trimmed.split_whitespace().collect();
            if f.len() >= 14 && f[0].parse::<u32>().is_ok() && f[1].parse::<u32>().is_ok() {
                let dev = f[2];
                if is_whole_disk(dev) {
                    let n = |i: usize| f.get(i).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
                    disk_snaps.push(DiskSnapshot {
                        dev: dev.to_string(),
                        reads_completed: n(3),
                        sectors_read: n(5),
                        ms_reading: n(6),
                        writes_completed: n(7),
                        sectors_written: n(9),
                        ms_writing: n(10),
                    });
                }
            }
        }
    }

    // Aggregate CPU% delta
    let cpu_pct = match prev_cpu {
        Some(prev) => {
            let d_total = cpu_snap.total().saturating_sub(prev.total()) as f64;
            let d_idle = cpu_snap.idle_total().saturating_sub(prev.idle_total()) as f64;
            if d_total > 0.0 {
                ((1.0 - d_idle / d_total) * 100.0) as f32
            } else {
                0.0
            }
        }
        None => 0.0,
    };

    // Per-core CPU% delta (empty on first poll — no previous snapshots)
    let cpu_cores: Vec<CoreMetrics> =
        if prev_cpu_cores.len() == cpu_core_snaps.len() && !prev_cpu_cores.is_empty() {
            cpu_core_snaps
                .iter()
                .zip(prev_cpu_cores.iter())
                .map(|(cur, prev)| {
                    let d_total = cur.total().saturating_sub(prev.total()) as f64;
                    let d_idle = cur.idle_total().saturating_sub(prev.idle_total()) as f64;
                    let d_user = cur.user.saturating_sub(prev.user) as f64;
                    let d_sys = cur.system.saturating_sub(prev.system) as f64;
                    let d_nice = cur.nice.saturating_sub(prev.nice) as f64;
                    let d_io = cur.iowait.saturating_sub(prev.iowait) as f64;
                    let d_steal = cur.softirq.saturating_sub(prev.softirq) as f64; // steal not in CpuSnapshot; use softirq placeholder
                    if d_total > 0.0 {
                        let scale = 100.0 / d_total;
                        let total = ((1.0 - d_idle / d_total) * 100.0) as f32;
                        CoreMetrics {
                            total,
                            user: (d_user * scale) as f32,
                            system: (d_sys * scale) as f32,
                            nice: (d_nice * scale) as f32,
                            iowait: (d_io * scale) as f32,
                            steal: (d_steal * scale) as f32,
                        }
                    } else {
                        CoreMetrics {
                            total: 0.0,
                            user: 0.0,
                            system: 0.0,
                            nice: 0.0,
                            iowait: 0.0,
                            steal: 0.0,
                        }
                    }
                })
                .collect()
        } else {
            vec![]
        };

    // Network rate
    let (rx_rate, tx_rate) = match prev_net {
        Some((prev_rx, prev_tx)) if poll_secs > 0.0 => (
            net_rx.saturating_sub(prev_rx) as f64 / poll_secs,
            net_tx.saturating_sub(prev_tx) as f64 / poll_secs,
        ),
        _ => (0.0, 0.0),
    };

    let mem_total = *mem.get("MemTotal").unwrap_or(&0);
    let mem_avail = *mem.get("MemAvailable").unwrap_or(&0);
    let mem_cached = *mem.get("Cached").unwrap_or(&0);
    let mem_used = mem_total.saturating_sub(mem_avail);

    // Pick the disk with highest total I/O among whole-disk devices
    let cur_disk = disk_snaps
        .into_iter()
        .max_by_key(|d| d.reads_completed + d.writes_completed);

    let (
        disk_read_rate,
        disk_write_rate,
        disk_iops,
        disk_read_latency_ms,
        disk_write_latency_ms,
        disk_dev,
        new_disk,
    ) = match (&cur_disk, prev_disk) {
        (Some(cur), Some(prev)) if cur.dev == prev.dev && poll_secs > 0.0 => {
            let d_reads = cur.reads_completed.saturating_sub(prev.reads_completed) as f64;
            let d_writes = cur.writes_completed.saturating_sub(prev.writes_completed) as f64;
            let d_sr = cur.sectors_read.saturating_sub(prev.sectors_read) as f64;
            let d_sw = cur.sectors_written.saturating_sub(prev.sectors_written) as f64;
            let d_ms_r = cur.ms_reading.saturating_sub(prev.ms_reading) as f64;
            let d_ms_w = cur.ms_writing.saturating_sub(prev.ms_writing) as f64;
            let read_lat = if d_reads > 0.0 {
                (d_ms_r / d_reads) as f32
            } else {
                0.0
            };
            let write_lat = if d_writes > 0.0 {
                (d_ms_w / d_writes) as f32
            } else {
                0.0
            };
            (
                d_sr * 512.0 / poll_secs, // bytes/sec
                d_sw * 512.0 / poll_secs,
                (d_reads + d_writes) / poll_secs,
                read_lat,
                write_lat,
                cur.dev.clone(),
                cur_disk,
            )
        }
        (Some(cur), _) => (0.0, 0.0, 0.0, 0.0, 0.0, cur.dev.clone(), cur_disk),
        _ => (0.0, 0.0, 0.0, 0.0, 0.0, String::new(), None),
    };

    let metrics = SystemMetrics {
        cpu_pct,
        cpu_cores,
        mem_total_kb: mem_total,
        mem_used_kb: mem_used,
        mem_cached_kb: mem_cached,
        swap_total_kb: *mem.get("SwapTotal").unwrap_or(&0),
        swap_used_kb: mem
            .get("SwapTotal")
            .unwrap_or(&0)
            .saturating_sub(*mem.get("SwapFree").unwrap_or(&0)),
        disk_total_kb,
        disk_used_kb,
        disk_read_rate,
        disk_write_rate,
        disk_iops,
        disk_read_latency_ms,
        disk_write_latency_ms,
        disk_dev,
        load_1m,
        load_5m,
        load_15m,
        uptime_secs,
        net_rx_rate: rx_rate,
        net_tx_rate: tx_rate,
        net_iface,
        cores,
        ip,
    };

    (
        metrics,
        cpu_snap,
        (net_rx, net_tx),
        cpu_core_snaps,
        new_disk,
    )
}

fn is_whole_disk(dev: &str) -> bool {
    if dev.starts_with("loop")
        || dev.starts_with("dm-")
        || dev.starts_with("ram")
        || dev.starts_with("sr")
    {
        return false;
    }
    // nvme: nvme0n1 is whole disk, nvme0n1p1 is a partition
    if dev.starts_with("nvme") {
        return !dev.contains('p');
    }
    // sda, vda, xvda, hda — whole disk has no trailing digit
    !dev.ends_with(|c: char| c.is_ascii_digit())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DockerPsEntry {
    pub id: String,
    pub name: String,
    pub state: String,
    pub status_text: String,
}

/// raw = output of `docker ps -a --no-trunc --format '{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Status}}'`
/// (docker expands `\t`/`\n` escapes in the format string itself, independent of shell quoting)
pub(crate) fn parse_docker_ps(raw: &str) -> Vec<DockerPsEntry> {
    raw.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.splitn(4, '\t').collect();
            let id = *fields.first()?;
            if id.is_empty() {
                return None;
            }
            Some(DockerPsEntry {
                id: id.to_string(),
                name: fields.get(1).copied().unwrap_or_default().to_string(),
                state: fields.get(2).copied().unwrap_or_default().to_string(),
                status_text: fields.get(3).copied().unwrap_or_default().to_string(),
            })
        })
        .collect()
}

/// Extracts a health suffix like "(healthy)" / "(unhealthy)" / "(health: starting)" from a
/// `docker ps` Status string, e.g. "Up 3 hours (healthy)".
pub(crate) fn parse_health(status_text: &str) -> Option<String> {
    let start = status_text.rfind('(')?;
    let end = status_text.rfind(')')?;
    if end <= start {
        return None;
    }
    let inner = &status_text[start + 1..end];
    let health = inner.strip_prefix("health: ").unwrap_or(inner);
    match health {
        "healthy" | "unhealthy" | "starting" => Some(health.to_string()),
        _ => None,
    }
}

/// raw = the `===STATS===`-delimited block from the batched docker collection exec: for each
/// running container, a `CID=<id> PID=<pid> RC=<restart_count>` header line followed by the
/// same cgroup+net shape `parse_container_cgroup` already understands, terminated by `===END===`.
pub(crate) struct ContainerStatsEntry {
    pub restart_count: u32,
    pub sample: ContainerCgroupSample,
}

pub(crate) fn parse_container_stats_batch(
    stats_raw: &str,
    prev_cpu: &HashMap<String, u64>,
    prev_net: &HashMap<String, (u64, u64)>,
    prev_io: &HashMap<String, (u64, u64)>,
    poll_secs: f64,
) -> HashMap<String, ContainerStatsEntry> {
    let mut out = HashMap::new();
    for block in stats_raw.split("===END===") {
        let block = block.trim_start_matches('\n');
        let (header, rest) = match block.split_once('\n') {
            Some(v) => v,
            None => continue,
        };
        if !header.starts_with("CID=") {
            continue;
        }
        let mut id = String::new();
        let mut restart_count: u32 = 0;
        for tok in header.split_whitespace() {
            if let Some(v) = tok.strip_prefix("CID=") {
                id = v.to_string();
            } else if let Some(v) = tok.strip_prefix("RC=") {
                restart_count = v.parse().unwrap_or(0);
            }
        }
        if id.is_empty() {
            continue;
        }
        let sample = parse_container_cgroup(
            rest,
            prev_cpu.get(&id).copied(),
            prev_net.get(&id).copied(),
            prev_io.get(&id).copied(),
            poll_secs,
        );
        out.insert(id, ContainerStatsEntry { restart_count, sample });
    }
    out
}

/// Sums cumulative read/write bytes out of a container's block-IO accounting file. Handles
/// both cgroup v2 `io.stat` (`<maj>:<min> rbytes=N wbytes=N rios=N wios=N dbytes=N dios=N`,
/// one line per backing device) and cgroup v1 `blkio.throttle.io_service_bytes`
/// (`<maj>:<min> Read|Write|Sync|Async|Discard|Total N`, same per-device shape plus a grand
/// "Total N" footer that's skipped so devices aren't double-counted).
pub(crate) fn parse_container_io_bytes(io_raw: &str) -> (u64, u64) {
    let mut read_bytes = 0u64;
    let mut write_bytes = 0u64;

    for line in io_raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        if line.contains("rbytes=") || line.contains("wbytes=") {
            for field in line.split_whitespace() {
                if let Some(v) = field.strip_prefix("rbytes=") {
                    read_bytes += v.parse::<u64>().unwrap_or(0);
                } else if let Some(v) = field.strip_prefix("wbytes=") {
                    write_bytes += v.parse::<u64>().unwrap_or(0);
                }
            }
            continue;
        }

        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() == 3 {
            match parts[1] {
                "Read" => read_bytes += parts[2].parse::<u64>().unwrap_or(0),
                "Write" => write_bytes += parts[2].parse::<u64>().unwrap_or(0),
                _ => {} // Sync/Async/Discard/Total — redundant with Read+Write, skip
            }
        }
    }

    (read_bytes, write_bytes)
}

/// raw = memory.current + memory.max + cpu.stat, then `===IO===`, then the block-IO
/// accounting file, then `===NET===`, then /proc/<pid>/net/dev — see the batched exec built
/// in `collect_docker_metrics`. Explicit markers (rather than sniffing line shape) keep the
/// net-dev parser from misreading `io.stat`'s `<maj>:<min> ...` lines, which also contain ':'.
pub(crate) fn parse_container_cgroup(
    cgroup_raw: &str,
    prev_cpu_ns: Option<u64>,
    prev_net: Option<(u64, u64)>,
    prev_io: Option<(u64, u64)>,
    poll_secs: f64,
) -> ContainerCgroupSample {
    let (mem_cpu_part, rest) = cgroup_raw.split_once("===IO===\n").unwrap_or((cgroup_raw, ""));
    let (io_part, net_part) = rest.split_once("===NET===\n").unwrap_or((rest, ""));

    let mut mem_used: u64 = 0;
    let mut mem_limit: u64 = u64::MAX;
    let mut cpu_usage_ns: u64 = 0;

    for line in mem_cpu_part.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() == 1 {
            if let Ok(v) = parts[0].parse::<u64>() {
                if mem_used == 0 {
                    mem_used = v;
                } else if mem_limit == u64::MAX {
                    mem_limit = v;
                }
            }
        }
        if parts.len() == 2 {
            match parts[0] {
                "usage_usec" => {
                    cpu_usage_ns = parts[1].parse().unwrap_or(0) * 1_000;
                }
                "usage" => {
                    cpu_usage_ns = parts[1].parse().unwrap_or(0);
                }
                _ => {}
            }
        }
    }

    let (read_bytes, write_bytes) = parse_container_io_bytes(io_part);

    let mut net_rx: u64 = 0;
    let mut net_tx: u64 = 0;
    for line in net_part.lines() {
        let trimmed = line.trim();
        if trimmed.contains(':')
            && !trimmed.starts_with("lo:")
            && !trimmed.starts_with("Inter")
            && !trimmed.starts_with("face")
        {
            let ps: Vec<&str> = trimmed.splitn(2, ':').collect();
            if ps.len() == 2 {
                let nums: Vec<u64> = ps[1]
                    .split_whitespace()
                    .filter_map(|v| v.parse().ok())
                    .collect();
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

    let (net_rx_rate, net_tx_rate) = match prev_net {
        Some((prev_rx, prev_tx)) if poll_secs > 0.0 => (
            net_rx.saturating_sub(prev_rx) as f64 / poll_secs,
            net_tx.saturating_sub(prev_tx) as f64 / poll_secs,
        ),
        _ => (0.0, 0.0),
    };

    let (disk_read_rate, disk_write_rate) = match prev_io {
        Some((prev_read, prev_write)) if poll_secs > 0.0 => (
            read_bytes.saturating_sub(prev_read) as f64 / poll_secs,
            write_bytes.saturating_sub(prev_write) as f64 / poll_secs,
        ),
        _ => (0.0, 0.0),
    };

    let next_cpu_ns = if cpu_usage_ns > 0 { Some(cpu_usage_ns) } else { None };
    let next_net = if net_rx > 0 || net_tx > 0 { Some((net_rx, net_tx)) } else { None };
    let next_io = if read_bytes > 0 || write_bytes > 0 {
        Some((read_bytes, write_bytes))
    } else {
        None
    };

    ContainerCgroupSample {
        cpu_pct,
        mem_used,
        mem_limit,
        net_rx_rate,
        net_tx_rate,
        disk_read_rate,
        disk_write_rate,
        next_cpu_ns,
        next_net,
        next_io,
    }
}

// ─── Actor types ─────────────────────────────────────────────────────────────

pub enum ActorCmd {
    /// Poll system metrics, optionally including processes and/or docker containers.
    /// System metrics are always collected; the other two are opt-in per request so the
    /// 30s overview poll (all hosts) doesn't pay for docker/process collection that only
    /// the open detail view needs.
    Poll {
        want_processes: bool,
        want_containers: bool,
        reply: tokio::sync::oneshot::Sender<HostPollResult>,
    },
    /// Frontend signal that a host's detail view opened/closed. While watching, a second
    /// dedicated SSH session short-polls `docker events` so a container dying/restarting is
    /// picked up in ~1-2s instead of waiting for the next 5s detail poll.
    WatchContainers(bool),
    /// Internal wake-up from the events watcher thread: do an out-of-band container poll
    /// and emit it directly, no reply channel — nothing is synchronously waiting on it.
    PokeContainers,
    Disconnect,
}

pub struct HostActor {
    pub(crate) tx: std::sync::mpsc::SyncSender<ActorCmd>,
}

/// Bounds how many SSH handshakes can be in flight at once. Without this, connecting to
/// e.g. 30 hosts at dashboard load fires 30 concurrent handshakes; with it, hosts connect
/// as a rolling wave and cards flip from Connecting to Online progressively.
pub struct ConnectGate {
    count: std::sync::Mutex<usize>,
    cvar: std::sync::Condvar,
    max: usize,
}

impl ConnectGate {
    pub fn new(max: usize) -> Self {
        Self {
            count: std::sync::Mutex::new(0),
            cvar: std::sync::Condvar::new(),
            max,
        }
    }

    fn acquire(&self) {
        let mut count = self.count.lock().unwrap();
        while *count >= self.max {
            count = self.cvar.wait(count).unwrap();
        }
        *count += 1;
    }

    fn release(&self) {
        let mut count = self.count.lock().unwrap();
        *count = count.saturating_sub(1);
        self.cvar.notify_one();
    }
}

// ─── SSH helpers ──────────────────────────────────────────────────────────────

fn ssh_connect(
    hostname: &str,
    port: u16,
    user: &str,
    password: Option<&str>,
    key_path: Option<&std::path::Path>,
) -> Result<Session, String> {
    let cfg = crate::ssh::SshConfig {
        hostname,
        port,
        username: user,
        password,
        key_path,
    };
    crate::ssh::connect(&cfg, |_stage, _msg| {}).map_err(String::from)
}

fn exec_cmd(session: &Session, cmd: &str) -> Result<String, String> {
    crate::ssh::exec(session, cmd)
}

// ─── Actor internals ──────────────────────────────────────────────────────────

struct ActorState {
    session: Session,
    prev_cpu: Option<CpuSnapshot>,
    prev_cpu_cores: Vec<CpuSnapshot>,
    prev_net: Option<(u64, u64)>,
    prev_disk: Option<DiskSnapshot>,
    prev_container_cpu: HashMap<String, u64>, // container_id → cpu_ns
    prev_container_net: HashMap<String, (u64, u64)>,
    prev_container_io: HashMap<String, (u64, u64)>, // container_id → (read_bytes, write_bytes)
    has_docker: Option<bool>,
    last_poll: Option<Instant>,
    prev_proc_ticks: HashMap<u32, u64>, // pid → utime+stime at last sample
    prev_total_ticks_for_proc: u64,     // aggregate CPU ticks at last process sample
}

struct ActorConfig {
    host_id: String,
    hostname: String,
    port: u16,
    user: String,
    password: Option<String>,
    key_path: Option<std::path::PathBuf>,
    gate: std::sync::Arc<ConnectGate>,
    /// Clone of this actor's own command sender, handed to the events-watcher thread so it
    /// can loop `PokeContainers` back into the main actor loop.
    self_tx: std::sync::mpsc::SyncSender<ActorCmd>,
}

/// Blocks (via `rx.recv_timeout`) retrying the SSH connection with backoff until it
/// succeeds or a `Disconnect` arrives. `Poll` commands received while waiting are
/// answered with the current error so callers don't hang. Returns `None` if the actor
/// should terminate.
#[allow(clippy::too_many_arguments)]
fn connect_with_backoff(
    app: &AppHandle,
    host_id: &str,
    hostname: &str,
    port: u16,
    user: &str,
    password: Option<&str>,
    key_path: Option<&std::path::Path>,
    gate: &ConnectGate,
    rx: &std::sync::mpsc::Receiver<ActorCmd>,
) -> Option<Session> {
    const BACKOFF_SECS: [u64; 3] = [5, 15, 60];
    let mut attempt = 0usize;
    loop {
        gate.acquire();
        let result = ssh_connect(hostname, port, user, password, key_path);
        gate.release();

        match result {
            Ok(s) => {
                emit_status(app, host_id, "online", None);
                return Some(s);
            }
            Err(e) => {
                emit_status(app, host_id, "offline", Some(e.clone()));
                let wait = Duration::from_secs(BACKOFF_SECS[attempt.min(BACKOFF_SECS.len() - 1)]);
                attempt += 1;
                match rx.recv_timeout(wait) {
                    Ok(ActorCmd::Disconnect)
                    | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return None,
                    Ok(ActorCmd::Poll { reply, .. }) => {
                        let _ = reply.send(HostPollResult {
                            host_id: host_id.to_string(),
                            ok: false,
                            system: None,
                            container_summary: None,
                            containers: None,
                            processes: None,
                            error: Some(e),
                            latency_ms: None,
                        });
                    }
                    // Not connected yet — nothing to watch/poke; the frontend will still be
                    // sending its regular Poll requests once the connection recovers.
                    Ok(ActorCmd::WatchContainers(_)) | Ok(ActorCmd::PokeContainers) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                }
                emit_status(app, host_id, "reconnecting", None);
            }
        }
    }
}

fn run_actor(app: AppHandle, cfg: ActorConfig, rx: std::sync::mpsc::Receiver<ActorCmd>) {
    let ActorConfig {
        host_id,
        hostname,
        port,
        user,
        password,
        key_path,
        gate,
        self_tx,
    } = cfg;

    // Set only while a host's detail view is open (see ActorCmd::WatchContainers).
    let mut watcher_stop: Option<std::sync::Arc<std::sync::atomic::AtomicBool>> = None;

    emit_status(&app, &host_id, "connecting", None);

    let session = match connect_with_backoff(
        &app,
        &host_id,
        &hostname,
        port,
        &user,
        password.as_deref(),
        key_path.as_deref(),
        &gate,
        &rx,
    ) {
        Some(s) => s,
        None => return, // Disconnect received while retrying the initial connection
    };

    let mut state = ActorState {
        session,
        prev_cpu: None,
        prev_cpu_cores: vec![],
        prev_net: None,
        prev_disk: None,
        prev_container_cpu: HashMap::new(),
        prev_container_net: HashMap::new(),
        prev_container_io: HashMap::new(),
        has_docker: None,
        last_poll: None,
        prev_proc_ticks: HashMap::new(),
        prev_total_ticks_for_proc: 0,
    };

    loop {
        // recv_timeout → send keepalive if idle for 10s
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(ActorCmd::Disconnect) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                if let Some(stop) = watcher_stop.take() {
                    stop.store(true, std::sync::atomic::Ordering::Relaxed);
                }
                break;
            }

            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // keepalive — no poll
                state.session.keepalive_send().ok();
                continue;
            }

            Ok(ActorCmd::WatchContainers(watch)) => {
                if watch {
                    if watcher_stop.is_none() {
                        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                        watcher_stop = Some(stop.clone());
                        let watcher_cfg = EventsWatcherConfig {
                            hostname: hostname.clone(),
                            port,
                            user: user.clone(),
                            password: password.clone(),
                            key_path: key_path.clone(),
                            self_tx: self_tx.clone(),
                            stop,
                        };
                        std::thread::Builder::new()
                            .name(format!("dashboard-events-{}", host_id))
                            .spawn(move || run_events_watcher(watcher_cfg))
                            .ok();
                    }
                } else if let Some(stop) = watcher_stop.take() {
                    stop.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            }

            Ok(ActorCmd::PokeContainers) => {
                // Best-effort out-of-band refresh triggered by a docker events line — the
                // regular 5s detail poll is the reliable fallback, so failures here are fine
                // to just drop.
                let now = Instant::now();
                let poll_secs = state
                    .last_poll
                    .map(|t| t.elapsed().as_secs_f64())
                    .unwrap_or(5.0);
                state.last_poll = Some(now);
                if let Ok(result) = do_poll(&mut state, &host_id, false, true, poll_secs) {
                    let _ = app.emit("dash:stat", result);
                }
            }

            Ok(ActorCmd::Poll {
                want_processes,
                want_containers,
                reply,
            }) => {
                let now = Instant::now();
                let poll_secs = state
                    .last_poll
                    .map(|t| t.elapsed().as_secs_f64())
                    .unwrap_or(30.0);
                state.last_poll = Some(now);

                let result = do_poll(&mut state, &host_id, want_processes, want_containers, poll_secs);

                // If the session died, retry with backoff and re-poll once reconnected.
                let result = if result.is_err() {
                    emit_status(&app, &host_id, "reconnecting", None);
                    match connect_with_backoff(
                        &app,
                        &host_id,
                        &hostname,
                        port,
                        &user,
                        password.as_deref(),
                        key_path.as_deref(),
                        &gate,
                        &rx,
                    ) {
                        Some(new_session) => {
                            state.session = new_session;
                            state.prev_cpu = None;
                            state.prev_net = None;
                            state.prev_container_cpu.clear();
                            state.prev_container_net.clear();
                            state.prev_container_io.clear();
                            do_poll(&mut state, &host_id, want_processes, want_containers, poll_secs)
                        }
                        None => {
                            // Disconnect received while retrying
                            if let Some(stop) = watcher_stop.take() {
                                stop.store(true, std::sync::atomic::Ordering::Relaxed);
                            }
                            return;
                        }
                    }
                } else {
                    result
                };

                let payload = match result {
                    Ok(r) => r,
                    Err(e) => HostPollResult {
                        host_id: host_id.clone(),
                        ok: false,
                        system: None,
                        container_summary: None,
                        containers: None,
                        processes: None,
                        error: Some(e),
                        latency_ms: None,
                    },
                };
                let _ = reply.send(payload);
            }
        }
    }
}

struct EventsWatcherConfig {
    hostname: String,
    port: u16,
    user: String,
    password: Option<String>,
    key_path: Option<std::path::PathBuf>,
    self_tx: std::sync::mpsc::SyncSender<ActorCmd>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

/// Runs on a dedicated SSH session (never shared with the actor's primary session — no
/// cross-thread access to a single `ssh2::Session`) for as long as a host's detail view is
/// open. Rather than a single long-lived `docker events` stream — which would need a way to
/// force-interrupt a blocked read from another thread to stop promptly — this short-polls a
/// 2s-bounded `docker events` window in a loop via the remote `timeout` command. Each
/// non-empty window pokes the actor to do an immediate container refresh (throttled to at
/// most once per 500ms), so container state changes surface in ~1-2s instead of waiting for
/// the next scheduled 5s poll. It's a best-effort accelerant, not the source of truth — the
/// regular detail poll keeps running regardless.
fn run_events_watcher(cfg: EventsWatcherConfig) {
    let EventsWatcherConfig {
        hostname,
        port,
        user,
        password,
        key_path,
        self_tx,
        stop,
    } = cfg;

    let session = match ssh_connect(&hostname, port, &user, password.as_deref(), key_path.as_deref()) {
        Ok(s) => s,
        Err(_) => return, // best-effort — container state still refreshes via the 5s poll
    };

    let mut last_poke = Instant::now()
        .checked_sub(Duration::from_secs(1))
        .unwrap_or_else(Instant::now);

    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
        let raw = exec_cmd(
            &session,
            "timeout 2 docker events --filter type=container --format '{{.Status}}' 2>/dev/null",
        );
        match raw {
            Ok(out) if !out.trim().is_empty() && last_poke.elapsed() >= Duration::from_millis(500) => {
                last_poke = Instant::now();
                let _ = self_tx.try_send(ActorCmd::PokeContainers);
            }
            Ok(_) => {}
            Err(_) => {
                // Host briefly unreachable or `timeout`/docker missing — back off instead of
                // spinning; the stop flag is still checked every iteration.
                std::thread::sleep(Duration::from_secs(3));
            }
        }
    }
}

fn do_poll(
    state: &mut ActorState,
    host_id: &str,
    want_processes: bool,
    want_containers: bool,
    poll_secs: f64,
) -> Result<HostPollResult, String> {
    // System metrics + disk usage + IP + a cheap container running/stopped count, all in a
    // single round trip (latency measured on this exec since it runs on every poll and
    // dominates round-trip time). The docker line doubles as docker-installed detection —
    // no separate `command -v docker` exec needed.
    let t0 = Instant::now();
    let sys_raw = exec_cmd(
        &state.session,
        "cat /proc/stat /proc/meminfo /proc/loadavg /proc/uptime /proc/net/dev /proc/diskstats; \
         echo ===DF===; df -k / 2>/dev/null | tail -1; \
         echo ===IP===; hostname -I 2>/dev/null | awk '{print $1}'; \
         echo ===DOCKER===; command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.State}}' 2>/dev/null || echo __nodocker__",
    )?;
    let latency_ms = (t0.elapsed().as_secs_f64() * 1000.0) as f32;

    let (proc_part, rest) = sys_raw.split_once("===DF===\n").unwrap_or((&sys_raw, ""));
    let (df_part, rest2) = rest.split_once("===IP===\n").unwrap_or((rest, ""));
    let (ip_part, docker_summary_part) = rest2.split_once("===DOCKER===\n").unwrap_or((rest2, ""));

    let (mut system, new_cpu, new_net, new_cpu_cores, new_disk) = parse_proc_output(
        proc_part,
        state.prev_cpu.as_ref(),
        state.prev_net,
        poll_secs,
        &state.prev_cpu_cores,
        state.prev_disk.as_ref(),
    );
    state.prev_cpu = Some(new_cpu);
    state.prev_net = Some(new_net);
    state.prev_cpu_cores = new_cpu_cores;
    if new_disk.is_some() {
        state.prev_disk = new_disk;
    }

    let df_fields: Vec<&str> = df_part.split_whitespace().collect();
    if df_fields.len() >= 3 {
        system.disk_total_kb = df_fields[1].parse().unwrap_or(0);
        system.disk_used_kb = df_fields[2].parse().unwrap_or(0);
    }
    system.ip = ip_part.trim().to_string();

    let has_docker = !docker_summary_part.trim_start().starts_with("__nodocker__");
    state.has_docker = Some(has_docker);

    let container_summary = if has_docker {
        let mut running = 0u32;
        let mut stopped = 0u32;
        for line in docker_summary_part.lines() {
            match line.trim() {
                "" => continue,
                "running" => running += 1,
                _ => stopped += 1,
            }
        }
        Some(ContainerSummary { running, stopped })
    } else {
        None
    };

    // Containers (full metrics) and processes are opt-in: the 30s overview poll (all hosts)
    // asks for neither, keeping it to one exec per host — it already gets the cheap
    // running/stopped counts above. The open detail view asks for both every 5s.
    let containers = if want_containers && state.has_docker == Some(true) {
        Some(collect_docker_metrics(state, poll_secs)?)
    } else {
        None
    };

    let processes = if want_processes {
        Some(collect_processes(state, system.cores.max(1))?)
    } else {
        None
    };

    Ok(HostPollResult {
        host_id: host_id.to_string(),
        ok: true,
        system: Some(system),
        container_summary,
        containers,
        processes,
        error: None,
        latency_ms: Some(latency_ms),
    })
}

/// Collects every container's state + resource usage in a single SSH exec regardless of
/// container count: one `docker ps -a` to list, one `docker inspect` covering every running
/// ID at once (it accepts multiple IDs), with cgroup/net reads done inline per container.
/// This is what makes polling this on the same 5s cadence as processes affordable — the old
/// one-`docker inspect`-exec-per-container approach cost 3-6s with just 15 containers.
fn collect_docker_metrics(
    state: &mut ActorState,
    poll_secs: f64,
) -> Result<Vec<ContainerMetric>, String> {
    let raw = exec_cmd(
        &state.session,
        r#"docker ps -a --no-trunc --format '{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Status}}' 2>/dev/null || echo __nodock__
echo ===STATS===
ids=$(docker ps -q --no-trunc 2>/dev/null)
if [ -n "$ids" ]; then
  docker inspect --format '{{.Id}} {{.State.Pid}} {{.RestartCount}}' $ids 2>/dev/null | while read id pid rc; do
    cgpath=$(awk -F: 'NR==1{print $3}' /proc/$pid/cgroup 2>/dev/null)
    echo CID=$id PID=$pid RC=$rc
    cat /sys/fs/cgroup$cgpath/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/docker/$id/memory.usage_in_bytes 2>/dev/null || echo 0
    cat /sys/fs/cgroup$cgpath/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/docker/$id/memory.limit_in_bytes 2>/dev/null || echo 0
    grep '^usage_usec\|^usage ' /sys/fs/cgroup$cgpath/cpu.stat 2>/dev/null || cat /sys/fs/cgroup/cpu/docker/$id/cpuacct.usage 2>/dev/null || echo 'usage 0'
    echo ===IO===
    cat /sys/fs/cgroup$cgpath/io.stat 2>/dev/null || cat /sys/fs/cgroup/blkio/docker/$id/blkio.throttle.io_service_bytes 2>/dev/null || true
    echo ===NET===
    cat /proc/$pid/net/dev 2>/dev/null
    echo ===END===
  done
fi"#,
    )?;

    let (ps_raw, stats_raw) = raw.split_once("===STATS===\n").unwrap_or((&raw, ""));

    if ps_raw.trim_start().starts_with("__nodock__") {
        state.has_docker = Some(false);
        return Ok(vec![]);
    }

    let entries = parse_docker_ps(ps_raw);
    let stats = parse_container_stats_batch(
        stats_raw,
        &state.prev_container_cpu,
        &state.prev_container_net,
        &state.prev_container_io,
        poll_secs,
    );

    const EMPTY_CGROUP_SAMPLE: ContainerCgroupSample = ContainerCgroupSample {
        cpu_pct: 0.0,
        mem_used: 0,
        mem_limit: 0,
        net_rx_rate: 0.0,
        net_tx_rate: 0.0,
        disk_read_rate: 0.0,
        disk_write_rate: 0.0,
        next_cpu_ns: None,
        next_net: None,
        next_io: None,
    };

    let mut next_cpu_map = HashMap::new();
    let mut next_net_map = HashMap::new();
    let mut next_io_map = HashMap::new();
    let mut result = Vec::with_capacity(entries.len());

    for entry in entries {
        // Container IDs must be hex-only before interpolating into the inspect/cgroup shell
        // commands next poll (defense in depth — docker itself always emits hex IDs).
        if !entry.id.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let health = parse_health(&entry.status_text);

        let (restart_count, sample) = match stats.get(&entry.id) {
            Some(s) => {
                if let Some(ns) = s.sample.next_cpu_ns {
                    next_cpu_map.insert(entry.id.clone(), ns);
                }
                if let Some(net) = s.sample.next_net {
                    next_net_map.insert(entry.id.clone(), net);
                }
                if let Some(io) = s.sample.next_io {
                    next_io_map.insert(entry.id.clone(), io);
                }
                (s.restart_count, &s.sample)
            }
            // No stats block — container isn't running (docker ps -q didn't list it).
            None => (0, &EMPTY_CGROUP_SAMPLE),
        };

        result.push(ContainerMetric {
            id: entry.id,
            name: entry.name,
            state: entry.state,
            status_text: entry.status_text,
            health,
            restart_count,
            cpu_pct: sample.cpu_pct,
            mem_used_bytes: sample.mem_used,
            mem_limit_bytes: sample.mem_limit,
            net_rx_rate: sample.net_rx_rate,
            net_tx_rate: sample.net_tx_rate,
            disk_read_rate: sample.disk_read_rate,
            disk_write_rate: sample.disk_write_rate,
        });
    }

    state.prev_container_cpu = next_cpu_map;
    state.prev_container_net = next_net_map;
    state.prev_container_io = next_io_map;

    Ok(result)
}

fn collect_processes(state: &mut ActorState, num_cores: u32) -> Result<Vec<ProcessInfo>, String> {
    // Single exec: /proc/[pid]/stat for ticks+rss, /proc/stat for normalization,
    // ps -eo pid,user for username mapping (no CPU calc — fast).
    // Works on all Linux; no process spawning for CPU measurement.
    let raw = exec_cmd(
        &state.session,
        "cat /proc/[0-9]*/stat 2>/dev/null; echo '===CPU==='; head -1 /proc/stat; echo '===USER==='; ps -eo pid=,user= --no-headers 2>/dev/null",
    )?;

    let (proc_raw, rest) = raw.split_once("===CPU===\n").unwrap_or((&raw, ""));
    let (cpu_raw, user_raw) = rest.split_once("===USER===\n").unwrap_or((rest, ""));

    // Aggregate CPU ticks for delta normalization
    let total_ticks: u64 = cpu_raw
        .split_whitespace()
        .skip(1)
        .filter_map(|v| v.parse::<u64>().ok())
        .take(7)
        .sum();

    let d_total = total_ticks.saturating_sub(state.prev_total_ticks_for_proc);

    // Build pid→user map (fast: ps just reads uid and maps /etc/passwd, no CPU sampling)
    let mut user_map: HashMap<u32, String> = HashMap::new();
    for line in user_raw.lines() {
        let mut parts = line.split_whitespace();
        if let (Some(pid_s), Some(user)) = (parts.next(), parts.next()) {
            if let Ok(pid) = pid_s.trim().parse::<u32>() {
                user_map.insert(pid, user.to_string());
            }
        }
    }

    // Parse /proc/[pid]/stat lines
    // Format: "pid (comm with spaces) state ppid ... utime(14) stime(15) ... rss(24) ..."
    let mut next_ticks: HashMap<u32, u64> = HashMap::new();
    let mut processes: Vec<ProcessInfo> = Vec::new();

    for line in proc_raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let open = match line.find('(') {
            Some(i) => i,
            None => continue,
        };
        let close = match line.rfind(')') {
            Some(i) => i,
            None => continue,
        };

        let pid: u32 = match line[..open].trim().parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let name = &line[open + 1..close];

        // fields after ')': state ppid pgrp session tty tpgid flags
        //   minflt cminflt majflt cmajflt utime[11] stime[12] ... rss[21]
        let fields: Vec<&str> = line[close + 1..].split_whitespace().collect();
        if fields.len() < 22 {
            continue;
        }

        let utime: u64 = fields[11].parse().unwrap_or(0);
        let stime: u64 = fields[12].parse().unwrap_or(0);
        let cpu_ticks = utime + stime;
        let rss_pages: u64 = fields[21].parse().unwrap_or(0);

        next_ticks.insert(pid, cpu_ticks);

        // CPU% = tick delta / total delta × num_cores × 100
        // d_total is the aggregate across all cores; multiplying by num_cores
        // gives percentage of one core (matching htop/top display convention).
        let cpu_pct = if d_total > 0 {
            let prev = state
                .prev_proc_ticks
                .get(&pid)
                .copied()
                .unwrap_or(cpu_ticks);
            (cpu_ticks.saturating_sub(prev) as f64 / d_total as f64 * num_cores as f64 * 100.0)
                as f32
        } else {
            0.0 // first poll — no delta yet
        };

        processes.push(ProcessInfo {
            pid,
            name: name.to_string(),
            user: user_map.get(&pid).cloned().unwrap_or_default(),
            cpu_pct,
            mem_kb: rss_pages * 4, // 4 KB pages (standard Linux page size)
        });
    }

    state.prev_proc_ticks = next_ticks;
    state.prev_total_ticks_for_proc = total_ticks;

    processes.sort_by(|a, b| {
        b.cpu_pct
            .partial_cmp(&a.cpu_pct)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    processes.truncate(20);
    Ok(processes)
}

// ─── DashboardManager ────────────────────────────────────────────────────────

pub struct DashboardManager {
    actors: HashMap<String, HostActor>,
    connect_gate: std::sync::Arc<ConnectGate>,
}

impl Default for DashboardManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DashboardManager {
    /// Max concurrent SSH handshakes across all hosts (initial connects + reconnects).
    const MAX_CONCURRENT_CONNECTS: usize = 6;

    pub fn new() -> Self {
        Self {
            actors: HashMap::new(),
            connect_gate: std::sync::Arc::new(ConnectGate::new(Self::MAX_CONCURRENT_CONNECTS)),
        }
    }

    pub fn connect_gate(&self) -> std::sync::Arc<ConnectGate> {
        self.connect_gate.clone()
    }

    pub fn connect(&mut self, host_id: String, actor: HostActor) {
        if let Some(old) = self.actors.remove(&host_id) {
            let _ = old.tx.try_send(ActorCmd::Disconnect);
        }
        self.actors.insert(host_id, actor);
    }

    pub fn disconnect(&mut self, host_id: &str) {
        if let Some(actor) = self.actors.remove(host_id) {
            let _ = actor.tx.try_send(ActorCmd::Disconnect);
        }
    }

    /// Disconnects every host actor — used by quit-to-background reset.
    pub fn disconnect_all(&mut self) {
        for (_, actor) in self.actors.drain() {
            let _ = actor.tx.try_send(ActorCmd::Disconnect);
        }
    }

    /// Returns cloned senders only — Mutex is released immediately after.
    pub fn senders(&self) -> Vec<(String, std::sync::mpsc::SyncSender<ActorCmd>)> {
        self.actors
            .iter()
            .map(|(id, a)| (id.clone(), a.tx.clone()))
            .collect()
    }

    pub fn sender(&self, host_id: &str) -> Option<std::sync::mpsc::SyncSender<ActorCmd>> {
        self.actors.get(host_id).map(|a| a.tx.clone())
    }
}

// ─── Public spawn function ────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub fn spawn_host_actor(
    app: AppHandle,
    host_id: String,
    hostname: String,
    port: u16,
    user: String,
    password: Option<String>,
    key_path: Option<std::path::PathBuf>,
    gate: std::sync::Arc<ConnectGate>,
) -> HostActor {
    // SyncSender with buffer=4 — prevents blocking Tauri commands
    let (tx, rx) = std::sync::mpsc::sync_channel::<ActorCmd>(4);
    let self_tx = tx.clone();

    std::thread::Builder::new()
        .name(format!("dashboard-{}", host_id))
        .spawn(move || {
            run_actor(
                app,
                ActorConfig {
                    host_id,
                    hostname,
                    port,
                    user,
                    password,
                    key_path,
                    gate,
                    self_tx,
                },
                rx,
            )
        })
        .expect("dashboard actor thread spawn");

    HostActor { tx }
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
        let (metrics, snap, _, core_snaps, _) =
            parse_proc_output(SAMPLE_PROC, None, None, 30.0, &[], None);
        assert_eq!(metrics.cpu_pct, 0.0, "first poll should be zero");
        assert!(
            metrics.cpu_cores.is_empty(),
            "first poll: no prev cores → empty cpu_cores"
        );
        assert_eq!(snap.user, 100);
        assert_eq!(snap.idle, 800);
        assert_eq!(core_snaps.len(), 2, "should collect 2 per-core snapshots");
        assert!(
            (metrics.load_1m - 0.45).abs() < 0.001,
            "load1m should be 0.45, got {}",
            metrics.load_1m
        );
        assert!(
            (metrics.load_5m - 0.32).abs() < 0.001,
            "load5m should be 0.32, got {}",
            metrics.load_5m
        );
        assert!(
            (metrics.load_15m - 0.28).abs() < 0.001,
            "load15m should be 0.28, got {}",
            metrics.load_15m
        );
    }

    #[test]
    fn test_parse_cpu_delta() {
        let prev = CpuSnapshot {
            user: 100,
            nice: 10,
            system: 50,
            idle: 800,
            iowait: 5,
            irq: 2,
            softirq: 3,
        };
        let prev_cores = vec![
            CpuSnapshot {
                user: 50,
                nice: 5,
                system: 25,
                idle: 400,
                iowait: 2,
                irq: 1,
                softirq: 1,
            },
            CpuSnapshot {
                user: 50,
                nice: 5,
                system: 25,
                idle: 400,
                iowait: 3,
                irq: 1,
                softirq: 2,
            },
        ];
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
        let (metrics, _, _, _, _) = parse_proc_output(
            raw2,
            Some(&prev),
            Some((5000000, 2000000)),
            30.0,
            &prev_cores,
            None,
        );
        // delta: total=250 idle=200 → cpu=(250-200)/250*100 = 20%
        assert!(
            (metrics.cpu_pct - 20.0).abs() < 1.0,
            "CPU should be ~20%, was: {}",
            metrics.cpu_pct
        );
        assert_eq!(
            metrics.cpu_cores.len(),
            2,
            "should compute 2 per-core metrics"
        );
        // cpu0: d_total=125 d_idle=100 → 20%
        assert!(
            (metrics.cpu_cores[0].total - 20.0).abs() < 1.0,
            "core0 should be ~20%"
        );
        assert_eq!(metrics.cores, 2);
        assert_eq!(metrics.mem_total_kb, 16384000);
        // net rate: (5100000-5000000)/30 = 3333 bytes/sec
        assert!((metrics.net_rx_rate - 3333.0).abs() < 10.0);
    }

    #[test]
    fn test_parse_docker_ps() {
        let raw = "abc123\tweb-app\trunning\tUp 3 hours (healthy)\ndef456\tdb\texited\tExited (137) 2 minutes ago\n";
        let result = parse_docker_ps(raw);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].id, "abc123");
        assert_eq!(result[0].name, "web-app");
        assert_eq!(result[0].state, "running");
        assert_eq!(result[0].status_text, "Up 3 hours (healthy)");
        assert_eq!(result[1].state, "exited");
    }

    #[test]
    fn test_parse_health() {
        assert_eq!(parse_health("Up 3 hours (healthy)"), Some("healthy".to_string()));
        assert_eq!(parse_health("Up 2 seconds (health: starting)"), Some("starting".to_string()));
        assert_eq!(parse_health("Up 3 hours (unhealthy)"), Some("unhealthy".to_string()));
        assert_eq!(parse_health("Up 3 hours"), None);
        assert_eq!(parse_health("Exited (137) 2 minutes ago"), None);
    }

    #[test]
    fn test_parse_container_stats_batch() {
        let raw = "CID=abc123 PID=4242 RC=2\n10485760\n8589934592\nusage_usec 500000\n===IO===\n253:0 rbytes=1048576 wbytes=524288 rios=10 wios=5 dbytes=0 dios=0\n===NET===\nlo: 0 0 0 0 0 0 0 0 0 0\n===END===\nCID=def456 PID=99 RC=0\n2048\n4096\nusage_usec 1000\n===IO===\n===NET===\n===END===\n";
        let prev_cpu = HashMap::new();
        let prev_net = HashMap::new();
        let prev_io = HashMap::new();
        let result = parse_container_stats_batch(raw, &prev_cpu, &prev_net, &prev_io, 30.0);
        assert_eq!(result.len(), 2);
        let abc = &result["abc123"];
        assert_eq!(abc.sample.cpu_pct, 0.0, "first poll — no delta yet");
        assert_eq!(abc.sample.mem_used, 10485760);
        assert_eq!(abc.sample.mem_limit, 8589934592);
        assert_eq!(abc.restart_count, 2);
        assert_eq!(abc.sample.next_cpu_ns, Some(500_000_000));
        assert_eq!(abc.sample.next_io, Some((1048576, 524288)));
        assert_eq!(result["def456"].restart_count, 0);
    }

    #[test]
    fn test_parse_container_cgroup_first_poll() {
        let raw = "10485760\n8589934592\nusage_usec 500000\n===IO===\n===NET===\n";
        let sample = parse_container_cgroup(raw, None, None, None, 30.0);
        assert_eq!(sample.cpu_pct, 0.0);
        assert_eq!(sample.mem_used, 10485760);
        assert_eq!(sample.mem_limit, 8589934592);
        assert_eq!(sample.next_cpu_ns, Some(500_000_000)); // 500_000 µs × 1000 = 500_000_000 ns
    }

    #[test]
    fn test_parse_container_io_bytes_cgroup_v2() {
        let raw = "253:0 rbytes=1048576 wbytes=524288 rios=10 wios=5 dbytes=0 dios=0\n253:16 rbytes=2048 wbytes=1024 rios=1 wios=1 dbytes=0 dios=0\n";
        let (read, write) = parse_container_io_bytes(raw);
        assert_eq!(read, 1048576 + 2048, "sums rbytes across devices");
        assert_eq!(write, 524288 + 1024, "sums wbytes across devices");
    }

    #[test]
    fn test_parse_container_io_bytes_cgroup_v1() {
        let raw = "8:0 Read 1048576\n8:0 Write 524288\n8:0 Sync 0\n8:0 Async 1572864\n8:0 Discard 0\n8:0 Total 1572864\nTotal 1572864\n";
        let (read, write) = parse_container_io_bytes(raw);
        assert_eq!(read, 1048576);
        assert_eq!(write, 524288, "Total/Sync/Async footer lines are not double-counted");
    }

    #[test]
    fn test_parse_container_io_bytes_empty() {
        assert_eq!(parse_container_io_bytes(""), (0, 0));
    }
}

#[cfg(test)]
mod quit_reset_tests {
    use super::*;

    #[test]
    fn disconnect_all_on_empty_manager_is_noop() {
        let mut mgr = DashboardManager::new();
        mgr.disconnect_all();
        assert!(mgr.actors.is_empty());
    }
}
