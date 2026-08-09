export type SshAuthMethod = 'password' | 'private_key';
export type SshRoutePolicy = 'auto' | 'direct' | 'cloud_only';
export type SshHostOs = 'linux' | 'windows' | 'unknown';
export type SshProxyType = 'none' | 'socks5' | 'http';

export interface SshConnectionGroup {
  id: string;
  name: string;
  isExpanded: boolean;
}

export interface SshConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  credentialReference?: string;
  privateKeyLabel?: string;
  publicKey?: string;
  /** Legacy file-based key records remain readable during migration. */
  privateKeyPath?: string;
  /** Missing on legacy records; the connection store migrates it to the default group. */
  groupId?: string;
  routePolicy: SshRoutePolicy;
  preferredRegion?: string;
  notes?: string;
  detectedOs?: SshHostOs;
  proxyType?: SshProxyType;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyCredentialReference?: string;
}

export interface SshStartRequest {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  credentialReference?: string;
  privateKeyPath?: string;
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
  routePolicy: SshRoutePolicy;
  preferredRegion?: string;
  reuseCloudBinding: boolean;
  proxyType?: SshProxyType;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyCredentialReference?: string;
}

export interface SshStartResponse {
  sessionId: string;
  routeLabel: string;
}

export interface SshMonitorProcess {
  memoryBytes: number;
  cpuPercent: number;
  command: string;
}

export interface SshMonitorDisk {
  path: string;
  availableBytes: number;
  totalBytes: number;
}

export interface SshMonitorSnapshot {
  supported: boolean;
  platform: SshHostOs;
  uptimeSeconds: number;
  loadAverage: [number, number, number];
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  swapUsedBytes: number;
  swapTotalBytes: number;
  processes: SshMonitorProcess[];
  networkInterface?: string;
  networkReceiveBytesPerSecond: number;
  networkTransmitBytesPerSecond: number;
  latencyMs: number;
  disks: SshMonitorDisk[];
}

export interface SshHostKeyPreview {
  host: string;
  port: number;
  status: 'unknown' | 'changed';
  algorithm: string;
  fingerprint: string;
  publicKey: string;
}

export type SshEvent =
  | {
      kind: 'state';
      sessionId: string;
      state: string;
      routeLabel?: string;
      message?: string;
    }
  | {
      kind: 'host_key';
      sessionId: string;
      preview: SshHostKeyPreview;
    };

export interface SshHostKeyTrustRequest {
  host: string;
  port: number;
  publicKey: string;
}

export interface SshKnownHostEntry {
  host: string;
  algorithm: string;
  fingerprint: string;
  publicKey: string;
}

export type SftpEntryKind = 'directory' | 'file' | 'symlink' | 'other';

export interface SftpEntry {
  name: string;
  path: string;
  kind: SftpEntryKind;
  size: number;
  modified?: number;
  permissions?: number;
  owner?: string;
  group?: string;
}

export interface SftpOpenResponse {
  path: string;
}

export interface SftpListResponse {
  path: string;
  entries: SftpEntry[];
}

export type SftpTransferDirection = 'upload' | 'download';
export type SftpTransferState = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';

export interface SftpTransferRequest {
  sessionId: string;
  transferId: string;
  localPath: string;
  remotePath: string;
  overwrite: boolean;
  recursive: boolean;
}

export interface SftpTransferProgress {
  transferId: string;
  direction: SftpTransferDirection;
  state: SftpTransferState;
  transferredBytes: number;
  totalBytes: number;
  message?: string;
}

export interface SftpCreateDirectoryRequest {
  sessionId: string;
  operationId: string;
  path: string;
}

export interface SftpRenameRequest {
  sessionId: string;
  operationId: string;
  fromPath: string;
  toPath: string;
  overwrite: boolean;
}

export interface SftpRemoveRequest {
  sessionId: string;
  operationId: string;
  path: string;
  recursive: boolean;
}

export interface SftpReadTextRequest {
  sessionId: string;
  path: string;
}

export interface SftpReadTextResponse {
  path: string;
  content: string;
  modified?: number;
  permissions?: number;
}

export interface SftpWriteTextRequest {
  sessionId: string;
  operationId: string;
  path: string;
  content: string;
}

export interface SftpSetPermissionsRequest {
  sessionId: string;
  operationId: string;
  path: string;
  permissions: number;
}
