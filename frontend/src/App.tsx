import { useState, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { 
  LayoutDashboard, 
  Server as ServerIcon, 
  Settings, 
  
  Activity, 
  Zap, 
  RefreshCw,
  CheckCircle2,
  Globe,
  Download,
  X,
  ChevronRight,
  FileText,
  PanelLeftClose,
  PanelLeft,
  Monitor,
  Play,
  Square,
  Cloud,
  AlertTriangle,
  Bug,
  Copy,
  FolderOpen,
  Trash2
} from 'lucide-react';
import { api, type EngineStatus, type Server, type UpdateInfo, type ProxyGroup, type Connection, type RunMode, type RelayEndpoint, type AutoUpdateStatus } from './api';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Logo } from '@/components/Logo';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { getTimeAgo } from './lib/timeAgo';
import { ThemeToggle } from '@/components/ThemeToggle';
import { LanguageProvider } from '@/i18n/LanguageProvider';
import { useTranslation } from '@/i18n/useTranslation';
import type { TranslationKey } from '@/i18n/translations';
import { LanguageToggle } from '@/components/LanguageToggle';
import { RdpManager } from '@/components/RdpManager';
import { rdpLog, type RdpLogModule } from '@/lib/rdp-logger';
import { useFolderSharingSetting } from '@/lib/useSessionStore';
import {
  delayStatus,
  delayText,
  groupRealNodes,
  markDelayNodesAsTesting,
  markUnresolvedDelayNodesAsTimeout,
  resolveActiveServerGroupName,
  resolveDelayTargetGroups,
  selectableServerGroups,
  sortServerNodes,
  type DelayScope,
  type ServerNodeSort,
  uniqueDelayNodesForGroups,
} from '@/lib/server-list';

const DEV_LOG_MODULES: RdpLogModule[] = [
  'connection',
  'render',
  'proxy',
  'native',
  'wasm',
  'clipboard',
  'input',
  'audio',
  'file',
  'network',
];

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

