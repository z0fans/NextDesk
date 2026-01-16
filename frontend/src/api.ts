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

// Check if pywebview API is available (may be injected after page load)
const hasPywebview = (): boolean => {
  return !!(window.pywebview?.api);
};

// Wait for pywebview to be ready (with timeout)
const waitForPywebview = (): Promise<boolean> => {
  return new Promise((resolve) => {
    if (hasPywebview()) {
      resolve(true);
      return;
    }
    
    // Check every 100ms for up to 3 seconds
    let attempts = 0;
    const maxAttempts = 30;
    const interval = setInterval(() => {
      attempts++;
      if (hasPywebview()) {
        clearInterval(interval);
        resolve(true);
      } else if (attempts >= maxAttempts) {
        clearInterval(interval);
        resolve(false);
      }
    }, 100);
  });
};

// Initialize: wait for pywebview on first call
let pywebviewReady: boolean | null = null;

const ensurePywebview = async (): Promise<boolean> => {
  if (pywebviewReady === null) {
    pywebviewReady = await waitForPywebview();
    console.log('[NextDesk] pywebview ready:', pywebviewReady);
  }
  return pywebviewReady;
};

export const api = {
  startEngine: async (): Promise<boolean> => {
    if (!(await ensurePywebview())) {
      console.warn('[NextDesk] pywebview not available, using mock');
      return true;
    }
    return window.pywebview.api.start_engine();
  },

  stopEngine: async (): Promise<boolean> => {
    if (!(await ensurePywebview())) {
      return true;
    }
    return window.pywebview.api.stop_engine();
  },

  getStatus: async (): Promise<EngineStatus> => {
    if (!(await ensurePywebview())) {
      return { clash: false, multidesk: false };
    }
    return window.pywebview.api.get_status();
  },

  saveConfig: async (config: Record<string, unknown>): Promise<boolean> => {
    if (!(await ensurePywebview())) {
      return true;
    }
    return window.pywebview.api.save_config(config);
  },

  loadSubscription: async (url: string): Promise<boolean> => {
    if (!(await ensurePywebview())) {
      return true;
    }
    return window.pywebview.api.load_subscription(url);
  },

  getServers: async (): Promise<Server[]> => {
    if (!(await ensurePywebview())) {
      // In dev mode without pywebview, return empty array (not mock data)
      return [];
    }
    return window.pywebview.api.get_servers();
  },
};
