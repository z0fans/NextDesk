export type RdpEngineMode = 'native' | 'native-drift' | 'official-web';
export type RdpWasmLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export const RDP_ENGINE_STORAGE_KEY = 'nextdesk_rdp_engine';
export const RDP_EXPERIMENTAL_NATIVE_STORAGE_KEY = 'nextdesk_experimental_native_rdp';
export const RDP_WASM_LOG_LEVEL_STORAGE_KEY = 'nextdesk_rdp_wasm_log_level';
export const DEFAULT_RDP_ENGINE_MODE: RdpEngineMode = 'native-drift';
export const DEFAULT_EXPERIMENTAL_NATIVE_RDP = true;

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

type ResolveRdpWasmLogLevelOptions = {
  isDev: boolean;
  storageValue?: string | null;
  envValue?: string | null;
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
    normalized === 'native-drift' ||
    normalized === 'native-fast' ||
    normalized === 'ironrdp-native-drift' ||
    normalized === 'drift'
  ) {
    return 'native-drift';
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

export function parseRdpWasmLogLevel(value: string | null | undefined): RdpWasmLogLevel | null {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'trace' ||
    normalized === 'debug' ||
    normalized === 'info' ||
    normalized === 'warn' ||
    normalized === 'error'
  ) {
    return normalized;
  }
  return null;
}

export function resolveRdpWasmLogLevel(options: ResolveRdpWasmLogLevelOptions): RdpWasmLogLevel {
  return parseRdpWasmLogLevel(options.storageValue) ??
    parseRdpWasmLogLevel(options.envValue) ??
    (options.isDev ? 'debug' : 'warn');
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
  if (typeof fromGlobal === 'string') return parseRdpBooleanFlag(fromGlobal, DEFAULT_EXPERIMENTAL_NATIVE_RDP);
  if (typeof fromGlobal === 'boolean') return fromGlobal;
  const experimentalNativeValue = readOption(options, 'experimentalNativeValue');
  if (experimentalNativeValue !== undefined) {
    return parseRdpBooleanFlag(experimentalNativeValue, DEFAULT_EXPERIMENTAL_NATIVE_RDP);
  }
  const fromStorage = readStorageItem(storage, RDP_EXPERIMENTAL_NATIVE_STORAGE_KEY);
  if (fromStorage !== null) return parseRdpBooleanFlag(fromStorage, DEFAULT_EXPERIMENTAL_NATIVE_RDP);
  return parseRdpBooleanFlag(
    readEnvValue('VITE_NEXTDESK_EXPERIMENTAL_NATIVE_RDP'),
    DEFAULT_EXPERIMENTAL_NATIVE_RDP,
  );
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
    if ((mode === 'native' || mode === 'native-drift') && experimentalNative) return mode;
  }

  return experimentalNative ? DEFAULT_RDP_ENGINE_MODE : 'official-web';
}

export function isNativeRdpMode(mode: RdpEngineMode): boolean {
  return mode === 'native' || mode === 'native-drift';
}

export function isNativeDriftRdpMode(mode: RdpEngineMode): boolean {
  return mode === 'native-drift';
}

export function isOfficialIronRdpWebMode(mode: RdpEngineMode): boolean {
  return mode === 'official-web';
}
