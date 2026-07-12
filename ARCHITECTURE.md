# System Architecture

This document provides a high-level overview of the architectural design, codebase layout, and backend concurrency patterns in Termifai.

---

## Directory Overview

```
termifai/
├── src/                          # React + TypeScript Frontend
│   ├── main.tsx                  # Webview entry point — routes window type (main / settings / quick-terminal)
│   ├── components/
│   │   ├── app/                  # Main window shell: tabs, terminal workspace, vault gate
│   │   ├── settings/             # Settings window
│   │   ├── quick-terminal/       # Quake-style drop-down terminal window
│   │   ├── shared/               # Shared UI primitives (modals, …)
│   │   └── ui/                   # shadcn/ui primitives (Radix-based, generated)
│   ├── features/                 # Feature views: hosts, sftp, dashboard, snippets, ssh-keys, port-forwarding
│   ├── hooks/                    # React hooks
│   └── lib/                      # Themes, shortcuts, appearance config
│       └── api/                  # Typed Tauri command bindings (one file per backend module)
│
├── src-tauri/                    # Tauri + Rust Desktop Backend (Cargo workspace)
│   ├── Cargo.toml                # Workspace definition & app dependencies
│   ├── tauri.conf.json           # Native capabilities, window permissions, bundling
│   ├── crates/
│   │   ├── termifai-core/        # Tauri-free core library
│   │   │   └── src/
│   │   │       ├── crypto.rs     # Argon2id KDF + ChaCha20-Poly1305 field encryption
│   │   │       ├── store.rs      # JsonStore<T>: atomic, thread-safe file persistence
│   │   │       ├── model/        # Host, snippet, SSH key, forward, vault, tombstone schemas
│   │   │       └── sync/         # E2E-encrypted sync engine (Google Drive, Dropbox, local dir)
│   │   └── termifaid/            # Background daemon: global hotkeys, app launcher
│   ├── finder-extension/         # macOS Finder "Open in Termifai" extension (Swift)
│   └── src/
│       ├── main.rs               # Process entry, single-instance, CLI args
│       ├── lib.rs                # Tauri command orchestration, window builders, tray
│       ├── pty_manager.rs        # PTY terminals & SSH verbose log tracker
│       ├── ssh/                  # Shared SSH connect + known_hosts verification (libssh2)
│       ├── hosts.rs              # SSH host & group repository
│       ├── vault.rs              # Master-key lifecycle, lock policies, keychain caching
│       ├── port_forwarding.rs    # SSH tunnels (local / remote / dynamic SOCKS)
│       ├── sftp.rs               # SFTP session transfers & operations
│       ├── ssh_keys.rs           # SSH key generation & import
│       ├── snippets.rs           # Snippet catalog (+ snippet_exec.rs for execution)
│       ├── dashboard.rs          # Remote metrics polling (CPU, RAM, disk, network, Docker)
│       ├── sync.rs               # App-side hooks into termifai-core's sync engine
│       ├── global_hotkey.rs      # Global hotkey configuration
│       └── quick_terminal.rs     # Quick Terminal window management
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
- We do **not** use manual file writes. Instead, we use `JsonStore<T>` (defined in `src-tauri/crates/termifai-core/src/store.rs`), which provides:
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
