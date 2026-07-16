import { describe, expect, it } from 'vitest';
import { translations } from '@/i18n/translations';

const cloudKeys = [
  'account',
  'accountDesc',
  'signInToCloud',
  'signOutOfCloud',
  'authorizeDevice',
  'authorizing',
  'cloudAccount',
  'cloudAvailableUntil',
  'deviceAuthorization',
  'authorized',
  'cloudUnavailable',
  'notAuthorized',
  'cloudExpiresAt',
  'cloudNoExpiry',
  'cloudAuthorizationFailed',
] as const;

describe('cloud account copy', () => {
  it('has complete Simplified Chinese and English account labels', () => {
    for (const key of cloudKeys) {
      expect(translations['en-US'][key]).toBeTruthy();
      expect(translations['zh-CN'][key]).toBeTruthy();
    }
  });

  it('does not expose the retired Cloud Mode switch copy', () => {
    expect(translations['en-US']).not.toHaveProperty('cloudMode');
    expect(translations['zh-CN']).not.toHaveProperty('cloudMode');
    expect(translations['en-US']).not.toHaveProperty('cloudModeDesc');
    expect(translations['zh-CN']).not.toHaveProperty('cloudModeDesc');
  });

  it('does not expose retired subscription, node, or Tube controls', () => {
    for (const key of [
      'subscription',
      'manageSubscription',
      'subUrlPlaceholder',
      'proxy',
      'noProxyGroups',
      'currentNode',
      'tubeMode',
      'tubeModeDesc',
      'relayApiKey',
    ]) {
      expect(translations['en-US']).not.toHaveProperty(key);
      expect(translations['zh-CN']).not.toHaveProperty(key);
    }
  });
});
