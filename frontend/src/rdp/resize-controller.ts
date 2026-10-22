import type { DesktopSize } from './resolution-modes';
import { canRecoverKktermWindowsResize } from './kkterm/resize-recovery';

type ResizeRequest = { size: DesktopSize };
type ResizeState = {
  size?: DesktopSize;
  pending?: ResizeRequest;
  connectedAt?: number;
  recoveredAt?: number;
  publicReconnectAt?: number;
  cooldownUntil: number;
  settleTimer?: ReturnType<typeof setTimeout>;
  resizeTimer?: ReturnType<typeof setTimeout>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  restart?: object;
};

const sameSize = (left: DesktopSize | undefined, right: DesktopSize) =>
  left?.w === right.w && left.h === right.h;

export class RdpResizeController {
  private sessions = new Map<string, ResizeState>();

  begin(tabId: string): void {
    const previous = this.sessions.get(tabId);
    this.forget(tabId);
    this.sessions.set(tabId, {
      cooldownUntil: 0,
      recoveredAt: previous?.recoveredAt,
      publicReconnectAt: previous?.publicReconnectAt,
    });
  }

  reset(tabId: string): void {
    if (this.sessions.has(tabId)) this.begin(tabId);
  }

  forget(tabId: string): void {
    const state = this.sessions.get(tabId);
    if (!state) return;
    clearTimeout(state.resizeTimer);
    clearTimeout(state.settleTimer);
    clearTimeout(state.reconnectTimer);
    this.sessions.delete(tabId);
  }

  dispose(): void {
    for (const tabId of this.sessions.keys()) this.forget(tabId);
  }

  connected(tabId: string): void {
    const state = this.sessions.get(tabId);
    if (state) state.connectedAt ??= Date.now();
  }

  observeSize(tabId: string, size: DesktopSize): void {
    const state = this.sessions.get(tabId);
    if (!state) return;
    state.size = size;
    if (sameSize(state.pending?.size, size)) state.pending = undefined;
  }

  size(tabId: string): DesktopSize | undefined {
    return this.sessions.get(tabId)?.size;
  }

  suppress(tabId: string, delay: number, settled: () => void): () => void {
    const state = this.sessions.get(tabId);
    if (!state) return () => {};
    state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + delay);
    clearTimeout(state.settleTimer);
    const timer = setTimeout(() => {
      if (this.sessions.get(tabId) === state) settled();
    }, state.cooldownUntil - Date.now());
    state.settleTimer = timer;
    return () => clearTimeout(timer);
  }

  suppressed(tabId: string): boolean {
    return Date.now() < (this.sessions.get(tabId)?.cooldownUntil ?? 0);
  }

  schedule(tabId: string, delay: number, resize: () => void): void {
    const state = this.sessions.get(tabId);
    if (!state) return;
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => {
      if (this.sessions.get(tabId) === state) resize();
    }, delay);
  }

  cancelPending(tabId: string): void {
    const state = this.sessions.get(tabId);
    if (state) state.pending = undefined;
    this.cancelScheduled(tabId);
  }

  cancelScheduled(tabId: string): void {
    clearTimeout(this.sessions.get(tabId)?.resizeTimer);
  }

  async resizeNative(tabId: string, size: DesktopSize, send: () => Promise<unknown>,
    canRecover: () => boolean, reconnect: () => void): Promise<void> {
    const state = this.sessions.get(tabId);
    if (!state) return;
    if (sameSize(state.size, size)) {
      state.pending = undefined;
      return;
    }
    if (sameSize(state.pending?.size, size)) return;
    const request = { size };
    state.pending = request;
    try {
      await send();
    } catch {
      if (this.sessions.get(tabId) !== state || state.pending !== request) return;
      state.pending = undefined;
      if (canRecover()) reconnect();
    }
  }

  async syncWindows(tabId: string, size: DesktopSize, sync: () => Promise<DesktopSize | null>,
    canRecover: () => boolean, reconnect: () => void, applied: (size: DesktopSize) => void): Promise<void> {
    const state = this.sessions.get(tabId);
    if (!state || sameSize(state.pending?.size, size)) return;
    const request = { size };
    state.pending = request;
    let result: DesktopSize | null;
    try {
      result = await sync();
    } catch {
      result = null;
    }
    if (this.sessions.get(tabId) !== state || state.pending !== request) return;
    state.pending = undefined;
    if (result) {
      state.size = result;
      state.recoveredAt = undefined;
      applied(result);
    } else if (canRecover() && canRecoverKktermWindowsResize(Date.now(), state.recoveredAt)) {
      state.recoveredAt = Date.now();
      reconnect();
    }
  }

  reconnectPublic(tabId: string, canRecover: () => boolean, reconnect: () => void): void {
    const state = this.sessions.get(tabId);
    if (!state) return;
    state.pending = undefined;
    const now = Date.now();
    if (state.connectedAt !== undefined && now - state.connectedAt < 20_000) return;
    if (state.publicReconnectAt !== undefined && now - state.publicReconnectAt < 20_000) return;
    if (!canRecover()) return;
    state.publicReconnectAt = now;
    reconnect();
  }

  reconnectAfter(tabId: string, disconnects: Promise<unknown>[],
    reconnect: () => void): void {
    const state = this.sessions.get(tabId);
    if (!state) return;
    clearTimeout(state.reconnectTimer);
    const restart = {};
    state.restart = restart;
    const current = () => this.sessions.get(tabId) === state && state.restart === restart;
    void Promise.allSettled(disconnects).then(() => {
      if (!current()) return;
      state.reconnectTimer = setTimeout(() => {
        if (current()) reconnect();
      }, 500);
    });
  }
}
