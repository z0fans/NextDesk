import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RdpResizeController } from '@/rdp/resize-controller';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const small = { w: 1280, h: 720 };
const large = { w: 1920, h: 1080 };

describe('RDP resize ownership', () => {
  let sizes: RdpResizeController;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    sizes = new RdpResizeController();
    sizes.begin('tab');
  });
  afterEach(() => { sizes.dispose(); vi.useRealTimers(); });

  it('debounces a burst and cancels delayed work when its tab closes', async () => {
    const applied = vi.fn();
    sizes.schedule('tab', 800, () => applied(small));
    await vi.advanceTimersByTimeAsync(400);
    sizes.schedule('tab', 800, () => applied(large));
    await vi.advanceTimersByTimeAsync(799);
    expect(applied).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(applied).toHaveBeenCalledExactlyOnceWith(large);
    sizes.schedule('tab', 800, applied);
    sizes.forget('tab');
    await vi.runAllTimersAsync();
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it('keeps overlapping cooldowns isolated by tab and honors the longer one', async () => {
    sizes.begin('other');
    const settled = vi.fn();
    sizes.suppress('tab', 2500, settled);
    await vi.advanceTimersByTimeAsync(500);
    sizes.suppress('tab', 500, settled);
    await vi.advanceTimersByTimeAsync(500);
    expect(sizes.suppressed('tab')).toBe(true);
    expect(sizes.suppressed('other')).toBe(false);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(sizes.suppressed('tab')).toBe(false);
    expect(settled).toHaveBeenCalledOnce();
  });

  it('ignores old native failures even when a replacement requests the same size', async () => {
    const old = deferred<void>();
    const current = deferred<void>();
    const reconnect = vi.fn();
    const first = sizes.resizeNative('tab', small, () => old.promise, () => true, reconnect);
    sizes.begin('tab');
    const second = sizes.resizeNative('tab', small, () => current.promise, () => true, reconnect);
    old.reject(new Error('old request'));
    await first;
    expect(reconnect).not.toHaveBeenCalled();
    current.reject(new Error('current request'));
    await second;
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it('deduplicates native requests and treats a matching frame as acknowledgement', async () => {
    const pending = deferred<void>();
    const send = vi.fn(() => pending.promise);
    const reconnect = vi.fn();
    const first = sizes.resizeNative('tab', large, send, () => true, reconnect);
    await sizes.resizeNative('tab', large, send, () => true, reconnect);
    expect(send).toHaveBeenCalledOnce();
    sizes.observeSize('tab', large);
    pending.reject(new Error('late transport error'));
    await first;
    expect(reconnect).not.toHaveBeenCalled();
    expect(sizes.size('tab')).toEqual(large);
  });

  it('does not reconnect if a file transfer begins while resize is in flight', async () => {
    let transferring = false;
    const pending = deferred<void>();
    const reconnect = vi.fn();
    const resizing = sizes.resizeNative('tab', small, () => pending.promise, () => !transferring, reconnect);
    transferring = true;
    pending.reject(new Error('not ready'));
    await resizing;
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('accepts only the latest Windows result, including after a mode change', async () => {
    const old = deferred<typeof small | null>();
    const applied = vi.fn();
    const reconnect = vi.fn();
    const first = sizes.syncWindows('tab', small, () => old.promise, () => true, reconnect, applied);
    await sizes.syncWindows('tab', large, async () => large, () => true, reconnect, applied);
    old.resolve(small);
    await first;
    expect(applied).toHaveBeenCalledExactlyOnceWith(large);
    expect(sizes.size('tab')).toEqual(large);
    const pending = deferred<typeof small | null>();
    const changed = sizes.syncWindows('tab', small, () => pending.promise, () => true, reconnect, applied);
    sizes.cancelPending('tab');
    pending.resolve(null);
    await changed;
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('preserves the Windows recovery cooldown across a replacement session', async () => {
    const reconnect = vi.fn();
    await sizes.syncWindows('tab', small, async () => null, () => true, reconnect, vi.fn());
    expect(reconnect).toHaveBeenCalledOnce();
    sizes.begin('tab');
    await sizes.syncWindows('tab', large, async () => null, () => true, reconnect, vi.fn());
    expect(reconnect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    await sizes.syncWindows('tab', large, async () => null, () => true, reconnect, vi.fn());
    expect(reconnect).toHaveBeenCalledTimes(2);
  });

  it('retains the public-route settle period and reconnect throttle', async () => {
    const reconnect = vi.fn();
    sizes.connected('tab');
    sizes.reconnectPublic('tab', () => true, reconnect);
    expect(reconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    sizes.reconnectPublic('tab', () => true, reconnect);
    sizes.begin('tab');
    sizes.reconnectPublic('tab', () => true, reconnect);
    expect(reconnect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);
    sizes.reconnectPublic('tab', () => true, reconnect);
    expect(reconnect).toHaveBeenCalledTimes(2);
  });

  it.each(['before disconnect', 'after disconnect'])('cancels replacement %s completes', async (when) => {
    const disconnected = deferred<void>();
    const reconnect = vi.fn();
    sizes.reconnectAfter('tab', [disconnected.promise], reconnect);
    if (when === 'after disconnect') {
      disconnected.resolve();
      await Promise.resolve();
    }
    sizes.forget('tab');
    sizes.begin('tab');
    disconnected.resolve();
    await vi.runAllTimersAsync();
    expect(reconnect).not.toHaveBeenCalled();
  });
});
