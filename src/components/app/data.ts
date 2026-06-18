import type { Host } from "./types";

export const sampleHosts: Host[] = [
  { id: "h1", name: "Sentry", user: "root", hostname: "10.0.4.21", port: 22, os: "ubuntu", tags: ["prod", "monitoring"], lastUsed: "2026-06-17T08:30:00Z" },
  { id: "h2", name: "87.107.154.69", user: "root", hostname: "87.107.154.69", port: 22, os: "centos", tags: ["edge"], lastUsed: "2026-06-15T14:20:00Z" },
  { id: "h3", name: "Ariyapanel", user: "root", hostname: "panel.ariya.dev", port: 2222, os: "ubuntu", tags: ["panel"], lastUsed: "2026-06-16T11:00:00Z" },
  { id: "h4", name: "192.168.2.117", user: "ubuntu", hostname: "192.168.2.117", port: 22, os: "ubuntu", tags: ["lan"], lastUsed: "2026-06-10T09:45:00Z" },
  { id: "h5", name: "Builder", user: "deploy", hostname: "builder.internal", port: 22, os: "debian", tags: ["ci"], lastUsed: "2026-06-14T16:30:00Z" },
  { id: "h6", name: "Edge-NL", user: "root", hostname: "nl1.helmsman.io", port: 22, os: "alpine", tags: ["edge"], lastUsed: "2026-06-17T10:15:00Z" },
];
