import { useState, useEffect } from 'react';
import { 
  LayoutDashboard, 
  Server as ServerIcon, 
  Settings, 
  Power, 
  Activity, 
  Zap, 
  RefreshCw,
  CheckCircle2,
  Globe,
  Download,
  X
} from 'lucide-react';
import { api, type EngineStatus, type Server, type UpdateInfo, type DownloadStatus } from './api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'servers' | 'proxy' | 'settings'>('dashboard');
  const [status, setStatus] = useState<EngineStatus>({ clash: false, multidesk: false });
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(false);
  const [subUrl, setSubUrl] = useState('');
  const [updatingSub, setUpdatingSub] = useState(false);
  
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<DownloadStatus>({ status: 'idle', progress: 0 });
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [currentVersion, setCurrentVersion] = useState('');
  const [subMessage, setSubMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchData = async () => {
    try {
      const [newStatus, newServers, savedUrl] = await Promise.all([
        api.getStatus(),
        api.getServers(),
        api.getSubscriptionUrl()
      ]);
      setStatus(newStatus);
      setServers(newServers);
      if (savedUrl && !subUrl) {
        setSubUrl(savedUrl);
      }
    } catch (error) {
      console.error('Failed to fetch data', error);
    }
  };

  const checkForUpdate = async () => {
    try {
      const [version, info] = await Promise.all([
        api.getCurrentVersion(),
        api.checkForUpdate()
      ]);
      setCurrentVersion(version);
      setUpdateInfo(info);
      if (info.has_update) {
        setShowUpdateModal(true);
      }
    } catch (error) {
      console.error('Failed to check for update', error);
    }
  };

  const pollDownloadStatus = async () => {
    try {
      const status = await api.getDownloadStatus();
      setDownloadStatus(status);
      return status;
    } catch (error) {
      console.error('Failed to get download status', error);
      return { status: 'idle', progress: 0 };
    }
  };

  const handleStartDownload = async () => {
    await api.startDownloadUpdate();
    const interval = setInterval(async () => {
      const status = await pollDownloadStatus();
      if (status.status === 'ready' || status.status.startsWith('error')) {
        clearInterval(interval);
      }
    }, 500);
  };

  const handleInstallUpdate = async () => {
    await api.installUpdate();
    window.close();
  };

  useEffect(() => {
    fetchData();
    checkForUpdate();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleToggleEngine = async () => {
    setLoading(true);
    try {
      if (status.clash || status.multidesk) {
        await api.stopEngine();
      } else {
        await api.startEngine();
      }
      setTimeout(fetchData, 1000);
    } catch (error) {
      console.error('Failed to toggle engine', error);
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
        setSubMessage({ type: 'success', text: `Loaded ${result.server_count} servers` });
        await fetchData();
      } else {
        setSubMessage({ type: 'error', text: result.error || 'Failed to load subscription' });
      }
    } catch (error) {
      setSubMessage({ type: 'error', text: 'Network error' });
    } finally {
      setUpdatingSub(false);
      setTimeout(() => setSubMessage(null), 5000);
    }
  };

  const isRunning = status.clash || status.multidesk;

  return (
    <div className="min-h-screen w-full bg-zinc-950 text-foreground font-sans flex">
      {/* Sidebar - Fixed Width w-64 */}
      <aside className="hidden md:flex md:w-64 md:flex-col md:fixed md:inset-y-0 md:left-0 border-r border-white/5 bg-zinc-950 z-50">
        <div className="p-6 flex items-center gap-3 border-b border-white/5">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-blue-600 to-cyan-600 flex items-center justify-center shadow-lg shadow-blue-900/20">
            <Zap className="h-6 w-6 text-white" />
          </div>
          <div>
            <span className="font-bold text-lg text-white block leading-none mb-1">
              NextDesk
            </span>
            <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider block leading-none">
              Accelerator
            </span>
          </div>
        </div>

        <nav className="flex-1 px-3 py-6 space-y-1">
          <Button
            variant="ghost"
            onClick={() => setActiveTab('dashboard')}
            className={cn(
              "w-full justify-start gap-3 h-11 text-sm font-medium transition-all mb-1",
              activeTab === 'dashboard' 
                ? "bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300" 
                : "text-zinc-400 hover:text-white hover:bg-white/5"
            )}
          >
            <LayoutDashboard className={cn("h-4 w-4", activeTab === 'dashboard' ? "text-blue-500" : "text-zinc-500")} />
            Dashboard
          </Button>

          <Button
            variant="ghost"
            onClick={() => setActiveTab('servers')}
            className={cn(
              "w-full justify-start gap-3 h-11 text-sm font-medium transition-all mb-1",
              activeTab === 'servers' 
                ? "bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/15 hover:text-cyan-300" 
                : "text-zinc-400 hover:text-white hover:bg-white/5"
            )}
          >
            <ServerIcon className={cn("h-4 w-4", activeTab === 'servers' ? "text-cyan-500" : "text-zinc-500")} />
            Servers
          </Button>

          <Button
            variant="ghost"
            onClick={() => setActiveTab('proxy')}
            className={cn(
              "w-full justify-start gap-3 h-11 text-sm font-medium transition-all mb-1",
              activeTab === 'proxy' 
                ? "bg-violet-500/10 text-violet-400 hover:bg-violet-500/15 hover:text-violet-300" 
                : "text-zinc-400 hover:text-white hover:bg-white/5"
            )}
          >
            <Globe className={cn("h-4 w-4", activeTab === 'proxy' ? "text-violet-500" : "text-zinc-500")} />
            Proxy
          </Button>

          <Button
            variant="ghost"
            onClick={() => setActiveTab('settings')}
            className={cn(
              "w-full justify-start gap-3 h-11 text-sm font-medium transition-all mb-1",
              activeTab === 'settings' 
                ? "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/15 hover:text-emerald-300" 
                : "text-zinc-400 hover:text-white hover:bg-white/5"
            )}
          >
            <Settings className={cn("h-4 w-4", activeTab === 'settings' ? "text-emerald-500" : "text-zinc-500")} />
            Settings
          </Button>
        </nav>

        <div className="p-4 border-t border-white/5">
          <div className="bg-zinc-900 rounded-lg p-3 border border-zinc-800">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Status</span>
              <div className={cn("h-1.5 w-1.5 rounded-full transition-colors", isRunning ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-700')} />
            </div>
            <div className="flex items-center gap-2">
              <Activity className={cn("h-3.5 w-3.5", isRunning ? "text-emerald-500" : "text-zinc-600")} />
              <div className="text-sm font-medium text-white">
                {isRunning ? 'System Active' : 'System Idle'}
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content - Offset ml-64 */}
      <main className="flex-1 md:ml-64 min-h-screen bg-zinc-950">
        <div className="max-w-6xl mx-auto px-6 py-8 md:px-10 md:py-10 space-y-8">
          
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-white tracking-tight mb-1">
                {activeTab === 'dashboard' && 'Dashboard'}
                {activeTab === 'servers' && 'Server List'}
                {activeTab === 'proxy' && 'Proxy'}
                {activeTab === 'settings' && 'Settings'}
              </h1>
              <p className="text-zinc-400">
                {activeTab === 'dashboard' && 'Overview of your network status'}
                {activeTab === 'servers' && 'Manage available connection nodes'}
                {activeTab === 'proxy' && 'Configure subscription and proxy settings'}
                {activeTab === 'settings' && 'Application version and updates'}
              </p>
            </div>
            <Button 
              variant="outline" 
              size="icon" 
              onClick={fetchData} 
              className="rounded-full h-10 w-10 border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white hover:bg-zinc-800 hover:border-zinc-700"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>

          {/* Dashboard View */}
          {activeTab === 'dashboard' && (
            <div className="space-y-10">
              
              {/* Status Cards - Grid Layout */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                
                {/* Clash Card */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-base font-medium text-white">Clash Engine</h3>
                    <Globe className="h-4 w-4 text-blue-500" />
                  </div>
                  <div className="text-2xl font-bold text-white mb-1">
                    {status.clash ? 'Running' : 'Stopped'}
                  </div>
                  <p className="text-xs text-zinc-500 mb-4">Core routing service</p>
                  <Badge variant="secondary" className={cn(
                    "rounded-sm px-2 py-0.5 text-xs font-normal border",
                    status.clash 
                      ? "bg-blue-500/10 text-blue-400 border-blue-500/20" 
                      : "bg-zinc-800 text-zinc-500 border-zinc-700"
                  )}>
                    {status.clash ? 'ACTIVE' : 'INACTIVE'}
                  </Badge>
                </div>

                {/* MultiDesk Card */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-base font-medium text-white">MultiDesk</h3>
                    <ServerIcon className="h-4 w-4 text-cyan-500" />
                  </div>
                  <div className="text-2xl font-bold text-white mb-1">
                    {status.multidesk ? 'Connected' : 'Disconnected'}
                  </div>
                  <p className="text-xs text-zinc-500 mb-4">RDP acceleration service</p>
                  <Badge variant="secondary" className={cn(
                    "rounded-sm px-2 py-0.5 text-xs font-normal border",
                    status.multidesk 
                      ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/20" 
                      : "bg-zinc-800 text-zinc-500 border-zinc-700"
                  )}>
                    {status.multidesk ? 'ACTIVE' : 'INACTIVE'}
                  </Badge>
                </div>
              </div>

              {/* Power Button - Centered */}
              <div className="flex justify-center py-4">
                 <button
                    onClick={handleToggleEngine}
                    disabled={loading}
                    className={cn(
                      "group relative w-40 h-40 rounded-full flex flex-col items-center justify-center transition-all duration-300 border-4",
                      isRunning 
                        ? 'bg-zinc-900 border-blue-500/50 shadow-[0_0_40px_rgba(59,130,246,0.2)]' 
                        : 'bg-zinc-900 border-zinc-800 hover:border-zinc-700'
                    )}
                  >
                    <Power className={cn("h-12 w-12 mb-2 transition-colors duration-300", 
                      isRunning ? 'text-blue-500' : 'text-zinc-600 group-hover:text-zinc-500'
                    )} />
                    <span className={cn("text-sm font-bold tracking-widest transition-colors duration-300", 
                      isRunning ? 'text-blue-400' : 'text-zinc-600 group-hover:text-zinc-500'
                    )}>
                      {loading ? '...' : isRunning ? 'ON' : 'OFF'}
                    </span>
                  </button>
              </div>
            </div>
          )}

          {/* Servers View */}
          {activeTab === 'servers' && (
            <Card className="bg-zinc-900 border-zinc-800">
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="border-zinc-800 hover:bg-transparent">
                      <TableHead className="text-zinc-500 pl-6">Server Name</TableHead>
                      <TableHead className="text-zinc-500">Host</TableHead>
                      <TableHead className="text-zinc-500">Latency</TableHead>
                      <TableHead className="text-zinc-500">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {servers.length === 0 ? (
                       <TableRow className="border-zinc-800 hover:bg-transparent">
                         <TableCell colSpan={4} className="h-24 text-center text-zinc-500">
                           No servers available
                         </TableCell>
                       </TableRow>
                    ) : (
                      servers.map((server) => (
                        <TableRow key={server.id} className="border-zinc-800 hover:bg-zinc-800/50">
                          <TableCell className="font-medium text-white pl-6">
                            <div className="flex items-center gap-3">
                              <div className="h-6 w-8 rounded overflow-hidden bg-zinc-800">
                                <img 
                                  src={`https://flagcdn.com/w80/${server.name.toLowerCase().slice(0, 2) === 'hk' ? 'hk' : server.name.toLowerCase().slice(0, 2) === 'sg' ? 'sg' : 'jp'}.png`} 
                                  className="object-cover w-full h-full opacity-80"
                                  onError={(e) => (e.currentTarget.style.display = 'none')}
                                  alt=""
                                />
                              </div>
                              {server.name}
                            </div>
                          </TableCell>
                          <TableCell className="text-zinc-400 font-mono text-xs">{server.host}</TableCell>
                          <TableCell>
                            {server.latency ? (
                              <div className="flex items-center gap-2">
                                <div className={cn("w-1.5 h-1.5 rounded-full", 
                                  server.latency < 100 ? 'bg-emerald-500' : server.latency < 200 ? 'bg-yellow-500' : 'bg-red-500'
                                )} />
                                <span className={cn("text-xs font-medium", 
                                  server.latency < 100 ? 'text-emerald-500' : server.latency < 200 ? 'text-yellow-500' : 'text-red-500'
                                )}>
                                  {server.latency}ms
                                </span>
                              </div>
                            ) : (
                              <span className="text-zinc-600 text-xs">-</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={cn(
                              "border-0 bg-opacity-10",
                              server.status === 'online' 
                                ? "bg-emerald-500 text-emerald-500" 
                                : server.status === 'unknown'
                                ? "bg-zinc-500 text-zinc-400"
                                : "bg-red-500 text-red-500"
                            )}>
                              {server.status === 'online' ? 'Online' : server.status === 'unknown' ? 'Unknown' : 'Offline'}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Proxy View */}
          {activeTab === 'proxy' && (
            <div className="max-w-2xl">
              <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                  <CardTitle className="text-lg text-white">Subscription</CardTitle>
                  <CardDescription className="text-zinc-500">Manage your server subscription source</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex gap-3">
                    <Input
                      placeholder="Subscription URL..."
                      value={subUrl}
                      onChange={(e) => setSubUrl(e.target.value)}
                      className="bg-zinc-950 border-zinc-800 text-white placeholder:text-zinc-600 focus-visible:ring-zinc-700"
                    />
                    <Button 
                      onClick={handleUpdateSubscription} 
                      disabled={updatingSub || !subUrl}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white"
                    >
                      {updatingSub ? 'Updating...' : 'Update'}
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
                  
                  <div className="bg-blue-500/5 border border-blue-500/10 rounded-md p-4">
                    <div className="flex gap-3">
                      <CheckCircle2 className="h-5 w-5 text-blue-500 shrink-0" />
                      <div>
                        <h4 className="text-sm font-medium text-blue-400 mb-1">Auto-Update Enabled</h4>
                        <p className="text-xs text-blue-400/60 leading-relaxed">
                          Server list automatically syncs every 24 hours.
                        </p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Settings View */}
          {activeTab === 'settings' && (
            <div className="max-w-md">
              <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                  <CardTitle className="text-lg text-white">About</CardTitle>
                  <CardDescription className="text-zinc-500">Application version and updates</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="bg-zinc-950 rounded-lg p-4">
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-zinc-400">Current Version</span>
                      <span className="text-white font-mono">v{currentVersion || '...'}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-zinc-400">Latest Version</span>
                      <span className={cn(
                        "font-mono",
                        updateInfo?.has_update ? "text-emerald-400" : "text-zinc-500"
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
                        checkForUpdate();
                      }
                    }}
                    className={cn(
                      "w-full",
                      updateInfo?.has_update 
                        ? "bg-emerald-600 hover:bg-emerald-500 text-white"
                        : "bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                    )}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    {updateInfo?.has_update ? 'Download Update' : 'Check for Updates'}
                  </Button>

                  {updateInfo && !updateInfo.has_update && !updateInfo.error && (
                    <div className="text-center text-xs text-zinc-500">
                      You're on the latest version
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

        </div>
      </main>

      {/* Update Modal */}
      {showUpdateModal && updateInfo?.has_update && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100]">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-full max-w-md mx-4 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-emerald-600 to-cyan-600 flex items-center justify-center">
                  <Download className="h-5 w-5 text-white" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-white">Update Available</h3>
                  <p className="text-xs text-zinc-500">A new version is ready to install</p>
                </div>
              </div>
              <button 
                onClick={() => setShowUpdateModal(false)}
                className="text-zinc-500 hover:text-white transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="bg-zinc-950 rounded-lg p-4 mb-4">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-zinc-400">Current Version</span>
                <span className="text-white font-mono">v{currentVersion}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-zinc-400">Latest Version</span>
                <span className="text-emerald-400 font-mono">v{updateInfo.latest_version}</span>
              </div>
            </div>

            {downloadStatus.status === 'idle' && (
              <Button 
                onClick={handleStartDownload}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white"
              >
                <Download className="h-4 w-4 mr-2" />
                Download Update
              </Button>
            )}

            {downloadStatus.status === 'downloading' && (
              <div className="space-y-2">
                <div className="flex justify-between text-sm text-zinc-400">
                  <span>Downloading...</span>
                  <span>{Math.round(downloadStatus.progress)}%</span>
                </div>
                <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-gradient-to-r from-emerald-600 to-cyan-600 transition-all duration-300"
                    style={{ width: `${downloadStatus.progress}%` }}
                  />
                </div>
              </div>
            )}

            {downloadStatus.status === 'ready' && (
              <Button 
                onClick={handleInstallUpdate}
                className="w-full bg-blue-600 hover:bg-blue-500 text-white"
              >
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Install and Restart
              </Button>
            )}

            {downloadStatus.status.startsWith('error') && (
              <div className="text-red-400 text-sm text-center">
                Download failed. Please try again later.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
