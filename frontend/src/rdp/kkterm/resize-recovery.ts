export const KKTERM_WINDOWS_RESIZE_RECOVERY_COOLDOWN_MS = 15_000;

export function canRecoverKktermWindowsResize(
  now: number,
  lastRecoveryAt: number | undefined,
): boolean {
  return lastRecoveryAt === undefined
    || now - lastRecoveryAt >= KKTERM_WINDOWS_RESIZE_RECOVERY_COOLDOWN_MS;
}
