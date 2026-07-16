import { describe, expect, it } from 'vitest';
import {
  RDP_ENGINE_STORAGE_KEY,
  isNativeRdpMode,
  isOfficialIronRdpWebMode,
  parseRdpBooleanFlag,
  parseRdpEngineMode,
  resolveRdpEngineMode,
} from '@/lib/rdp-engine';

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

function createThrowingStorage(): Storage {
  return {
    get length() {
      return 0;
    },
    clear() {
      // no-op
    },
    getItem() {
      throw new Error('storage unavailable');
    },
    key() {
      return null;
    },
    removeItem() {
      // no-op
    },
    setItem() {
      // no-op
    },
  };
}

describe('RDP engine mode selection', () => {
  it('keeps the localStorage key stable for DevTools toggling', () => {
    expect(RDP_ENGINE_STORAGE_KEY).toBe('nextdesk_rdp_engine');
  });

  it('defaults to kkterm-copy when no override is present', () => {
    expect(resolveRdpEngineMode({ envValue: null, storage: null, globalValue: null })).toBe('kkterm-copy');
  });

  it('parses official web aliases', () => {
    expect(parseRdpEngineMode('official-web')).toBe('official-web');
    expect(parseRdpEngineMode('  OFFICIAL-WEB  ')).toBe('official-web');
    expect(parseRdpEngineMode('web')).toBe('official-web');
    expect(parseRdpEngineMode('wasm')).toBe('official-web');
    expect(parseRdpEngineMode('ironrdp-web')).toBe('official-web');
  });

  it('parses native aliases', () => {
    expect(parseRdpEngineMode('native')).toBe('native');
    expect(parseRdpEngineMode('ironrdp-native')).toBe('native');
  });

  it('ignores invalid values', () => {
    expect(parseRdpEngineMode('freerdp')).toBeNull();
    expect(parseRdpEngineMode('')).toBeNull();
    expect(parseRdpEngineMode(null)).toBeNull();
  });

  it('uses debug global before localStorage and env', () => {
    const storage = createStorage({ [RDP_ENGINE_STORAGE_KEY]: 'native' });
    expect(resolveRdpEngineMode({
      envValue: 'native',
      storage,
      globalValue: 'official-web',
    })).toBe('official-web');
  });

  it('uses env before localStorage', () => {
    const storage = createStorage({ [RDP_ENGINE_STORAGE_KEY]: 'official-web' });
    expect(resolveRdpEngineMode({
      envValue: 'native',
      storage,
      globalValue: null,
    })).toBe('native');
  });

  it('uses env when no debug override exists', () => {
    expect(resolveRdpEngineMode({
      envValue: 'official-web',
      storage: createStorage(),
      globalValue: null,
    })).toBe('official-web');
  });

  it('uses env when no debug override exists and native is experimental', () => {
    expect(resolveRdpEngineMode({
      envValue: 'native',
      storage: createStorage(),
      globalValue: null,
      experimentalNativeValue: '1',
    })).toBe('native');
  });

  it('does not read ambient global override when globalValue is null', () => {
    const runtimeGlobal = globalThis as { __NEXTDESK_RDP_ENGINE__?: unknown };
    const previous = runtimeGlobal.__NEXTDESK_RDP_ENGINE__;
    runtimeGlobal.__NEXTDESK_RDP_ENGINE__ = 'official-web';

    try {
      expect(resolveRdpEngineMode({ envValue: null, storage: null, globalValue: null })).toBe('kkterm-copy');
    } finally {
      runtimeGlobal.__NEXTDESK_RDP_ENGINE__ = previous;
    }
  });

  it('falls back from an invalid debug global to env', () => {
    const storage = createStorage({ [RDP_ENGINE_STORAGE_KEY]: 'official-web' });
    expect(resolveRdpEngineMode({
      envValue: 'native',
      storage,
      globalValue: 'freerdp',
    })).toBe('native');
  });

  it('falls back from invalid localStorage to env', () => {
    const storage = createStorage({ [RDP_ENGINE_STORAGE_KEY]: 'freerdp' });
    expect(resolveRdpEngineMode({
      envValue: 'official-web',
      storage,
      globalValue: null,
    })).toBe('official-web');
  });

  it('falls back from throwing storage to env', () => {
    expect(resolveRdpEngineMode({
      envValue: 'official-web',
      storage: createThrowingStorage(),
      globalValue: null,
    })).toBe('official-web');
  });

  it('falls back from throwing storage to kkterm-copy when env is absent', () => {
    expect(resolveRdpEngineMode({
      envValue: null,
      storage: createThrowingStorage(),
      globalValue: null,
    })).toBe('kkterm-copy');
  });

  it('falls back from a blocked default localStorage getter to env', () => {
    const originalLocalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('localStorage blocked');
      },
    });

    try {
      expect(resolveRdpEngineMode({
        envValue: 'official-web',
        globalValue: null,
      })).toBe('official-web');
    } finally {
      if (originalLocalStorage) {
        Object.defineProperty(window, 'localStorage', originalLocalStorage);
      }
    }
  });

  it('falls back to official-web when env reading fails', () => {
    const options: Parameters<typeof resolveRdpEngineMode>[0] = {
      get envValue(): string | null {
        throw new Error('env unavailable');
      },
      storage: null,
      globalValue: null,
    };

    expect(resolveRdpEngineMode(options)).toBe('kkterm-copy');
  });

  it('exposes boolean helpers', () => {
    expect(isNativeRdpMode('native')).toBe(true);
    expect(isNativeRdpMode('official-web')).toBe(false);
    expect(isOfficialIronRdpWebMode('official-web')).toBe(true);
    expect(isOfficialIronRdpWebMode('native')).toBe(false);
  });
});

describe('RDP runtime boolean flags', () => {
  it('parses enabled values', () => {
    expect(parseRdpBooleanFlag('1')).toBe(true);
    expect(parseRdpBooleanFlag('true')).toBe(true);
    expect(parseRdpBooleanFlag('YES')).toBe(true);
    expect(parseRdpBooleanFlag('on')).toBe(true);
    expect(parseRdpBooleanFlag('enabled')).toBe(true);
  });

  it('parses disabled values', () => {
    expect(parseRdpBooleanFlag('0', true)).toBe(false);
    expect(parseRdpBooleanFlag('false', true)).toBe(false);
    expect(parseRdpBooleanFlag('NO', true)).toBe(false);
    expect(parseRdpBooleanFlag('off', true)).toBe(false);
    expect(parseRdpBooleanFlag('disabled', true)).toBe(false);
  });

  it('falls back for empty or invalid values', () => {
    expect(parseRdpBooleanFlag(null, true)).toBe(true);
    expect(parseRdpBooleanFlag(undefined, false)).toBe(false);
    expect(parseRdpBooleanFlag('', true)).toBe(true);
    expect(parseRdpBooleanFlag('maybe', false)).toBe(false);
    expect(parseRdpBooleanFlag('maybe', true)).toBe(true);
  });
});
