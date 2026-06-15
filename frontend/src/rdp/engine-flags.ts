export type RdpEngineMode = 'native' | 'official-web';

export const RDP_ENGINE_STORAGE_KEY = 'nextdesk_rdp_engine';
export const RDP_EXPERIMENTAL_NATIVE_STORAGE_KEY = 'nextdesk_experimental_native_rdp';

type RuntimeGlobal = typeof globalThis & {
  __NEXTDESK_RDP_ENGINE__?: unknown;
  __NEXTDESK_EXPERIMENTAL_NATIVE_RDP__?: unknown;
};

type ResolveRdpEngineModeOptions = {
  envValue?: string | null;
  storage?: Storage | null;
  globalValue?: unknown;
  experimentalNativeValue?: string | null;
};

type ResolveRdpRuntimeBooleanFlagOptions = {
  storageValue?: string | null;
  envValue?: string | null;
  defaultValue: boolean;
};

export type OfficialWebFeatureFlags = {
  audio: boolean;
  gfx: boolean;
  gfxForce: boolean;
  gfxRequested: boolean;
  fileTransfer: boolean;
  displayControl: boolean;
};

function readOption<K extends keyof ResolveRdpEngineModeOptions>(
  options: ResolveRdpEngineModeOptions,
  key: K,
): ResolveRdpEngineModeOptions[K] | undefined {
  try {
    return options[key];
  } catch {
    return undefined;
  }
}

function readGlobalValue(key: keyof RuntimeGlobal): unknown {
  try {
    return (globalThis as RuntimeGlobal)[key];
  } catch {
    return null;
  }
}

function readDefaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readStorageItem(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function readEnvValue(key: string): string | null {
  try {
    return (import.meta.env as Record<string, string | undefined>)?.[key] ?? null;
  } catch {
    return null;
  }
}

export function parseRdpEngineMode(value: string | null | undefined): RdpEngineMode | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'native' || normalized === 'ironrdp-native') return 'native';
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

export function parseRdpBooleanFlag(value: string | null | undefined, defaultValue = false): boolean {
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

export function resolveRdpRuntimeBooleanFlag(options: ResolveRdpRuntimeBooleanFlagOptions): boolean {
  if (options.storageValue !== null && options.storageValue !== undefined) {
    return parseRdpBooleanFlag(options.storageValue, options.defaultValue);
  }
  return parseRdpBooleanFlag(options.envValue, options.defaultValue);
}

export function resolveOfficialWebFeatureFlags(
  read: (storageKey: string, envKey: string) => string | null,
): OfficialWebFeatureFlags {
  const value = (storageKey: string, envKey: string, defaultValue: boolean) => {
    const storageValue = read(storageKey, '');
    const envValue = read('', envKey);
    return resolveRdpRuntimeBooleanFlag({ storageValue, envValue, defaultValue });
  };

  const gfxRequested = value('nextdesk_official_web_gfx', 'VITE_NEXTDESK_OFFICIAL_WEB_GFX', false);
  const gfxForce = value('nextdesk_official_web_gfx_force', 'VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE', false);

  return {
    audio: value('nextdesk_official_web_audio', 'VITE_NEXTDESK_OFFICIAL_WEB_AUDIO', false),
    gfx: gfxRequested || gfxForce,
    gfxForce,
    gfxRequested,
    fileTransfer: value('nextdesk_official_web_file_transfer', 'VITE_NEXTDESK_OFFICIAL_WEB_FILE_TRANSFER', false),
    displayControl: value('nextdesk_official_web_display_control', 'VITE_NEXTDESK_OFFICIAL_WEB_DISPLAY_CONTROL', true),
  };
}

function resolveExperimentalNativeFlag(
  options: ResolveRdpEngineModeOptions,
  storage: Storage | null,
): boolean {
  const fromGlobal = readGlobalValue('__NEXTDESK_EXPERIMENTAL_NATIVE_RDP__');
  if (typeof fromGlobal === 'string') return parseRdpBooleanFlag(fromGlobal, false);
  if (typeof fromGlobal === 'boolean') return fromGlobal;
  const experimentalNativeValue = readOption(options, 'experimentalNativeValue');
  if (experimentalNativeValue !== undefined) {
    return parseRdpBooleanFlag(experimentalNativeValue, false);
  }
  const fromStorage = readStorageItem(storage, RDP_EXPERIMENTAL_NATIVE_STORAGE_KEY);
  if (fromStorage !== null) return parseRdpBooleanFlag(fromStorage, false);
  return parseRdpBooleanFlag(readEnvValue('VITE_NEXTDESK_EXPERIMENTAL_NATIVE_RDP'), false);
}

export function resolveRdpEngineMode(options: ResolveRdpEngineModeOptions = {}): RdpEngineMode {
  const storageOption = readOption(options, 'storage');
  const storage = storageOption === undefined ? readDefaultStorage() : storageOption ?? null;
  const experimentalNative = resolveExperimentalNativeFlag(options, storage);
  const globalOption = readOption(options, 'globalValue');
  const globalValue = globalOption === undefined
    ? readGlobalValue('__NEXTDESK_RDP_ENGINE__')
    : globalOption;
  const envOption = readOption(options, 'envValue');

  const candidates = [
    typeof globalValue === 'string' ? globalValue : null,
    readStorageItem(storage, RDP_ENGINE_STORAGE_KEY),
    envOption === undefined ? readEnvValue('VITE_NEXTDESK_RDP_ENGINE') : envOption,
  ];

  for (const candidate of candidates) {
    const mode = parseRdpEngineMode(candidate);
    if (mode === 'official-web') return 'official-web';
    if (mode === 'native' && experimentalNative) return 'native';
  }

  return 'official-web';
}

export function isNativeRdpMode(mode: RdpEngineMode): boolean {
  return mode === 'native';
}

export function isOfficialIronRdpWebMode(mode: RdpEngineMode): boolean {
  return mode === 'official-web';
}
