# Termifai

A modern SSH client and terminal emulator built with Tauri 2, React, and Rust.

## Features

- **Local Terminal** — Full PTY-backed terminal with xterm.js, tab support, drag-to-reorder, and rename
- **Host Manager** — Organize SSH hosts in nested groups; grid/list view with search and sort
- **Server Dashboard** — Real-time CPU, RAM, disk, network, and Docker container stats per host
- **SFTP Browser** — Split-pane local/remote file manager
- **Port Forwarding** — Save and manage SSH tunnels
- **Snippets** — Store and run reusable shell commands
- **SSH Key Manager** — Generate (ed25519/RSA), import, and manage SSH keys
- **Themes** — 12 built-in themes (Termifai Dark/Light, Dracula, Nord, Gruvbox, Tokyo Night, Catppuccin Mocha, Solarized, One Dark, Rosé Pine, Kanagawa Wave)
- **Multi-window** — Open multiple independent terminal windows

## Tech Stack

| Layer     | Technology                          |
|-----------|-------------------------------------|
| Shell     | React 19 + TypeScript               |
| UI        | Tailwind CSS v4 + shadcn/ui (Radix) |
| Terminal  | xterm.js v6                         |
| DnD       | dnd-kit                             |
| Charts    | Recharts                            |
| Desktop   | Tauri 2                             |
| Backend   | Rust (`portable-pty`, `tokio`)      |

## Prerequisites

- [Node.js](https://nodejs.org) ≥ 18 or [Bun](https://bun.sh)
- [Rust](https://rustup.rs) ≥ 1.77.2
- [Tauri CLI prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS

## Getting Started

```bash
# Install dependencies
bun install

# Run in development
bun run tauri dev

# Build for production
bun run tauri build
```

## License

MIT
