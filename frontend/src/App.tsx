import { useState, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { 
  LayoutDashboard, 
  Settings, 
  
  Activity, 
  RefreshCw,
  CheckCircle2,
  CircleUserRound,
  Globe,
  Download,
  X,
  FileText,
  PanelLeftClose,
  PanelLeft,
  Monitor,
  FolderOpen,
  ArrowRight,
  Plus,
  Server,
  Zap,
} from 'lucide-react';
import { api, type UpdateInfo, type CloudAccountStatus } from './api';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Logo } from '@/components/Logo';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { cloudAuthErrorKey } from '@/lib/cloud-auth-errors';
import { ThemeToggle } from '@/components/ThemeToggle';
import { LanguageProvider } from '@/i18n/LanguageProvider';
import { useTranslation } from '@/i18n/useTranslation';
import { LanguageToggle } from '@/components/LanguageToggle';
import { RdpManager } from '@/components/RdpManager';
import { AccountPage } from '@/components/AccountPage';
import { LogViewer } from '@/components/LogViewer';
import { useSessionStore } from '@/lib/useSessionStore';

function AppContent() {
  const { t } = useTranslation();
  const sessionStore = useSessionStore();
  const { folderSharingEnabled, setFolderSharingEnabled } = sessionStore;
  const [activeTab, setActiveTab] = useState<'dashboard' | 'account' | 'logs' | 'settings' | 'rdp'>('dashboard');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'downloading' | 'installing' | 'error'>('idle');
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [, setCurrentVersion] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showUpToDateToast, setShowUpToDateToast] = useState(false);
  const [cloudAuthorizing, setCloudAuthorizing] = useState(false);
  const [cloudRefreshing, setCloudRefreshing] = useState(false);
  const [cloudRefreshMessage, setCloudRefreshMessage] = useState('');
  const [cloudStatus, setCloudStatus] = useState<CloudAccountStatus | null>(null);
  const cloudAuthInFlightRef = useRef(false);
  const cloudAuthTimeoutRef = useRef<number | null>(null);

  const dashboardServers = [...sessionStore.servers]
    .sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite))
    .slice(0, 3);
  const accountAuthorized = cloudStatus?.authorized === true;
  const cloudAccelerationAvailable = accountAuthorized && cloudStatus?.account_available === true;

  const openRemoteDesktop = () => {
    setActiveTab('rdp');
    setSidebarCollapsed(true);
  };

  const createRemoteDesktop = () => {
    openRemoteDesktop();
    window.dispatchEvent(new Event('nextdesk-new-connection'));
  };

  const openSavedServer = (serverId: string) => {
    const server = sessionStore.getServerById(serverId);
    if (!server) return;
    sessionStore.openSession(server);
    openRemoteDesktop();
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
    checkForUpdate();
  }, []);

  useEffect(() => {
    api.cloudGetStatus()
      .then((status) => {
        setCloudStatus(status);
      })
      .catch(() => {
        setCloudStatus(null);
      });
  }, []);

  useEffect(() => {
    let active = true;
    const unlisten = listen<{ ok: boolean; status?: CloudAccountStatus; error?: string }>(
      'cloud-auth-result',
      (event) => {
        if (!active) return;
        cloudAuthInFlightRef.current = false;
        if (cloudAuthTimeoutRef.current !== null) {
          window.clearTimeout(cloudAuthTimeoutRef.current);
          cloudAuthTimeoutRef.current = null;
        }
        setCloudAuthorizing(false);
        if (event.payload.ok && event.payload.status) {
          setCloudStatus(event.payload.status);
          return;
        }
        setCloudStatus({
          enabled: false,
          authorized: false,
          account_available: false,
          reason: t(cloudAuthErrorKey(event.payload.error)),
        });
      }
    );
    return () => {
      active = false;
      unlisten.then((dispose) => dispose()).catch(console.error);
    };
  }, [t]);

  useEffect(() => {
    return () => {
      if (cloudAuthTimeoutRef.current !== null) {
        window.clearTimeout(cloudAuthTimeoutRef.current);
        cloudAuthTimeoutRef.current = null;
      }
      cloudAuthInFlightRef.current = false;
    };
  }, []);

  const refreshCloudStatus = async () => {
    const status = await api.cloudRefreshStatus();
    setCloudStatus(status);
    return status;
  };

  const handleCloudRefresh = async () => {
    if (cloudRefreshing) return;
    setCloudRefreshing(true);
    setCloudRefreshMessage('');
    try {
      await refreshCloudStatus();
      setCloudRefreshMessage(t('accountStatusUpdated'));
    } catch (error) {
      console.error('Failed to refresh cloud account status', error);
      setCloudRefreshMessage(t('accountStatusRefreshFailed'));
    } finally {
      setCloudRefreshing(false);
    }
  };

  const handleCloudEnable = async () => {
    if (cloudAuthInFlightRef.current) return;
    cloudAuthInFlightRef.current = true;
    setCloudAuthorizing(true);
    try {
      await api.cloudStartAuthorization();
      cloudAuthTimeoutRef.current = window.setTimeout(() => {
        cloudAuthInFlightRef.current = false;
        cloudAuthTimeoutRef.current = null;
        setCloudAuthorizing(false);
        refreshCloudStatus().catch(console.error);
      }, 300_000);
    } catch (error) {
      cloudAuthInFlightRef.current = false;
      if (cloudAuthTimeoutRef.current !== null) {
        window.clearTimeout(cloudAuthTimeoutRef.current);
        cloudAuthTimeoutRef.current = null;
      }
      setCloudAuthorizing(false);
      setCloudStatus({
        enabled: false,
        authorized: false,
        account_available: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleCloudDisable = async () => {
    cloudAuthInFlightRef.current = false;
    if (cloudAuthTimeoutRef.current !== null) {
      window.clearTimeout(cloudAuthTimeoutRef.current);
      cloudAuthTimeoutRef.current = null;
    }
    setCloudAuthorizing(false);
    await api.cloudDisable();
    setCloudStatus({ enabled: false, authorized: false, account_available: false });
  };

  const isRunning = cloudStatus?.authorized === true && cloudStatus.account_available === true;

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
                {t('rdp')}
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
            onClick={() => setActiveTab('account')}
            className={cn(
              "w-full h-11 text-sm font-medium transition-all mb-1",
              sidebarCollapsed ? "justify-center px-0" : "justify-start gap-3",
              activeTab === 'account'
                ? "bg-violet-500/10 text-violet-400 hover:bg-violet-500/15 hover:text-violet-300"
                : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent"
            )}
            title={sidebarCollapsed ? t('account') : undefined}
          >
            <CircleUserRound className={cn("h-4 w-4 shrink-0", activeTab === 'account' ? "text-violet-500" : "text-muted-foreground")} />
            {!sidebarCollapsed && t('account')}
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
                {activeTab === 'account' && t('account')}
                {activeTab === 'logs' && t('logs')}
                {activeTab === 'settings' && t('settings')}
              </h1>
              <p className="text-muted-foreground">
                {activeTab === 'dashboard' && t('dashboardDesc')}
                {activeTab === 'account' && t('accountDesc')}
                {activeTab === 'logs' && t('logsDesc')}
                {activeTab === 'settings' && t('settingsDesc')}
              </p>
            </div>
          </div>
          )}

          {/* Dashboard View */}
          {activeTab === "dashboard" && (
            <div className="space-y-8">
              <section className="overflow-hidden rounded-md border border-border bg-card">
                <div className="grid border-b border-border md:grid-cols-2 md:divide-x md:divide-border">
                  <button
                    type="button"
                    onClick={() => setActiveTab('account')}
                    className="flex min-h-28 items-center gap-4 border-b border-border px-6 py-5 text-left transition-colors hover:bg-accent/20 md:border-b-0"
                  >
                    <div className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
                      accountAuthorized ? "bg-emerald-500/10 text-emerald-400" : "bg-cyan-500/10 text-cyan-400"
                    )}>
                      {accountAuthorized ? <CheckCircle2 className="h-5 w-5" /> : <CircleUserRound className="h-5 w-5" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-muted-foreground">01</span>
                        <span className="font-medium text-foreground">{t('dashboardAuthorizeStep')}</span>
                      </div>
                      <div className={cn("mt-1 text-sm", accountAuthorized ? "text-emerald-400" : "text-muted-foreground")}>
                        {accountAuthorized ? t('authorized') : t('dashboardAuthorizeRequired')}
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('account')}
                    className="flex min-h-28 items-center gap-4 px-6 py-5 text-left transition-colors hover:bg-accent/20"
                  >
                    <div className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
                      cloudAccelerationAvailable ? "bg-emerald-500/10 text-emerald-400" : "bg-muted text-muted-foreground"
                    )}>
                      <Zap className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-muted-foreground">02</span>
                        <span className="font-medium text-foreground">{t('cloudAcceleration')}</span>
                      </div>
                      <div className={cn("mt-1 text-sm", cloudAccelerationAvailable ? "text-emerald-400" : "text-muted-foreground")}>
                        {cloudAccelerationAvailable
                          ? t('available')
                          : accountAuthorized ? t('unavailable') : t('dashboardCloudAfterLogin')}
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                </div>

                <div className="grid gap-8 px-6 py-7 md:px-8 md:py-8 lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-end">
                  <div className="max-w-2xl">
                    <h2 className="text-2xl font-semibold text-foreground">
                      {accountAuthorized ? t('dashboardConnectTitle') : t('dashboardGuideTitle')}
                    </h2>
                    <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                      {accountAuthorized ? t('dashboardConnectDesc') : t('dashboardGuideDesc')}
                    </p>
                    <div className="mt-6 flex flex-wrap gap-3">
                      {!accountAuthorized ? (
                        <Button
                          onClick={() => handleCloudEnable().catch(console.error)}
                          disabled={cloudAuthorizing}
                          className="gap-2 bg-cyan-600 text-white hover:bg-cyan-500"
                        >
                          <CircleUserRound className="h-4 w-4" />
                          {cloudAuthorizing ? t('authorizing') : t('dashboardAuthorizeNow')}
                        </Button>
                      ) : (
                        <>
                          <Button onClick={createRemoteDesktop} className="gap-2 bg-cyan-600 text-white hover:bg-cyan-500">
                            <Plus className="h-4 w-4" />
                            {t('rdpNewConnection')}
                          </Button>
                          <Button variant="outline" onClick={openRemoteDesktop} className="gap-2">
                            {t('dashboardOpenWorkspace')}
                            <ArrowRight className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="border-t border-border pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
                    <div className="text-xs text-muted-foreground">{t('dashboardSavedDevices')}</div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{sessionStore.servers.length}</div>
                    <div className="mt-4 text-xs leading-5 text-muted-foreground">
                      {cloudAccelerationAvailable ? t('dashboardCloudReady') : t('dashboardDirectStillAvailable')}
                    </div>
                  </div>
                </div>
              </section>

              <section>
                <div className="mb-4 flex items-end justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">{t('dashboardSavedConnections')}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{t('dashboardSavedConnectionsDesc')}</p>
                  </div>
                  {sessionStore.servers.length > 0 && (
                    <button
                      type="button"
                      onClick={openRemoteDesktop}
                      className="shrink-0 text-sm font-medium text-cyan-400 transition-colors hover:text-cyan-300"
                    >
                      {t('dashboardViewAll')}
                    </button>
                  )}
                </div>

                {dashboardServers.length > 0 ? (
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {dashboardServers.map(server => (
                      <button
                        key={server.id}
                        type="button"
                        onClick={() => openSavedServer(server.id)}
                        className="group min-h-36 rounded-md border border-border bg-card p-5 text-left transition-[border-color,background-color,transform] duration-200 hover:-translate-y-0.5 hover:border-cyan-500/35 hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-cyan-500/10 text-cyan-400">
                            <Server className="h-4 w-4" />
                          </div>
                          <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-cyan-400" />
                        </div>
                        <div className="mt-5 min-w-0">
                          <div className="truncate font-medium text-foreground">{server.name || server.host}</div>
                          <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                            {server.host}:{server.port}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={createRemoteDesktop}
                    className="flex w-full items-center justify-between gap-6 rounded-md border border-dashed border-border bg-card/40 px-5 py-6 text-left transition-colors hover:border-cyan-500/30 hover:bg-card"
                  >
                    <div className="flex items-center gap-4">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                        <Plus className="h-5 w-5" />
                      </div>
                      <div>
                        <div className="font-medium text-foreground">{t('dashboardEmptyTitle')}</div>
                        <div className="mt-1 text-sm text-muted-foreground">{t('dashboardEmptyDesc')}</div>
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                )}
              </section>

            </div>
          )}

          {activeTab === 'account' && (
            <AccountPage
              status={cloudStatus}
              authorizing={cloudAuthorizing}
              refreshing={cloudRefreshing}
              refreshMessage={cloudRefreshMessage}
              onAuthorize={() => handleCloudEnable().catch(console.error)}
              onRefresh={() => handleCloudRefresh().catch(console.error)}
              onSignOut={() => handleCloudDisable().catch(console.error)}
            />
          )}

          {/* Logs View */}
          {activeTab === 'logs' && (
            <LogViewer />
          )}

          {/* RDP View — always mounted, hidden via CSS to preserve sessions */}
          <div className={cn("flex-1 overflow-hidden", activeTab !== 'rdp' && "hidden")}>
            <RdpManager
              isRdpViewVisible={activeTab === 'rdp'}
              onMainSidebarCollapse={() => setSidebarCollapsed(true)}
              store={sessionStore}
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
