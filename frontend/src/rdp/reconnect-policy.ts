const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 16_000;
export const MAX_RECONNECT_ATTEMPTS = 5;

export function reconnectDelayMs(attempt: number): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const exponent = Math.min(normalizedAttempt - 1, 4);
  return Math.min(INITIAL_RECONNECT_DELAY_MS * (2 ** exponent), MAX_RECONNECT_DELAY_MS);
}

export function canRetryReconnect(attempt: number): boolean {
  return attempt >= 1 && attempt <= MAX_RECONNECT_ATTEMPTS;
}
