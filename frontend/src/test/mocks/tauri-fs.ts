// Mock for @tauri-apps/plugin-fs
import { vi } from 'vitest';

export const readTextFile = vi.fn(() => Promise.resolve(''));
export const writeTextFile = vi.fn(() => Promise.resolve());
export const readDir = vi.fn(() => Promise.resolve([]));
export const exists = vi.fn(() => Promise.resolve(false));
export const mkdir = vi.fn(() => Promise.resolve());
export const remove = vi.fn(() => Promise.resolve());
export const BaseDirectory = {
  AppData: 'AppData',
  Home: 'Home',
  Desktop: 'Desktop',
};
