declare global {
  interface Window {
    pywebview: {
      api: {
        start_engine: () => Promise<boolean>;
        stop_engine: () => Promise<boolean>;
        get_status: () => Promise<EngineStatus>;
        save_config: (config: Record<string, unknown>) => Promise<boolean>;
        load_subscription: (url: string) => Promise<boolean>;
        get_servers: () => Promise<Server[]>;
      };
    };
  }
}

export interface EngineStatus {
  clash: boolean;
  multidesk: boolean;
}

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  latency?: number;
  status: 'online' | 'offline' | 'unknown';
}

const isDev = !window.pywebview;

const mockStatus: EngineStatus = { clash: false, multidesk: false };
const mockServers: Server[] = [
  { id: '1', name: 'Tokyo-01', host: '103.x.x.1', port: 3389, latency: 45, status: 'online' },
  { id: '2', name: 'Singapore-02', host: '103.x.x.2', port: 3389, latency: 68, status: 'online' },
  { id: '3', name: 'HongKong-03', host: '103.x.x.3', port: 3389, status: 'offline' },
];

export const api = {
  startEngine: async (): Promise<boolean> => {
    if (isDev) {
      mockStatus.clash = true;
      mockStatus.multidesk = true;
      return true;
    }
    return window.pywebview.api.start_engine();
  },

  stopEngine: async (): Promise<boolean> => {
    if (isDev) {
      mockStatus.clash = false;
      mockStatus.multidesk = false;
      return true;
    }
    return window.pywebview.api.stop_engine();
  },

  getStatus: async (): Promise<EngineStatus> => {
    if (isDev) return mockStatus;
    return window.pywebview.api.get_status();
  },

  saveConfig: async (config: Record<string, unknown>): Promise<boolean> => {
    if (isDev) return true;
    return window.pywebview.api.save_config(config);
  },

  loadSubscription: async (url: string): Promise<boolean> => {
    if (isDev) return true;
    return window.pywebview.api.load_subscription(url);
  },

  getServers: async (): Promise<Server[]> => {
    if (isDev) return mockServers;
    return window.pywebview.api.get_servers();
  },
};
