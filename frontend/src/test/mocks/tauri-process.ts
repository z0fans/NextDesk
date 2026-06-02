// Mock for @tauri-apps/plugin-process
import { vi } from 'vitest';

export const exit = vi.fn(() => Promise.resolve());
export const relaunch = vi.fn(() => Promise.resolve());
