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
  networkRoutePreferences?: Record<string, SshRoutePolicy>;
  lastNetworkScopeId?: string;
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
  networkRoutePreferences?: Record<string, SshRoutePolicy>;
  preferredRegion?: string;
  reuseCloudBinding: boolean;
  replaceExisting?: boolean;
  proxyType?: SshProxyType;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyCredentialReference?: string;
}

export interface SshStartResponse {
  sessionId: string;
  routeLabel: string;
  routeDiagnostics?: SshRouteDiagnostics;
  networkScopeId?: string;
}

export interface SshRouteCarrierCapabilities {
  ingress: string[];
  egress: string[];
}

export interface SshRouteAsnCapabilities {
  ingress: number[];
  egress: number[];
}

export interface SshRouteAgentDiagnostics {
  agent_ref: string;
  country_code: string;
  subregion: string;
  routing_group: string;
  line_tags: string[];
  carrier_capabilities: SshRouteCarrierCapabilities;
  asn_capabilities: SshRouteAsnCapabilities;
  supported_protocols: string[];
  capacity: number;
  failure_domain: string;
  software_version: string;
  declared_capabilities: unknown;
  recommendation_rank: number;
}

export interface SshClientNetworkDiagnostics {
  schema_version: number;
  country_code: string;
  province: string;
  asn?: number;
  carrier: string;
  source: string;
  classification_source: string;
  network_scope_id?: string;
}

export interface SshShadowCandidateDiagnostics extends SshRouteAgentDiagnostics {
  shadow_score?: number;
  affinity_reasons: string[];
}

export interface SshShadowEvaluation {
  schema_version: number;
  mode: string;
  policy_revision: string;
  production_policy_revision: string;
  input_summary: {
    country_code: string;
    province: string;
    asn?: number;
    carrier: string;
    requested_protocols: string[];
    target_group: string;
  };
  current_candidates: SshShadowCandidateDiagnostics[];
  shadow_candidates: SshShadowCandidateDiagnostics[];
  excluded_summary: Record<string, number>;
  comparison: {
    same_order: boolean;
    reordered: boolean;
    entered: string[];
    exited: string[];
  };
  rollout?: {
    schema_version: number;
    mode: string;
    service_kind: string;
    rollout_enabled: boolean;
    rollout_percentage: number;
    rollout_bucket: number;
    stable_subject_kind: string;
    candidate_applied: boolean;
    kill_switch: boolean;
    policy_valid: boolean;
    production_policy_revision: string;
    candidate_policy_revision: string;
    selected_policy_revision: string;
  };
}

export interface SshRouteDiagnostics {
  schema_version: number;
  agent: SshRouteAgentDiagnostics;
  client_network: SshClientNetworkDiagnostics;
  shadow_evaluation?: SshShadowEvaluation;
  agent_target_probe?: {
    status?: string;
    service_kind?: "ssh" | "rdp";
    stage_durations_ms?: Record<string, number>;
    outcome_category?: string;
  };
  quality_shadow?: {
    schema_version: number;
    mode: "shadow" | "disabled";
    production_winner_binding_id?: string;
    shadow_winner_binding_id?: string;
    same_winner?: boolean;
    score_delta?: number;
    candidates?: Array<{
      binding_id: string;
      agent_ref?: string;
      score: number;
      realtime_score: number;
      historical_score: number;
      historical_weight: number;
      history_scope: string;
      history_samples: number;
      circuit_state: "closed" | "open" | "observing";
      eligible: boolean;
    }>;
  };
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
