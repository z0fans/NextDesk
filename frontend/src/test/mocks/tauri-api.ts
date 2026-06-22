// Mock for @tauri-apps/api
import { vi } from 'vitest';

export async function invoke(_cmd: string, _args?: Record<string, unknown>): Promise<unknown> {
  return null;
}

export const event = {
  listen: vi.fn(() => Promise.resolve(vi.fn())),
  emit: vi.fn(() => Promise.resolve()),
  once: vi.fn(() => Promise.resolve(vi.fn())),
};

export const listen = event.listen;
export const emit = event.emit;
export const once = event.once;

export const window = {
  appWindow: {
    listen: vi.fn(() => Promise.resolve(vi.fn())),
  },
  getCurrent: vi.fn(() => ({
    listen: vi.fn(() => Promise.resolve(vi.fn())),
    setTitle: vi.fn(() => Promise.resolve()),
  })),
};

export const core = {
  invoke,
};
