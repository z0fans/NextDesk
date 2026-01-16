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
  Shield,
  Radio,
  ChevronRight
} from 'lucide-react';
import { api, type EngineStatus, type Server } from './api';
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
  const [activeTab, setActiveTab] = useState<'dashboard' | 'servers' | 'settings'>('dashboard');
  const [status, setStatus] = useState<EngineStatus>({ clash: false, multidesk: false });
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(false);
  const [subUrl, setSubUrl] = useState('');
  const [updatingSub, setUpdatingSub] = useState(false);

  const fetchData = async () => {
    try {
      const [newStatus, newServers] = await Promise.all([
        api.getStatus(),
        api.getServers()
      ]);
      setStatus(newStatus);
      setServers(newServers);
    } catch (error) {
      console.error('Failed to fetch data', error);
    }
  };

  useEffect(() => {
    fetchData();
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
    try {
      await api.loadSubscription(subUrl);
      await fetchData();
      setSubUrl('');
    } catch (error) {
      console.error('Failed to update subscription', error);
    } finally {
      setUpdatingSub(false);
    }
  };

  const isRunning = status.clash || status.multidesk;

  return (
    <div className="flex h-screen w-full bg-[#030303] text-foreground font-sans selection:bg-cyan-500/30 overflow-hidden relative">
      {/* Background Effects */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full bg-blue-900/10 blur-[120px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full bg-cyan-900/10 blur-[120px]" />
        <div className="absolute inset-0 bg-grid-pattern opacity-[0.15]" />
      </div>

      {/* Sidebar */}
      <aside className="w-72 border-r border-white/5 bg-black/40 backdrop-blur-2xl flex flex-col fixed inset-y-0 left-0 z-50 transition-all duration-300">
        <div className="p-8 flex items-center gap-4">
          <div className="relative">
            <div className="absolute inset-0 bg-gradient-to-br from-blue-500 to-cyan-500 blur-lg opacity-40 rounded-xl" />
            <div className="relative h-10 w-10 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center shadow-inner shadow-white/20">
              <Zap className="h-6 w-6 text-white" />
            </div>
          </div>
          <div>
            <span className="font-bold text-xl tracking-tight bg-gradient-to-r from-white via-white to-white/60 bg-clip-text text-transparent block">
              NextDesk
            </span>
            <span className="text-[10px] font-medium text-blue-400 tracking-wider uppercase">Network Accelerator</span>
          </div>
        </div>

        <nav className="flex-1 px-4 py-6 space-y-2">
          {[
            { id: 'dashboard', icon: LayoutDashboard, label: 'Dashboard', color: 'blue' },
            { id: 'servers', icon: ServerIcon, label: 'Servers', color: 'cyan' },
            { id: 'settings', icon: Settings, label: 'Settings', color: 'emerald' },
          ].map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              onClick={() => setActiveTab(item.id as any)}
              className={cn(
                "w-full justify-start gap-3 h-12 text-base font-medium transition-all duration-300 relative overflow-hidden group",
                activeTab === item.id 
                  ? `bg-${item.color}-500/10 text-${item.color}-400 shadow-[0_0_20px_rgba(0,0,0,0.2)]` 
                  : "text-zinc-400 hover:text-white hover:bg-white/5"
              )}
            >
              <div className={cn(
                "absolute left-0 top-0 bottom-0 w-1 transition-all duration-300",
                activeTab === item.id ? `bg-${item.color}-500` : "bg-transparent group-hover:bg-white/10"
              )} />
              <item.icon className={cn("h-5 w-5 transition-colors", activeTab === item.id ? `text-${item.color}-500` : "text-zinc-500 group-hover:text-zinc-300")} />
              {item.label}
              {activeTab === item.id && (
                <div className={cn(
                  "absolute right-4 h-2 w-2 rounded-full shadow-[0_0_10px_currentColor]", 
                  `bg-${item.color}-500`
                )} />
              )}
            </Button>
          ))}
        </nav>

        <div className="p-4 border-t border-white/5">
          <div className="bg-gradient-to-br from-zinc-900/80 to-black/80 rounded-xl p-4 border border-white/5 backdrop-blur-md relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-r from-blue-500/5 to-cyan-500/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
            <div className="flex items-center justify-between mb-3 relative z-10">
              <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Engine Status</span>
              <div className={cn("h-2 w-2 rounded-full shadow-[0_0_8px_currentColor] transition-colors duration-500", isRunning ? 'bg-emerald-500 text-emerald-500 animate-pulse' : 'bg-zinc-700 text-zinc-700')} />
            </div>
            <div className="flex items-center gap-2 relative z-10">
              <div className={cn("p-1.5 rounded-lg", isRunning ? "bg-emerald-500/10" : "bg-zinc-800")}>
                <Activity className={cn("h-4 w-4", isRunning ? "text-emerald-500" : "text-zinc-500")} />
              </div>
              <div className="text-sm font-semibold text-white">
                {isRunning ? 'System Active' : 'System Idle'}
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 ml-72 p-10 relative z-10 overflow-y-auto h-full">
        <div className="max-w-6xl mx-auto space-y-10">
          
          {/* Header */}
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1 flex-1 min-w-0">
              <h1 className="text-4xl font-bold text-white tracking-tight">
                {activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}
              </h1>
              <p className="text-zinc-400 text-lg truncate">Manage your network acceleration environment</p>
            </div>
            <Button 
              variant="outline" 
              size="icon" 
              onClick={fetchData} 
              className="rounded-full h-12 w-12 border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/20 text-white shadow-lg transition-all duration-300 hover:rotate-180 shrink-0"
            >
              <RefreshCw className="h-5 w-5" />
            </Button>
          </div>

          {/* Dashboard View */}
          {activeTab === 'dashboard' && (
            <div className="space-y-12 animate-in fade-in slide-in-from-bottom-8 duration-700">
              
              {/* Status Cards */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Clash Card */}
                <Card className="bg-zinc-900/40 border-white/5 backdrop-blur-md overflow-hidden relative group hover:border-blue-500/30 transition-all duration-500">
                  <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                  <CardHeader className="relative z-10">
                    <CardTitle className="flex items-center gap-3 text-white text-xl">
                      <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400">
                        <Globe className="h-6 w-6" />
                      </div>
                      Clash Engine
                    </CardTitle>
                    <CardDescription className="text-zinc-400 text-base">Core routing engine status</CardDescription>
                  </CardHeader>
                  <CardContent className="relative z-10">
                    <div className="flex items-center justify-between mt-2">
                      <div className="flex items-center gap-3">
                        <Badge variant="outline" className={cn("text-sm px-3 py-1.5 border transition-colors duration-300", 
                          status.clash 
                            ? 'bg-blue-500/10 text-blue-400 border-blue-500/30 shadow-[0_0_15px_rgba(59,130,246,0.2)]' 
                            : 'bg-zinc-800/50 text-zinc-500 border-zinc-700'
                        )}>
                          {status.clash ? 'RUNNING' : 'STOPPED'}
                        </Badge>
                        {status.clash && <span className="text-xs text-blue-400/80 animate-pulse">● Active</span>}
                      </div>
                      <Shield className={cn("h-8 w-8 opacity-20 transition-colors duration-500", status.clash ? 'text-blue-500' : 'text-zinc-500')} />
                    </div>
                  </CardContent>
                </Card>

                {/* MultiDesk Card */}
                <Card className="bg-zinc-900/40 border-white/5 backdrop-blur-md overflow-hidden relative group hover:border-cyan-500/30 transition-all duration-500">
                  <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                  <CardHeader className="relative z-10">
                    <CardTitle className="flex items-center gap-3 text-white text-xl">
                      <div className="p-2 rounded-lg bg-cyan-500/10 text-cyan-400">
                        <ServerIcon className="h-6 w-6" />
                      </div>
                      MultiDesk
                    </CardTitle>
                    <CardDescription className="text-zinc-400 text-base">RDP acceleration service</CardDescription>
                  </CardHeader>
                  <CardContent className="relative z-10">
                    <div className="flex items-center justify-between mt-2">
                      <div className="flex items-center gap-3">
                        <Badge variant="outline" className={cn("text-sm px-3 py-1.5 border transition-colors duration-300", 
                          status.multidesk 
                            ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30 shadow-[0_0_15px_rgba(6,182,212,0.2)]' 
                            : 'bg-zinc-800/50 text-zinc-500 border-zinc-700'
                        )}>
                          {status.multidesk ? 'ACTIVE' : 'INACTIVE'}
                        </Badge>
                        {status.multidesk && <span className="text-xs text-cyan-400/80 animate-pulse">● Connected</span>}
                      </div>
                      <Radio className={cn("h-8 w-8 opacity-20 transition-colors duration-500", status.multidesk ? 'text-cyan-500' : 'text-zinc-500')} />
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Power Button */}
              <div className="flex justify-center py-8">
                <div className="relative group">
                  <div className={cn("absolute inset-0 rounded-full blur-[80px] transition-all duration-700", 
                    isRunning ? 'bg-blue-600/30 group-hover:bg-blue-600/40' : 'bg-transparent'
                  )} />
                  <div className={cn("absolute inset-0 rounded-full blur-3xl transition-all duration-700 opacity-50", 
                    isRunning ? 'bg-cyan-500/20' : 'bg-zinc-800/10'
                  )} />
                  
                  <button
                    onClick={handleToggleEngine}
                    disabled={loading}
                    className={cn(
                      "relative w-56 h-56 rounded-full flex flex-col items-center justify-center gap-4 transition-all duration-500 border-[6px]",
                      isRunning 
                        ? 'bg-gradient-to-b from-zinc-900 to-black border-blue-500/50 shadow-[0_0_60px_rgba(59,130,246,0.3),inset_0_0_20px_rgba(59,130,246,0.2)] hover:scale-105 active:scale-95' 
                        : 'bg-zinc-900 border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800 shadow-xl hover:scale-105 active:scale-95'
                    )}
                  >
                    <div className={cn("absolute inset-2 rounded-full border border-white/5")} />
                    
                    <Power className={cn("h-20 w-20 transition-all duration-500", 
                      isRunning ? 'text-blue-500 drop-shadow-[0_0_15px_rgba(59,130,246,1)]' : 'text-zinc-600'
                    )} />
                    
                    <div className="flex flex-col items-center">
                      <span className={cn("text-2xl font-bold tracking-widest transition-all duration-500", 
                        isRunning ? 'text-blue-400 drop-shadow-[0_0_8px_rgba(59,130,246,0.8)]' : 'text-zinc-600'
                      )}>
                        {loading ? '...' : isRunning ? 'ON' : 'OFF'}
                      </span>
                      {isRunning && (
                        <span className="text-[10px] text-blue-500/60 font-medium tracking-widest uppercase mt-1 animate-pulse">
                          Accelerating
                        </span>
                      )}
                    </div>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Servers View */}
          {activeTab === 'servers' && (
            <Card className="bg-zinc-900/40 border-white/5 backdrop-blur-md animate-in fade-in slide-in-from-bottom-8 duration-700 overflow-hidden">
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-white/5 border-white/5 bg-white/[0.02]">
                      <TableHead className="text-zinc-400 pl-6 h-14">Server Name</TableHead>
                      <TableHead className="text-zinc-400 h-14">Host</TableHead>
                      <TableHead className="text-zinc-400 h-14">Latency</TableHead>
                      <TableHead className="text-zinc-400 h-14">Status</TableHead>
                      <TableHead className="text-zinc-400 h-14 text-right pr-6">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {servers.map((server, i) => (
                      <TableRow key={server.id} className="hover:bg-white/5 border-white/5 transition-colors group" style={{ animationDelay: `${i * 50}ms` }}>
                        <TableCell className="font-medium text-white pl-6 py-4">
                          <div className="flex items-center gap-3">
                            <div className="h-8 w-10 relative overflow-hidden rounded shadow-sm">
                              <img 
                                src={`https://flagcdn.com/w80/${server.name.toLowerCase().slice(0, 2) === 'hk' ? 'hk' : server.name.toLowerCase().slice(0, 2) === 'sg' ? 'sg' : 'jp'}.png`} 
                                className="object-cover w-full h-full opacity-90"
                                onError={(e) => (e.currentTarget.style.display = 'none')}
                                alt=""
                              />
                            </div>
                            <span className="group-hover:text-blue-400 transition-colors">{server.name}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-zinc-400 font-mono text-xs">{server.host}</TableCell>
                        <TableCell>
                          {server.latency ? (
                            <div className="flex items-center gap-2">
                              <div className={cn("w-16 h-1.5 rounded-full bg-zinc-800 overflow-hidden")}>
                                <div 
                                  className={cn("h-full rounded-full", 
                                    server.latency < 100 ? 'bg-emerald-500' : server.latency < 200 ? 'bg-yellow-500' : 'bg-red-500'
                                  )} 
                                  style={{ width: `${Math.min(100, (server.latency / 300) * 100)}%` }}
                                />
                              </div>
                              <span className={cn("text-xs font-bold", 
                                server.latency < 100 ? 'text-emerald-400' : server.latency < 200 ? 'text-yellow-400' : 'text-red-400'
                              )}>
                                {server.latency}ms
                              </span>
                            </div>
                          ) : (
                            <span className="text-zinc-600 text-xs">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {server.status === 'online' ? (
                            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 hover:bg-emerald-500/20">
                              Online
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-red-500/10 text-red-500 border-red-500/20 hover:bg-red-500/20">
                              Offline
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right pr-6">
                           <Button variant="ghost" size="icon" className="h-8 w-8 text-zinc-500 hover:text-white hover:bg-white/10">
                              <ChevronRight className="h-4 w-4" />
                           </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Settings View */}
          {activeTab === 'settings' && (
            <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-8 duration-700">
              <Card className="bg-zinc-900/40 border-white/5 backdrop-blur-md">
                <CardHeader>
                  <CardTitle className="text-white text-xl flex items-center gap-2">
                    <Zap className="h-5 w-5 text-yellow-500" />
                    Subscription Configuration
                  </CardTitle>
                  <CardDescription className="text-zinc-400">Manage your server subscription source</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-zinc-300 ml-1">Subscription URL</label>
                    <div className="flex gap-4">
                      <div className="relative flex-1">
                        <Input
                          placeholder="https://subscribe.nextdesk.net/api/v1/client/subscribe..."
                          value={subUrl}
                          onChange={(e) => setSubUrl(e.target.value)}
                          className="bg-zinc-950/50 border-white/10 text-white placeholder:text-zinc-700 focus-visible:ring-emerald-500/50 h-12 pl-4"
                        />
                      </div>
                      <Button 
                        onClick={handleUpdateSubscription} 
                        disabled={updatingSub || !subUrl}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white h-12 px-6 shadow-lg shadow-emerald-900/20 font-medium tracking-wide"
                      >
                        {updatingSub ? 'Updating...' : 'Update'}
                      </Button>
                    </div>
                  </div>
                  
                  <div className="rounded-lg bg-blue-500/5 border border-blue-500/10 p-4">
                    <div className="flex gap-3">
                      <div className="p-2 rounded bg-blue-500/10 h-fit">
                        <CheckCircle2 className="h-4 w-4 text-blue-400" />
                      </div>
                      <div className="space-y-1">
                        <h4 className="text-sm font-medium text-blue-200">Auto-Update Enabled</h4>
                        <p className="text-xs text-blue-300/60 leading-relaxed">
                          Your server list will be automatically synchronized with the subscription server every 24 hours.
                          Manual updates can be triggered above.
                        </p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}

export default App;
