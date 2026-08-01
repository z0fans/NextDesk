import { useState, type FormEvent } from 'react';
import { KeyRound, ShieldCheck, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n/useTranslation';
import { sshApi } from './ssh-api';
import type { SshAuthMethod, SshConnection, SshRoutePolicy } from './types';

interface NewSshConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (connection: SshConnection) => void;
  onUpdated: (connection: SshConnection) => void;
  editConnection?: SshConnection | null;
}

function newConnectionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function NewSshConnectionDialog({
  open,
  onClose,
  onCreated,
  onUpdated,
  editConnection,
}: NewSshConnectionDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(editConnection?.name ?? '');
  const [host, setHost] = useState(editConnection?.host ?? '');
  const [port, setPort] = useState(String(editConnection?.port ?? 22));
  const [username, setUsername] = useState(editConnection?.username ?? 'root');
  const [authMethod, setAuthMethod] = useState<SshAuthMethod>(editConnection?.authMethod ?? 'password');
  const [secret, setSecret] = useState('');
  const [privateKeyPath, setPrivateKeyPath] = useState(editConnection?.privateKeyPath ?? '');
  const [routePolicy, setRoutePolicy] = useState<SshRoutePolicy>(editConnection?.routePolicy ?? 'auto');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isEdit = Boolean(editConnection);
  const canReuseCredential = Boolean(
    editConnection?.credentialReference && editConnection.authMethod === authMethod,
  );

  if (!open) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsedPort = Number(port);
    if (
      !host.trim() ||
      host.trim().split('').some((character) => /\s/.test(character)) ||
      !username.trim() ||
      !Number.isInteger(parsedPort) ||
      parsedPort < 1 ||
      parsedPort > 65535
    ) {
      setError(t('sshFormInvalid'));
      return;
    }
    if (authMethod === 'password' && !secret && !canReuseCredential) {
      setError(t('sshPasswordRequired'));
      return;
    }
    if (authMethod === 'private_key' && !privateKeyPath.trim()) {
      setError(t('sshPrivateKeyRequired'));
      return;
    }

    setSaving(true);
    setError('');
    try {
      const id = editConnection?.id ?? newConnectionId();
      let credentialReference = canReuseCredential
        ? editConnection?.credentialReference
        : undefined;
      if (secret) {
        // Active tabs keep immutable connection snapshots, so edited secrets must use a new vault entry.
        credentialReference = editConnection
          ? `ssh-${id}-${newConnectionId()}`
          : `ssh-${id}`;
      }
      if (credentialReference) {
        if (secret) await sshApi.storeCredential(credentialReference, secret);
      }
      const savedConnection: SshConnection = {
        id,
        name: name.trim() || host.trim(),
        host: host.trim(),
        port: parsedPort,
        username: username.trim(),
        authMethod,
        credentialReference,
        privateKeyPath: authMethod === 'private_key' ? privateKeyPath.trim() : undefined,
        routePolicy,
        preferredRegion: editConnection?.preferredRegion,
      };
      if (editConnection) {
        onUpdated(savedConnection);
      } else {
        onCreated(savedConnection);
      }
      onClose();
    } catch {
      setError(t('sshErrorCredential'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <form
        onSubmit={submit}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <div className="flex items-start justify-between border-b border-border px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              {isEdit ? t('sshEditConnection') : t('sshNewConnection')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('sshCredentialVaultHint')}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label={t('sshCancel')}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid gap-4 px-6 py-5 sm:grid-cols-2">
          <label className="space-y-1.5 sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">{t('sshName')}</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('sshNamePlaceholder')} />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('sshHost')}</span>
            <Input required value={host} onChange={(event) => setHost(event.target.value)} placeholder="server.example.com" />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('port')}</span>
            <Input required type="number" min={1} max={65535} value={port} onChange={(event) => setPort(event.target.value)} />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('sshUsername')}</span>
            <Input required value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('sshAuthentication')}</span>
            <select
              value={authMethod}
              onChange={(event) => setAuthMethod(event.target.value as SshAuthMethod)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/50"
            >
              <option value="password">{t('sshPassword')}</option>
              <option value="private_key">{t('sshPrivateKey')}</option>
            </select>
          </label>

          {authMethod === 'private_key' && (
            <label className="space-y-1.5 sm:col-span-2">
              <span className="text-xs font-medium text-muted-foreground">{t('sshPrivateKeyPath')}</span>
              <Input value={privateKeyPath} onChange={(event) => setPrivateKeyPath(event.target.value)} placeholder="~/.ssh/id_ed25519" />
              <span className="block text-[11px] text-muted-foreground">{t('sshModernKeyHint')}</span>
            </label>
          )}

          <label className="space-y-1.5 sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">
              {authMethod === 'password' ? t('sshPassword') : t('sshPassphraseOptional')}
            </span>
            <Input
              required={authMethod === 'password' && !canReuseCredential}
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder={isEdit && canReuseCredential ? t('sshKeepSavedCredential') : undefined}
              autoComplete="new-password"
            />
            {isEdit && canReuseCredential && (
              <span className="block text-[11px] text-muted-foreground">{t('sshKeepSavedCredentialHint')}</span>
            )}
          </label>

          <label className="space-y-1.5 sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">{t('sshRoutePolicy')}</span>
            <select
              value={routePolicy}
              onChange={(event) => setRoutePolicy(event.target.value as SshRoutePolicy)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/50"
            >
              <option value="auto">{t('sshRouteAuto')}</option>
              <option value="direct">{t('sshRouteDirect')}</option>
              <option value="cloud_only">{t('sshRouteCloudOnly')}</option>
            </select>
          </label>

          <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600 sm:col-span-2 dark:text-emerald-400">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            {t('sshCredentialVaultHint')}
          </div>
          {error && <p className="text-sm text-destructive sm:col-span-2">{error}</p>}
        </div>

        <div className="flex justify-end gap-3 border-t border-border bg-muted/20 px-6 py-4">
          <Button type="button" variant="outline" onClick={onClose}>{t('sshCancel')}</Button>
          <Button type="submit" disabled={saving} className="bg-cyan-600 text-white hover:bg-cyan-500">
            <KeyRound className="h-4 w-4" />
            {saving ? t('sshSaving') : isEdit ? t('sshSave') : t('sshSaveAndConnect')}
          </Button>
        </div>
      </form>
    </div>
  );
}
