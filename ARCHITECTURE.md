# System Architecture

This document provides a high-level overview of the architectural design, codebase layout, and backend concurrency patterns in Termifai.

---

## Directory Overview

```
termifai/
├── src/                          # React + TypeScript Frontend
│   ├── main.tsx                  # Webview entry point
│   ├── components/               # App layout & feature components
│   └── lib/                      # Themes, shortcuts, and style configurations
│
├── src-tauri/                    # Tauri + Rust Desktop Backend
│   ├── Cargo.toml                # Rust dependencies
│   ├── tauri.conf.json           # Native capabilities, window permissions
│   └── src/
│       ├── main.rs               # Backend entry point
│       ├── lib.rs                # Tauri command orchestration
│       ├── store.rs              # Atomic, thread-safe file persistence
│       ├── vault.rs              # Master keys and settings
│       ├── hosts.rs              # SSH host configuration management
│       ├── port_forwarding.rs    # SSH port forwarding tunnels
│       ├── sftp.rs               # SFTP session transfers & operations
│       └── pty_manager.rs        # PTY terminals & SSH verbose log tracker
```

---

## Code Organization & Coding Conventions

We enforce a strict separation of concerns between native orchestration and business logic:

### The Vertical-Slice Rule

- Keep `src-tauri/src/lib.rs` clean. It should only define Tauri command endpoints (`#[tauri::command]`) that act as thin coordinators.
- Real domain logic belongs inside its respective module (e.g. `sftp.rs` for transfers, `port_forwarding.rs` for tunnels, etc.).
- Backend commands return `Result<T, String>` to be easily caught and resolved by the webview.

### Data Persistence Rule

- User configurations (hosts, snippets, keys, tunnels) are stored as JSON databases.
- We do **not** use manual file writes. Instead, we use `JsonStore<T>` (defined in `src-tauri/src/store.rs`), which provides:
  1. Thread-safe atomic file writes using a `.tmp` file and `rename`.
  2. Operating system sync (`fsync`) to guarantee data is fully persisted on the disk.
  3. Thread-safe synchronization using a per-file lock.

---

## Concurrency & Locking Guidelines

Because Termifai handles multiple terminal PTY sessions and concurrent SFTP transfers, thread management is critical:

### 1. The Concurrency Rule

- **Never** perform blocking network operations or long-running synchronous work directly on a Tauri command thread. Use `tokio::task::spawn_blocking` to offload blocking tasks (like SFTP reads/writes or file copies).
- **Never** hold a global resource lock (like the `sftp_manager` mutex) across an `.await` boundary or during a long-running transfer. Doing so freezes the entire application UI.

### 2. SFTP Granular Locking Pattern

- `SftpManager` manages session lifecycles using `HashMap<String, Arc<Mutex<SftpEntry>>>`.
- To perform an SFTP command:
  1. Acquire the lock on `sftp_manager` briefly to clone the session `Arc`.
  2. Release the `sftp_manager` lock immediately.
  3. Acquire a lock on the specific session's `Mutex` (`SftpEntry`) to execute the operations.
  
This allows a long-running 1 GB download on session A to run concurrently without blocking directory listings or actions on session B.
