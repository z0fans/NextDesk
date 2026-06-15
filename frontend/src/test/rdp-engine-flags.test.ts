import { describe, expect, it } from 'vitest';
import {
  RDP_ENGINE_STORAGE_KEY,
  parseRdpEngineMode,
  resolveOfficialWebFeatureFlags,
  resolveRdpEngineMode,
  resolveRdpRuntimeBooleanFlag,
} from '@/rdp/engine-flags';

function createStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

describe('IronRDP-first engine flags', () => {
  it('keeps the existing storage key for compatibility', () => {
    expect(RDP_ENGINE_STORAGE_KEY).toBe('nextdesk_rdp_engine');
  });

  it('parses official-web aliases', () => {
    expect(parseRdpEngineMode('official-web')).toBe('official-web');
    expect(parseRdpEngineMode('web')).toBe('official-web');
    expect(parseRdpEngineMode('wasm')).toBe('official-web');
    expect(parseRdpEngineMode('ironrdp-web')).toBe('official-web');
  });

  it('parses native aliases but does not enable native without the experimental flag', () => {
    expect(parseRdpEngineMode('native')).toBe('native');
    expect(resolveRdpEngineMode({
      envValue: 'native',
      storage: createStorage(),
      globalValue: null,
      experimentalNativeValue: '0',
    })).toBe('official-web');
  });

  it('allows native only when experimental native is enabled', () => {
    expect(resolveRdpEngineMode({
      envValue: 'native',
      storage: createStorage(),
      globalValue: null,
      experimentalNativeValue: '1',
    })).toBe('native');
  });

  it('lets localStorage request native only when experimental native is enabled', () => {
    const storage = createStorage({ [RDP_ENGINE_STORAGE_KEY]: 'native' });
    expect(resolveRdpEngineMode({
      envValue: 'official-web',
      storage,
      globalValue: null,
      experimentalNativeValue: '0',
    })).toBe('official-web');
    expect(resolveRdpEngineMode({
      envValue: 'official-web',
      storage,
      globalValue: null,
      experimentalNativeValue: 'yes',
    })).toBe('native');
  });

  it('parses runtime boolean flags', () => {
    expect(resolveRdpRuntimeBooleanFlag({
      storageValue: null,
      envValue: null,
      defaultValue: true,
    })).toBe(true);
    expect(resolveRdpRuntimeBooleanFlag({
      storageValue: '0',
      envValue: '1',
      defaultValue: true,
    })).toBe(false);
    expect(resolveRdpRuntimeBooleanFlag({
      storageValue: null,
      envValue: 'enabled',
      defaultValue: false,
    })).toBe(true);
  });
});

describe('official-web stable profile', () => {
  it('defaults to stable IronRDP-first baseline', () => {
    const flags = resolveOfficialWebFeatureFlags(() => null);
    expect(flags).toEqual({
      audio: false,
      gfx: false,
      gfxForce: false,
      gfxRequested: false,
      fileTransfer: false,
      displayControl: true,
    });
  });

  it('enables requested official-web GFX through the safe H.264 fallback path', () => {
    const flags = resolveOfficialWebFeatureFlags((storageKey, envKey) => {
      const values: Record<string, string> = {
        VITE_NEXTDESK_OFFICIAL_WEB_GFX: 'true',
      };
      return values[storageKey] ?? values[envKey] ?? null;
    });

    expect(flags.gfxRequested).toBe(true);
    expect(flags.gfx).toBe(true);
    expect(flags.gfxForce).toBe(false);
  });

  it('keeps force flag visible for diagnostics', () => {
    const flags = resolveOfficialWebFeatureFlags((storageKey, envKey) => {
      const values: Record<string, string> = {
        nextdesk_official_web_gfx: '1',
        VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE: 'true',
      };
      return values[storageKey] ?? values[envKey] ?? null;
    });

    expect(flags.gfx).toBe(true);
    expect(flags.gfxRequested).toBe(true);
    expect(flags.gfxForce).toBe(true);
  });

  it('allows feature flags to be enabled explicitly', () => {
    const flags = resolveOfficialWebFeatureFlags((storageKey, envKey) => {
      const values: Record<string, string> = {
        nextdesk_official_web_audio: '1',
        VITE_NEXTDESK_OFFICIAL_WEB_GFX: 'true',
        VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE: 'true',
        nextdesk_official_web_file_transfer: 'yes',
        nextdesk_official_web_display_control: '0',
      };
      return values[storageKey] ?? values[envKey] ?? null;
    });

    expect(flags).toEqual({
      audio: true,
      gfx: true,
      gfxForce: true,
      gfxRequested: true,
      fileTransfer: true,
      displayControl: false,
    });
  });
});
