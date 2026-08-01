export type SshAuthMethod = 'password' | 'private_key';
export type SshRoutePolicy = 'auto' | 'direct' | 'cloud_only';

export interface SshConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  credentialReference?: string;
  privateKeyPath?: string;
  routePolicy: SshRoutePolicy;
  preferredRegion?: string;
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
}

export interface SshStartResponse {
  sessionId: string;
  routeLabel: string;
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
