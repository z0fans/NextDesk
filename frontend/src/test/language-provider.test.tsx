import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/api';
import { LanguageProvider } from '@/i18n/LanguageProvider';
import { useTranslation } from '@/i18n/useTranslation';

function wrapper({ children }: { children: ReactNode }) {
  return <LanguageProvider>{children}</LanguageProvider>;
}

function deferredLanguage() {
  let resolve!: (language: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('LanguageProvider initialization ownership', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
  });

  afterEach(() => vi.restoreAllMocks());

  it('keeps a saved preference without querying the system', () => {
    localStorage.setItem('nextdesk-language', 'zh-CN');
    const getSystemLanguage = vi.spyOn(api, 'getSystemLanguage');
    const { result } = renderHook(useTranslation, { wrapper });

    expect(result.current.language).toBe('zh-CN');
    expect(getSystemLanguage).not.toHaveBeenCalled();
  });

  it('applies and persists the system language when no preference exists', async () => {
    vi.spyOn(api, 'getSystemLanguage').mockResolvedValue('zh-CN');
    const { result } = renderHook(useTranslation, { wrapper });
    await act(async () => {});

    expect(result.current.language).toBe('zh-CN');
    expect(localStorage.getItem('nextdesk-language')).toBe('zh-CN');
  });

  it.each(['resolve', 'reject'] as const)(
    'keeps a user selection when the startup request later %ss',
    async (outcome) => {
      const pending = deferredLanguage();
      vi.spyOn(api, 'getSystemLanguage').mockReturnValue(pending.promise);
      const { result } = renderHook(useTranslation, { wrapper });
      act(() => result.current.setLanguage('zh-CN'));

      await act(async () => {
        if (outcome === 'resolve') pending.resolve('en-US');
        else pending.reject(new Error('system language unavailable'));
      });

      expect(result.current.language).toBe('zh-CN');
      expect(localStorage.getItem('nextdesk-language')).toBe('zh-CN');
    },
  );

  it('does not persist a startup result after unmount', async () => {
    const pending = deferredLanguage();
    vi.spyOn(api, 'getSystemLanguage').mockReturnValue(pending.promise);
    const { unmount } = renderHook(useTranslation, { wrapper });
    unmount();
    await act(async () => pending.resolve('zh-CN'));

    expect(localStorage.getItem('nextdesk-language')).toBeNull();
  });

  it('ignores the obsolete startup request from StrictMode effect replay', async () => {
    const first = deferredLanguage();
    const second = deferredLanguage();
    const getSystemLanguage = vi.spyOn(api, 'getSystemLanguage')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(useTranslation, {
      wrapper,
      reactStrictMode: true,
    });
    expect(getSystemLanguage).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve('zh-CN'));
    await act(async () => first.resolve('en-US'));

    expect(result.current.language).toBe('zh-CN');
    expect(localStorage.getItem('nextdesk-language')).toBe('zh-CN');
  });

  it('keeps the browser fallback when system language lookup fails', async () => {
    vi.spyOn(api, 'getSystemLanguage').mockRejectedValue(new Error('unavailable'));
    const { result } = renderHook(useTranslation, { wrapper });
    await act(async () => {});
    expect(result.current.language).toBe('en-US');
  });

  it('keeps language selection usable when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(api, 'getSystemLanguage').mockResolvedValue('zh-CN');
    const { result } = renderHook(useTranslation, { wrapper });
    await act(async () => {});

    expect(result.current.language).toBe('zh-CN');
    act(() => result.current.setLanguage('en-US'));
    expect(result.current.language).toBe('en-US');
  });
});
