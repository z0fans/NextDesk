export type RdpEngineMode = 'native' | 'official-web';

export const RDP_ENGINE_STORAGE_KEY = 'nextdesk_rdp_engine';

type RuntimeGlobal = typeof globalThis & {
  __NEXTDESK_RDP_ENGINE__?: unknown;
};

type ResolveRdpEngineModeOptions = {
  envValue?: string | null;
  storage?: Storage | null;
  globalValue?: unknown;
};

function readOptionSafely<K extends keyof ResolveRdpEngineModeOptions>(
  options: ResolveRdpEngineModeOptions,
  key: K,
): { failed: boolean; value: ResolveRdpEngineModeOptions[K] | undefined } {
  try {
    return { failed: false, value: options[key] };
  } catch {
    return { failed: true, value: undefined };
  }
}

function readGlobalEngineSafely(): unknown {
  try {
    return (globalThis as RuntimeGlobal).__NEXTDESK_RDP_ENGINE__;
  } catch {
    return null;
  }
}

function readDefaultStorageSafely(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readStorageItemSafely(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function readEnvEngineSafely(): string | null {
  try {
    return import.meta.env?.VITE_NEXTDESK_RDP_ENGINE ?? null;
  } catch {
    return null;
  }
}

export function parseRdpEngineMode(value: string | null | undefined): RdpEngineMode | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;

  if (normalized === 'native' || normalized === 'ironrdp-native') {
    return 'native';
  }

  if (
    normalized === 'official-web' ||
    normalized === 'web' ||
    normalized === 'wasm' ||
    normalized === 'ironrdp-web'
  ) {
    return 'official-web';
  }

  return null;
}

export function parseRdpBooleanFlag(
  value: string | null | undefined,
  defaultValue = false,
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return defaultValue;

  if (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on' ||
    normalized === 'enabled'
  ) {
    return true;
  }

  if (
    normalized === '0' ||
    normalized === 'false' ||
    normalized === 'no' ||
    normalized === 'off' ||
    normalized === 'disabled'
  ) {
    return false;
  }

  return defaultValue;
}

export function resolveRdpEngineMode(options: ResolveRdpEngineModeOptions = {}): RdpEngineMode {
  const globalOption = readOptionSafely(options, 'globalValue');
  const globalValue = !globalOption.failed && globalOption.value === undefined
    ? readGlobalEngineSafely()
    : globalOption.value;
  const fromGlobal = typeof globalValue === 'string' ? parseRdpEngineMode(globalValue) : null;
  if (fromGlobal) return fromGlobal;

  const storageOption = readOptionSafely(options, 'storage');
  const storage = !storageOption.failed && storageOption.value === undefined
    ? readDefaultStorageSafely()
    : storageOption.value ?? null;
  const fromStorage = parseRdpEngineMode(readStorageItemSafely(storage, RDP_ENGINE_STORAGE_KEY));
  if (fromStorage) return fromStorage;

  const envOption = readOptionSafely(options, 'envValue');
  const envValue = !envOption.failed && envOption.value === undefined
    ? readEnvEngineSafely()
    : envOption.value;
  const fromEnv = parseRdpEngineMode(envValue);
  if (fromEnv) return fromEnv;

  return 'official-web';
}

export function isNativeRdpMode(mode: RdpEngineMode): boolean {
  return mode === 'native';
}

export function isOfficialIronRdpWebMode(mode: RdpEngineMode): boolean {
  return mode === 'official-web';
}
