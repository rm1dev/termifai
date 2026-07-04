use serde::Serialize;
use ssh2::Session;
use std::collections::HashMap;
use std::io::Read as IoRead;
use std::net::TcpStream;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// ─── Internal type aliases ────────────────────────────────────────────────────

/// Return type of `parse_container_cgroup`:
/// (cpu_pct, mem_used, mem_limit, rx_rate, tx_rate, next_cpu_ns, next_net)
type CgroupStats = (f32, u64, u64, f64, f64, Option<u64>, Option<(u64, u64)>);

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
    pub disk_read_rate: f64,    // bytes/sec
    pub disk_write_rate: f64,   // bytes/sec
    pub disk_iops: f64,         // ops/sec
    pub disk_read_latency_ms: f32,  // avg ms per read op
    pub disk_write_latency_ms: f32, // avg ms per write op
    pub disk_dev: String,
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
/// Returns (metrics, aggregate_snap, net, per_core_snaps, disk_snap)
pub(crate) fn parse_proc_output(
    raw: &str,
    prev_cpu: Option<&CpuSnapshot>,
    prev_net: Option<(u64, u64)>,
    poll_secs: f64,
    prev_cpu_cores: &[CpuSnapshot],
    prev_disk: Option<&DiskSnapshot>,
) -> (SystemMetrics, CpuSnapshot, (u64, u64), Vec<CpuSnapshot>, Option<DiskSnapshot>) {
    let mut cpu_snap = CpuSnapshot { user:0, nice:0, system:0, idle:0, iowait:0, irq:0, softirq:0 };
    let mut cpu_core_snaps: Vec<CpuSnapshot> = Vec::new();
    let mut mem: HashMap<&str, u64> = HashMap::new();
    let mut load_1m = 0f32; let mut load_5m = 0f32; let mut load_15m = 0f32;
    let mut uptime_secs = 0u64;
    let mut net_iface = String::new();
    let mut net_rx = 0u64; let mut net_tx = 0u64;
    let disk_total_kb = 0u64; let disk_used_kb = 0u64;
    let mut cores = 0u32;
    let ip = String::new();
    // Collect all real disk devices from /proc/diskstats; pick highest-traffic one
    let mut disk_snaps: Vec<DiskSnapshot> = Vec::new();

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
        // /proc/stat — per-core lines: count and snapshot each core
        if line.starts_with("cpu") && line.len() > 3 && line.chars().nth(3).map(|c| c.is_ascii_digit()).unwrap_or(false) {
            cores += 1;
            let p: Vec<u64> = line.split_whitespace().skip(1)
                .filter_map(|v| v.parse().ok()).collect();
            if p.len() >= 7 {
                cpu_core_snaps.push(CpuSnapshot {
                    user: p[0], nice: p[1], system: p[2], idle: p[3],
                    iowait: p[4], irq: p[5], softirq: p[6],
                });
            }
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
        // /proc/loadavg — exactly 5 tokens, 4th contains '/' (e.g. "0.45 0.32 0.28 2/456 12345")
        {
            let p: Vec<&str> = line.split_whitespace().collect();
            if p.len() == 5 && p[3].contains('/') {
                if let (Ok(a), Ok(b), Ok(c)) = (p[0].parse::<f32>(), p[1].parse::<f32>(), p[2].parse::<f32>()) {
                    load_1m = a; load_5m = b; load_15m = c;
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
                        reads_completed:  n(3),
                        sectors_read:     n(5),
                        ms_reading:       n(6),
                        writes_completed: n(7),
                        sectors_written:  n(9),
                        ms_writing:       n(10),
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
            if d_total > 0.0 { ((1.0 - d_idle / d_total) * 100.0) as f32 } else { 0.0 }
        }
        None => 0.0,
    };

    // Per-core CPU% delta (empty on first poll — no previous snapshots)
    let cpu_cores: Vec<CoreMetrics> = if prev_cpu_cores.len() == cpu_core_snaps.len() && !prev_cpu_cores.is_empty() {
        cpu_core_snaps.iter().zip(prev_cpu_cores.iter()).map(|(cur, prev)| {
            let d_total = cur.total().saturating_sub(prev.total()) as f64;
            let d_idle  = cur.idle_total().saturating_sub(prev.idle_total()) as f64;
            let d_user  = cur.user.saturating_sub(prev.user) as f64;
            let d_sys   = cur.system.saturating_sub(prev.system) as f64;
            let d_nice  = cur.nice.saturating_sub(prev.nice) as f64;
            let d_io    = cur.iowait.saturating_sub(prev.iowait) as f64;
            let d_steal = cur.softirq.saturating_sub(prev.softirq) as f64; // steal not in CpuSnapshot; use softirq placeholder
            if d_total > 0.0 {
                let scale = 100.0 / d_total;
                let total = ((1.0 - d_idle / d_total) * 100.0) as f32;
                CoreMetrics {
                    total,
                    user:   (d_user   * scale) as f32,
                    system: (d_sys    * scale) as f32,
                    nice:   (d_nice   * scale) as f32,
                    iowait: (d_io     * scale) as f32,
                    steal:  (d_steal  * scale) as f32,
                }
            } else {
                CoreMetrics { total: 0.0, user: 0.0, system: 0.0, nice: 0.0, iowait: 0.0, steal: 0.0 }
            }
        }).collect()
    } else {
        vec![]
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

    // Pick the disk with highest total I/O among whole-disk devices
    let cur_disk = disk_snaps.into_iter()
        .max_by_key(|d| d.reads_completed + d.writes_completed);

    let (disk_read_rate, disk_write_rate, disk_iops, disk_read_latency_ms, disk_write_latency_ms, disk_dev, new_disk) =
        match (&cur_disk, prev_disk) {
            (Some(cur), Some(prev)) if cur.dev == prev.dev && poll_secs > 0.0 => {
                let d_reads  = cur.reads_completed.saturating_sub(prev.reads_completed) as f64;
                let d_writes = cur.writes_completed.saturating_sub(prev.writes_completed) as f64;
                let d_sr     = cur.sectors_read.saturating_sub(prev.sectors_read) as f64;
                let d_sw     = cur.sectors_written.saturating_sub(prev.sectors_written) as f64;
                let d_ms_r   = cur.ms_reading.saturating_sub(prev.ms_reading) as f64;
                let d_ms_w   = cur.ms_writing.saturating_sub(prev.ms_writing) as f64;
                let read_lat  = if d_reads  > 0.0 { (d_ms_r / d_reads)  as f32 } else { 0.0 };
                let write_lat = if d_writes > 0.0 { (d_ms_w / d_writes) as f32 } else { 0.0 };
                (
                    d_sr * 512.0 / poll_secs,   // bytes/sec
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
        swap_used_kb: mem.get("SwapTotal").unwrap_or(&0)
            .saturating_sub(*mem.get("SwapFree").unwrap_or(&0)),
        disk_total_kb, disk_used_kb,
        disk_read_rate, disk_write_rate, disk_iops,
        disk_read_latency_ms, disk_write_latency_ms,
        disk_dev,
        load_1m, load_5m, load_15m,
        uptime_secs,
        net_rx_rate: rx_rate,
        net_tx_rate: tx_rate,
        net_iface,
        cores,
        ip,
    };

    (metrics, cpu_snap, (net_rx, net_tx), cpu_core_snaps, new_disk)
}

fn is_whole_disk(dev: &str) -> bool {
    if dev.starts_with("loop") || dev.starts_with("dm-") || dev.starts_with("ram") || dev.starts_with("sr") {
        return false;
    }
    // nvme: nvme0n1 is whole disk, nvme0n1p1 is a partition
    if dev.starts_with("nvme") {
        return !dev.contains('p');
    }
    // sda, vda, xvda, hda — whole disk has no trailing digit
    !dev.ends_with(|c: char| c.is_ascii_digit())
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
) -> CgroupStats {
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
    let next_net = if net_rx > 0 || net_tx > 0 { Some((net_rx, net_tx)) } else { None };
    (cpu_pct, mem_used, mem_limit, rx_rate, tx_rate, next_cpu, next_net)
}

// ─── Actor types ─────────────────────────────────────────────────────────────

pub enum ActorCmd {
    /// Poll system + docker + processes
    Poll {
        want_detail: bool,
        reply: tokio::sync::oneshot::Sender<HostPollResult>,
    },
    Disconnect,
}

pub struct HostActor {
    pub(crate) tx: std::sync::mpsc::SyncSender<ActorCmd>,
}

// ─── SSH helpers ──────────────────────────────────────────────────────────────

fn ssh_connect(
    hostname: &str,
    port: u16,
    user: &str,
    password: Option<&str>,
    key_path: Option<&std::path::Path>,
) -> Result<Session, String> {
    let addr = format!("{}:{}", hostname, port);
    let tcp = TcpStream::connect(&addr)
        .map_err(|e| format!("TCP connect to {}: {}", addr, e))?;
    tcp.set_read_timeout(Some(Duration::from_secs(15))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(15))).ok();

    let mut session = Session::new()
        .map_err(|e| format!("SSH session init: {}", e))?;
    session.set_tcp_stream(tcp);
    session.handshake()
        .map_err(|e| format!("SSH handshake: {}", e))?;

    if let Some(key) = key_path {
        session.userauth_pubkey_file(user, None, key, None)
            .map_err(|e| format!("Key auth: {}", e))?;
    } else if let Some(pw) = password {
        session.userauth_password(user, pw)
            .map_err(|e| format!("Password auth: {}", e))?;
    } else {
        session.userauth_agent(user)
            .map_err(|e| format!("Agent auth: {}", e))?;
    }

    if !session.authenticated() {
        return Err("Authentication failed".to_string());
    }

    // keepalive every 15s — prevents NAT timeout
    session.set_keepalive(true, 15);
    Ok(session)
}

fn exec_cmd(session: &Session, cmd: &str) -> Result<String, String> {
    let mut ch = session.channel_session()
        .map_err(|e| format!("Channel open: {}", e))?;
    ch.exec(cmd)
        .map_err(|e| format!("Exec '{}': {}", &cmd[..cmd.len().min(40)], e))?;
    let mut out = String::new();
    ch.read_to_string(&mut out)
        .map_err(|e| format!("Read channel: {}", e))?;
    ch.wait_close().ok();
    Ok(out)
}

// ─── Actor internals ──────────────────────────────────────────────────────────

struct ActorState {
    session: Session,
    prev_cpu: Option<CpuSnapshot>,
    prev_cpu_cores: Vec<CpuSnapshot>,
    prev_net: Option<(u64, u64)>,
    prev_disk: Option<DiskSnapshot>,
    prev_container_cpu: HashMap<String, u64>,  // container_id → cpu_ns
    prev_container_net: HashMap<String, (u64, u64)>,
    has_docker: Option<bool>,
    last_poll: Option<Instant>,
    prev_proc_ticks: HashMap<u32, u64>,  // pid → utime+stime at last sample
    prev_total_ticks_for_proc: u64,      // aggregate CPU ticks at last process sample
}

struct ActorConfig {
    host_id: String,
    hostname: String,
    port: u16,
    user: String,
    password: Option<String>,
    key_path: Option<std::path::PathBuf>,
}

fn run_actor(
    app: AppHandle,
    cfg: ActorConfig,
    rx: std::sync::mpsc::Receiver<ActorCmd>,
) {
    let ActorConfig { host_id, hostname, port, user, password, key_path } = cfg;
    // Initial connection
    let session = match ssh_connect(&hostname, port, &user, password.as_deref(), key_path.as_deref()) {
        Ok(s) => s,
        Err(e) => {
            // Emit error so frontend clears the loading spinner
            let _ = app.emit("dash:stat", HostPollResult {
                host_id: host_id.clone(),
                ok: false,
                system: None,
                containers: None,
                processes: None,
                error: Some(e.clone()),
            });
            // Also reply to any already-queued Poll commands
            while let Ok(cmd) = rx.try_recv() {
                if let ActorCmd::Poll { reply, .. } = cmd {
                    let _ = reply.send(HostPollResult {
                        host_id: host_id.clone(), ok: false,
                        system: None, containers: None, processes: None,
                        error: Some(e.clone()),
                    });
                }
            }
            return;
        }
    };

    let mut state = ActorState {
        session,
        prev_cpu: None,
        prev_cpu_cores: vec![],
        prev_net: None,
        prev_disk: None,
        prev_container_cpu: HashMap::new(),
        prev_container_net: HashMap::new(),
        has_docker: None,
        last_poll: None,
        prev_proc_ticks: HashMap::new(),
        prev_total_ticks_for_proc: 0,
    };

    loop {
        // recv_timeout → send keepalive if idle for 10s
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(ActorCmd::Disconnect) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,

            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // keepalive — no poll
                state.session.keepalive_send().ok();
                continue;
            }

            Ok(ActorCmd::Poll { want_detail, reply }) => {
                let now = Instant::now();
                let poll_secs = state.last_poll.map(|t| t.elapsed().as_secs_f64()).unwrap_or(30.0);
                state.last_poll = Some(now);

                let result = do_poll(&mut state, &host_id, want_detail, poll_secs);

                // If session died, attempt one reconnect and retry
                let result = if result.is_err() {
                    match ssh_connect(&hostname, port, &user, password.as_deref(), key_path.as_deref()) {
                        Ok(new_session) => {
                            state.session = new_session;
                            state.prev_cpu = None;
                            state.prev_net = None;
                            state.prev_container_cpu.clear();
                            state.prev_container_net.clear();
                            do_poll(&mut state, &host_id, want_detail, poll_secs)
                        }
                        Err(e) => Err(e),
                    }
                } else {
                    result
                };

                let payload = match result {
                    Ok(r) => r,
                    Err(e) => HostPollResult {
                        host_id: host_id.clone(), ok: false,
                        system: None, containers: None, processes: None,
                        error: Some(e),
                    },
                };
                let _ = reply.send(payload);
            }
        }
    }
}

fn do_poll(state: &mut ActorState, host_id: &str, want_detail: bool, poll_secs: f64) -> Result<HostPollResult, String> {
    // System metrics — single channel, single cat
    let sys_raw = exec_cmd(
        &state.session,
        "cat /proc/stat /proc/meminfo /proc/loadavg /proc/uptime /proc/net/dev /proc/diskstats",
    )?;

    let (mut system, new_cpu, new_net, new_cpu_cores, new_disk) =
        parse_proc_output(&sys_raw, state.prev_cpu.as_ref(), state.prev_net, poll_secs, &state.prev_cpu_cores, state.prev_disk.as_ref());
    state.prev_cpu = Some(new_cpu);
    state.prev_net = Some(new_net);
    state.prev_cpu_cores = new_cpu_cores;
    if new_disk.is_some() { state.prev_disk = new_disk; }

    // Disk usage from df
    if let Ok(df_raw) = exec_cmd(&state.session, "df -k / 2>/dev/null | tail -1") {
        let parts: Vec<&str> = df_raw.split_whitespace().collect();
        if parts.len() >= 3 {
            system.disk_total_kb = parts[1].parse().unwrap_or(0);
            system.disk_used_kb = parts[2].parse().unwrap_or(0);
        }
    }

    // IP from hostname -I
    if let Ok(ip_raw) = exec_cmd(&state.session, "hostname -I 2>/dev/null | awk '{print $1}'") {
        system.ip = ip_raw.trim().to_string();
    }

    // Docker detection — done once and cached
    if state.has_docker.is_none() {
        state.has_docker = Some(
            exec_cmd(&state.session, "command -v docker >/dev/null 2>&1 && echo yes || echo no")
                .map(|o| o.trim() == "yes")
                .unwrap_or(false),
        );
    }

    // When want_detail=true (frequent process polls), skip Docker to keep overhead low.
    // Docker metrics are collected on the slow path (want_detail=false, every 30s).
    let containers = if !want_detail && state.has_docker == Some(true) {
        Some(collect_docker_metrics(state, poll_secs)?)
    } else {
        None
    };

    let processes = if want_detail {
        Some(collect_processes(state, system.cores.max(1))?)
    } else {
        None
    };

    Ok(HostPollResult {
        host_id: host_id.to_string(),
        ok: true,
        system: Some(system),
        containers,
        processes,
        error: None,
    })
}

fn collect_docker_metrics(state: &mut ActorState, poll_secs: f64) -> Result<Vec<ContainerMetric>, String> {
    let ps_raw = exec_cmd(
        &state.session,
        r#"docker ps -a --no-trunc --format '{"id":"{{.ID}}","name":"{{.Names}}","state":"{{.State}}"}' 2>/dev/null || echo '__nodock__'"#,
    )?;

    if ps_raw.contains("__nodock__") {
        state.has_docker = Some(false);
        return Ok(vec![]);
    }

    let container_list = parse_docker_ps(&ps_raw);
    let mut result = Vec::new();

    for (id, name, container_state) in &container_list {
        // Container IDs must be hex-only before interpolating into shell
        if !id.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }

        if container_state != "running" {
            result.push(ContainerMetric {
                id: id.clone(), name: name.clone(), state: container_state.clone(),
                cpu_pct: 0.0, mem_used_bytes: 0, mem_limit_bytes: 0,
                net_rx_rate: 0.0, net_tx_rate: 0.0,
            });
            continue;
        }

        // Get PID via docker inspect, then read cgroup + network from /proc/<pid>/
        let cgroup_cmd = format!(
            r#"pid=$(docker inspect --format '{{{{.State.Pid}}}}' {id} 2>/dev/null); \
[ -z "$pid" ] || [ "$pid" = "0" ] || {{ \
  cgpath=$(awk -F: 'NR==1{{print $3}}' /proc/$pid/cgroup 2>/dev/null); \
  echo "PID=$pid"; \
  cat /sys/fs/cgroup$cgpath/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/docker/{id}/memory.usage_in_bytes 2>/dev/null || echo 0; \
  cat /sys/fs/cgroup$cgpath/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/docker/{id}/memory.limit_in_bytes 2>/dev/null || echo 0; \
  grep '^usage_usec\|^usage ' /sys/fs/cgroup$cgpath/cpu.stat 2>/dev/null || cat /sys/fs/cgroup/cpu/docker/{id}/cpuacct.usage 2>/dev/null || echo 'usage 0'; \
  cat /proc/$pid/net/dev 2>/dev/null; \
}}"#,
            id = id
        );

        let cgroup_raw = exec_cmd(&state.session, &cgroup_cmd).unwrap_or_default();

        let prev_cpu_ns = state.prev_container_cpu.get(id).copied();
        let prev_net = state.prev_container_net.get(id).copied();

        let (cpu_pct, mem_used, mem_limit, rx_rate, tx_rate, next_cpu, next_net) =
            parse_container_cgroup(&cgroup_raw, prev_cpu_ns, prev_net, poll_secs);

        if let Some(ns) = next_cpu {
            state.prev_container_cpu.insert(id.clone(), ns);
        }
        if let Some(net) = next_net {
            state.prev_container_net.insert(id.clone(), net);
        }

        result.push(ContainerMetric {
            id: id.clone(), name: name.clone(), state: container_state.clone(),
            cpu_pct, mem_used_bytes: mem_used, mem_limit_bytes: mem_limit,
            net_rx_rate: rx_rate, net_tx_rate: tx_rate,
        });
    }

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
        .split_whitespace().skip(1)
        .filter_map(|v| v.parse::<u64>().ok())
        .take(7).sum();

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
        if line.is_empty() { continue; }

        let open  = match line.find('(')  { Some(i) => i, None => continue };
        let close = match line.rfind(')') { Some(i) => i, None => continue };

        let pid: u32 = match line[..open].trim().parse() { Ok(p) => p, Err(_) => continue };
        let name = &line[open+1..close];

        // fields after ')': state ppid pgrp session tty tpgid flags
        //   minflt cminflt majflt cmajflt utime[11] stime[12] ... rss[21]
        let fields: Vec<&str> = line[close+1..].split_whitespace().collect();
        if fields.len() < 22 { continue; }

        let utime: u64 = fields[11].parse().unwrap_or(0);
        let stime: u64 = fields[12].parse().unwrap_or(0);
        let cpu_ticks = utime + stime;
        let rss_pages: u64 = fields[21].parse().unwrap_or(0);

        next_ticks.insert(pid, cpu_ticks);

        // CPU% = tick delta / total delta × num_cores × 100
        // d_total is the aggregate across all cores; multiplying by num_cores
        // gives percentage of one core (matching htop/top display convention).
        let cpu_pct = if d_total > 0 {
            let prev = state.prev_proc_ticks.get(&pid).copied().unwrap_or(cpu_ticks);
            (cpu_ticks.saturating_sub(prev) as f64 / d_total as f64 * num_cores as f64 * 100.0) as f32
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

    processes.sort_by(|a, b| b.cpu_pct.partial_cmp(&a.cpu_pct).unwrap_or(std::cmp::Ordering::Equal));
    processes.truncate(20);
    Ok(processes)
}

// ─── DashboardManager ────────────────────────────────────────────────────────

pub struct DashboardManager {
    actors: HashMap<String, HostActor>,
}

impl Default for DashboardManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DashboardManager {
    pub fn new() -> Self {
        Self { actors: HashMap::new() }
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

    /// Returns cloned senders only — Mutex is released immediately after.
    pub fn senders(&self) -> Vec<(String, std::sync::mpsc::SyncSender<ActorCmd>)> {
        self.actors.iter().map(|(id, a)| (id.clone(), a.tx.clone())).collect()
    }

    pub fn sender(&self, host_id: &str) -> Option<std::sync::mpsc::SyncSender<ActorCmd>> {
        self.actors.get(host_id).map(|a| a.tx.clone())
    }
}

// ─── Public spawn function ────────────────────────────────────────────────────

pub fn spawn_host_actor(
    app: AppHandle,
    host_id: String,
    hostname: String,
    port: u16,
    user: String,
    password: Option<String>,
    key_path: Option<std::path::PathBuf>,
) -> HostActor {
    // SyncSender with buffer=4 — prevents blocking Tauri commands
    let (tx, rx) = std::sync::mpsc::sync_channel::<ActorCmd>(4);

    std::thread::Builder::new()
        .name(format!("dashboard-{}", host_id))
        .spawn(move || run_actor(app, ActorConfig { host_id, hostname, port, user, password, key_path }, rx))
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
        let (metrics, snap, _, core_snaps, _) = parse_proc_output(SAMPLE_PROC, None, None, 30.0, &[], None);
        assert_eq!(metrics.cpu_pct, 0.0, "first poll should be zero");
        assert!(metrics.cpu_cores.is_empty(), "first poll: no prev cores → empty cpu_cores");
        assert_eq!(snap.user, 100);
        assert_eq!(snap.idle, 800);
        assert_eq!(core_snaps.len(), 2, "should collect 2 per-core snapshots");
        assert!((metrics.load_1m - 0.45).abs() < 0.001, "load1m should be 0.45, got {}", metrics.load_1m);
        assert!((metrics.load_5m - 0.32).abs() < 0.001, "load5m should be 0.32, got {}", metrics.load_5m);
        assert!((metrics.load_15m - 0.28).abs() < 0.001, "load15m should be 0.28, got {}", metrics.load_15m);
    }

    #[test]
    fn test_parse_cpu_delta() {
        let prev = CpuSnapshot { user: 100, nice: 10, system: 50, idle: 800, iowait: 5, irq: 2, softirq: 3 };
        let prev_cores = vec![
            CpuSnapshot { user: 50, nice: 5, system: 25, idle: 400, iowait: 2, irq: 1, softirq: 1 },
            CpuSnapshot { user: 50, nice: 5, system: 25, idle: 400, iowait: 3, irq: 1, softirq: 2 },
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
        let (metrics, _, _, _, _) = parse_proc_output(raw2, Some(&prev), Some((5000000, 2000000)), 30.0, &prev_cores, None);
        // delta: total=250 idle=200 → cpu=(250-200)/250*100 = 20%
        assert!((metrics.cpu_pct - 20.0).abs() < 1.0, "CPU should be ~20%, was: {}", metrics.cpu_pct);
        assert_eq!(metrics.cpu_cores.len(), 2, "should compute 2 per-core metrics");
        // cpu0: d_total=125 d_idle=100 → 20%
        assert!((metrics.cpu_cores[0].total - 20.0).abs() < 1.0, "core0 should be ~20%");
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
        let (cpu, mem_used, mem_limit, _, _, next_cpu, _) = parse_container_cgroup(raw, None, None, 30.0);
        assert_eq!(cpu, 0.0);
        assert_eq!(mem_used, 10485760);
        assert_eq!(mem_limit, 8589934592);
        assert_eq!(next_cpu, Some(500_000_000)); // 500_000 µs × 1000 = 500_000_000 ns
    }
}
