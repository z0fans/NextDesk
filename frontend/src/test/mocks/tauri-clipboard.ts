// Mock for @tauri-apps/plugin-clipboard-manager
import { vi } from 'vitest';

export const readText = vi.fn(() => Promise.resolve(''));
export const writeText = vi.fn(() => Promise.resolve());
