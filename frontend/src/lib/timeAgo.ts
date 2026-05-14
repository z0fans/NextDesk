/**
 * Returns a translation key and interpolation value for relative time display.
 * @param unixSeconds - Unix timestamp in seconds (from backend last_sync_ts)
 */
export function getTimeAgo(unixSeconds: number): { key: string; n: number } {
  if (unixSeconds === 0) {
    return { key: 'timeAgoNever', n: 0 };
  }

  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixSeconds;

  if (diff < 60) {
    return { key: 'timeAgoJustNow', n: 0 };
  }
  if (diff < 3600) {
    return { key: 'timeAgoMinutes', n: Math.floor(diff / 60) };
  }
  if (diff < 86400) {
    return { key: 'timeAgoHours', n: Math.floor(diff / 3600) };
  }
  return { key: 'timeAgoDays', n: Math.floor(diff / 86400) };
}
