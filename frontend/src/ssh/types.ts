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
