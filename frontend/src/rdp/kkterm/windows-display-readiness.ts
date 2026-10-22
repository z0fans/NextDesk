export type KktermWindowsDisplayState = {
  connectionState: number;
  connected: boolean;
  surfaceReady?: boolean;
};

export function shouldRevealKktermWindowsSurface(
  state: KktermWindowsDisplayState,
): boolean {
  return state.connectionState === 1 || state.connected;
}

export function isKktermWindowsDisplayReady(
  state: KktermWindowsDisplayState,
): boolean {
  return shouldRevealKktermWindowsSurface(state) && state.surfaceReady === true;
}
