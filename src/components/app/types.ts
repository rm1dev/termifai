export type OsKind = "ubuntu" | "debian" | "centos" | "alpine" | "macos" | "windows";

export interface Host {
  id: string;
  name: string;
  user: string;
  hostname: string;
  port: number;
  os: OsKind;
  tags?: string[];
  lastUsed?: string; // ISO date string
  groupId?: string | null;
  authMethod?: "password" | "key";
  password?: string;
  sshKeyId?: string | null;
  showStatusInDashboard?: boolean;
  defaultSftpPath?: string;
}

export interface HostGroup {
  id: string;
  name: string;
  parentId: string | null;
}

export type SidebarKey =
  | "dashboard"
  | "hosts"
  | "keychain"
  | "port-forwarding"
  | "snippets"
  | "ssh-keys"
  | "logs";

export type TabKind = "vaults" | "sftp" | "terminal";

export interface AppTab {
  id: string;
  kind: TabKind;
  title: string;
  closable: boolean;
  sessionId?: string; // for terminal tabs to preserve session across switches
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
  createdAt?: string; // ISO date string
}

export type SshKeyType = "ed25519" | "rsa";

export interface SshKey {
  id: string;
  name: string;
  type: SshKeyType;
  size?: number; // for RSA
  fingerprint: string;
  remark?: string;
  hasPassphrase?: boolean;
  createdAt: string; // ISO date string
  publicKey?: string;
  publicKeyPath?: string;
  privateKeyPath?: string;
}
