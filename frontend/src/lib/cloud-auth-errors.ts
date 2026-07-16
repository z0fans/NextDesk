import type { TranslationKey } from '@/i18n/translations';

export function cloudAuthErrorKey(error?: string): TranslationKey {
  if (!error) return 'cloudAuthorizationFailed';
  if (error.includes('cloud_auth_too_many_devices')) {
    return 'cloudAuthorizationTooManyDevices';
  }
  if (error.includes('cloud_auth_rate_limited')) {
    return 'cloudAuthorizationRateLimited';
  }
  if (error.includes('cloud_auth_invalid_or_expired')) {
    return 'cloudAuthorizationExpired';
  }
  return 'cloudAuthorizationFailed';
}
