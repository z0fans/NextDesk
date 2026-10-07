export type KktermCopyPlatform = 'windows' | 'macos' | 'other';

export type DesktopSize = {
  w: number;
  h: number;
};

export function restoreRdpResolution(mode: string, localScalingSupported: boolean): {
  mode: string;
  desktopSize: DesktopSize | null;
} {
  if (['1920x1080', '1600x900', '1440x900', '1366x768', '1280x720'].includes(mode)) {
    const [w, h] = mode.split('x').map(Number);
    return { mode, desktopSize: { w, h } };
  }
  return {
    mode: mode === 'smartSizing' && localScalingSupported ? mode : 'adaptive',
    desktopSize: null,
  };
}

export type LocalScalingPlan = {
  desktopSize: DesktopSize;
  reconnect: boolean;
};

export function supportsKktermLocalScaling(platform: KktermCopyPlatform): boolean {
  return platform === 'windows' || platform === 'macos';
}

export function planKktermLocalScaling(
  platform: KktermCopyPlatform,
  currentRemoteSize: DesktopSize,
  fallbackSize: DesktopSize,
): LocalScalingPlan | null {
  if (!supportsKktermLocalScaling(platform)) return null;

  const source = currentRemoteSize.w > 0 && currentRemoteSize.h > 0
    ? currentRemoteSize
    : fallbackSize;
  const desktopSize = {
    w: Math.max(320, Math.round(source.w)),
    h: Math.max(240, Math.round(source.h)),
  };

  return {
    desktopSize,
    // Windows must reconnect so ActiveX starts in SmartSizing mode. The macOS
    // canvas already fills its pane with CSS, so keeping the current backing
    // resolution is sufficient and avoids an unnecessary session restart.
    reconnect: platform === 'windows',
  };
}
