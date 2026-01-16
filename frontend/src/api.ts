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
        check_for_update: () => Promise<UpdateInfo>;
        get_download_status: () => Promise<DownloadStatus>;
        start_download_update: () => Promise<boolean>;
        install_update: () => Promise<boolean>;
        get_current_version: () => Promise<string>;
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

export interface UpdateInfo {
  has_update: boolean;
  current_version: string;
  latest_version: string | null;
  download_url?: string;
  error?: string;
}

export interface DownloadStatus {
  status: 'idle' | 'downloading' | 'ready' | string;
  progress: number;
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
      return [];
    }
    return window.pywebview.api.get_servers();
  },

  checkForUpdate: async (): Promise<UpdateInfo> => {
    if (!(await ensurePywebview())) {
      return { has_update: false, current_version: 'dev', latest_version: null };
    }
    return window.pywebview.api.check_for_update();
  },

  getDownloadStatus: async (): Promise<DownloadStatus> => {
    if (!(await ensurePywebview())) {
      return { status: 'idle', progress: 0 };
    }
    return window.pywebview.api.get_download_status();
  },

  startDownloadUpdate: async (): Promise<boolean> => {
    if (!(await ensurePywebview())) {
      return false;
    }
    return window.pywebview.api.start_download_update();
  },

  installUpdate: async (): Promise<boolean> => {
    if (!(await ensurePywebview())) {
      return false;
    }
    return window.pywebview.api.install_update();
  },

  getCurrentVersion: async (): Promise<string> => {
    if (!(await ensurePywebview())) {
      return 'dev';
    }
    return window.pywebview.api.get_current_version();
  },
};