function AppContent() {
  const { t } = useTranslation();
  const { folderSharingEnabled, setFolderSharingEnabled } = useFolderSharingSetting();
  const [activeTab, setActiveTab] = useState<'dashboard' | 'servers' | 'proxy' | 'logs' | 'settings' | 'rdp'>('dashboard');
  const [status, setStatus] = useState<EngineStatus>({ clash: false, rdp_proxy_port: 8765 });
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(false);
  const [subUrl, setSubUrl] = useState('');
  const [updatingSub, setUpdatingSub] = useState(false);
  
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'downloading' | 'installing' | 'error'>('idle');
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [, setCurrentVersion] = useState('');
  const [subMessage, setSubMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [proxyGroups, setProxyGroups] = useState<ProxyGroup[]>([]);
  const [activeServerGroupName, setActiveServerGroupName] = useState<string | null>(null);
  const [serverNodeSort, setServerNodeSort] = useState<ServerNodeSort>('default');
  const [selectedProxies, setSelectedProxies] = useState<Record<string, string>>({});
  const [testingConnectivity, setTestingConnectivity] = useState(false);
  const [testingGroups, setTestingGroups] = useState<Set<string>>(new Set());
  const [nodeDelays, setNodeDelays] = useState<Record<string, number>>({});
  const [connections, setConnections] = useState<Connection[]>([]);
  const [runMode, setRunMode] = useState<RunMode>({ reuse_mode: false, clash_api: '', proxy_port: 17897, cloud_mode: false, dashboard_url: '' });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showUpToDateToast, setShowUpToDateToast] = useState(false);
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [, setDashboardUrl] = useState('');
  const [relayEndpoints, setRelayEndpoints] = useState<RelayEndpoint[]>([]);
  const [autoUpdateStatus, setAutoUpdateStatus] = useState<AutoUpdateStatus>({
    enabled: true,
    last_sync_ts: 0,
    sync_state: { type: 'Idle' },
  });
  const [devLogLevel, setDevLogLevel] = useState<'info' | 'debug'>(() =>
    import.meta.env.DEV && rdpLog.getLevel() === 'debug' ? 'debug' : 'info'
  );
  const [devLogModules, setDevLogModules] = useState<Set<RdpLogModule>>(
    () => new Set(DEV_LOG_MODULES)
  );
  const [backendLogPath, setBackendLogPath] = useState('');
  const [rdpLogPath, setRdpLogPath] = useState('');
  const [backendLogSize, setBackendLogSize] = useState(0);
  const [rdpLogSize, setRdpLogSize] = useState(0);
  const [diagnosticMessage, setDiagnosticMessage] = useState('');

  const refreshDiagnosticLogInfo = async () => {
    if (!import.meta.env.DEV) return;
    const [backendPath, rdpPath, backendSize, rdpSize] = await Promise.all([
      api.logFilePath(),
      api.rdpLogFilePath(),
      api.logFileSize(),
      api.rdpLogFileSize(),
    ]);
    setBackendLogPath(backendPath);
    setRdpLogPath(rdpPath);
    setBackendLogSize(backendSize);
    setRdpLogSize(rdpSize);
  };

  const handleDevLogLevelToggle = (enabled: boolean) => {
    const level = enabled ? 'debug' : 'info';
    rdpLog.setLevel(level);
    setDevLogLevel(level);
    rdpLog.info('connection', 'developer log level changed', { level });
  };

  const handleDevLogModuleToggle = (module: RdpLogModule, enabled: boolean) => {
    setDevLogModules(prev => {
      const next = new Set(prev);
      if (enabled) {
        next.add(module);
      } else {
        next.delete(module);
      }
      rdpLog.setModules([...next]);
      rdpLog.info('connection', 'developer log modules changed', { modules: [...next] });
      return next;
    });
  };

  const handleClearDiagnosticLogs = async () => {
    if (!window.confirm(t('logClearConfirm'))) return;
    await Promise.all([api.logClear(), api.rdpLogClear()]);
    setDiagnosticMessage(t('logCleared'));
    await refreshDiagnosticLogInfo();
  };

  const handleCopyDiagnosticBundle = async () => {
    const path = await api.logCopyDiagnosticBundleToDesktop();
    setDiagnosticMessage(`${t('diagnosticBundleCopied')}: ${path}`);
  };

  useEffect(() => {
    if (import.meta.env.DEV && activeTab === 'settings') {
      refreshDiagnosticLogInfo().catch(console.error);
    }
  }, [activeTab]);

  useEffect(() => {
    if (proxyGroups.length > 0) {
      setSelectedProxies(prev => {
        const next = { ...prev };
        let changed = false;
        proxyGroups.forEach(group => {
          if (!next[group.name] && group.proxies.length > 0) {
            next[group.name] = group.proxies[0];
            changed = true;
          }
        });
        return changed ? next : prev;
      });

    }
  }, [proxyGroups]);

  useEffect(() => {
    setActiveServerGroupName((current) =>
      resolveActiveServerGroupName(current, proxyGroups, servers)
    );
  }, [proxyGroups, servers]);

  // Fetch auto-update status on mount + listen for changes
  useEffect(() => {
    api.getAutoUpdateStatus().then(setAutoUpdateStatus).catch(console.error);

    const unlisten = listen<AutoUpdateStatus>('subscription_sync_state', (event) => {
      setAutoUpdateStatus(event.payload);
    });

    return () => { unlisten.then(fn => fn()); };
  }, []);

  const handleProxySelect = async (groupName: string, proxyName: string) => {
    setSelectedProxies(prev => ({
      ...prev,
      [groupName]: proxyName
    }));
    const success = await api.switchProxy(groupName, proxyName);
    if (success) {
      const newProxyGroups = await api.getProxyGroups();
      setProxyGroups(newProxyGroups);
    }
  };

  const ensureEngineRunningForDelayTest = async () => {
    const currentStatus = await api.getStatus();
    if (currentStatus.clash) {
      setStatus(currentStatus);
      return;
    }

    await api.startEngine();
    const [newStatus, newProxyGroups, newRunMode] = await Promise.all([
      api.getStatus(),
      api.getProxyGroups(),
      api.getRunMode()
    ]);
    setStatus(newStatus);
    setProxyGroups(newProxyGroups);
    setRunMode(newRunMode);
  };

  const handleTestConnectivity = async (scope: DelayScope = { type: 'all' }) => {
    const targetGroupNames = resolveDelayTargetGroups(scope, proxyGroups, servers);

    if (targetGroupNames.length === 0) {
      return;
    }

    const targetNodeNames = uniqueDelayNodesForGroups(targetGroupNames, proxyGroups, servers);

    const setGroupTimeoutState = (groupName: string) => {
      const group = proxyGroups.find(item => item.name === groupName);
      if (!group) {
        return;
      }
      const entries = groupRealNodes(group, servers);
      if (entries.length === 0) {
        return;
      }
      setNodeDelays(prev => markUnresolvedDelayNodesAsTimeout(prev, entries));
    };

    setTestingConnectivity(true);
    setTestingGroups(prev => new Set([...prev, ...targetGroupNames]));
    setNodeDelays(prev => markDelayNodesAsTesting(prev, targetNodeNames));
    try {
      await ensureEngineRunningForDelayTest();
      for (const groupName of targetGroupNames) {
        try {
          const delays = await api.testGroupDelays(groupName);
          setNodeDelays(prev => ({ ...prev, ...delays }));
        } catch (error) {
          setGroupTimeoutState(groupName);
          console.error(`Failed to test connectivity for ${groupName}`, error);
        }
      }
    } catch (error) {
      console.error('Failed to test connectivity', error);
    } finally {
      setTestingConnectivity(false);
      setTestingGroups(prev => {
        const next = new Set(prev);
        targetGroupNames.forEach(groupName => next.delete(groupName));
        return next;
      });
    }
  };

  const fetchData = async () => {
    try {
      const [newStatus, newServers, newProxyGroups, newRunMode] = await Promise.all([
        api.getStatus(),
        api.getServers(),
        api.getProxyGroups(),
        api.getRunMode()
      ]);
      setStatus(newStatus);
      setServers(newServers);
      setProxyGroups(newProxyGroups);
      setRunMode(newRunMode);
      // Sync cloud mode state from backend
      if (newRunMode.cloud_mode !== undefined) {
        setCloudEnabled(newRunMode.cloud_mode);
        setDashboardUrl(newRunMode.dashboard_url || '');
      }
      // Load relay endpoints if cloud mode is on
      if (newRunMode.cloud_mode) {
        try {
          const eps = await api.getRelayEndpoints();
          setRelayEndpoints(eps);
        } catch { /* ignore */ }
      }
    } catch (error) {
      console.error('Failed to fetch data', error);
    }
  };

  const checkForUpdate = async (manual = false) => {
    try {
      const [version, info] = await Promise.all([
        api.getCurrentVersion(),
        api.checkForUpdate()
      ]);
      setCurrentVersion(version);
      setUpdateInfo(info);
      if (info.has_update) {
        setShowUpdateModal(true);
      } else if (manual && !info.error) {
        setShowUpToDateToast(true);
        setTimeout(() => setShowUpToDateToast(false), 3000);
      }
    } catch (error) {
      console.error('Failed to check for update', error);
    }
  };

  const handleDownloadAndInstall = async () => {
    try {
      setUpdateStatus('downloading');
      setDownloadProgress(0);
      const update = await check();
      if (!update) {
        console.warn('Updater check() returned null — version in latest.json may not be newer than current');
        setUpdateStatus('error');
        return;
      }

      let downloaded = 0;
      let totalSize = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            totalSize = event.data.contentLength ?? 0;
            downloaded = 0;
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            if (totalSize > 0) {
              setDownloadProgress(Math.round((downloaded / totalSize) * 100));
            }
            break;
          case 'Finished':
            setUpdateStatus('installing');
            break;
        }
      });
      await relaunch();
    } catch (error) {
      console.error('Update failed', error);
      setUpdateStatus('error');
    }
  };

  useEffect(() => {
    fetchData();
    checkForUpdate();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (activeTab === 'logs') {
      const fetchConnections = async () => {
        const data = await api.getConnections();
        setConnections(data.connections || []);
      };
      fetchConnections();
      const interval = setInterval(fetchConnections, 2000);
      return () => clearInterval(interval);
    }
  }, [activeTab]);

  const handleToggleEngine = async () => {
    setLoading(true);
    try {
      if (status.clash) {
        await api.stopEngine();
      } else {
        await api.startEngine();
      }
      setTimeout(fetchData, 1000);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Failed to toggle engine:', msg);
      alert(`Engine error: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateSubscription = async () => {
    if (!subUrl) return;
    setUpdatingSub(true);
    setSubMessage(null);
    try {
      const result = await api.loadSubscription(subUrl);
      if (result.success) {
        setSubMessage({ type: 'success', text: t('loadedServers', { count: result.server_count }) });
        await fetchData();
      } else {
        setSubMessage({ type: 'error', text: result.error || t('failedToLoadSub') });
      }
    } catch {
      setSubMessage({ type: 'error', text: t('networkError') });
    } finally {
      setUpdatingSub(false);
      setTimeout(() => setSubMessage(null), 5000);
    }
  };

  const handleAutoUpdateToggle = async (enabled: boolean) => {
    try {
      await api.setAutoUpdateEnabled(enabled);
      setAutoUpdateStatus(prev => ({ ...prev, enabled }));
    } catch (e) {
      console.error('Failed to toggle auto-update:', e);
    }
  };

  const handleRetrySync = async () => {
    try {
      await api.triggerSyncNow();
    } catch (e) {
      console.error('Failed to trigger sync:', e);
    }
  };

  const isRunning = status.clash;

  return (
    <div className="h-screen w-full bg-background text-foreground font-sans flex transition-colors duration-300 overflow-hidden">
      <aside className={cn(
        "hidden md:flex md:flex-col md:fixed md:inset-y-0 md:left-0 border-r border-border bg-sidebar z-50 transition-all duration-300 relative",
        sidebarCollapsed ? "md:w-16" : "md:w-48"
      )}>
        <div className={cn("p-4 flex items-center border-b border-sidebar-border", sidebarCollapsed ? "justify-center" : "gap-3")}>
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-blue-600 to-cyan-600 flex items-center justify-center shadow-lg shadow-blue-900/20 overflow-hidden shrink-0">
            <Logo className="h-7 w-7" />
          </div>
          {!sidebarCollapsed && (
            <div className="flex-1 min-w-0">
              <span className="font-bold text-lg text-sidebar-foreground block leading-none mb-1">
                NextDesk
              </span>
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block leading-none">
                {t('accelerator')}
              </span>
            </div>
          )}
        </div>

        <nav className={cn("flex-1 py-4 space-y-1", sidebarCollapsed ? "px-2" : "px-3")}>
          <Button
            variant="ghost"
            onClick={() => setActiveTab('dashboard')}
            className={cn(
              "w-full h-11 text-sm font-medium transition-all mb-1",
              sidebarCollapsed ? "justify-center px-0" : "justify-start gap-3",
              activeTab === 'dashboard' 
                ? "bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300" 
                : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent"
            )}
            title={sidebarCollapsed ? t('dashboard') : undefined}
          >
            <LayoutDashboard className={cn("h-4 w-4 shrink-0", activeTab === 'dashboard' ? "text-blue-500" : "text-muted-foreground")} />
            {!sidebarCollapsed && t('dashboard')}
          </Button>

          <Button
            variant="ghost"
            onClick={() => setActiveTab('servers')}
            className={cn(
              "w-full h-11 text-sm font-medium transition-all mb-1",
              sidebarCollapsed ? "justify-center px-0" : "justify-start gap-3",
              activeTab === 'servers' 
                ? "bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/15 hover:text-cyan-300" 
                : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent"
            )}
            title={sidebarCollapsed ? t('servers') : undefined}
          >
            <ServerIcon className={cn("h-4 w-4 shrink-0", activeTab === 'servers' ? "text-cyan-500" : "text-muted-foreground")} />
            {!sidebarCollapsed && t('servers')}
          </Button>

          <Button
            variant="ghost"
            onClick={() => setActiveTab('rdp')}
            className={cn(
              "w-full h-11 text-sm font-medium transition-all mb-1",
              sidebarCollapsed ? "justify-center px-0" : "justify-start gap-3",
              activeTab === 'rdp' 
                ? "bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/15 hover:text-cyan-300" 
                : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent"
            )}
            title={sidebarCollapsed ? t('rdp') : undefined}
          >
            <Monitor className={cn("h-4 w-4 shrink-0", activeTab === 'rdp' ? "text-cyan-500" : "text-muted-foreground")} />
            {!sidebarCollapsed && t('rdp')}
          </Button>

          <Button
            variant="ghost"
            onClick={() => setActiveTab('proxy')}
            className={cn(
              "w-full h-11 text-sm font-medium transition-all mb-1",
              sidebarCollapsed ? "justify-center px-0" : "justify-start gap-3",
              activeTab === 'proxy' 
                ? "bg-violet-500/10 text-violet-400 hover:bg-violet-500/15 hover:text-violet-300" 
                : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent"
            )}
            title={sidebarCollapsed ? t('proxy') : undefined}
          >
            <Globe className={cn("h-4 w-4 shrink-0", activeTab === 'proxy' ? "text-violet-500" : "text-muted-foreground")} />
            {!sidebarCollapsed && t('proxy')}
          </Button>

          <Button
            variant="ghost"
            onClick={() => setActiveTab('logs')}
            className={cn(
              "w-full h-11 text-sm font-medium transition-all mb-1",
              sidebarCollapsed ? "justify-center px-0" : "justify-start gap-3",
              activeTab === 'logs' 
                ? "bg-amber-500/10 text-amber-400 hover:bg-amber-500/15 hover:text-amber-300" 
                : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent"
            )}
            title={sidebarCollapsed ? t('logs') : undefined}
          >
            <FileText className={cn("h-4 w-4 shrink-0", activeTab === 'logs' ? "text-amber-500" : "text-muted-foreground")} />
            {!sidebarCollapsed && t('logs')}
          </Button>

          <Button
            variant="ghost"
            onClick={() => setActiveTab('settings')}
            className={cn(
              "w-full h-11 text-sm font-medium transition-all mb-1",
              sidebarCollapsed ? "justify-center px-0" : "justify-start gap-3",
              activeTab === 'settings' 
                ? "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/15 hover:text-emerald-300" 
                : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent"
            )}
            title={sidebarCollapsed ? t('settings') : undefined}
          >
            <Settings className={cn("h-4 w-4 shrink-0", activeTab === 'settings' ? "text-emerald-500" : "text-muted-foreground")} />
            {!sidebarCollapsed && t('settings')}
          </Button>
        </nav>

        <div className={cn("p-3 border-t border-sidebar-border", sidebarCollapsed ? "px-2" : "px-4")}>
          {!sidebarCollapsed && (
            <div className="bg-sidebar-accent rounded-lg p-3 border border-sidebar-border mb-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">{t('status')}</span>
                <div className={cn("h-1.5 w-1.5 rounded-full transition-colors", isRunning ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground/30')} />
              </div>
              <div className="flex items-center gap-2">
                <Activity className={cn("h-3.5 w-3.5", isRunning ? "text-emerald-500" : "text-muted-foreground")} />
                <div className="text-sm font-medium text-sidebar-foreground">
                  {isRunning ? t('systemActive') : t('systemIdle')}
                </div>
              </div>
            </div>
          )}
          {sidebarCollapsed && (
            <div className="flex justify-center mb-3">
              <div className={cn("h-2.5 w-2.5 rounded-full transition-colors", isRunning ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground/30')} />
            </div>
          )}

        </div>

        {/* Edge hover trigger for collapse/expand */}
        <div
          className="absolute top-0 right-0 w-3 h-full flex items-center justify-center group/edge cursor-pointer z-10"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        >
          <div className="opacity-0 group-hover/edge:opacity-100 transition-opacity duration-200 bg-sidebar-accent/90 backdrop-blur-sm rounded-l-md py-2 px-0.5 border border-r-0 border-sidebar-border shadow-md">
            {sidebarCollapsed
              ? <PanelLeft className="h-3 w-3 text-muted-foreground" />
              : <PanelLeftClose className="h-3 w-3 text-muted-foreground" />
            }
          </div>
        </div>
      </aside>

      <main className={cn(
        "flex-1 min-w-0 h-screen bg-background transition-all duration-300 overflow-hidden",
        sidebarCollapsed ? "md:ml-16" : "md:ml-48"
      )}>
        <div className={cn(
          activeTab === 'rdp'
            ? "h-full flex flex-col"
            : "h-full overflow-y-auto scrollbar-none max-w-6xl mx-auto px-6 py-8 md:px-10 md:py-10 space-y-8"
        )}>
          
          {/* Header — hidden for RDP (has its own chrome) */}
          {activeTab !== 'rdp' && (
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-foreground tracking-tight mb-1">
                {activeTab === 'dashboard' && t('dashboard')}
                {activeTab === 'servers' && t('serverList')}
                {activeTab === 'proxy' && t('proxy')}
                {activeTab === 'logs' && t('logs')}
                {activeTab === 'settings' && t('settings')}
              </h1>
              <p className="text-muted-foreground">
                {activeTab === 'dashboard' && t('dashboardDesc')}
                {activeTab === 'servers' && t('serversDesc')}
                {activeTab === 'proxy' && t('proxyDesc')}
                {activeTab === 'logs' && t('logsDesc')}
                {activeTab === 'settings' && t('settingsDesc')}
              </p>
            </div>
            {activeTab === 'servers' ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => activeServerGroupName && handleTestConnectivity({ type: 'group', groupName: activeServerGroupName })}
                  disabled={testingConnectivity || !activeServerGroupName}
                  className="h-9 rounded-full border-input bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
                  title={t('testCurrentGroup')}
                >
                  <Zap className={cn("mr-1.5 h-3.5 w-3.5", testingConnectivity && "animate-pulse")} />
                  {t('testCurrentGroup')}
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => handleTestConnectivity({ type: 'all' })}
                  disabled={testingConnectivity || selectableServerGroups(proxyGroups, servers).length === 0}
                  className="h-9 rounded-full bg-gradient-to-r from-blue-500 to-cyan-500 text-white shadow-[0_10px_24px_rgba(59,130,246,0.22)] hover:from-blue-600 hover:to-cyan-600"
                  title={t('testAllNodes')}
                >
                  <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", testingConnectivity && "animate-spin")} />
                  {t('testAllNodes')}
                </Button>
              </div>
            ) : activeTab === 'dashboard' ? (
              <Button 
                variant="outline" 
                size="icon" 
                disabled={loading}
                onClick={async () => {
                  setLoading(true);
                  try {
                    await api.startEngine();
                    setTimeout(fetchData, 1000);
                  } catch (error: unknown) {
                    const msg = error instanceof Error ? error.message : String(error);
                    alert(`Engine error: ${msg}`);
                  } finally {
                    setLoading(false);
                  }
                }}
                className="rounded-full h-10 w-10 border-input bg-card text-muted-foreground hover:text-foreground hover:bg-accent hover:border-accent"
                title={t('refresh')}
              >
                <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              </Button>
            ) : null}
          </div>
          )}

          {/* Dashboard View */}
          {activeTab === 'dashboard' && (
            <div className="space-y-6">
              
              {/* Hero Engine Status Card */}
              <div className={cn(
                "relative overflow-hidden rounded-2xl border p-6 backdrop-blur-md transition-all duration-500",
                isRunning
                  ? "bg-gradient-to-br from-blue-500/5 via-card/80 to-cyan-500/5 border-blue-500/20 shadow-[0_0_30px_-5px_rgba(59,130,246,0.15)]"
                  : "bg-card/60 border-border"
              )}>
                {/* Subtle glow effect when running */}
                {isRunning && (
                  <div className="absolute inset-0 bg-gradient-to-r from-blue-500/5 via-transparent to-cyan-500/5 pointer-events-none" />
                )}
                <div className="relative flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    {/* Status indicator */}
                    <div className={cn(
                      "h-12 w-12 rounded-xl flex items-center justify-center transition-all duration-300",
                      isRunning
                        ? "bg-blue-500/10 shadow-[0_0_15px_rgba(59,130,246,0.2)]"
                        : "bg-muted/50"
                    )}>
                      <div className="relative">
                        <Activity className={cn(
                          "h-6 w-6 transition-colors duration-300",
                          isRunning ? "text-blue-500" : "text-muted-foreground"
                        )} />
                        {isRunning && (
                          <div className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse ring-2 ring-card" />
                        )}
                      </div>
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-foreground">
                        {t('coreEngine')}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {isRunning ? t('running') : t('stopped')}
                      </p>
                    </div>
                  </div>
                  {/* Start / Stop Button */}
                  <Button
                    onClick={handleToggleEngine}
                    disabled={loading}
                    className={cn(
                      "h-10 px-6 rounded-full font-medium transition-all duration-300 gap-2",
                      isRunning
                        ? "bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20"
                        : "bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white shadow-lg shadow-blue-500/20"
                    )}
                  >
                    {loading ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : isRunning ? (
                      <><Square className="h-3.5 w-3.5" /> {t('stopEngine')}</>
                    ) : (
                      <><Play className="h-4 w-4" /> {t('startEngine')}</>
                    )}
                  </Button>
                </div>
              </div>

              {/* Info Cards - 2 Column Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                
                {/* RDP Card */}
                <div 
                  className={cn(
                    "group relative overflow-hidden rounded-xl border p-5 cursor-pointer transition-all duration-300 backdrop-blur-sm",
                    "bg-card/60 border-border hover:border-cyan-500/30 hover:shadow-[0_0_20px_-5px_rgba(6,182,212,0.15)]"
                  )}
                  onClick={() => setActiveTab('rdp')}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-lg bg-cyan-500/10 flex items-center justify-center">
                        <Monitor className="h-4 w-4 text-cyan-500" />
                      </div>
                      <h3 className="text-sm font-semibold text-foreground">{t('rdp')}</h3>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-cyan-400 transition-colors" />
                  </div>
                  <div className="text-xl font-bold text-foreground mb-1">{t('rdpAcceleration')}</div>
                  <p className="text-xs text-muted-foreground mb-3">{t('rdpDesc')}</p>
                  <Badge variant="secondary" className="rounded-full px-2.5 py-0.5 text-xs font-mono font-normal border bg-cyan-500/10 text-cyan-400 border-cyan-500/20">
                    v{__APP_VERSION__}
                  </Badge>
                </div>

                {/* Network Status Card */}
                <div className="relative overflow-hidden rounded-xl border border-border p-5 backdrop-blur-sm bg-card/60">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="h-9 w-9 rounded-lg bg-violet-500/10 flex items-center justify-center">
                      <Globe className="h-4 w-4 text-violet-500" />
                    </div>
                    <h3 className="text-sm font-semibold text-foreground">{t('networkStatus')}</h3>
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">{t('runningMode')}</span>
                      <span className="text-sm font-medium text-foreground">
                        {t('builtIn')}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">{t('accelerationChannel')}</span>
                      <span className="relative group text-sm font-medium text-foreground flex items-center gap-1.5 cursor-default">
                        <span className={`h-2 w-2 rounded-full ${status.clash ? 'bg-green-500' : 'bg-muted-foreground/40'}`}></span>
                        {status.clash ? t('ready') : t('notReady')}
                        <span className="absolute bottom-full right-0 mb-2 px-2.5 py-1 rounded-md bg-popover border border-border text-xs font-mono text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap shadow-lg">
                          {t('port')} {runMode.proxy_port}
                        </span>
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">{t('connectionRelay')}</span>
                      <span className="relative group text-sm font-medium text-foreground flex items-center gap-1.5 cursor-default">
                        <span className={`h-2 w-2 rounded-full ${status.clash ? 'bg-blue-500' : 'bg-muted-foreground/40'}`}></span>
                        {status.clash ? t('normal') : t('closed')}
                        <span className="absolute bottom-full right-0 mb-2 px-2.5 py-1 rounded-md bg-popover border border-border text-xs font-mono text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap shadow-lg">
                          {t('port')} {status.rdp_proxy_port}
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Cloud Relay Endpoints */}
              {cloudEnabled && (
                <div className="relative overflow-hidden rounded-xl border border-violet-500/20 p-5 backdrop-blur-sm bg-card/60">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-lg bg-violet-500/10 flex items-center justify-center">
                        <Cloud className="h-4 w-4 text-violet-500" />
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-foreground">{t('cloudRelay')}</h3>
                        <p className="text-xs text-muted-foreground">{t('cloudRelayDesc')}</p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      onClick={async () => {
                        try {
                          const eps = await api.refreshRelayEndpoints();
                          setRelayEndpoints(eps);
                        } catch (e) { console.error(e); }
                      }}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {relayEndpoints.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t('noEndpoints')}</p>
                  ) : (
                    <div className="space-y-1.5">
                      {relayEndpoints.map((ep) => (
                        <div key={ep.id} className="flex items-center justify-between py-1.5 px-2 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                            <span className="text-xs font-medium text-foreground">{ep.name}</span>
                          </div>
                          <span className="text-xs font-mono text-muted-foreground">
                            {ep.host}:{ep.port}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground mt-2">{t('autoCreateInfo')}</p>
                </div>
              )}

            </div>
          )}

          {/* Servers View */}
          {activeTab === 'servers' && (() => {
            const getGroupMeta = (name: string) => {
              const lower = name.toLowerCase();
              if (lower.includes('americas')) return {
                icon: '🌎', accentBg: 'border-l-blue-500',
                dotColor: 'bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]',
                nameColor: 'text-blue-400',
                descKey: 'serverGroupDescAmericas' as const,
                coverageKey: 'serverGroupCoverageAmericas' as const,
                iconBg: 'bg-blue-500/12',
              };
              if (lower.includes('asia')) return {
                icon: '🌏', accentBg: 'border-l-amber-500',
                dotColor: 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]',
                nameColor: 'text-amber-400',
                descKey: 'serverGroupDescAsia' as const,
                coverageKey: 'serverGroupCoverageAsia' as const,
                iconBg: 'bg-amber-500/12',
              };
              return {
                icon: '🌐', accentBg: 'border-l-slate-500',
                dotColor: 'bg-slate-500 shadow-[0_0_8px_rgba(100,116,139,0.4)]',
                nameColor: 'text-slate-400',
                descKey: 'serverGroupDescGlobal' as const,
                coverageKey: 'serverGroupCoverageGlobal' as const,
                iconBg: 'bg-slate-500/12',
              };
            };
            const realGroups = selectableServerGroups(proxyGroups, servers);
            const activeGroup = realGroups.find(group => group.name === activeServerGroupName) ?? realGroups[0] ?? null;

            const cleanGroupName = (name: string) =>
              name.replace(/^[^\p{L}\p{N}]+/u, '').trim();

            const resolveSelectedRealProxy = (group: ProxyGroup) => {
              const realNodes = groupRealNodes(group, servers);
              const candidates = [
                group.now,
                selectedProxies[group.name],
                proxyGroups.find(item => item.name === group.now)?.now,
                realNodes[0],
              ];
              return candidates.find((candidate): candidate is string =>
                Boolean(candidate && realNodes.includes(candidate))
              ) ?? realNodes[0] ?? group.now ?? group.proxies[0] ?? '';
            };

            const getDelayColor = (delay: number | undefined) => {
              switch (delayStatus(delay)) {
                case 'testing':
                  return 'text-cyan-400';
                case 'timeout':
                  return 'text-red-400';
                case 'good':
                  return 'text-emerald-400';
                case 'medium':
                  return 'text-yellow-400';
                case 'slow':
                  return 'text-orange-400';
                default:
                  return 'text-muted-foreground/60';
              }
            };

            const activeGroupMeta = activeGroup ? getGroupMeta(activeGroup.name) : null;
            const activeSelectedProxy = activeGroup ? resolveSelectedRealProxy(activeGroup) : '';
            const activeGroupNodes = activeGroup
              ? sortServerNodes(groupRealNodes(activeGroup, servers), nodeDelays, serverNodeSort)
              : [];

            return (
            <div className="space-y-6">
              {realGroups.length === 0 ? (
                <Card className="bg-card border-border">
                  <CardContent className="p-6 text-center text-muted-foreground">
                    {t('noProxyGroups')}
                  </CardContent>
                </Card>
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                    {realGroups.map((group) => {
                      const meta = getGroupMeta(group.name);
                      const selectedProxy = resolveSelectedRealProxy(group);
                      const selectedNodeDelay = nodeDelays[selectedProxy];
                      const selectedDelay = testingGroups.has(group.name) && selectedNodeDelay === undefined
                        ? 0
                        : selectedNodeDelay;
                      const selectedDelayText = delayText(selectedDelay);
                      const displayName = cleanGroupName(group.name);
                      const isActive = activeGroup?.name === group.name;

                      return (
                        <button
                          key={group.name}
                          type="button"
                          onClick={() => setActiveServerGroupName(group.name)}
                          className={cn(
                            "relative bg-card/80 backdrop-blur-sm border rounded-2xl overflow-hidden text-left transition-all duration-200 hover:border-border/80 hover:shadow-[0_8px_32px_rgba(0,0,0,0.18)] hover:-translate-y-0.5",
                            `border-l-4 ${meta.accentBg}`,
                            isActive ? "border-border shadow-[0_10px_32px_rgba(15,23,42,0.12)]" : "border-border/70"
                          )}
                        >
                          <div className="p-5">
                            <div className="flex items-center gap-3 mb-2">
                              <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0", meta.iconBg)}>
                                {meta.icon}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="font-bold text-foreground text-[15px] truncate">{displayName}</span>
                                  <Badge variant="outline" className="text-[9px] uppercase tracking-wider border bg-cyan-500/10 text-cyan-400 border-cyan-500/20 shrink-0">
                                    {group.type}
                                  </Badge>
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5">{t(meta.descKey)}</p>
                              </div>
                            </div>

                            {t(meta.coverageKey) && t(meta.coverageKey) !== meta.coverageKey && <p className="text-[11px] text-muted-foreground/70 mb-3 pl-[52px]">{t(meta.coverageKey)}</p>}

                            <div className="flex items-center gap-2 px-3 py-2.5 bg-background/40 rounded-xl border border-border/50">
                              <div className={cn("w-2 h-2 rounded-full shrink-0", meta.dotColor)} />
                              <span className="text-[11px] text-muted-foreground">{t('currentNode')}</span>
                              <span className={cn("text-[13px] font-semibold ml-auto truncate", meta.nameColor)}>{selectedProxy}</span>
                              {selectedDelayText && (
                                <span className={cn("text-[10px] font-mono font-semibold shrink-0", getDelayColor(selectedDelay))}>
                                  {selectedDelayText}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {activeGroup && activeGroupMeta && (
                    <div className={cn("bg-card/80 backdrop-blur-sm border border-border rounded-2xl overflow-hidden border-l-4", activeGroupMeta.accentBg)}>
                      <div className="p-4 sm:p-5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between border-b border-border">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0", activeGroupMeta.iconBg)}>{activeGroupMeta.icon}</div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-bold text-foreground text-base truncate">{cleanGroupName(activeGroup.name)}</span>
                              <Badge variant="outline" className="text-[9px] uppercase tracking-wider border bg-cyan-500/10 text-cyan-400 border-cyan-500/20">{activeGroup.type}</Badge>
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">{t(activeGroupMeta.descKey)}</p>
                          </div>
                        </div>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between lg:justify-end">
                          <div className="flex min-w-0 items-center gap-2 rounded-xl border border-border/60 bg-background/40 px-3 py-2">
                            <span className="text-[11px] text-muted-foreground shrink-0">{t('currentNode')}:</span>
                            <span className={cn("truncate text-[13px] font-semibold", activeGroupMeta.nameColor)}>{activeSelectedProxy}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="flex rounded-full border border-border bg-muted/50 p-1">
                              {([
                                ['default', t('sortDefault')],
                                ['delay', t('sortByDelay')],
                                ['name', t('sortByName')],
                              ] as const).map(([value, label]) => (
                                <button
                                  key={value}
                                  type="button"
                                  onClick={() => setServerNodeSort(value)}
                                  className={cn(
                                    "h-7 rounded-full px-3 text-[11px] font-semibold transition-colors",
                                    serverNodeSort === value
                                      ? "bg-card text-foreground shadow-sm"
                                      : "text-muted-foreground hover:text-foreground"
                                  )}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => handleTestConnectivity({ type: 'group', groupName: activeGroup.name })}
                              disabled={testingConnectivity}
                              className="h-9 w-9 rounded-full border-input bg-card text-muted-foreground hover:bg-accent hover:text-yellow-400"
                              title={t('testCurrentGroup')}
                            >
                              <Zap className={cn("h-4 w-4", testingGroups.has(activeGroup.name) && "animate-pulse text-yellow-400")} />
                            </Button>
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-3 bg-muted/20 p-4 sm:grid-cols-2 lg:grid-cols-3">
                        {activeGroupNodes.map(proxy => {
                          const isSelected = activeSelectedProxy === proxy;
                          const delay = testingGroups.has(activeGroup.name) && nodeDelays[proxy] === undefined
                            ? 0
                            : nodeDelays[proxy];
                          const text = delayText(delay);

                          return (
                            <button
                              key={proxy}
                              type="button"
                              onClick={() => handleProxySelect(activeGroup.name, proxy)}
                              className={cn(
                                "min-w-0 rounded-xl border px-4 py-3 text-left transition-all flex items-center justify-between gap-3",
                                isSelected
                                  ? "bg-blue-500/15 text-blue-400 border-blue-500/30 shadow-[0_8px_18px_rgba(59,130,246,0.12)]"
                                  : "bg-card/70 text-muted-foreground border-transparent hover:bg-accent hover:text-foreground"
                              )}
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-semibold">{proxy}</span>
                                <span className="mt-0.5 block text-[11px] text-muted-foreground">RDP</span>
                              </span>
                              {text && (
                                <span className={cn("font-mono text-[11px] font-semibold shrink-0", getDelayColor(delay))}>{text}</span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            );
          })()}

          {/* Proxy View */}
          {activeTab === 'proxy' && (
            <div className="space-y-6">
              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle className="text-lg text-foreground">{t('subscription')}</CardTitle>
                  <CardDescription className="text-muted-foreground">{t('manageSubscription')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex gap-3">
                    <Input
                      placeholder={t('subUrlPlaceholder')}
                      value={subUrl}
                      onChange={(e) => setSubUrl(e.target.value)}
                      className="bg-background border-input text-foreground placeholder:text-muted-foreground focus-visible:ring-ring"
                    />
                    <Button 
                      onClick={handleUpdateSubscription} 
                      disabled={updatingSub || !subUrl}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white"
                    >
                      {updatingSub ? t('updating') : t('update')}
                    </Button>
                  </div>

                  {subMessage && (
                    <div className={cn(
                      "rounded-md p-3 text-sm",
                      subMessage.type === 'success' 
                        ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
                        : "bg-red-500/10 border border-red-500/20 text-red-400"
                    )}>
                      {subMessage.text}
                    </div>
                  )}
                  
                  {/* Auto-Update Status Bar */}
                  {autoUpdateStatus.sync_state.type === 'Failed' ? (
                    <div className="bg-orange-500/5 border border-orange-500/20 rounded-md p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex gap-3 items-center">
                          <AlertTriangle className="h-5 w-5 text-orange-500 shrink-0" />
                          <span className="text-sm font-medium text-orange-400">
                            {t('autoSyncFailed').replace(
                              '{reason}',
                              t(
                                autoUpdateStatus.sync_state.error_category === 'network_error'
                                  ? 'errorCategoryNetwork'
                                  : autoUpdateStatus.sync_state.error_category === 'subscription_invalid'
                                  ? 'errorCategorySubscriptionInvalid'
                                  : 'errorCategoryUnknown'
                              )
                            )}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-orange-400/60 cursor-pointer hover:text-orange-400/80" onClick={handleRetrySync}>
                            {t('syncRetryNow')}
                          </span>
                          <Switch
                            checked={autoUpdateStatus.enabled}
                            onCheckedChange={handleAutoUpdateToggle}
                          />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className={cn(
                      "rounded-md p-4 border",
                      autoUpdateStatus.enabled
                        ? "bg-blue-500/5 border-blue-500/10"
                        : "bg-muted/30 border-border"
                    )}>
                      <div className="flex items-center justify-between">
                        <div className="flex gap-3 items-center">
                          <CheckCircle2 className={cn(
                            "h-5 w-5 shrink-0",
                            autoUpdateStatus.enabled ? "text-blue-500" : "text-muted-foreground"
                          )} />
                          <span className={cn(
                            "text-sm font-medium",
                            autoUpdateStatus.enabled ? "text-blue-400" : "text-muted-foreground"
                          )}>
                            {autoUpdateStatus.enabled ? t('autoUpdateEnabled') : t('autoUpdateDisabled')}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          {autoUpdateStatus.enabled && autoUpdateStatus.last_sync_ts > 0 && (
                            <span className="text-xs text-blue-400/60">
                              {t('lastSyncedAgo').replace('{time}', (() => {
                                const { key, n } = getTimeAgo(autoUpdateStatus.last_sync_ts);
                                return t(key as TranslationKey).replace('{n}', String(n));
                              })())}
                            </span>
                          )}
                          <Switch
                            checked={autoUpdateStatus.enabled}
                            onCheckedChange={handleAutoUpdateToggle}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Logs View */}
          {activeTab === 'logs' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between mb-4">
                <div className="text-sm text-muted-foreground">
                  {t('activeConnections')}: <span className="text-foreground font-medium">{connections.length}</span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    const data = await api.getConnections();
                    setConnections(data.connections || []);
                  }}
                  className="border-input bg-card text-muted-foreground hover:text-foreground hover:bg-zinc-800"
                >
                  <RefreshCw className="h-3 w-3 mr-2" />
                  {t('refresh')}
                </Button>
              </div>

              {connections.length === 0 ? (
                <Card className="bg-card border-border">
                  <CardContent className="p-6 text-center text-muted-foreground">
                    {t('noActiveConnections')}
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-2">
                  {connections.map((conn) => (
                    <div 
                      key={conn.id} 
                      className="bg-card border border-border rounded-lg p-4"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-2">
                            <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-xs">
                              {conn.metadata.network.toUpperCase()}
                            </Badge>
                            <Badge variant="outline" className="bg-violet-500/10 text-violet-400 border-violet-500/20 text-xs">
                              {conn.metadata.type}
                            </Badge>
                            {conn.rule && (
                              <Badge variant="outline" className="bg-muted text-muted-foreground border-border text-xs">
                                {conn.rule}
                              </Badge>
                            )}
                          </div>
                          <div className="text-sm text-foreground font-mono truncate">
                            {conn.metadata.host || conn.metadata.destinationIP}:{conn.metadata.destinationPort}
                          </div>
                          <div className="text-xs text-muted-foreground mt-1">
                            {conn.metadata.sourceIP}:{conn.metadata.sourcePort} → {conn.metadata.destinationIP}:{conn.metadata.destinationPort}
                          </div>
                          {conn.chains.length > 0 && (
                            <div className="text-xs text-amber-400/80 mt-2">
                              {t('chain')}: {conn.chains.join(' → ')}
                            </div>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-xs text-emerald-400">
                            ↓ {formatBytes(conn.download)}
                          </div>
                          <div className="text-xs text-blue-400">
                            ↑ {formatBytes(conn.upload)}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* RDP View — always mounted, hidden via CSS to preserve sessions */}
          <div className={cn("flex-1 overflow-hidden", activeTab !== 'rdp' && "hidden")}>
            <RdpManager
              isRdpViewVisible={activeTab === 'rdp'}
              onMainSidebarCollapse={() => setSidebarCollapsed(true)}
            />
          </div>

          {/* Settings View */}
          {activeTab === 'settings' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">
              {/* Appearance & Language Card */}
              <Card className="bg-card border-border flex flex-col">
                <CardHeader>
                  <CardTitle className="text-lg text-foreground">{t('appearance')}</CardTitle>
                  <CardDescription className="text-muted-foreground">{t('language')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 flex-1">
                  <div className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-lg bg-amber-500/10 flex items-center justify-center">
                        <span className="text-amber-500 text-lg">☀</span>
                      </div>
                      <div>
                        <div className="text-sm font-medium text-foreground">{t('appearance')}</div>
                        <div className="text-xs text-muted-foreground">Light / Dark</div>
                      </div>
                    </div>
                    <ThemeToggle />
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-lg bg-blue-500/10 flex items-center justify-center">
                        <Globe className="h-4 w-4 text-blue-500" />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-foreground">{t('language')}</div>
                        <div className="text-xs text-muted-foreground">English / 中文</div>
                      </div>
                    </div>
                    <LanguageToggle />
                  </div>
                </CardContent>
              </Card>

              {/* About Card */}
              <Card className="bg-card border-border flex flex-col">
                <CardHeader>
                  <CardTitle className="text-lg text-foreground">{t('about')}</CardTitle>
                  <CardDescription className="text-muted-foreground">{t('settingsDesc')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 flex-1">
                  <div className="bg-muted dark:bg-zinc-800/50 rounded-lg p-4">
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-muted-foreground">{t('currentVersion')}</span>
                      <span className="text-foreground font-mono">v{__APP_VERSION__}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">{t('latestVersion')}</span>
                      <span className={cn(
                        "font-mono",
                        updateInfo?.has_update ? "text-emerald-400" : "text-muted-foreground"
                      )}>
                        {updateInfo?.latest_version ? `v${updateInfo.latest_version}` : '...'}
                      </span>
                    </div>
                  </div>

                  <Button 
                    onClick={() => {
                      if (updateInfo?.has_update) {
                        setShowUpdateModal(true);
                      } else {
                        checkForUpdate(true);
                      }
                    }}
                    className={cn(
                      "w-full",
                      updateInfo?.has_update 
                        ? "bg-emerald-600 hover:bg-emerald-500 text-white"
                        : "bg-muted dark:bg-zinc-800 hover:bg-muted-foreground/10 dark:hover:bg-zinc-700 text-foreground dark:text-zinc-300"
                    )}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    {updateInfo?.has_update ? t('downloadUpdate') : t('checkForUpdates')}
                  </Button>


                </CardContent>
              </Card>

              {/* RDP Settings Card */}
              <Card className="bg-card border-border flex flex-col md:col-span-2">
                <CardHeader>
                  <CardTitle className="text-lg text-foreground">{t('rdpSettings')}</CardTitle>
                  <CardDescription className="text-muted-foreground">{t('rdpSettingsDesc')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 flex-1">
                  {/* Turbo Mode — coming soon */}
                  <div className="flex items-center justify-between py-2 opacity-50 cursor-not-allowed">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-lg bg-blue-500/10 flex items-center justify-center">
                        <Zap className="h-4 w-4 text-blue-500" />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-foreground flex items-center gap-2">
                          {t('tubeMode')}
                          <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/25">Soon</span>
                        </div>
                        <div className="text-xs text-muted-foreground">{t('tubeModeDesc')}</div>
                      </div>
                    </div>
                    <div className="relative inline-flex h-6 w-11 items-center rounded-full bg-zinc-600 pointer-events-none">
                      <span className="inline-block h-4 w-4 rounded-full bg-white shadow-sm translate-x-1" />
                    </div>
                  </div>
                  {/* Cloud Mode — coming soon */}
                  <div className="flex items-center justify-between py-2 opacity-50 cursor-not-allowed">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-lg bg-violet-500/10 flex items-center justify-center">
                        <Cloud className="h-4 w-4 text-violet-500" />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-foreground flex items-center gap-2">
                          {t('cloudMode')}
                          <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/25">Soon</span>
                        </div>
                        <div className="text-xs text-muted-foreground">{t('cloudModeDesc')}</div>
                      </div>
                    </div>
                    <div className="relative inline-flex h-6 w-11 items-center rounded-full bg-zinc-600 pointer-events-none">
                      <span className="inline-block h-4 w-4 rounded-full bg-white shadow-sm translate-x-1" />
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-4 py-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="h-9 w-9 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
                        <FolderOpen className="h-4 w-4 text-emerald-500" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground">{t('folderSharing')}</div>
                        <div className="text-xs text-muted-foreground">{t('folderSharingDesc')}</div>
                      </div>
                    </div>
                    <Switch
                      checked={folderSharingEnabled}
                      onCheckedChange={setFolderSharingEnabled}
                    />
                  </div>
                </CardContent>
              </Card>

              {import.meta.env.DEV && (
                <Card className="bg-card border-border flex flex-col md:col-span-2">
                  <CardHeader>
                    <CardTitle className="text-lg text-foreground flex items-center gap-2">
                      <Bug className="h-4 w-4 text-cyan-500" />
                      {t('devLogMode')}
                    </CardTitle>
                    <CardDescription className="text-muted-foreground">
                      {t('devLogModeDesc')}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5 flex-1">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                      <div className="rounded-lg border border-border bg-muted/30 p-3">
                        <div className="text-xs text-muted-foreground mb-1">{t('backendLog')}</div>
                        <div className="text-xs font-mono text-foreground break-all">{backendLogPath || '...'}</div>
                        <div className="text-xs text-muted-foreground mt-2">{t('logFileSize')}: {formatBytes(backendLogSize)}</div>
                      </div>
                      <div className="rounded-lg border border-border bg-muted/30 p-3">
                        <div className="text-xs text-muted-foreground mb-1">{t('rdpLog')}</div>
                        <div className="text-xs font-mono text-foreground break-all">{rdpLogPath || '...'}</div>
                        <div className="text-xs text-muted-foreground mt-2">{t('logFileSize')}: {formatBytes(rdpLogSize)}</div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between rounded-lg border border-border bg-muted/20 p-3">
                      <div>
                        <div className="text-sm font-medium text-foreground">{t('debugConsoleLevel')}</div>
                        <div className="text-xs text-muted-foreground">{t('debugConsoleLevelDesc')}</div>
                      </div>
                      <Switch
                        checked={devLogLevel === 'debug'}
                        onCheckedChange={handleDevLogLevelToggle}
                      />
                    </div>

                    <div className="rounded-lg border border-border bg-muted/20 p-3">
                      <div className="text-sm font-medium text-foreground mb-3">{t('debugModules')}</div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                        {DEV_LOG_MODULES.map(module => (
                          <label
                            key={module}
                            className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground"
                          >
                            <span className="font-mono">{module}</span>
                            <Switch
                              checked={devLogModules.has(module)}
                              onCheckedChange={(checked) => handleDevLogModuleToggle(module, checked)}
                            />
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => api.logShowInFinder()}
                        className="border-input bg-card text-muted-foreground hover:text-foreground"
                      >
                        <FolderOpen className="h-3 w-3 mr-2" />
                        {t('logShowInFinder')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={refreshDiagnosticLogInfo}
                        className="border-input bg-card text-muted-foreground hover:text-foreground"
                      >
                        <RefreshCw className="h-3 w-3 mr-2" />
                        {t('refresh')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleCopyDiagnosticBundle}
                        className="border-input bg-card text-muted-foreground hover:text-foreground"
                      >
                        <Copy className="h-3 w-3 mr-2" />
                        {t('copyDiagnosticBundle')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleClearDiagnosticLogs}
                        className="border-red-500/30 bg-card text-red-400 hover:text-red-300 hover:bg-red-500/10"
                      >
                        <Trash2 className="h-3 w-3 mr-2" />
                        {t('logClear')}
                      </Button>
                    </div>

                    {diagnosticMessage && (
                      <div className="rounded-md border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-300 break-all">
                        {diagnosticMessage}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          )}

        </div>
      </main>

      {/* Update Modal */}
      {showUpdateModal && updateInfo?.has_update && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100]">
          <div className="bg-card border border-border rounded-xl p-6 w-full max-w-md mx-4 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-emerald-600 to-cyan-600 flex items-center justify-center">
                  <Download className="h-5 w-5 text-white" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-foreground">{t('updateAvailable')}</h3>
                  <p className="text-xs text-muted-foreground">{t('newVersionReady')}</p>
                </div>
              </div>
              <button 
                onClick={() => setShowUpdateModal(false)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="bg-muted/50 rounded-lg p-4 mb-4">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-muted-foreground">{t('currentVersion')}</span>
                <span className="text-foreground font-mono">v{__APP_VERSION__}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('latestVersion')}</span>
                <span className="text-emerald-400 font-mono">v{updateInfo.latest_version}</span>
              </div>
            </div>

            {updateStatus === 'idle' && (
              <Button 
                onClick={handleDownloadAndInstall}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white"
              >
                <Download className="h-4 w-4 mr-2" />
                {t('installAndRestart')}
              </Button>
            )}

            {updateStatus === 'downloading' && (
              <div className="space-y-2">
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>{t('downloading')}</span>
                  <span>{downloadProgress}%</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-gradient-to-r from-emerald-600 to-cyan-600 transition-all duration-300"
                    style={{ width: `${downloadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {updateStatus === 'installing' && (
              <div className="text-emerald-400 text-sm text-center">
                {t('installAndRestart')}...
              </div>
            )}

            {updateStatus === 'error' && (
              <div className="space-y-2">
                <div className="text-red-400 text-sm text-center">
                  {t('downloadFailed')}
                </div>
                <Button 
                  onClick={() => { setUpdateStatus('idle'); handleDownloadAndInstall(); }}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 text-white"
                >
                  <RefreshCw className="h-4 w-4 mr-2" />
                  {t('downloadUpdate')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Up-to-date toast notification */}
      {showUpToDateToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] animate-in slide-in-from-bottom-4 fade-in duration-300">
          <div className="flex items-center gap-2 px-5 py-3 rounded-xl bg-emerald-500/15 border border-emerald-500/25 backdrop-blur-md shadow-lg shadow-emerald-900/10">
            <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
            <span className="text-sm font-medium text-emerald-300">{t('latestVersionMsg')}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function App() {
  return (
    <LanguageProvider>
      <AppContent />
    </LanguageProvider>
  );
}

export default App;
