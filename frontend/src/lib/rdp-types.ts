export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error' | 'reconnecting';

export interface ServerEntry {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  domain: string;
  sharedFolder?: string;
  groupId: string;
  isFavorite: boolean;
  colorTag: string;
}

export interface ServerGroup {
  id: string;
  name: string;
  isExpanded: boolean;
}

export interface SessionTab {
  id: string;
  serverId: string;
  name: string;
  host: string;
  status: ConnectionState;
  errorMsg: string;
  thumbnailUrl?: string;
}

export type ViewMode = 'tab' | 'grid';
