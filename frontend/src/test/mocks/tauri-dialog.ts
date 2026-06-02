// Mock for @tauri-apps/plugin-dialog
import { vi } from 'vitest';

export const open = vi.fn(() => Promise.resolve(null));
export const save = vi.fn(() => Promise.resolve(null));
export const message = vi.fn(() => Promise.resolve());
export const ask = vi.fn(() => Promise.resolve(false));
export const confirm = vi.fn(() => Promise.resolve(false));
