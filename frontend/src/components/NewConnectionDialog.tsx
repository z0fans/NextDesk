import { useState, useEffect, useRef } from 'react';
import { Monitor, X, ChevronDown, Check } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type { SessionStore } from '@/lib/useSessionStore';
import type { ServerEntry } from '@/lib/rdp-types';
import { useTranslation } from '@/i18n/useTranslation';

interface Props {
  store: SessionStore;
  open: boolean;
  onClose: () => void;
  onSaved: (serverId: string, connect: boolean) => void;
  editServer?: ServerEntry | null;
}

const COLOR_TAGS = ['#3B82F6', '#10B981', '#EF4444', '#F59E0B', '#8B5CF6', '#EC4899'];

export function NewConnectionDialog({ store, open, onClose, onSaved, editServer }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('3389');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [domain, setDomain] = useState('');

  const [groupId, setGroupId] = useState('default');
  const [colorTag, setColorTag] = useState(COLOR_TAGS[0]);
  const isEdit = !!editServer;

  useEffect(() => {
    if (editServer) {
      setName(editServer.name || '');
      setHost(editServer.host || '');
      setPort(String(editServer.port || 3389));
      setUsername(editServer.username || '');
      setPassword(editServer.password || '');
      setDomain(editServer.domain || '');

      setGroupId(editServer.groupId || 'default');
      setColorTag(editServer.colorTag || COLOR_TAGS[0]);
    } else {
      setName(''); setHost(''); setPort('3389');
      setUsername(''); setPassword(''); setDomain('');
      setGroupId('default'); setColorTag(COLOR_TAGS[0]);
    }
  }, [editServer]);

  if (!open) return null;

  const handleSave = (connect: boolean) => {
    if (!host || !username) return;
    if (isEdit) {
      store.updateServer(editServer.id, {
        name: name || host, host,
        port: parseInt(port) || 3389,
        username, password, domain,

        groupId, colorTag,
      });
      onSaved(editServer.id, connect);
    } else {
      const server = store.addServer({
        name: name || host, host,
        port: parseInt(port) || 3389,
        username, password, domain,


        groupId, isFavorite: false, colorTag,
      });
      onSaved(server.id, connect);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-xl w-full max-w-md p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center">
              <Monitor className="h-4 w-4 text-white" />
            </div>
            <h2 className="text-base font-semibold">{isEdit ? t('rdpEditConnection') : t('rdpNewConnection')}</h2>
          </div>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-3">
          <Field label={t('rdpDisplayName')}>
            <Input placeholder="My Server" value={name} onChange={e => setName(e.target.value)} className="h-8 text-sm" />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label={t('rdpHost')}>
                <Input placeholder="192.168.1.100" value={host} onChange={e => setHost(e.target.value)} required className="h-8 text-sm" />
              </Field>
            </div>
            <Field label={t('rdpPort')}>
              <Input placeholder="3389" value={port} onChange={e => setPort(e.target.value)} type="number" className="h-8 text-sm" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('rdpUsername')}>
              <Input placeholder="Administrator" value={username} onChange={e => setUsername(e.target.value)} required className="h-8 text-sm" />
            </Field>
            <Field label={t('rdpPassword')}>
              <Input placeholder="••••••" type="password" value={password} onChange={e => setPassword(e.target.value)} className="h-8 text-sm" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('rdpDomain')}>
              <Input placeholder={t('rdpOptional')} value={domain} onChange={e => setDomain(e.target.value)} className="h-8 text-sm" />
            </Field>
            <Field label={t('rdpGroup')}>
              <GroupSelect
                groups={store.groups.filter(g => g.id !== 'fav')}
                value={groupId}
                onChange={setGroupId}
              />
            </Field>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1.5">{t('rdpColorTag')}</label>
            <div className="flex gap-2">
              {COLOR_TAGS.map(c => (
                <button
                  key={c} type="button"
                  className={`h-5 w-5 rounded-full cursor-pointer transition-transform ${colorTag === c ? 'ring-2 ring-offset-2 ring-offset-background scale-110' : ''}`}
                  style={{ backgroundColor: c }} onClick={() => setColorTag(c)}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="flex gap-2 mt-6">
          <Button variant="outline" className="flex-1 h-9" onClick={onClose}>{t('rdpCancel')}</Button>
          <Button
            className="flex-1 h-9 bg-gradient-to-r from-cyan-600 to-blue-600 text-white"
            disabled={!host || !username}
            onClick={() => handleSave(isEdit ? false : true)}
          >
            {isEdit ? t('rdpSave') : t('rdpSaveAndConnect')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function GroupSelect({ groups, value, onChange }: {
  groups: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selected = groups.find(g => g.id === value);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex h-8 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 text-sm transition-colors hover:border-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
      >
        <span className="truncate">{selected?.name ?? t('rdpSelect')}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-lg">
          <div className="max-h-40 overflow-y-auto py-1">
            {groups.map(g => (
              <button
                key={g.id}
                type="button"
                onClick={() => { onChange(g.id); setOpen(false); }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ${g.id === value ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                <Check className={`h-3.5 w-3.5 shrink-0 ${g.id === value ? 'opacity-100' : 'opacity-0'}`} />
                <span className="truncate">{g.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground block mb-1">{label}</label>
      {children}
    </div>
  );
}
