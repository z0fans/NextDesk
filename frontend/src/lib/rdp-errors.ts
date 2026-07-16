import type { TranslationKey } from '@/i18n/translations';

const NON_RECOVERABLE_RDP_ERROR_TOKENS = [
  'another user connected',
  'forcing the disconnection',
  'logon_failure',
  'account_disabled',
  'account_locked',
  'account_expired',
  'password_expired',
  'access_denied',
  'administratively',
  'license',
  'idle timeout',
  'credssp',
  'certificate',
];

export function isNonRecoverableRdpError(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  if (NON_RECOVERABLE_RDP_ERROR_TOKENS.some(token => lowerMessage.includes(token))) {
    return true;
  }

  return lowerMessage.includes('rdpgfx')
    && (lowerMessage.includes('avc420')
      || lowerMessage.includes('h.264')
      || lowerMessage.includes('h264')
      || lowerMessage.includes('did not negotiate'));
}

/** Map raw backend/RDP errors to user-facing copy without exposing renderer/protocol internals. */
export function friendlyRdpError(raw: string, t: (key: TranslationKey) => string): string {
  const r = raw.toLowerCase();
  if (!r.trim()) {
    return t('rdpErrUnknown');
  }
  if (
    r.includes('cloud_authorization_expired')
    || (r.includes('cloud') && (r.includes('401') || r.includes('403') || r.includes('unauthorized')))
  ) {
    return t('rdpErrCloudAuth');
  }
  if (r.includes('cloud_prepare_unsupported')) {
    return t('rdpErrCloudGatewayOutdated');
  }
  if (
    r.includes('cloud_all_candidates_failed')
    || r.includes('cloud_no_candidates')
    || r.includes('candidate_apply_timeout')
    || r.includes('not_enough_candidates')
  ) {
    return t('rdpErrCloudRelayUnavailable');
  }
  if (r.includes('status_logon_failure') || r.includes('0xc000006d')) {
    return t('rdpErrLoginFailed');
  }
  if (r.includes('status_account_disabled') || r.includes('0xc0000072')) {
    return t('rdpErrAccountDisabled');
  }
  if (r.includes('status_account_locked') || r.includes('0xc0000234')) {
    return t('rdpErrAccountLocked');
  }
  if (r.includes('status_password_expired') || r.includes('0xc0000071')) {
    return t('rdpErrPasswordExpired');
  }
  if (r.includes('status_account_expired') || r.includes('0xc0000193')) {
    return t('rdpErrAccountExpired');
  }
  if (r.includes('status_password_must_change') || r.includes('0xc0000224')) {
    return t('rdpErrPasswordMustChange');
  }
  if (r.includes('credssp')) {
    return t('rdpErrCredSsp');
  }
  if (r.includes('tls') || r.includes('ssl') || r.includes('certificate')) {
    return t('rdpErrTls');
  }
  if (r.includes('dns') || r.includes('resolve')) {
    return t('rdpErrDns');
  }
  if (r.includes('refused') || r.includes('reset')) {
    return t('rdpErrRefused');
  }
  if (r.includes('timeout') || r.includes('timed out')) {
    return t('rdpErrTimeout');
  }
  if (r.includes('socks') || r.includes('proxy') || r.includes('internal clash api')) {
    return t('rdpErrProxy');
  }
  if (r.includes('read frame by hint') || r.includes('not enough bytes') || r.includes('read frame')) {
    return t('rdpErrNoResponse');
  }
  if (r.includes('renderer')) {
    return t('rdpErrDisplayStartup');
  }
  if (r.includes('rdpgfx') || r.includes('h.264') || r.includes('h264') || r.includes('avc420')) {
    return t('rdpErrDisplayStartup');
  }
  if (r.includes('ironrdp')) {
    return t('rdpErrUnknown');
  }
  if (r.includes('rdcleanpath')) {
    return t('rdpErrWsClosed');
  }
  if (r.includes('websocket') || r.includes('ws://')) {
    return t('rdpErrWsClosed');
  }
  if (r.includes('canvas')) {
    return t('rdpErrCanvas');
  }
  if (r.includes('another user connected') || r.includes('forcing the disconnection')) {
    return t('rdpErrAnotherUser');
  }
  if (r.includes('administratively')) {
    return t('rdpErrAdmin');
  }
  if (r.includes('idle timeout')) {
    return t('rdpErrIdleTimeout');
  }
  return t('rdpErrUnknown');
}
