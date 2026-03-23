import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Monitor, Loader2 } from 'lucide-react';

interface RdpConnectDialogProps {
  onConnect: (config: RdpConfig) => void;
  connecting: boolean;
}

export interface RdpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  domain: string;
}

export function RdpConnectDialog({ onConnect, connecting }: RdpConnectDialogProps) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('3389');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [domain, setDomain] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!host || !username) return;
    onConnect({
      host,
      port: parseInt(port) || 3389,
      username,
      password,
      domain,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-md mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center">
          <Monitor className="h-5 w-5 text-white" />
        </div>
        <div>
          <h3 className="text-lg font-semibold">RDP Connection</h3>
          <p className="text-xs text-muted-foreground">Connect to remote desktop</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Host</label>
          <Input
            placeholder="192.168.1.100"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Port</label>
          <Input
            placeholder="3389"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            type="number"
          />
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Username</label>
        <Input
          placeholder="Administrator"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Password</label>
        <Input
          placeholder="••••••••"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Domain (optional)</label>
        <Input
          placeholder="WORKGROUP"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
        />
      </div>

      <Button
        type="submit"
        disabled={!host || !username || connecting}
        className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white"
      >
        {connecting ? (
          <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Connecting...</>
        ) : (
          <><Monitor className="h-4 w-4 mr-2" /> Connect</>
        )}
      </Button>
    </form>
  );
}
