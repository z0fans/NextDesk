import { useState, type FormEvent } from 'react';
import { KeyRound, ShieldCheck, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n/useTranslation';
import { cn } from '@/lib/utils';
import { SSH_DEFAULT_GROUP_ID } from './connection-store';
import { sshApi } from './ssh-api';
import type {
  SshAuthMethod,
  SshConnection,
  SshConnectionGroup,
  SshProxyType,
  SshRoutePolicy,
} from './types';

interface NewSshConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (connection: SshConnection) => void;
  onUpdated: (connection: SshConnection) => void;
  groups: SshConnectionGroup[];
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
  groups,
  editConnection,
}: NewSshConnectionDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(editConnection?.name ?? '');
  const [host, setHost] = useState(editConnection?.host ?? '');
  const [port, setPort] = useState(String(editConnection?.port ?? 22));
  const [username, setUsername] = useState(editConnection?.username ?? 'root');
  const [groupId, setGroupId] = useState(editConnection?.groupId ?? SSH_DEFAULT_GROUP_ID);
  const [authMethod, setAuthMethod] = useState<SshAuthMethod>(editConnection?.authMethod ?? 'password');
  const [secret, setSecret] = useState('');
  const [privateKeyLabel, setPrivateKeyLabel] = useState(
    editConnection?.privateKeyLabel
      ?? (editConnection?.authMethod === 'private_key' ? editConnection.name : ''),
  );
  const [privateKey, setPrivateKey] = useState('');
  const [publicKey, setPublicKey] = useState(editConnection?.publicKey ?? '');
  const [notes, setNotes] = useState(editConnection?.notes ?? '');
  const [proxyType, setProxyType] = useState<SshProxyType>(editConnection?.proxyType ?? 'none');
  const [proxyHost, setProxyHost] = useState(editConnection?.proxyHost ?? '');
  const [proxyPort, setProxyPort] = useState(String(editConnection?.proxyPort ?? 1080));
  const [proxyUsername, setProxyUsername] = useState(editConnection?.proxyUsername ?? '');
  const [proxyPassword, setProxyPassword] = useState('');
  const [routePolicy, setRoutePolicy] = useState<SshRoutePolicy>(editConnection?.routePolicy ?? 'auto');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isEdit = Boolean(editConnection);
  const canReuseCredential = Boolean(
    editConnection?.credentialReference && editConnection.authMethod === authMethod,
  );
  const canReuseLegacyKeyPath = Boolean(
    editConnection?.privateKeyPath && editConnection.authMethod === authMethod,
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
    const parsedProxyPort = Number(proxyPort);
    if (
      proxyType !== 'none'
      && (
        !proxyHost.trim()
        || proxyHost.trim().split('').some((character) => /\s/.test(character))
        || !Number.isInteger(parsedProxyPort)
        || parsedProxyPort < 1
        || parsedProxyPort > 65535
      )
    ) {
      setError(t('sshProxyInvalid'));
      return;
    }
    if (authMethod === 'password' && !secret && !canReuseCredential) {
      setError(t('sshPasswordRequired'));
      return;
    }
    if (authMethod === 'private_key' && !privateKeyLabel.trim()) {
      setError(t('sshPrivateKeyLabelRequired'));
      return;
    }
    if (
      authMethod === 'private_key'
      && !privateKey.trim()
      && !canReuseCredential
      && !canReuseLegacyKeyPath
    ) {
      setError(t('sshPrivateKeyRequired'));
      return;
    }
    if (
      authMethod === 'private_key'
      && secret
      && !privateKey.trim()
      && !canReuseLegacyKeyPath
    ) {
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
      const replacesInlinePrivateKey = authMethod === 'private_key' && Boolean(privateKey.trim());
      const replacesLegacyPassphrase = authMethod === 'private_key'
        && !privateKey.trim()
        && canReuseLegacyKeyPath
        && Boolean(secret);
      const replacesCredential = authMethod === 'password'
        ? Boolean(secret)
        : replacesInlinePrivateKey || replacesLegacyPassphrase;
      if (replacesCredential) {
        // Active tabs keep immutable connection snapshots, so edited secrets must use a new vault entry.
        credentialReference = editConnection
          ? `ssh-${id}-${newConnectionId()}`
          : `ssh-${id}`;
      }
      if (credentialReference) {
        if (replacesCredential) {
          if (authMethod === 'password' || replacesLegacyPassphrase) {
            await sshApi.storeCredential(credentialReference, secret);
          } else {
            await sshApi.storePrivateKeyCredential(
              credentialReference,
              privateKeyLabel.trim(),
              privateKey.trim(),
              publicKey.trim() || undefined,
              secret || undefined,
            );
          }
        }
      }
      let proxyCredentialReference = proxyType === 'none'
        ? undefined
        : editConnection?.proxyCredentialReference;
      if (proxyType !== 'none' && proxyPassword) {
        proxyCredentialReference = `ssh-proxy-${id}-${newConnectionId()}`;
        await sshApi.storeCredential(proxyCredentialReference, proxyPassword);
      }
      const savedConnection: SshConnection = {
        id,
        name: name.trim() || host.trim(),
        host: host.trim(),
        port: parsedPort,
        username: username.trim(),
        authMethod,
        groupId,
        credentialReference,
        privateKeyLabel: authMethod === 'private_key' ? privateKeyLabel.trim() : undefined,
        publicKey: authMethod === 'private_key' && publicKey.trim() ? publicKey.trim() : undefined,
        privateKeyPath: authMethod === 'private_key' && !privateKey.trim()
          ? editConnection?.privateKeyPath
          : undefined,
        routePolicy,
        preferredRegion: editConnection?.preferredRegion,
        notes: notes.trim() || undefined,
        detectedOs: editConnection?.detectedOs,
        proxyType,
        proxyHost: proxyType === 'none' ? undefined : proxyHost.trim(),
        proxyPort: proxyType === 'none' ? undefined : parsedProxyPort,
        proxyUsername: proxyType === 'none' ? undefined : proxyUsername.trim() || undefined,
        proxyCredentialReference,
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
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <div className="flex shrink-0 items-start justify-between border-b border-border px-6 py-5">
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

        <div className="grid overflow-y-auto gap-4 px-6 py-5 sm:grid-cols-2">
          <label className="space-y-1.5 sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">{t('sshName')}</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('sshNamePlaceholder')} />
          </label>
          <label className="space-y-1.5 sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">{t('sshGroup')}</span>
            <select
              value={groupId}
              onChange={(event) => setGroupId(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/50"
            >
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.id === SSH_DEFAULT_GROUP_ID ? t('sshDefaultGroup') : group.name}
                </option>
              ))}
            </select>
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
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium text-muted-foreground">{t('sshAuthentication')}</legend>
            <div
              role="radiogroup"
              aria-label={t('sshAuthentication')}
              className="grid h-9 grid-cols-2 rounded-md border border-input bg-muted/30 p-0.5"
            >
              {(['password', 'private_key'] as const).map((method) => (
                <label key={method} className="relative cursor-pointer">
                  <input
                    className="peer sr-only"
                    type="radio"
                    name="ssh-authentication"
                    value={method}
                    checked={authMethod === method}
                    onChange={() => {
                      if (method !== authMethod) setSecret('');
                      setAuthMethod(method);
                      setError('');
                    }}
                  />
                  <span
                    className={cn(
                      'flex h-full items-center justify-center rounded-[5px] px-2 text-sm font-medium text-muted-foreground transition-colors',
                      'peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50',
                      'peer-checked:bg-background peer-checked:text-foreground peer-checked:shadow-sm',
                    )}
                  >
                    {method === 'password' ? t('sshPassword') : t('sshPrivateKey')}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {authMethod === 'private_key' && (
            <div className="grid gap-4 rounded-lg border border-border bg-muted/15 p-4 sm:col-span-2">
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t('sshPrivateKeyLabel')}</span>
                <Input
                  required
                  value={privateKeyLabel}
                  onChange={(event) => setPrivateKeyLabel(event.target.value)}
                  placeholder={t('sshPrivateKeyLabelPlaceholder')}
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t('sshPrivateKeyContent')}</span>
                <textarea
                  aria-label={t('sshPrivateKeyContent')}
                  required={!canReuseCredential && !canReuseLegacyKeyPath}
                  value={privateKey}
                  onChange={(event) => setPrivateKey(event.target.value)}
                  placeholder={canReuseCredential || canReuseLegacyKeyPath
                    ? t('sshKeepSavedPrivateKey')
                    : '-----BEGIN OPENSSH PRIVATE KEY-----'}
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
                <span className="block text-[11px] text-muted-foreground">{t('sshModernKeyHint')}</span>
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t('sshPublicKey')}</span>
                <textarea
                  aria-label={t('sshPublicKey')}
                  value={publicKey}
                  onChange={(event) => setPublicKey(event.target.value)}
                  placeholder="ssh-ed25519 AAAA... user@host"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-20 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
                <span className="block text-[11px] text-muted-foreground">{t('sshPublicKeyHint')}</span>
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t('sshPassphraseOptional')}</span>
                <Input
                  type="password"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  placeholder={canReuseCredential ? t('sshKeepSavedCredential') : undefined}
                  autoComplete="new-password"
                />
              </label>
            </div>
          )}

          {authMethod === 'password' && (
            <label className="space-y-1.5 sm:col-span-2">
              <span className="text-xs font-medium text-muted-foreground">{t('sshPassword')}</span>
              <Input
                required={!canReuseCredential}
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
          )}

          <label className="space-y-1.5 sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">{t('sshNotes')}</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value.slice(0, 2000))}
              placeholder={t('sshNotesPlaceholder')}
              className="min-h-20 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
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

          <fieldset className="grid gap-3 rounded-lg border border-border bg-muted/15 p-4 sm:col-span-2 sm:grid-cols-2">
            <legend className="px-1 text-xs font-medium text-muted-foreground">{t('sshProxy')}</legend>
            <label className="space-y-1.5 sm:col-span-2">
              <span className="text-xs font-medium text-muted-foreground">{t('sshProxyType')}</span>
              <select
                value={proxyType}
                onChange={(event) => {
                  const nextType = event.target.value as SshProxyType;
                  setProxyType(nextType);
                  if (nextType === 'http' && (!editConnection?.proxyPort || editConnection.proxyType !== 'http')) setProxyPort('8080');
                  if (nextType === 'socks5' && (!editConnection?.proxyPort || editConnection.proxyType !== 'socks5')) setProxyPort('1080');
                }}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/50"
              >
                <option value="none">{t('sshProxyNone')}</option>
                <option value="socks5">SOCKS5</option>
                <option value="http">HTTP CONNECT</option>
              </select>
            </label>
            {proxyType !== 'none' && (
              <>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{t('sshProxyHost')}</span>
                  <Input value={proxyHost} onChange={(event) => setProxyHost(event.target.value)} placeholder="127.0.0.1" />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{t('port')}</span>
                  <Input type="number" min={1} max={65535} value={proxyPort} onChange={(event) => setProxyPort(event.target.value)} />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{t('sshProxyUsername')}</span>
                  <Input value={proxyUsername} onChange={(event) => setProxyUsername(event.target.value)} autoComplete="off" />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{t('sshProxyPassword')}</span>
                  <Input type="password" value={proxyPassword} onChange={(event) => setProxyPassword(event.target.value)} placeholder={editConnection?.proxyCredentialReference ? t('sshKeepSavedCredential') : undefined} autoComplete="new-password" />
                </label>
                <p className="text-[11px] leading-5 text-muted-foreground sm:col-span-2">{t('sshProxyHint')}</p>
              </>
            )}
          </fieldset>

          <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600 sm:col-span-2 dark:text-emerald-400">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            {t('sshCredentialVaultHint')}
          </div>
          {error && <p className="text-sm text-destructive sm:col-span-2">{error}</p>}
        </div>

        <div className="flex shrink-0 justify-end gap-3 border-t border-border bg-muted/20 px-6 py-4">
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
