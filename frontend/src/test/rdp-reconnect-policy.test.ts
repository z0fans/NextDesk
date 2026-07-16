import { describe, expect, it } from 'vitest';
import {
  MAX_RECONNECT_ATTEMPTS,
  canRetryReconnect,
  reconnectDelayMs,
} from '@/rdp/reconnect-policy';

describe('RDP reconnect policy', () => {
  it('uses exponential backoff for the five allowed attempts', () => {
    expect(reconnectDelayMs(1)).toBe(1_000);
    expect(reconnectDelayMs(5)).toBe(16_000);
  });

  it('stops after five automatic reconnect attempts', () => {
    expect(MAX_RECONNECT_ATTEMPTS).toBe(5);
    expect(canRetryReconnect(5)).toBe(true);
    expect(canRetryReconnect(6)).toBe(false);
  });
});
