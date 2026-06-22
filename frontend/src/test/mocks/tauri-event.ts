import { vi } from 'vitest';

export const listen = vi.fn(() => Promise.resolve(vi.fn()));
export const emit = vi.fn(() => Promise.resolve());
export const once = vi.fn(() => Promise.resolve(vi.fn()));
